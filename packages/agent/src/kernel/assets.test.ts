import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MIHOMO_VERSION, mihomoAsset } from './assets'

const V = MIHOMO_VERSION

describe('mIHOMO_VERSION', () => {
  it('is pinned to v1.19.34 (overridable via env)', () => {
    expect(MIHOMO_VERSION).toBe(process.env.MIHOMO_VERSION ?? 'v1.19.34')
  })

  // README Kernel versions / docs/build-docker-image.md: metadata, Docker and
  // desktop release downloads must describe the same bundled kernel default.
  it('keeps Docker, both release jobs and build documentation on the bundled pin', () => {
    const pin = 'v1.19.34'
    const dockerfile = readFileSync(
      new URL('../../../../apps/server/Dockerfile', import.meta.url),
      'utf8',
    )
    const workflow = readFileSync(
      new URL('../../../../.github/workflows/release.yml', import.meta.url),
      'utf8',
    )
    const docs = readFileSync(
      new URL('../../../../docs/build-docker-image.md', import.meta.url),
      'utf8',
    )
    expect(dockerfile).toContain(`ARG MIHOMO_VERSION=${pin}`)
    const releasePins = [
      ...workflow.matchAll(
        /MIHOMO_VERSION(?::|=)\s*(v\d+\.\d+\.\d+)/g,
      ),
    ].map((match) => match[1])
    expect(releasePins).toEqual([pin, pin])
    expect(docs).toContain(`Dockerfile 默认 \`${pin}\``)
  })
})

describe('mihomoAsset — all 6 (os,arch) combos', () => {
  it('linux/amd64 -> -compatible .gz', () => {
    const a = mihomoAsset('linux', 'amd64')
    expect(a.name).toBe(`mihomo-linux-amd64-compatible-${V}.gz`)
    expect(a.ext).toBe('gz')
    expect(a.binName).toBe('mihomo')
    expect(a.url).toBe(
      `https://github.com/MetaCubeX/mihomo/releases/download/${V}/mihomo-linux-amd64-compatible-${V}.gz`,
    )
  })

  it('linux/arm64 -> plain .gz', () => {
    const a = mihomoAsset('linux', 'arm64')
    expect(a.name).toBe(`mihomo-linux-arm64-${V}.gz`)
    expect(a.ext).toBe('gz')
    expect(a.binName).toBe('mihomo')
  })

  it('darwin/amd64 -> -compatible .gz', () => {
    const a = mihomoAsset('darwin', 'amd64')
    expect(a.name).toBe(`mihomo-darwin-amd64-compatible-${V}.gz`)
    expect(a.binName).toBe('mihomo')
  })

  it('darwin/arm64 -> plain .gz', () => {
    const a = mihomoAsset('darwin', 'arm64')
    expect(a.name).toBe(`mihomo-darwin-arm64-${V}.gz`)
  })

  it('win32/amd64 -> windows -compatible .zip, binName mihomo.exe', () => {
    const a = mihomoAsset('win32', 'amd64')
    expect(a.name).toBe(`mihomo-windows-amd64-compatible-${V}.zip`)
    expect(a.ext).toBe('zip')
    expect(a.binName).toBe('mihomo.exe')
    // the entry inside the zip is the un-versioned full name, not binName
    expect(a.zipEntry).toBe('mihomo-windows-amd64-compatible.exe')
  })

  it('windows/arm64 -> windows plain .zip', () => {
    const a = mihomoAsset('windows', 'arm64')
    expect(a.name).toBe(`mihomo-windows-arm64-${V}.zip`)
    expect(a.ext).toBe('zip')
    expect(a.binName).toBe('mihomo.exe')
    expect(a.zipEntry).toBe('mihomo-windows-arm64.exe')
  })

  it('maps node arch alias x64 -> amd64', () => {
    expect(mihomoAsset('linux', 'x64').name).toBe(
      `mihomo-linux-amd64-compatible-${V}.gz`,
    )
  })

  it('accepts an explicit version override', () => {
    const a = mihomoAsset('linux', 'arm64', 'v1.18.0')
    expect(a.name).toBe('mihomo-linux-arm64-v1.18.0.gz')
    expect(a.url).toContain('/download/v1.18.0/')
  })

  it('throws on unsupported os', () => {
    expect(() => mihomoAsset('plan9', 'amd64')).toThrow('unsupported os')
  })

  it('throws on unsupported arch', () => {
    expect(() => mihomoAsset('linux', 'mips')).toThrow('unsupported arch')
  })
})
