import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parse } from 'yaml'
import { isPlainObject } from './merge'

/** Scalars that can be injected as a single top-level `key: value` YAML line. */
export type ConfigOverrideValue = string | number | boolean

/** Instance-level config overrides keyed by top-level mihomo config key. */
export type ConfigOverrides = Record<string, ConfigOverrideValue>

/**
 * Panel-editable runtime switches whose persistence lives in the agent-level
 * settings bag instead of a profile file.
 *
 * They HAVE to live here because `profiles.refresh()` overwrites the profile
 * file with the subscription body verbatim — anything the user persisted into
 * the profile is silently lost on the next refresh and reverts after a kernel
 * restart. The supervisor injects these keys into active.yaml at spawn instead.
 * Only scalars are handled: nested structures (dns, tun, …) stay
 * profile-owned. MUST stay in sync with the UI-side list in
 * packages/ui/composables/useQueries.ts (SHARED CONTRACTS).
 */
export const CONFIG_OVERRIDE_KEYS = [
  'allow-lan',
  'mode',
  'log-level',
  'unified-delay',
  'interface-name',
  'ipv6',
  'geodata-mode',
  'tcp-concurrent',
] as const

const CONFIG_OVERRIDE_KEY_SET: ReadonlySet<string> = new Set(
  CONFIG_OVERRIDE_KEYS,
)

/** Whether `key` is one of the panel-editable switch keys above. */
export function isConfigOverrideKey(key: string): boolean {
  return CONFIG_OVERRIDE_KEY_SET.has(key)
}

/** Scalars only — a nested object/array would need a whole YAML block. */
export function isConfigOverrideValue(
  value: unknown,
): value is ConfigOverrideValue {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * Copy the valid entries of an untrusted override bag into a fresh map. Called
 * on every read and on every write so a hand-edited settings.json (or a request
 * body) can never smuggle a non-scalar into the YAML injector.
 */
export function sanitizeConfigOverrides(value: unknown): ConfigOverrides {
  if (!isPlainObject(value)) return {}
  const out: ConfigOverrides = {}
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && isConfigOverrideValue(entry)) out[key] = entry
  }
  return out
}

/**
 * Extract the whitelisted scalars from raw subscription YAML. Used at import
 * time (ProfileStoreOptions.onImportOverrides) to seed the overrides a freshly
 * imported subscription already carries. Unparseable / non-mapping content
 * yields {}.
 */
export function pickConfigOverrides(content: string): ConfigOverrides {
  let parsed: unknown
  try {
    parsed = parse(content)
  } catch {
    return {}
  }
  if (!isPlainObject(parsed)) return {}
  const out: ConfigOverrides = {}
  for (const key of CONFIG_OVERRIDE_KEYS) {
    const value = parsed[key]
    if (isConfigOverrideValue(value)) out[key] = value
  }
  return out
}

/**
 * Generic agent-level settings bag (server-wide, profile-independent). The
 * first key is the geo download idle timeout; future options (download
 * mirrors, scheduler tuning, …) should be added here rather than minting a
 * new file/endpoint per setting.
 */
export interface AgentSettings {
  // Per-file idle timeout (ms) for geo asset downloads: the transfer aborts
  // only when NO bytes arrive for this long — a slow but progressing
  // download always runs to completion. Default 60s for weak networks.
  geoIdleTimeoutMs: number
  // Instance-level overrides for the panel-editable runtime switches
  // (CONFIG_OVERRIDE_KEYS). The supervisor injects them into active.yaml at
  // spawn, so a subscription refresh that overwrites the profile file cannot
  // drop them. Values are scalars; PUT merges them shallowly.
  configOverrides: ConfigOverrides
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  geoIdleTimeoutMs: 60_000,
  configOverrides: {},
}

export interface AgentSettingsStore {
  read: () => Promise<AgentSettings>
  update: (patch: Partial<AgentSettings>) => Promise<AgentSettings>
}

/**
 * Persisted as JSON at `filePath` (<dataDir>/settings.json). Read merges over
 * the defaults so a settings file written by an older version (missing newer
 * keys) still resolves to a complete AgentSettings.
 */
export function createAgentSettings(filePath: string): AgentSettingsStore {
  async function atomicWrite(content: string): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true })
    const temporary = `${filePath}.${randomUUID()}.tmp`
    await writeFile(temporary, content)
    try {
      await rename(temporary, filePath)
    } finally {
      await rm(temporary, { force: true })
    }
  }

  // Always resolved from a fresh copy of the defaults: `configOverrides` is a
  // nested map, so returning the DEFAULT_AGENT_SETTINGS reference itself would
  // let a caller mutate every future read.
  function defaults(): AgentSettings {
    return { ...DEFAULT_AGENT_SETTINGS, configOverrides: {} }
  }

  async function read(): Promise<AgentSettings> {
    if (!existsSync(filePath)) return defaults()
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      if (!isPlainObject(parsed)) return defaults()
      const merged: AgentSettings = {
        ...DEFAULT_AGENT_SETTINGS,
        ...(parsed as object),
      }
      return {
        ...merged,
        // Copy + drop non-scalars: a hand-edited file must not leak a shared
        // reference (or an unserializable value) into callers.
        configOverrides: sanitizeConfigOverrides(merged.configOverrides),
      }
    } catch {
      // Corrupt file — fall back to defaults instead of bricking the route.
      return defaults()
    }
  }

  return {
    read,
    async update(patch) {
      const next = { ...(await read()), ...patch }
      next.configOverrides = sanitizeConfigOverrides(next.configOverrides)
      await atomicWrite(`${JSON.stringify(next, null, 2)}\n`)
      return next
    },
  }
}

/**
 * Pure merge for the overrides bag: sanitized scalars from `set` win over
 * `current`, then `remove` deletes (so a delete always beats a set in the same
 * call). Shared by the HTTP PUT /settings route and patchConfigOverrides.
 */
export function mergeConfigOverrides(
  current: ConfigOverrides,
  set: Record<string, unknown> = {},
  remove: string[] = [],
): ConfigOverrides {
  const next: ConfigOverrides = { ...current, ...sanitizeConfigOverrides(set) }
  for (const key of remove) delete next[key]
  return next
}

/**
 * Shallow-merge `set` into the stored overrides, delete `remove`, persist. This
 * is the write path behind PUT /config/section (mirroring a panel-editable
 * switch) — see mergeConfigOverrides for the merge semantics.
 */
export async function patchConfigOverrides(
  store: AgentSettingsStore,
  set: Record<string, unknown> = {},
  remove: string[] = [],
): Promise<AgentSettings> {
  const current = await store.read()
  return store.update({
    configOverrides: mergeConfigOverrides(current.configOverrides, set, remove),
  })
}

/**
 * Seed overrides for keys that have none yet (subscription import). Existing
 * values win: a re-import must never reset a switch the user set in the panel.
 */
export async function fillMissingConfigOverrides(
  store: AgentSettingsStore,
  values: Record<string, unknown>,
): Promise<AgentSettings> {
  const current = await store.read()
  const missing = sanitizeConfigOverrides(values)
  for (const key of Object.keys(missing)) {
    if (key in current.configOverrides) delete missing[key]
  }
  if (Object.keys(missing).length === 0) return current
  return store.update({
    configOverrides: { ...current.configOverrides, ...missing },
  })
}
