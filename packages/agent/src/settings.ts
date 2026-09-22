import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
}

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  geoIdleTimeoutMs: 60_000,
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

  async function read(): Promise<AgentSettings> {
    if (!existsSync(filePath)) return { ...DEFAULT_AGENT_SETTINGS }
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object') {
        return { ...DEFAULT_AGENT_SETTINGS }
      }
      return { ...DEFAULT_AGENT_SETTINGS, ...(parsed as object) }
    } catch {
      // Corrupt file — fall back to defaults instead of bricking the route.
      return { ...DEFAULT_AGENT_SETTINGS }
    }
  }

  return {
    read,
    async update(patch) {
      const next = { ...(await read()), ...patch }
      await atomicWrite(`${JSON.stringify(next, null, 2)}\n`)
      return next
    },
  }
}
