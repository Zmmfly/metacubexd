import type { ConfigObject } from '@metacubexd/config-editor'
import { findDialerProxyCycle } from '@metacubexd/config-editor'

export const PROXY_TYPES = [
  'ss',
  'ssr',
  'http',
  'socks5',
  'vmess',
  'vless',
  'trojan',
  'hysteria2',
  'tuic',
  'wireguard',
  'ssh',
  'snell',
  'anytls',
  'direct',
  'reject',
  'pass',
] as const

export const PROXY_GROUP_TYPES = [
  'select',
  'url-test',
  'fallback',
  'load-balance',
  'relay',
  'smart',
] as const

export const PROXY_PROTOCOL_FIELDS: Record<string, string[]> = {
  ss: ['cipher', 'password', 'udp', 'udp-over-tcp'],
  ssr: ['cipher', 'password', 'obfs', 'protocol'],
  http: ['username', 'password', 'tls', 'skip-cert-verify'],
  socks5: ['username', 'password', 'tls', 'udp'],
  vmess: ['uuid', 'alterId', 'cipher', 'tls', 'network', 'servername'],
  vless: ['uuid', 'flow', 'tls', 'network', 'servername'],
  trojan: ['password', 'tls', 'sni', 'skip-cert-verify'],
  hysteria2: ['password', 'sni', 'skip-cert-verify', 'up', 'down'],
  tuic: ['uuid', 'password', 'sni', 'skip-cert-verify'],
  wireguard: ['private-key', 'public-key', 'ip', 'mtu'],
  ssh: ['username', 'password', 'private-key', 'host-key-algorithms'],
  snell: ['psk', 'version', 'obfs-opts'],
  anytls: ['password', 'client-fingerprint', 'sni', 'skip-cert-verify'],
}

export const BOOLEAN_ROUTING_FIELDS = new Set([
  'tls',
  'udp',
  'skip-cert-verify',
  'udp-over-tcp',
  'tfo',
])

export const NUMBER_ROUTING_FIELDS = new Set([
  'port',
  'interval',
  'mtu',
  'alterId',
])

export function routingResourceFields(kind: 'proxy' | 'group', type: string) {
  if (kind === 'group') return ['name', 'type', 'url', 'interval']
  return [
    'name',
    'type',
    'server',
    'port',
    'dialer-proxy',
    ...(PROXY_PROTOCOL_FIELDS[type] ?? []),
  ]
}

export interface DialerProxyOption {
  name: string
  kind: 'proxy' | 'group'
  cycle: boolean
}

/** Build chain-target choices without mutating the editor's resource arrays. */
export function dialerProxyOptions(
  draft: ConfigObject,
  resourceIndex: number | null,
  proxies: ConfigObject[],
  groups: ConfigObject[],
): DialerProxyOption[] {
  const currentName = typeof draft.name === 'string' ? draft.name : ''
  const candidates = [
    ...proxies.map((value) => ({ value, kind: 'proxy' as const })),
    ...groups.map((value) => ({ value, kind: 'group' as const })),
  ]
  return candidates.flatMap(({ value, kind }) => {
    if (typeof value.name !== 'string' || !value.name) return []
    const nextDraft = { ...draft, 'dialer-proxy': value.name }
    const nextProxies =
      resourceIndex === null
        ? [...proxies, nextDraft]
        : proxies.map((proxy, index) =>
            index === resourceIndex ? nextDraft : proxy,
          )
    const cycle = currentName
      ? findDialerProxyCycle(
          { proxies: nextProxies, 'proxy-groups': groups },
          currentName,
        ).length > 0
      : false
    return [{ name: value.name, kind, cycle }]
  })
}

export function isSensitiveRoutingField(field: string) {
  return /password|secret|private-key|psk/i.test(field)
}
