import { Buffer } from 'node:buffer'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Canonical download sources for mihomo's default geo data. Centralized so the
 * exact URL per file is asserted in tests and easy to bump.
 *
 * geoip.dat / geosite.dat / country.mmdb all ship from meta-rules-dat's rolling
 * `latest` release, which is the source mihomo documents for its default geodata.
 */
export const GEO_ASSET_URLS = {
  'geoip.dat':
    'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat',
  'geosite.dat':
    'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
  'country.mmdb':
    'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/country.mmdb',
} as const

export type GeoAssetFile = keyof typeof GEO_ASSET_URLS

const GEO_FILES = Object.keys(GEO_ASSET_URLS) as GeoAssetFile[]

export interface FetchGeoAssetsDeps {
  fetch?: typeof fetch
  // Per-file idle timeout (ms): the transfer aborts when NO bytes arrive for
  // this long. A slow but progressing download resets the timer on every
  // chunk and always runs to completion — this is what makes weak networks
  // workable. Default 60s. 0/undefined disables the idle watchdog.
  idleTimeoutMs?: number
  // Injectable timer handles for tests.
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (handle: ReturnType<typeof setTimeout>) => void
}

/**
 * Read a response body to a Buffer while enforcing an idle watchdog: the
 * timer is re-armed on EVERY received chunk, so only a genuinely stalled
 * transfer (connected but silent) times out — never a slow one.
 */
async function readBodyWithIdleTimeout(
  res: Response,
  file: string,
  idleTimeoutMs: number,
  setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void,
): Promise<Buffer> {
  if (!res.body) {
    // No stream (e.g. a test double) — fall back to the buffered read.
    return Buffer.from(await res.arrayBuffer())
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onIdle: (() => void) | undefined
  const idle = new Promise<never>((_, reject) => {
    onIdle = () =>
      reject(
        new Error(
          `fetchGeoAssets: no data for ${idleTimeoutMs}ms while downloading ${file}`,
        ),
      )
  })
  const arm = () => {
    if (timer !== undefined) clearTimer(timer)
    timer = setTimer(() => onIdle?.(), idleTimeoutMs)
  }
  try {
    arm()
    const chunks: Uint8Array[] = []
    const reading = (async () => {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
        arm()
      }
    })()
    await Promise.race([reading, idle])
    return Buffer.concat(chunks)
  } finally {
    if (timer !== undefined) clearTimer(timer)
    // Abort the stream on idle timeout so the socket is released promptly.
    await res.body.cancel().catch(() => {})
  }
}

/**
 * Download mihomo's default geo data (geoip.dat, geosite.dat, country.mmdb) into
 * `destDir` (the kernel home dir). `fetch` is injectable for tests; a non-OK
 * response throws a clear error naming the file and status. Returns the list of
 * written file names.
 */
export async function fetchGeoAssets(
  destDir: string,
  deps: FetchGeoAssetsDeps = {},
): Promise<{ files: string[] }> {
  const doFetch = deps.fetch ?? fetch
  const idleTimeoutMs = deps.idleTimeoutMs ?? 60_000
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h))
  await mkdir(destDir, { recursive: true })

  const files: string[] = []
  for (const file of GEO_FILES) {
    const url = GEO_ASSET_URLS[file]
    const res = await doFetch(url)
    if (!res.ok) {
      throw new Error(
        `fetchGeoAssets: download failed ${res.status} for ${file} (${url})`,
      )
    }
    const bytes = idleTimeoutMs
      ? await readBodyWithIdleTimeout(
          res,
          file,
          idleTimeoutMs,
          setTimer,
          clearTimer,
        )
      : Buffer.from(await res.arrayBuffer())
    await writeFile(join(destDir, file), bytes)
    files.push(file)
  }
  return { files }
}
