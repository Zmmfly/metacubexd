import { describe, expect, it } from 'vitest'
import { dialerProxyOptions, routingResourceFields } from '../routingResources'

describe('routing resource chain proxies', () => {
  // README Profiles & Config Editor: expose dialer-proxy in the node editor.
  it('includes dialer-proxy in standard node fields', () => {
    expect(routingResourceFields('proxy', 'ss')).toContain('dialer-proxy')
    expect(routingResourceFields('group', 'select')).not.toContain(
      'dialer-proxy',
    )
  })

  it('offers nodes and groups while disabling direct and indirect cycles', () => {
    const draft = { name: 'entry', type: 'direct' }
    const proxies = [
      draft,
      { name: 'exit', type: 'direct', 'dialer-proxy': 'landing' },
      { name: 'landing', type: 'direct' },
    ]
    const groups = [
      { name: 'safe-group', type: 'select', proxies: ['exit'] },
      { name: 'cyclic-group', type: 'select', proxies: ['entry'] },
    ]
    const options = dialerProxyOptions(draft, 0, proxies, groups)

    expect(options).toEqual([
      { name: 'entry', kind: 'proxy', cycle: true },
      { name: 'exit', kind: 'proxy', cycle: false },
      { name: 'landing', kind: 'proxy', cycle: false },
      { name: 'safe-group', kind: 'group', cycle: false },
      { name: 'cyclic-group', kind: 'group', cycle: true },
    ])
    expect(draft).toEqual({ name: 'entry', type: 'direct' })
  })

  it('checks a new node against the existing chain without changing its draft', () => {
    const draft = { name: 'new-entry', type: 'direct' }
    const proxies = [
      { name: 'exit', type: 'direct', 'dialer-proxy': 'new-entry' },
    ]
    const options = dialerProxyOptions(draft, null, proxies, [])
    expect(options).toEqual([{ name: 'exit', kind: 'proxy', cycle: true }])
    expect(draft).not.toHaveProperty('dialer-proxy')
  })
})
