import type { MihomoSupervisor } from './types'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { diffDocument, openDocument } from '@metacubexd/config-editor'
import { describe, expect, it, vi } from 'vitest'
import { parse, stringify } from 'yaml'
import { createProfileConfigEditor } from './profile-editor'
import { createProfileStore } from './profiles'
import { applyActiveRefresh } from './refresh-apply'

function state() {
  return {
    status: 'running' as const,
    externalController: '127.0.0.1:9090',
    secret: '',
  }
}

function supervisor(restart = vi.fn(async () => state())): MihomoSupervisor {
  return {
    getState: state,
    start: vi.fn(async () => state()),
    stop: vi.fn(async () => state()),
    restart,
    setBinaryPath: vi.fn(),
    validate: vi.fn(async () => ({ valid: true, message: 'ok' })),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(async () => {}),
  }
}

describe('profile config editor', () => {
  it('previews and applies a local profile with one restart', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-local-'))
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath: join(home, 'active.yaml'),
      idGen: () => 'local',
    })
    await profiles.create({
      name: 'local',
      content:
        'proxies:\n  - { name: node, type: direct }\nproxy-groups:\n  - { name: group, type: select, proxies: [node] }\n',
    })
    const sup = supervisor()
    const editor = createProfileConfigEditor({
      profiles,
      supervisor: sup,
      homeDir: home,
    })
    const opened = await editor.open('local')
    const draft =
      'proxies:\n  - { name: node, type: reject }\nproxy-groups:\n  - { name: group, type: fallback, proxies: [node], url: https://example.test }\n'
    const patch = diffDocument(opened.editableYaml, draft)
    const preview = await editor.preview('local', patch)
    expect(preview.editableYaml).toContain('type: reject')
    expect(preview.editableYaml).toContain('type: fallback')

    const result = await editor.apply('local', patch)
    expect(result.activeId).toBe('local')
    expect(await profiles.read('local')).toContain('type: reject')
    expect(await profiles.read('local')).toContain('type: fallback')
    expect(sup.restart).toHaveBeenCalledTimes(1)
  })

  it('stores remote edits in one scoped managed merge and detects refresh conflicts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-remote-'))
    let remote =
      'proxies:\n  - { name: node, type: direct }\nproxy-groups:\n  - { name: group, type: select, proxies: [node] }\n'
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath: join(home, 'active.yaml'),
      fetch: (async () => new Response(remote)) as typeof fetch,
      idGen: (() => {
        let n = 0
        return () => `id${++n}`
      })(),
    })
    await profiles.importFromUrl('https://example.test/sub', 'remote')
    const sup = supervisor()
    const editor = createProfileConfigEditor({
      profiles,
      supervisor: sup,
      homeDir: home,
    })
    const opened = await editor.open('id1')
    const draft =
      'proxies:\n  - { name: node, type: reject }\nproxy-groups:\n  - { name: group, type: fallback, proxies: [node], url: https://example.test }\n'
    await editor.apply('id1', diffDocument(opened.editableYaml, draft))

    expect(await profiles.read('id1')).toBe(remote)
    const overlays = (await profiles.list()).filter(
      (meta) => meta.type === 'merge',
    )
    expect(overlays).toEqual([
      expect.objectContaining({
        baseProfileId: 'id1',
        managedBy: 'visual-editor',
      }),
    ])
    expect((await profiles.compose('id1')).content).toContain('type: reject')
    expect((await profiles.compose('id1')).content).toContain('type: fallback')
    expect(sup.restart).toHaveBeenCalledTimes(1)

    remote =
      'proxies:\n  - { name: node, type: ss, server: upstream }\nproxy-groups:\n  - { name: group, type: select, proxies: [node] }\n'
    await profiles.refresh('id1')
    const conflicted = await editor.open('id1')
    expect(conflicted.profile.editorStatus).toBe('conflicted')
    expect(conflicted.conflicts).toHaveLength(1)
    expect(conflicted.conflicts[0]?.reason).toBe('changed')
    expect(readFileSync(join(home, 'active.yaml'), 'utf8')).toContain(
      'type: reject',
    )

    await editor.resetManagedOverlay('id1')
    expect(
      (await profiles.list()).filter((meta) => meta.type === 'merge'),
    ).toEqual([])
    expect((await profiles.compose('id1')).content).toContain('type: ss')
  })

  it('upgrades legacy additions and rebases them through an active refresh', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-rebase-'))
    let remote = `proxies:
  - { name: a, type: direct }
  - { name: b, type: direct }
proxy-groups:
  - { name: group, type: select, proxies: [a, b] }
rules:
  - DOMAIN,old.test,DIRECT
  - MATCH,group
`
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath: join(home, 'active.yaml'),
      fetch: (async () => new Response(remote)) as typeof fetch,
      idGen: (() => {
        let n = 0
        return () => `id${++n}`
      })(),
    })
    await profiles.importFromUrl('https://example.test/sub', 'remote')
    const sup = supervisor()
    const editor = createProfileConfigEditor({
      profiles,
      supervisor: sup,
      homeDir: home,
    })
    const opened = await editor.open('id1')
    const draft = `proxies:
  - { name: a, type: direct }
  - { name: b, type: direct }
  - { name: custom, type: direct }
proxy-groups:
  - { name: group, type: select, proxies: [a, custom, b] }
rules:
  - DOMAIN,custom.test,REJECT
  - DOMAIN,old.test,DIRECT
  - MATCH,group
`
    await editor.apply('id1', diffDocument(opened.editableYaml, draft))

    // Simulate a patch written before three-way resource snapshots and
    // two-sided rule anchors existed. refresh() must upgrade what it can
    // before replacing the matching remote base.
    const managed = (await profiles.list()).find(
      (meta) => meta.managedBy === 'visual-editor',
    )!
    const managedPath = join(home, 'profiles', `${managed.id}.yaml`)
    const legacy = parse(readFileSync(managedPath, 'utf8')) as {
      'x-metacubexd-visual-patch': {
        operations: Array<Record<string, unknown>>
      }
    }
    for (const operation of legacy['x-metacubexd-visual-patch'].operations) {
      if (operation.op === 'upsert') delete operation.previousValue
      if (operation.op === 'sequence-insert') {
        delete operation.afterId
        delete operation.fallback
      }
    }
    writeFileSync(managedPath, stringify(legacy))

    remote = `proxies:
  - { name: b, type: direct }
  - { name: upstream, type: direct }
proxy-groups:
  - { name: group, type: select, proxies: [upstream, b], url: https://upstream.test }
rules:
  - DOMAIN,new.test,DIRECT
  - MATCH,group
`
    await profiles.refresh('id1')
    await applyActiveRefresh(profiles, sup, 'id1')

    const rebased = await editor.open('id1')
    expect(rebased.profile.editorStatus).toBe('clean')
    expect(rebased.conflicts).toEqual([])
    const composed = openDocument(
      readFileSync(join(home, 'active.yaml'), 'utf8'),
    ).data
    expect(composed.proxies).toEqual([
      { name: 'b', type: 'direct' },
      { name: 'upstream', type: 'direct' },
      { name: 'custom', type: 'direct' },
    ])
    expect(composed['proxy-groups']).toEqual([
      {
        name: 'group',
        type: 'select',
        proxies: ['upstream', 'custom', 'b'],
        url: 'https://upstream.test',
      },
    ])
    expect(composed.rules).toEqual([
      'DOMAIN,custom.test,REJECT',
      'DOMAIN,new.test,DIRECT',
      'MATCH,group',
    ])
    expect(sup.restart).toHaveBeenCalledTimes(2)
  })

  it('restores persisted and active state when the restart fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-rollback-'))
    let sequence = 0
    const activeConfigPath = join(home, 'active.yaml')
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath,
      idGen: () => `id${++sequence}`,
    })
    await profiles.create({ name: 'old', content: 'mode: rule\n' })
    await profiles.create({ name: 'draft', content: 'mode: direct\n' })
    await profiles.setActive('id1')

    const restart = vi.fn(async () => {
      throw new Error('restart failed')
    })
    const editor = createProfileConfigEditor({
      profiles,
      supervisor: supervisor(restart),
      homeDir: home,
    })
    const opened = await editor.open('id2')
    const patch = diffDocument(opened.editableYaml, 'mode: global\n')

    await expect(editor.apply('id2', patch)).rejects.toThrow('restart failed')
    expect(await profiles.read('id2')).toBe('mode: direct\n')
    expect(await profiles.getActiveId()).toBe('id1')
    expect(readFileSync(activeConfigPath, 'utf8')).toBe('mode: rule\n')
  })

  it('leaves the profile and active config untouched when validation fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-validation-'))
    const activeConfigPath = join(home, 'active.yaml')
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath,
      idGen: () => 'local',
    })
    await profiles.create({ name: 'local', content: 'mode: rule\n' })
    await profiles.setActive('local')
    const sup = supervisor()
    vi.mocked(sup.validate).mockResolvedValue({
      valid: false,
      message: 'invalid configuration',
    })
    const editor = createProfileConfigEditor({
      profiles,
      supervisor: sup,
      homeDir: home,
    })
    const opened = await editor.open('local')

    await expect(
      editor.apply(
        'local',
        diffDocument(opened.editableYaml, 'mode: global\n'),
      ),
    ).rejects.toThrow('invalid configuration')
    expect(await profiles.read('local')).toBe('mode: rule\n')
    expect(await profiles.getActiveId()).toBe('local')
    expect(readFileSync(activeConfigPath, 'utf8')).toBe('mode: rule\n')
    expect(sup.restart).not.toHaveBeenCalled()
  })

  it('restores a managed remote overlay when the restart fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcxd-editor-overlay-rollback-'))
    let sequence = 0
    const profiles = createProfileStore({
      dir: join(home, 'profiles'),
      activeConfigPath: join(home, 'active.yaml'),
      fetch: (async () =>
        new Response(
          'proxies:\n  - { name: node, type: direct }\n',
        )) as typeof fetch,
      idGen: () => `id${++sequence}`,
    })
    await profiles.importFromUrl('https://example.test/sub', 'remote')
    const firstEditor = createProfileConfigEditor({
      profiles,
      supervisor: supervisor(),
      homeDir: home,
    })
    const first = await firstEditor.open('id1')
    await firstEditor.apply(
      'id1',
      diffDocument(
        first.editableYaml,
        'proxies:\n  - { name: node, type: reject }\n',
      ),
    )
    const overlay = (await profiles.list()).find(
      (meta) => meta.managedBy === 'visual-editor',
    )!
    const originalOverlay = await profiles.read(overlay.id)

    const failingEditor = createProfileConfigEditor({
      profiles,
      supervisor: supervisor(
        vi.fn(async () => {
          throw new Error('restart failed')
        }),
      ),
      homeDir: home,
    })
    const opened = await failingEditor.open('id1')
    await expect(
      failingEditor.apply(
        'id1',
        diffDocument(
          opened.editableYaml,
          'proxies:\n  - { name: node, type: pass }\n',
        ),
      ),
    ).rejects.toThrow('restart failed')

    expect(await profiles.read(overlay.id)).toBe(originalOverlay)
    expect((await profiles.compose('id1')).content).toContain('type: reject')
    expect((await profiles.list()).find((meta) => meta.id === 'id1')).toEqual(
      expect.objectContaining({ editorStatus: 'clean' }),
    )
  })
})
