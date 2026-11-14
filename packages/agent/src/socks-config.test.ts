import { describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  buildSocksRuntime,
  SOCKS_LISTENER_PREFIX,
  validateSocksTarget,
} from './socks-config'

// README Authenticated SOCKS: fixed destinations must be mode-independent and
// cannot fall back to DIRECT when subscriptions, groups or providers disappear.
const backend = {
  id: 'a',
  username: 'internal-user',
  password: 'random-secret',
  port: 19001,
}
const profile = {
  mode: 'direct',
  proxies: [
    { name: 'exit', type: 'ss', server: 'example.test' },
    { name: 'chain', type: 'ss', 'dialer-proxy': 'exit' },
  ],
  'proxy-groups': [{ name: 'group', type: 'select', proxies: ['chain'] }],
  listeners: [
    {
      name: 'existing',
      type: 'http',
      port: 1,
      users: [{ username: 'keep', password: 'keep' }],
    },
  ],
  'proxy-providers': {
    provider: {
      type: 'inline',
      payload: [
        {
          name: 'node',
          type: 'ss',
          server: 'example.test',
          'dialer-proxy': 'exit',
        },
      ],
    },
  },
  rules: ['MATCH,group'],
}

describe('authenticated SOCKS runtime', () => {
  it.each(['direct', 'global', 'rule'])(
    'pins top-level nodes/groups/chains independently of %s mode and only unbound follows',
    (mode) => {
      const compiled = buildSocksRuntime(stringify({ ...profile, mode }), [
        backend,
        { ...backend, id: 'b', port: 19002, proxy: 'group' },
        { ...backend, id: 'c', port: 19003, proxy: 'chain' },
      ])
      expect(compiled.errors).toEqual({})
      const root = parse(compiled.content)
      expect(root.mode).toBe(mode)
      expect(root.listeners[0]).toEqual(profile.listeners[0])
      expect(root['proxy-groups']).toEqual(profile['proxy-groups'])
      expect(root.listeners[1]).not.toHaveProperty('proxy')
      expect(root.listeners[2]).toMatchObject({
        type: 'socks',
        listen: '127.0.0.1',
        udp: false,
        proxy: 'group',
        users: [{ username: backend.username, password: backend.password }],
      })
      expect(root.listeners[3].proxy).toBe('chain')
    },
  )

  it('generates a private exact-name RE2 provider-only select and rejects a missing provider', () => {
    const name = 'a.b[1]+(x)$^|?*{}\\`inject\n'
    const source = {
      ...profile,
      'proxy-providers': {
        provider: {
          type: 'inline',
          payload: [{ name, type: 'ss', server: 'example.test' }],
        },
      },
    }
    const result = buildSocksRuntime(stringify(source), [
      { ...backend, proxy: name, provider: 'provider' },
    ])
    const root = parse(result.content)
    const group = root['proxy-groups'][1]
    expect(group).toMatchObject({
      type: 'select',
      use: ['provider'],
      'empty-fallback': 'REJECT',
      hidden: true,
    })
    expect(group.filter.startsWith('\\A')).toBe(true)
    expect(group.filter.endsWith('\\z')).toBe(true)
    expect(group.filter).not.toContain('`')
    expect(group.filter).toContain('\\x60')
    expect(group.filter).toContain('\\x0a')
    // Translate only absolute anchors for this JS assertion; emitted syntax
    // is the RE2-compatible form consumed by Mihomo, not JavaScript regex.
    const expression = new RegExp(
      `^(?:${group.filter.slice(2, -2)})$(?![\\s\\S])`,
    )
    expect(expression.test(name)).toBe(true)
    expect(expression.test(`${name}x`)).toBe(false)
    expect(expression.test('a')).toBe(false)
    expect(expression.test('inject')).toBe(false)
    expect(root.listeners[1].proxy).toBe(group.name)
    const missing = buildSocksRuntime(stringify(profile), [
      { ...backend, proxy: name, provider: 'missing' },
    ])
    expect(parse(missing.content).listeners[1].proxy).toBe('REJECT')
    expect(missing.errors.a).toContain('Provider')
  })

  it('replaces only its namespace and strips stale private groups/listeners', () => {
    const first = buildSocksRuntime(stringify(profile), [
      { ...backend, proxy: 'node', provider: 'provider' },
    ])
    const second = buildSocksRuntime(first.content, [backend])
    const root = parse(second.content)
    expect(root.listeners).toHaveLength(2)
    expect(root['proxy-groups']).toEqual(profile['proxy-groups'])
    expect(root.listeners[1].name.startsWith(SOCKS_LISTENER_PREFIX)).toBe(true)
    const disabled = parse(buildSocksRuntime(second.content, []).content)
    expect(disabled.listeners).toEqual(profile.listeners)
    expect(disabled).not.toHaveProperty('x-metacubexd-socks-service')
  })

  it('refuses unowned reserved names and malformed ownership markers rather than deleting profile items', () => {
    for (const field of ['listeners', 'proxy-groups']) {
      const source = {
        ...profile,
        [field]: [
          { name: `${SOCKS_LISTENER_PREFIX}user-owned`, type: 'select' },
        ],
      }
      expect(() => buildSocksRuntime(stringify(source), [])).toThrow(
        'namespace conflicts',
      )
    }
    expect(() =>
      buildSocksRuntime(
        stringify({
          ...profile,
          'x-metacubexd-socks-service': {
            version: 1,
            listeners: ['existing'],
            groups: [],
          },
        }),
        [],
      ),
    ).toThrow('ownership marker')
    const generated = parse(
      buildSocksRuntime(stringify(profile), [backend]).content,
    )
    expect(generated['x-metacubexd-socks-service']).toEqual({
      version: 1,
      listeners: [generated.listeners[1].name],
      groups: [],
    })
    generated.listeners.push({
      name: `${SOCKS_LISTENER_PREFIX}not-owned`,
      type: 'http',
      port: 123,
    })
    expect(() => buildSocksRuntime(stringify(generated), [])).toThrow(
      'namespace conflicts',
    )
  })

  it('rejects opaque external providers and checks inline payload plus provider-level and override dialer closure', () => {
    const providers = [
      { type: 'http', url: 'https://example.test/proxies' },
      { type: 'file', path: './proxies.yaml' },
      { type: 'inline', payload: [{ name: 'node', type: 'direct' }] },
      {
        type: 'inline',
        payload: [{ name: 'node', type: 'ss', 'dialer-proxy': 'missing' }],
      },
      {
        type: 'inline',
        payload: [{ name: 'node', type: 'ss' }],
        'dialer-proxy': 'GLOBAL',
      },
      {
        type: 'inline',
        payload: [{ name: 'node', type: 'ss' }],
        override: { 'dialer-proxy': 'DIRECT' },
      },
      {
        type: 'inline',
        payload: [{ name: 'node', type: 'ss' }],
        override: { 'additional-prefix': 'x' },
      },
      {
        type: 'inline',
        payload: [
          { name: 'node', type: 'ss' },
          { name: 'node', type: 'ss' },
        ],
      },
    ]
    for (const provider of providers) {
      const source = stringify({ ...profile, 'proxy-providers': { provider } })
      expect(validateSocksTarget(source, 'node', 'provider')).toBeTruthy()
      const output = buildSocksRuntime(source, [
        { ...backend, proxy: 'node', provider: 'provider' },
      ])
      expect(output.errors.a).toBeTruthy()
      expect(parse(output.content).listeners[1].proxy).toBe('REJECT')
    }
    const source = stringify({
      ...profile,
      'proxy-providers': {
        provider: {
          type: 'inline',
          payload: [{ name: 'node', type: 'ss' }],
          override: { 'dialer-proxy': 'chain' },
        },
      },
    })
    expect(validateSocksTarget(source, 'node', 'provider')).toBeUndefined()
    const recursive = stringify({
      ...profile,
      'proxy-groups': [
        {
          name: 'recursive',
          type: 'select',
          use: ['provider'],
          'empty-fallback': 'REJECT',
        },
      ],
      'proxy-providers': {
        provider: {
          type: 'inline',
          payload: [{ name: 'node', type: 'ss', 'dialer-proxy': 'recursive' }],
        },
      },
    })
    expect(validateSocksTarget(recursive, 'node', 'provider')).toContain(
      'Cyclic',
    )
  })

  it.each(['DIRECT', 'GLOBAL', 'COMPATIBLE', 'PASS', 'missing'])(
    'fails closed for %s instead of changing main routing',
    (proxy) => {
      const output = buildSocksRuntime(stringify(profile), [
        { ...backend, proxy },
      ])
      const root = parse(output.content)
      expect(root.listeners[1].proxy).toBe('REJECT')
      expect(output.errors.a).toBeTruthy()
      expect(root.rules).toEqual(profile.rules)
    },
  )

  it('recursively rejects unsafe candidates, dialers, cycles and dynamic empty defaults', () => {
    const cases = [
      { proxies: [{ name: 'bad', type: 'ss', 'dialer-proxy': 'DIRECT' }] },
      { proxies: [{ name: 'bad', type: 'direct' }] },
      { proxies: [{ name: 'bad', type: 'ss', 'dialer-proxy': 'gone' }] },
      { proxies: [{ name: 'bad', type: 'ss', 'dialer-proxy': 'bad' }] },
      {
        'proxy-groups': [
          { name: 'bad', type: 'select', proxies: ['exit', 'DIRECT'] },
        ],
      },
      { 'proxy-groups': [{ name: 'bad', type: 'select', use: ['provider'] }] },
      {
        proxies: [],
        'proxy-groups': [{ name: 'bad', type: 'select', 'include-all': true }],
      },
      {
        proxies: [{ name: 'directNode', type: 'direct' }],
        'proxy-groups': [
          {
            name: 'bad',
            type: 'select',
            'include-all-proxies': true,
            'empty-fallback': 'REJECT',
          },
        ],
      },
      {
        proxies: [
          { name: 'unsafeDialer', type: 'ss', 'dialer-proxy': 'GLOBAL' },
        ],
        'proxy-groups': [
          {
            name: 'bad',
            type: 'select',
            'include-all-proxies': true,
            'empty-fallback': 'REJECT',
          },
        ],
      },
      {
        'proxy-groups': [
          {
            name: 'bad',
            type: 'select',
            proxies: ['exit'],
            filter: 'not-matching',
          },
        ],
      },
      { 'proxy-groups': [{ name: 'bad', type: 'select', proxies: ['bad'] }] },
      {
        'proxy-groups': [
          {
            name: 'bad',
            type: 'select',
            use: ['missing'],
            'empty-fallback': 'REJECT',
          },
        ],
      },
    ]
    for (const patch of cases) {
      const content = stringify({ ...profile, ...patch })
      expect(validateSocksTarget(content, 'bad')).toBeTruthy()
      const compiled = buildSocksRuntime(content, [
        { ...backend, proxy: 'bad' },
      ])
      expect(parse(compiled.content).listeners[1].proxy).toBe('REJECT')
    }
    const dynamic = stringify({
      ...profile,
      'proxy-groups': [
        {
          name: 'safe',
          type: 'select',
          use: ['provider'],
          'empty-fallback': 'REJECT',
        },
      ],
    })
    expect(validateSocksTarget(dynamic, 'safe')).toBeUndefined()
    expect(validateSocksTarget(stringify(profile), 'group')).toBeUndefined()
    expect(validateSocksTarget(stringify(profile), 'REJECT')).toBeUndefined()
  })

  it('never coerces malformed fixed binding into follow and rejects invalid runtime inputs', () => {
    for (const proxy of [null, false, 1, '']) {
      const result = buildSocksRuntime(stringify(profile), [
        { ...backend, proxy } as never,
      ])
      expect(parse(result.content).listeners[1].proxy).toBe('REJECT')
    }
    expect(() => buildSocksRuntime('[]', [])).toThrow()
    expect(() => buildSocksRuntime('listeners: {}', [])).toThrow()
    expect(() =>
      buildSocksRuntime('{}', [{ ...backend, password: '' }]),
    ).toThrow()
    expect(() => buildSocksRuntime('{}', [backend, backend])).toThrow()
  })
})
