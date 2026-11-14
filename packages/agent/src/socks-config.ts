import { Buffer } from 'node:buffer'
import { parse, stringify } from 'yaml'

export const SOCKS_LISTENER_PREFIX = '__metacubexd_socks__'
const OWNERSHIP_MARKER = 'x-metacubexd-socks-service'

export interface SocksBackend {
  id: string
  username: string
  proxy?: string
  provider?: string
  port: number
  password: string
}

type Mapping = Record<string, unknown>

function mapping(value: unknown): value is Mapping {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function document(content: string): Mapping {
  const value: unknown = parse(content)
  if (!mapping(value)) throw new Error('SOCKS runtime requires a YAML mapping')
  for (const field of ['listeners', 'proxy-groups', 'proxies']) {
    if (value[field] !== undefined && !Array.isArray(value[field]))
      throw new Error(`Invalid ${field} collection`)
  }
  return value
}

function owned(value: unknown): boolean {
  return (
    mapping(value) &&
    typeof value.name === 'string' &&
    value.name.startsWith(SOCKS_LISTENER_PREFIX)
  )
}

function targetError(
  root: Mapping,
  target: string,
  provider?: string,
): string | undefined {
  const providers = mapping(root['proxy-providers'])
    ? root['proxy-providers']
    : {}
  const nodes = new Map<string, Mapping>()
  const duplicate = new Set<string>()
  for (const item of [
    ...((root.proxies as unknown[]) ?? []),
    ...((root['proxy-groups'] as unknown[]) ?? []).filter(
      (item) => !owned(item),
    ),
  ]) {
    if (!mapping(item) || typeof item.name !== 'string') continue
    if (nodes.has(item.name)) duplicate.add(item.name)
    nodes.set(item.name, item)
  }
  const groups = new Set(
    ((root['proxy-groups'] as unknown[]) ?? [])
      .filter(mapping)
      .filter((item) => !owned(item))
      .map((group) => group.name),
  )
  const visiting = new Set<string>()
  const providerVisiting = new Set<string>()
  const done = new Set<string>()

  function dialer(node: Mapping, label: string): string | undefined {
    if (node['dialer-proxy'] === undefined) return undefined
    if (typeof node['dialer-proxy'] !== 'string' || !node['dialer-proxy'])
      return `Invalid dialer-proxy on ${label}`
    return visit(node['dialer-proxy'])
  }

  function adapter(node: Mapping, label: string): string | undefined {
    if (typeof node.type !== 'string' || !node.type)
      return `Invalid node type: ${label}`
    if (['direct', 'compatible', 'pass'].includes(node.type.toLowerCase()))
      return `Unsafe default escape through ${label}`
    return dialer(node, label)
  }

  function inspectProvider(name: string, exact?: string): string | undefined {
    if (!Object.hasOwn(providers, name) || !mapping(providers[name]))
      return `Provider is missing: ${name}; binding is blocked`
    if (providerVisiting.has(name)) return `Cyclic provider dependency: ${name}`
    const entry = providers[name]
    providerVisiting.add(name)
    try {
      const providerDialer = dialer(entry, `provider ${name}`)
      if (providerDialer) return providerDialer
      if (entry.override !== undefined && !mapping(entry.override))
        return `Invalid provider override: ${name}`
      const override = mapping(entry.override) ? entry.override : {}
      const overrideDialer = dialer(override, `provider ${name} override`)
      if (overrideDialer) return overrideDialer
      // A URL/file provider can later replace its payload with arbitrary raw
      // dialer-proxy dependencies. A filtered select and REJECT fallback only
      // prove absence safety, not those mutable members' dependency closure.
      if (entry.type !== 'inline' || !Array.isArray(entry.payload))
        return `Dynamic provider ${name} is unavailable for fixed SOCKS binding; materialize its nodes in top-level proxies`
      // Renaming transforms cannot be reproduced safely without implementing
      // Mihomo's regex engine. Refuse rather than bind the wrong raw name.
      if (
        override['proxy-name'] !== undefined ||
        override['additional-prefix'] !== undefined ||
        override['additional-suffix'] !== undefined
      )
        return `Provider ${name} renaming is unavailable; materialize its nodes in top-level proxies`
      const payload = entry.payload
      if (
        !payload.every(
          (node) =>
            mapping(node) &&
            typeof node.name === 'string' &&
            node.name.length > 0,
        )
      )
        return `Invalid inline provider payload: ${name}`
      const selected =
        exact === undefined
          ? payload
          : payload.filter((node) => (node as Mapping).name === exact)
      if (exact !== undefined && selected.length !== 1)
        return `Missing or ambiguous inline provider target: ${exact}`
      const names = new Set<string>()
      for (const value of selected) {
        const node = value as Mapping
        if (names.has(node.name as string))
          return `Ambiguous inline provider target: ${node.name}`
        names.add(node.name as string)
        const error = adapter(node, `${name}/${node.name}`)
        if (error) return error
      }
      return undefined
    } finally {
      providerVisiting.delete(name)
    }
  }

  function visit(name: string): string | undefined {
    if (name === 'REJECT' || name === 'REJECT-DROP') return undefined
    if (['GLOBAL', 'DIRECT', 'COMPATIBLE', 'PASS'].includes(name))
      return `Unsafe default escape through ${name}`
    if (duplicate.has(name)) return `Ambiguous target: ${name}`
    const node = nodes.get(name)
    if (!node || name.startsWith(SOCKS_LISTENER_PREFIX))
      return `Missing target: ${name}`
    if (visiting.has(name)) return `Cyclic target dependency: ${name}`
    if (done.has(name)) return undefined
    visiting.add(name)
    const upstreamError = dialer(node, name)
    if (upstreamError) return upstreamError
    if (groups.has(name)) {
      if (
        typeof node.type !== 'string' ||
        !['select', 'url-test', 'fallback', 'load-balance', 'relay'].includes(
          node.type,
        )
      )
        return `Unsupported group type: ${name}`
      if (
        node.proxies !== undefined &&
        (!Array.isArray(node.proxies) ||
          !node.proxies.every(
            (item) => typeof item === 'string' && item.length > 0,
          ))
      )
        return `Invalid group candidates: ${name}`
      if (
        node.use !== undefined &&
        (!Array.isArray(node.use) ||
          !node.use.every(
            (item) => typeof item === 'string' && item.length > 0,
          ))
      )
        return `Invalid group providers: ${name}`
      for (const field of [
        'include-all',
        'include-all-proxies',
        'include-all-providers',
      ]) {
        if (node[field] !== undefined && typeof node[field] !== 'boolean')
          return `Invalid ${field}: ${name}`
      }
      const candidates = [...((node.proxies ?? []) as string[])]
      // Match Mihomo's visible node expansion without rewriting the original
      // group. Filters may narrow members, but never justify an unsafe member.
      if (
        node['include-all'] === true ||
        node['include-all-proxies'] === true
      ) {
        for (const item of (root.proxies as unknown[]) ?? []) {
          if (mapping(item) && typeof item.name === 'string')
            candidates.push(item.name)
        }
      }
      for (const candidate of candidates) {
        const error = visit(candidate)
        if (error) return error
      }
      const usedProviders = [...((node.use ?? []) as string[])]
      if (
        node['include-all'] === true ||
        node['include-all-providers'] === true
      )
        usedProviders.push(...Object.keys(providers))
      for (const used of usedProviders) {
        const error = inspectProvider(used)
        if (error) return error
      }
      const filtered =
        node.filter !== undefined ||
        node['exclude-filter'] !== undefined ||
        node['exclude-type'] !== undefined
      const staticNonempty = candidates.length > 0 && !filtered
      const fallback = node['empty-fallback']
      if (fallback !== undefined && fallback !== 'REJECT') {
        if (typeof fallback !== 'string')
          return `Invalid empty-fallback: ${name}`
        const error = visit(fallback)
        if (error) return error
      }
      if (!staticNonempty && fallback !== 'REJECT')
        return `Unsafe possibly empty group ${name}; set empty-fallback: REJECT`
    } else {
      const error = adapter(node, name)
      if (error) return error
    }
    visiting.delete(name)
    done.add(name)
    return undefined
  }
  return provider === undefined
    ? visit(target)
    : inspectProvider(provider, target)
}

/** Same conservative safety check used by runtime fail-closed compilation. */
export function validateSocksTarget(
  content: string,
  proxy: string,
  provider?: string,
): string | undefined {
  if (
    typeof proxy !== 'string' ||
    !proxy ||
    (provider !== undefined && (typeof provider !== 'string' || !provider))
  )
    return 'Invalid fixed SOCKS target'
  try {
    return targetError(document(content), proxy, provider)
  } catch {
    return 'Unable to inspect profile targets'
  }
}

function exactRE2(name: string): string {
  // Mihomo splits filters on raw backticks. Encode delimiters/control bytes
  // without a control-character regex, so formatting cannot detach a lint pragma.
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const literal = Array.from(escaped, (char) => {
    const code = char.charCodeAt(0)
    return code === 96 || code < 32 || code === 127
      ? `\\x${code.toString(16).padStart(2, '0')}`
      : char
  }).join('')
  return `\\A${literal}\\z`
}

export function buildSocksRuntime(
  content: string,
  backends: SocksBackend[],
): { content: string; errors: Record<string, string> } {
  const root = document(content)
  const marker = root[OWNERSHIP_MARKER]
  let priorListeners: string[] = []
  let priorGroups: string[] = []
  if (marker !== undefined) {
    const names = (value: unknown): value is string[] =>
      Array.isArray(value) &&
      value.every(
        (name) =>
          typeof name === 'string' && name.startsWith(SOCKS_LISTENER_PREFIX),
      ) &&
      new Set(value).size === value.length
    if (
      !mapping(marker) ||
      marker.version !== 1 ||
      !names(marker.listeners) ||
      !names(marker.groups)
    )
      throw new Error('Invalid SOCKS runtime ownership marker')
    priorListeners = marker.listeners
    priorGroups = marker.groups
  }
  function retain(items: unknown[], prior: string[]): unknown[] {
    const previous = new Set(prior)
    return items.filter((item) => {
      if (!owned(item)) return true
      if (!previous.has((item as Mapping).name as string))
        throw new Error(
          'Reserved SOCKS namespace conflicts with an existing profile item',
        )
      return false
    })
  }
  const listeners = retain((root.listeners as unknown[]) ?? [], priorListeners)
  const groups = retain((root['proxy-groups'] as unknown[]) ?? [], priorGroups)
  const generatedListeners: string[] = []
  const generatedGroups: string[] = []
  const errors: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >
  const seenIds = new Set<string>()
  const seenPorts = new Set<number>()
  for (const backend of backends) {
    if (
      !backend.id ||
      seenIds.has(backend.id) ||
      !Number.isInteger(backend.port) ||
      backend.port < 1 ||
      backend.port > 65535 ||
      seenPorts.has(backend.port)
    )
      throw new Error('Invalid or duplicate SOCKS backend')
    seenIds.add(backend.id)
    seenPorts.add(backend.port)
    for (const value of [backend.username, backend.password]) {
      if (
        typeof value !== 'string' ||
        Buffer.byteLength(value) < 1 ||
        Buffer.byteLength(value) > 255
      )
        throw new Error('Invalid SOCKS backend credentials')
    }
    const name = `${SOCKS_LISTENER_PREFIX}${Buffer.from(backend.id).toString('hex')}`
    generatedListeners.push(name)
    const listener: Mapping = {
      name,
      type: 'socks',
      listen: '127.0.0.1',
      port: backend.port,
      udp: false,
      users: [{ username: backend.username, password: backend.password }],
    }
    if (backend.proxy !== undefined || backend.provider !== undefined) {
      let error: string | undefined
      if (
        typeof backend.proxy !== 'string' ||
        !backend.proxy ||
        (backend.provider !== undefined &&
          (typeof backend.provider !== 'string' || !backend.provider))
      )
        error = 'Invalid fixed SOCKS target'
      else error = targetError(root, backend.proxy, backend.provider)
      if (error) {
        errors[backend.id] = error
        listener.proxy = 'REJECT'
      } else if (backend.provider !== undefined) {
        const groupName = `${name}_provider`
        generatedGroups.push(groupName)
        groups.push({
          name: groupName,
          type: 'select',
          use: [backend.provider],
          filter: exactRE2(backend.proxy!),
          'empty-fallback': 'REJECT',
          hidden: true,
        })
        listener.proxy = groupName
      } else listener.proxy = backend.proxy
    }
    listeners.push(listener)
  }
  // Only replace owned namespace. No original group/node is rewritten, cloned,
  // or mode-adjusted; unrelated listener authentication is retained verbatim.
  if (listeners.length || root.listeners !== undefined)
    root.listeners = listeners
  if (groups.length || root['proxy-groups'] !== undefined)
    root['proxy-groups'] = groups
  if (backends.length)
    root[OWNERSHIP_MARKER] = {
      version: 1,
      listeners: generatedListeners,
      groups: generatedGroups,
    }
  else delete root[OWNERSHIP_MARKER]
  return { content: stringify(root), errors }
}
