import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchGeoAssets, GEO_ASSET_URLS } from './geo'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'mcxd-geo-'))
}

describe('fetchGeoAssets', () => {
  afterEach(() => vi.restoreAllMocks())

  it('downloads geoip.dat, geosite.dat and country.mmdb into destDir', async () => {
    const dest = tmp()
    const requested: string[] = []
    const fakeFetch = vi.fn(async (url: string) => {
      requested.push(url)
      return new Response(Buffer.from(`bytes-for:${url}`), { status: 200 })
    })

    const { files } = await fetchGeoAssets(dest, {
      fetch: fakeFetch as unknown as typeof fetch,
    })

    // Returns the three written file names.
    expect(files).toEqual(['geoip.dat', 'geosite.dat', 'country.mmdb'])

    // Hits exactly the canonical URL for each file.
    expect(requested).toEqual([
      GEO_ASSET_URLS['geoip.dat'],
      GEO_ASSET_URLS['geosite.dat'],
      GEO_ASSET_URLS['country.mmdb'],
    ])

    // Writes the fetched bytes into destDir under the correct names.
    for (const file of files) {
      expect(readFileSync(join(dest, file)).toString()).toBe(
        `bytes-for:${GEO_ASSET_URLS[file as keyof typeof GEO_ASSET_URLS]}`,
      )
    }
  })

  it('throws a clear error naming the file + status on a failing fetch', async () => {
    const dest = tmp()
    const fakeFetch = vi.fn(async (url: string) => {
      if (url === GEO_ASSET_URLS['geosite.dat']) {
        return new Response('not found', { status: 404 })
      }
      return new Response(Buffer.from('ok'), { status: 200 })
    })

    const error = await fetchGeoAssets(dest, {
      fetch: fakeFetch as unknown as typeof fetch,
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('geosite.dat')
    expect((error as Error).message).toContain('404')
  })

  it('centralizes the canonical URLs in GEO_ASSET_URLS', () => {
    expect(GEO_ASSET_URLS['geoip.dat']).toBe(
      'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geoip.dat',
    )
    expect(GEO_ASSET_URLS['geosite.dat']).toBe(
      'https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat',
    )
    expect(GEO_ASSET_URLS['country.mmdb'].endsWith('/country.mmdb')).toBe(true)
  })

  it('idle watchdog: a slow-but-progressing download runs to completion', async () => {
    const dest = tmp()
    // 4 chunks 100ms apart (< 150ms budget) => total ~300ms > budget: proves the
    // timer re-arms per chunk instead of bounding the whole transfer.
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              const chunks = [
                new Uint8Array([1]),
                new Uint8Array([2]),
                new Uint8Array([3]),
                new Uint8Array([4]),
              ]
              for (const chunk of chunks) {
                await new Promise((resolve) => setTimeout(resolve, 100))
                controller.enqueue(chunk)
              }
              controller.close()
            },
          }),
          { status: 200 },
        ),
    )
    const { files } = await fetchGeoAssets(dest, {
      fetch: fakeFetch as unknown as typeof fetch,
      idleTimeoutMs: 150,
    })
    expect(files).toHaveLength(3)
    expect(readFileSync(join(dest, 'geoip.dat'))).toHaveLength(4)
  }, 10_000)

  it('idle watchdog: a stalled transfer aborts with a clear error', async () => {
    const dest = tmp()
    // One chunk immediately, then silence — the 100ms idle budget must fire.
    const fakeFetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            async pull(controller) {
              controller.enqueue(new Uint8Array([1]))
              await new Promise((resolve) => setTimeout(resolve, 5_000))
              controller.enqueue(new Uint8Array([2]))
              controller.close()
            },
          }),
          { status: 200 },
        ),
    )
    const error = await fetchGeoAssets(dest, {
      fetch: fakeFetch as unknown as typeof fetch,
      idleTimeoutMs: 100,
    }).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('no data for 100ms')
    expect((error as Error).message).toContain('geoip.dat')
  }, 10_000)
})
