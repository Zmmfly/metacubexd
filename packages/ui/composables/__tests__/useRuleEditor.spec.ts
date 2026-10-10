import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useRuleEditor } from '../useRuleEditor'

const api = {
  listProfiles: vi.fn(),
  getProfileEditor: vi.fn(),
  applyProfileEditor: vi.fn(),
}
vi.mock('../useControlApi', () => ({ useControlApi: () => api }))

let featurePresent = true
vi.mock('../useControlInfo', () => ({
  useControlInfo: () => ({
    hasFeature: (feature: string) =>
      featurePresent && feature === 'visual-config-editor',
  }),
}))

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('vue-sonner', () => ({ toast }))

const yaml = `rules:
  - DOMAIN-SUFFIX,google.com,PROXY
  - AND,((DOMAIN,one.test),(NETWORK,UDP)),DIRECT
  - MATCH,DIRECT
`

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    profile: { id: 'active', name: 'Active', type: 'remote', active: true },
    active: true,
    revision: 'rev',
    editableYaml: yaml,
    composedYaml: yaml,
    schemaVersion: 'test',
    composition: [],
    diagnostics: [],
    conflicts: [],
    ...overrides,
  }
}

describe('useRuleEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    featurePresent = true
    api.listProfiles.mockResolvedValue([
      { id: 'active', name: 'Active', type: 'remote', active: true },
    ])
    api.getProfileEditor.mockResolvedValue(snapshot())
    api.applyProfileEditor.mockResolvedValue({ activeId: 'active' })
  })

  it('is available only with visual-config-editor', () => {
    expect(useRuleEditor().available.value).toBe(true)
    featurePresent = false
    expect(useRuleEditor().available.value).toBe(false)
  })

  it('loads raw rule strings without corrupting composite rules', async () => {
    const editor = useRuleEditor()
    await expect(editor.load()).resolves.toBe('ready')
    expect(editor.rules.value).toEqual([
      'DOMAIN-SUFFIX,google.com,PROXY',
      'AND,((DOMAIN,one.test),(NETWORK,UDP)),DIRECT',
      'MATCH,DIRECT',
    ])
  })

  it('adds, updates, removes and reorders raw lines', async () => {
    const editor = useRuleEditor()
    await editor.load()
    editor.add('DOMAIN,new.test,REJECT')
    editor.update(0, 'DOMAIN,changed.test,DIRECT')
    editor.remove(1)
    editor.move(2, 0)
    expect(editor.rules.value).toEqual([
      'DOMAIN,new.test,REJECT',
      'DOMAIN,changed.test,DIRECT',
      'MATCH,DIRECT',
    ])
  })

  it('prepends a rule at the top when an index is given', async () => {
    const editor = useRuleEditor()
    await editor.load()
    editor.add('DOMAIN,top.test,PROXY', 0)
    expect(editor.rules.value[0]).toBe('DOMAIN,top.test,PROXY')
    expect(editor.rules.value).toHaveLength(4)
  })

  it('rejects empty fields but accepts logical rules', () => {
    const editor = useRuleEditor()
    expect(editor.isValid('')).toBe(false)
    expect(editor.isValid('DOMAIN,,DIRECT')).toBe(false)
    expect(editor.isValid('DOMAIN,DIRECT')).toBe(false)
    expect(editor.isValid('MATCH,DIRECT')).toBe(true)
    expect(editor.isValid('AND,((DOMAIN,one.test),(NETWORK,UDP)),DIRECT')).toBe(
      true,
    )
  })

  it('hides diagnostics for blank lines but checks non-blank edits', async () => {
    const editor = useRuleEditor()
    await editor.load()
    // A freshly added blank row must not raise an immediate error banner,
    // even once the batched document sync has flushed it into the draft.
    editor.add('')
    editor.flushSync()
    expect(
      editor.diagnostics.value.filter(
        (item) => item.path[0] === 'rules' && item.path[1] === 3,
      ),
    ).toEqual([])
    // A partially typed (non-blank) line is flagged by the delayed sync.
    editor.update(3, 'DOMAIN-SUFFIX')
    editor.flushSync()
    expect(
      editor.diagnostics.value.some(
        (item) =>
          item.path[0] === 'rules' &&
          item.path[1] === 3 &&
          item.severity === 'error',
      ),
    ).toBe(true)
    // Deferring the check never weakens save(): the incomplete rule blocks it.
    await expect(editor.save()).resolves.toBe(false)
    expect(api.applyProfileEditor).not.toHaveBeenCalled()
  })

  it('saves a rules-only profile patch through one apply', async () => {
    const editor = useRuleEditor()
    await editor.load()
    editor.add('DOMAIN,new.test,REJECT')
    await expect(editor.save()).resolves.toBe(true)
    expect(api.applyProfileEditor).toHaveBeenCalledTimes(1)
    const [, patch] = api.applyProfileEditor.mock.calls[0]!
    expect(
      patch.operations.every(
        (operation: { target: { path: string[] } }) =>
          operation.target.path[0] === 'rules',
      ),
    ).toBe(true)
  })

  it('reports no active profile without applying an empty config', async () => {
    api.listProfiles.mockResolvedValue([])
    const editor = useRuleEditor()
    await expect(editor.load()).resolves.toBe('no-active-profile')
    expect(editor.rules.value).toEqual([])
    expect(api.applyProfileEditor).not.toHaveBeenCalled()
  })

  it('blocks a stored conflict and exposes the full editor path', async () => {
    api.getProfileEditor.mockResolvedValue(
      snapshot({ conflicts: [{ reason: 'changed' }] }),
    )
    const editor = useRuleEditor()
    await expect(editor.load()).resolves.toBe('conflict')
    expect(editor.fullEditorPath.value).toBe('/profiles/active/edit')
    await expect(editor.save()).resolves.toBe(false)
    expect(api.applyProfileEditor).not.toHaveBeenCalled()
  })
})
