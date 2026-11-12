import { describe, expect, it } from 'vitest'
import {
  applyPatch,
  ConfigDocumentError,
  diffDocument,
  findResourceReferences,
  openDocument,
  splitRuleFields,
  validateDocument,
} from './index'

describe('config editor document', () => {
  it('rejects invalid YAML and non-mapping roots', () => {
    expect(() => openDocument('dns: [')).toThrow(ConfigDocumentError)
    expect(() => openDocument('- one\n- two\n')).toThrow(ConfigDocumentError)
  })

  it('preserves untouched section comments while replacing touched sections', () => {
    const base = `# header\nmode: rule # keep\ndns:\n  enable: true\n`
    const draft = `mode: rule\ndns:\n  enable: false\n  nameserver: [1.1.1.1]\n`
    const result = applyPatch(base, diffDocument(base, draft))
    expect(result.conflicts).toEqual([])
    expect(result.document.yaml).toContain('# header')
    expect(result.document.yaml).toContain('mode: rule # keep')
    expect(result.document.data.dns).toEqual({
      enable: false,
      nameserver: ['1.1.1.1'],
    })
  })

  it('upserts, deletes, and reorders named resources', () => {
    const base = `proxies:\n  - { name: a, type: ss, server: old }\n  - { name: b, type: direct }\n`
    const draft = `proxies:\n  - { name: c, type: direct }\n  - { name: a, type: ss, server: new }\n`
    const patch = diffDocument(base, draft)
    expect(patch.operations.map((op) => op.op)).toEqual([
      'upsert',
      'delete',
      'upsert',
      'order',
    ])
    const result = applyPatch(base, patch)
    expect(result.conflicts).toEqual([])
    expect(result.document.data.proxies).toEqual([
      { name: 'c', type: 'direct' },
      { name: 'a', type: 'ss', server: 'new' },
    ])
  })

  it('rebases an independent change and reports an overlapping change', () => {
    const base = `proxies:\n  - { name: a, type: ss, server: one }\n  - { name: b, type: direct }\n`
    const draft = `proxies:\n  - { name: a, type: ss, server: two }\n  - { name: b, type: direct }\n`
    const patch = diffDocument(base, draft)
    const independent = applyPatch(`${base}dns:\n  enable: true\n`, patch)
    expect(independent.conflicts).toEqual([])

    const changed = applyPatch(
      `proxies:\n  - { name: a, type: ss, server: upstream }\n  - { name: b, type: direct }\n`,
      patch,
    )
    expect(changed.conflicts).toHaveLength(1)
    expect(changed.conflicts[0]?.reason).toBe('changed')
  })

  it('rebases a pure named addition when upstream removes or reorders entries', () => {
    const base = `proxies:\n  - { name: a, type: direct }\n  - { name: b, type: direct }\n`
    const draft = `${base}  - { name: custom, type: direct }\n`
    const patch = diffDocument(base, draft)
    expect(patch.operations.map((op) => op.op)).toEqual(['upsert', 'order'])

    const result = applyPatch(
      `proxies:\n  - { name: b, type: direct }\n  - { name: upstream, type: direct }\n`,
      patch,
    )
    expect(result.conflicts).toEqual([])
    expect(result.document.data.proxies).toEqual([
      { name: 'b', type: 'direct' },
      { name: 'upstream', type: 'direct' },
      { name: 'custom', type: 'direct' },
    ])
  })

  it('merges non-overlapping group edits and membership updates upstream', () => {
    const base = `proxy-groups:\n  - { name: group, type: select, proxies: [a, b] }\n`
    const draft = `proxy-groups:\n  - { name: group, type: select, proxies: [a, custom, b], url: https://local.test }\n`
    const refreshed = `proxy-groups:\n  - { name: group, type: select, proxies: [upstream, a, b], use: [provider], interval: 30 }\n`
    const result = applyPatch(refreshed, diffDocument(base, draft))

    expect(result.conflicts).toEqual([])
    expect(result.document.data['proxy-groups']).toEqual([
      {
        name: 'group',
        type: 'select',
        proxies: ['upstream', 'a', 'custom', 'b'],
        use: ['provider'],
        interval: 30,
        url: 'https://local.test',
      },
    ])
  })

  it('still reports overlapping named scalar edits after a refresh', () => {
    const base = `proxy-groups:\n  - { name: group, type: select }\n`
    const local = `proxy-groups:\n  - { name: group, type: fallback }\n`
    const upstream = `proxy-groups:\n  - { name: group, type: url-test }\n`
    const result = applyPatch(upstream, diffDocument(base, local))

    expect(result.conflicts).toEqual([
      expect.objectContaining({ reason: 'changed' }),
    ])
  })

  it('keeps leading rule additions ordered when their original anchor disappears', () => {
    const base = `rules:\n  - DOMAIN,old.test,DIRECT\n  - MATCH,DIRECT\n`
    const draft = `rules:\n  - DOMAIN,one.test,REJECT\n  - DOMAIN,two.test,REJECT\n  - DOMAIN,old.test,DIRECT\n  - MATCH,DIRECT\n`
    const patch = diffDocument(base, draft)
    const refreshed = `rules:\n  - DOMAIN,new.test,DIRECT\n  - MATCH,DIRECT\n`
    const result = applyPatch(refreshed, patch)

    expect(result.conflicts).toEqual([])
    expect(result.document.data.rules).toEqual([
      'DOMAIN,one.test,REJECT',
      'DOMAIN,two.test,REJECT',
      'DOMAIN,new.test,DIRECT',
      'MATCH,DIRECT',
    ])
    expect(applyPatch(result.document, patch).conflicts).toEqual([])
  })

  it('uses either neighboring anchor for an inserted rule', () => {
    const base = `rules:\n  - DOMAIN,a.test,DIRECT\n  - DOMAIN,b.test,DIRECT\n`
    const draft = `rules:\n  - DOMAIN,a.test,DIRECT\n  - DOMAIN,custom.test,REJECT\n  - DOMAIN,b.test,DIRECT\n`
    const patch = diffDocument(base, draft)
    const oneAnchor = applyPatch(
      `rules:\n  - DOMAIN,a.test,DIRECT\n  - DOMAIN,new.test,DIRECT\n`,
      patch,
    )
    expect(oneAnchor.conflicts).toEqual([])
    expect(oneAnchor.document.data.rules).toEqual([
      'DOMAIN,a.test,DIRECT',
      'DOMAIN,custom.test,REJECT',
      'DOMAIN,new.test,DIRECT',
    ])

    const noAnchors = applyPatch(`rules:\n  - DOMAIN,new.test,DIRECT\n`, patch)
    expect(noAnchors.conflicts).toEqual([
      expect.objectContaining({ reason: 'missing' }),
    ])
  })

  it('keeps a legacy anchored rule addition when its anchor disappears', () => {
    const base = `rules:\n  - DOMAIN,old.test,DIRECT\n`
    const draft = `rules:\n  - DOMAIN,custom.test,REJECT\n  - DOMAIN,old.test,DIRECT\n`
    const patch = diffDocument(base, draft)
    const insert = patch.operations[0]
    expect(insert?.op).toBe('sequence-insert')
    if (insert?.op === 'sequence-insert') {
      delete insert.afterId
      delete insert.fallback
    }

    const result = applyPatch(`rules:\n  - DOMAIN,new.test,DIRECT\n`, patch)
    expect(result.conflicts).toEqual([])
    expect(result.document.data.rules).toEqual([
      'DOMAIN,custom.test,REJECT',
      'DOMAIN,new.test,DIRECT',
    ])
  })

  it('validates duplicate resources and broken references', () => {
    const diagnostics = validateDocument({
      proxies: [
        { name: 'same', type: 'direct' },
        { name: 'same', type: 'direct' },
      ],
      'proxy-groups': [{ name: 'group', type: 'select', proxies: ['missing'] }],
      rules: ['MATCH,missing'],
    })
    expect(diagnostics.map((item) => item.code)).toEqual([
      'duplicate-name',
      'missing-reference',
      'missing-reference',
    ])
  })

  it('addresses rules by content identity instead of array index', () => {
    const base = `rules:\n  - DOMAIN,one.test,DIRECT\n  - MATCH,DIRECT\n`
    const draft = `rules:\n  - DOMAIN,one.test,REJECT\n  - MATCH,DIRECT\n`
    const patch = diffDocument(base, draft)
    expect(patch.operations[0]?.op).toBe('sequence-replace')

    const refreshed = `rules:\n  - DOMAIN,new.test,DIRECT\n  - DOMAIN,one.test,DIRECT\n  - MATCH,DIRECT\n`
    const result = applyPatch(refreshed, patch)
    expect(result.conflicts).toEqual([])
    expect(result.document.data.rules).toEqual([
      'DOMAIN,new.test,DIRECT',
      'DOMAIN,one.test,REJECT',
      'MATCH,DIRECT',
    ])
  })

  it('reports a conflict when a reorder anchor disappeared upstream', () => {
    const base = `proxies:\n  - { name: a, type: direct }\n  - { name: b, type: direct }\n`
    const draft = `proxies:\n  - { name: b, type: direct }\n  - { name: a, type: direct }\n`
    const patch = diffDocument(base, draft)
    const result = applyPatch(
      `proxies:\n  - { name: b, type: direct }\n`,
      patch,
    )
    expect(result.conflicts).toEqual([
      expect.objectContaining({ reason: 'missing' }),
    ])
  })

  it('splits logical and quoted rules only at top-level commas', () => {
    expect(
      splitRuleFields(
        'AND,((DOMAIN,one.test),(NETWORK,UDP)),Proxy Group,no-resolve',
      ),
    ).toEqual([
      'AND',
      '((DOMAIN,one.test),(NETWORK,UDP))',
      'Proxy Group',
      'no-resolve',
    ])
    expect(splitRuleFields('DOMAIN,"one,two.test",DIRECT')).toEqual([
      'DOMAIN',
      '"one,two.test"',
      'DIRECT',
    ])
  })

  it('finds named proxy references across routing and network sections', () => {
    const data = openDocument(`
proxies:
  - { name: chained, type: direct, dialer-proxy: target }
proxy-groups:
  - { name: group, type: select, proxies: [target] }
proxy-providers:
  remote: { type: http, url: https://example.test, proxy: target }
rule-providers:
  rules: { type: http, url: https://example.test, proxy: target }
listeners:
  - { name: inbound, type: mixed, port: 7890, proxy: target }
tunnels:
  - { network: tcp, address: 127.0.0.1:1, target: example.test:2, proxy: target }
ntp: { enable: true, dialer-proxy: target }
sub-rules:
  child:
    - MATCH,target
rules:
  - AND,((DOMAIN,one.test),(NETWORK,UDP)),target
  - SUB-RULE,(NETWORK,TCP),target
`).data
    expect(
      findResourceReferences(data, 'target').map((item) => item.kind),
    ).toEqual([
      'proxy-group-member',
      'rule-policy',
      'rule-policy',
      'dialer-proxy',
      'dialer-proxy',
      'provider-proxy',
      'provider-proxy',
      'listener-proxy',
      'tunnel-proxy',
    ])
  })

  it('does not treat unrelated same-name strings as proxy references', () => {
    const data = openDocument(`
proxies:
  - { name: target, type: direct, server: target }
hosts: { target: 127.0.0.1 }
rules:
  - DOMAIN,target,DIRECT
`).data
    expect(findResourceReferences(data, 'target')).toEqual([])
  })

  it('validates missing references in sub-rules and dialer fields', () => {
    const diagnostics = validateDocument({
      proxies: [{ name: 'node', type: 'direct', 'dialer-proxy': 'missing' }],
      'sub-rules': { child: ['MATCH,missing'] },
      rules: ['SUB-RULE,(NETWORK,TCP),absent', 'MATCH,GLOBAL'],
    })
    expect(diagnostics).toEqual([
      expect.objectContaining({
        path: ['sub-rules', 'child', 0],
        severity: 'warning',
      }),
      expect.objectContaining({
        path: ['proxies', 0, 'dialer-proxy'],
        severity: 'error',
      }),
      expect.objectContaining({
        path: ['rules', 0],
        message: 'Unknown sub-rule: absent',
        severity: 'error',
      }),
    ])
  })
})
