import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createAgentSettings,
  DEFAULT_AGENT_SETTINGS,
  fillMissingConfigOverrides,
  mergeConfigOverrides,
  patchConfigOverrides,
  pickConfigOverrides,
} from './settings'

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'mcxd-settings-')), 'settings.json')
}

const DEFAULTS = { geoIdleTimeoutMs: 60_000, configOverrides: {} }

describe('createAgentSettings — read/update', () => {
  it('resolves the defaults when the file does not exist yet', async () => {
    const store = createAgentSettings(tmpFile())
    expect(await store.read()).toEqual(DEFAULTS)
  })

  it('persists a patch and re-reads it through a new store instance', async () => {
    const file = tmpFile()
    const store = createAgentSettings(file)
    await store.update({
      geoIdleTimeoutMs: 5_000,
      configOverrides: { 'allow-lan': true },
    })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      geoIdleTimeoutMs: 5_000,
      configOverrides: { 'allow-lan': true },
    })
    expect(await createAgentSettings(file).read()).toEqual({
      geoIdleTimeoutMs: 5_000,
      configOverrides: { 'allow-lan': true },
    })
  })

  it('update shallow-merges the top-level patch (untouched keys survive)', async () => {
    const store = createAgentSettings(tmpFile())
    await store.update({ configOverrides: { 'allow-lan': true } })
    const next = await store.update({ geoIdleTimeoutMs: 2_000 })
    expect(next).toEqual({
      geoIdleTimeoutMs: 2_000,
      configOverrides: { 'allow-lan': true },
    })
    expect(await store.read()).toEqual(next)
  })

  it('falls back to the defaults on a corrupt settings file (and repairs it)', async () => {
    const file = tmpFile()
    writeFileSync(file, '{ not json')
    const store = createAgentSettings(file)
    expect(await store.read()).toEqual(DEFAULTS)
    await store.update({ geoIdleTimeoutMs: 2_000 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      geoIdleTimeoutMs: 2_000,
      configOverrides: {},
    })
  })

  it('treats a non-object settings file as defaults', async () => {
    const file = tmpFile()
    writeFileSync(file, '["nope"]')
    expect(await createAgentSettings(file).read()).toEqual(DEFAULTS)
  })

  it('drops non-scalar overrides read from a hand-edited file', async () => {
    const file = tmpFile()
    writeFileSync(
      file,
      JSON.stringify({
        geoIdleTimeoutMs: 60_000,
        configOverrides: {
          'allow-lan': true,
          mode: 'rule',
          dns: { nameserver: ['1.1.1.1'] },
          tun: null,
          '': 'empty key',
        },
      }),
    )
    expect((await createAgentSettings(file).read()).configOverrides).toEqual({
      'allow-lan': true,
      mode: 'rule',
    })
  })

  it('returns a fresh overrides map (mutating a result cannot corrupt the defaults)', async () => {
    const store = createAgentSettings(tmpFile())
    const first = await store.read()
    first.configOverrides['allow-lan'] = true
    expect(await store.read()).toEqual(DEFAULTS)
    expect(DEFAULT_AGENT_SETTINGS.configOverrides).toEqual({})
  })
})

describe('config override helpers', () => {
  it('mergeConfigOverrides shallow-merges and lets a removal win', () => {
    expect(
      mergeConfigOverrides(
        { 'allow-lan': true, mode: 'rule' },
        { mode: 'global', ipv6: false },
        ['allow-lan'],
      ),
    ).toEqual({ mode: 'global', ipv6: false })
  })

  it('mergeConfigOverrides ignores non-scalars and empty keys', () => {
    expect(
      mergeConfigOverrides(
        { mode: 'rule' },
        { dns: { a: 1 }, '': true, 'allow-lan': [true], ipv6: false },
      ),
    ).toEqual({ mode: 'rule', ipv6: false })
  })

  it('patchConfigOverrides merges into the stored bag without dropping siblings', async () => {
    const store = createAgentSettings(tmpFile())
    await patchConfigOverrides(store, { 'allow-lan': true })
    const next = await patchConfigOverrides(store, { mode: 'rule' })
    expect(next.configOverrides).toEqual({ 'allow-lan': true, mode: 'rule' })
    expect((await store.read()).configOverrides).toEqual({
      'allow-lan': true,
      mode: 'rule',
    })
  })

  it('patchConfigOverrides deletes a key when told to', async () => {
    const store = createAgentSettings(tmpFile())
    await patchConfigOverrides(store, { 'allow-lan': true, mode: 'rule' })
    const next = await patchConfigOverrides(store, {}, ['allow-lan'])
    expect(next.configOverrides).toEqual({ mode: 'rule' })
  })

  it('fillMissingConfigOverrides only writes keys that have no override yet', async () => {
    const store = createAgentSettings(tmpFile())
    await patchConfigOverrides(store, { 'allow-lan': false })
    await fillMissingConfigOverrides(store, {
      'allow-lan': true,
      mode: 'rule',
      dns: { a: 1 },
    })
    expect((await store.read()).configOverrides).toEqual({
      'allow-lan': false,
      mode: 'rule',
    })
  })

  it('fillMissingConfigOverrides is a no-op when every key is already set', async () => {
    const store = createAgentSettings(tmpFile())
    await patchConfigOverrides(store, { mode: 'rule' })
    const before = JSON.stringify(await store.read())
    await fillMissingConfigOverrides(store, { mode: 'global' })
    expect(JSON.stringify(await store.read())).toBe(before)
  })

  it('pickConfigOverrides extracts the whitelisted top-level scalars only', () => {
    const content = [
      'allow-lan: true',
      'mode: rule',
      'log-level: warning',
      'unified-delay: true',
      'interface-name: eth0',
      'ipv6: false',
      'geodata-mode: true',
      'tcp-concurrent: true',
      // Noise: not whitelisted / nested / non-scalar.
      'port: 7890',
      'secret: abc',
      'sniffer:',
      '  mode: rules',
      'dns:',
      '  enable: true',
      'proxies: []',
      '',
    ].join('\n')
    expect(pickConfigOverrides(content)).toEqual({
      'allow-lan': true,
      mode: 'rule',
      'log-level': 'warning',
      'unified-delay': true,
      'interface-name': 'eth0',
      ipv6: false,
      'geodata-mode': true,
      'tcp-concurrent': true,
    })
  })

  it('pickConfigOverrides returns {} for missing keys, non-mappings and broken YAML', () => {
    expect(pickConfigOverrides('proxies: []\n')).toEqual({})
    expect(pickConfigOverrides('- a\n- b\n')).toEqual({})
    expect(pickConfigOverrides('allow-lan: [\n')).toEqual({})
  })

  it('pickConfigOverrides requires a scalar (a whitelisted key holding a mapping is skipped)', () => {
    expect(pickConfigOverrides('mode:\n  nested: 1\n')).toEqual({})
  })
})
