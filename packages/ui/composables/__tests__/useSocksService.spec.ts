// README Authenticated SOCKS: exercise the dashboard path without storing credentials.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { socksTargetValue, useSocksService } from '../useSocksService'

const api = { getSocks: vi.fn(), getSocksTargets: vi.fn(), setSocks: vi.fn() }
let feature = true
vi.mock('../useControlApi', () => ({ useControlApi: () => api }))
vi.mock('../useControlInfo', () => ({
  useControlInfo: () => ({
    hasFeature: (name: string) => feature && name === 'socks-service',
  }),
}))
const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock('vue-sonner', () => ({ toast }))
const snapshot = () => ({
  enabled: false,
  listen: '127.0.0.1',
  port: 10808,
  status: 'disabled',
  users: [
    {
      id: 'old',
      username: 'alice',
      enabled: true,
      hasPassword: true,
      proxy: 'missing',
      provider: 'subscription',
    },
  ],
})

describe('rEADME Authenticated SOCKS dashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    feature = true
    api.getSocks.mockResolvedValue(snapshot())
    api.getSocksTargets.mockResolvedValue({
      targets: [
        { name: 'node', type: 'ss', provider: 'one' },
        { name: 'node', type: 'ss', provider: 'two' },
        {
          name: 'unsafe',
          type: 'group',
          unavailable: 'empty-fallback required',
        },
      ],
    })
    api.setSocks.mockResolvedValue(snapshot())
  })
  it('gates load and save on capability and starts with safe defaults', async () => {
    feature = false
    const s = useSocksService()
    expect(s.available.value).toBe(false)
    expect(s.enabled.value).toBe(false)
    expect(s.listen.value).toBe('127.0.0.1')
    expect(s.port.value).toBe(10808)
    await s.load()
    await s.save()
    expect(api.getSocks).not.toHaveBeenCalled()
    expect(api.setSocks).not.toHaveBeenCalled()
  })
  it('keeps a missing binding and omits an unchanged password and response metadata', async () => {
    const s = useSocksService()
    await s.load()
    expect(s.targetProblem(s.users.value[0]!)).toBe('socksMissingTarget')
    await s.save()
    expect(api.setSocks).toHaveBeenCalledWith({
      enabled: false,
      listen: '127.0.0.1',
      port: 10808,
      users: [
        {
          id: 'old',
          username: 'alice',
          enabled: true,
          proxy: 'missing',
          provider: 'subscription',
        },
      ],
    })
    expect(s.users.value[0]!.password).toBe('')
    expect(localStorage.length).toBe(0)
    expect(sessionStorage.length).toBe(0)
  })
  it('adds, edits, disables and deletes users; new users require passwords', async () => {
    const s = useSocksService()
    await s.load()
    s.addUser()
    s.users.value[1]!.username = 'bob'
    expect(await s.save()).toBe(false)
    expect(api.setSocks).not.toHaveBeenCalled()
    s.users.value[1]!.password = 'test-only-placeholder'
    s.users.value[1]!.enabled = false
    s.removeUser(0)
    await s.save()
    expect(api.setSocks.mock.calls[0]![0].users).toEqual([
      { username: 'bob', enabled: false, password: 'test-only-placeholder' },
    ])
    expect(s.users.value.every((u) => u.password === '')).toBe(true)
  })
  it('selects provider-specific exits, refuses unsafe targets and explicitly follows the main route', async () => {
    const s = useSocksService()
    await s.load()
    const u = s.users.value[0]!
    s.setTarget(u, socksTargetValue('node', 'two'))
    expect(u.provider).toBe('two')
    s.setTarget(u, socksTargetValue('unsafe'))
    expect(u.proxy).toBe('node')
    s.setTarget(u, '')
    expect(u.proxy).toBeUndefined()
    expect(u.provider).toBeUndefined()
  })
  it('shows unavailable existing targets without changing the binding', async () => {
    const state = snapshot()
    state.users[0]!.proxy = 'unsafe'
    state.users[0]!.provider = ''
    api.getSocks.mockResolvedValue(state)
    const s = useSocksService()
    await s.load()
    expect(s.targetProblem(s.users.value[0]!)).toBe('empty-fallback required')
    expect(s.users.value[0]!.proxy).toBe('unsafe')
  })
  it('uses persisted error snapshots, clears submitted passwords and toasts error, not success', async () => {
    api.setSocks.mockResolvedValue({
      ...snapshot(),
      enabled: true,
      status: 'error',
      error: 'apply failed',
      users: [{ ...snapshot().users[0], error: 'missing target' }],
    })
    const s = useSocksService()
    await s.load()
    s.users.value[0]!.password = 'test-only-placeholder'
    expect(await s.save()).toBe(false)
    expect(s.enabled.value).toBe(true)
    expect(s.status.value).toBe('error')
    expect(s.error.value).toBe('apply failed')
    expect(s.users.value[0]!.error).toBe('missing target')
    expect(s.users.value[0]!.password).toBe('')
    expect(toast.error).toHaveBeenCalledWith('socksApplyFailed')
    expect(toast.success).not.toHaveBeenCalled()
  })
  it('never echoes transport errors or retains passwords after failed save', async () => {
    const s = useSocksService()
    await s.load()
    s.users.value[0]!.password = 'test-only-placeholder'
    api.setSocks.mockRejectedValue(new Error('test-only-placeholder'))
    await s.save()
    expect(s.users.value[0]!.password).toBe('')
    expect(toast.error).toHaveBeenCalledWith('socksSaveFailed')
    expect(s.busy.value).toBe(false)
    api.getSocks.mockRejectedValue(new Error('private detail'))
    await s.load()
    expect(toast.error).toHaveBeenLastCalledWith('socksLoadFailed')
    expect(s.busy.value).toBe(false)
  })
  it('serializes busy actions and prevents CRUD while a request is pending', async () => {
    let resolve!: (value: unknown) => void
    api.getSocks.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    const s = useSocksService()
    const pending = s.load()
    expect(s.busy.value).toBe(true)
    s.addUser()
    s.removeUser(0)
    await s.load()
    await s.save()
    expect(s.users.value).toEqual([])
    expect(api.getSocks).toHaveBeenCalledTimes(1)
    expect(api.setSocks).not.toHaveBeenCalled()
    resolve(snapshot())
    await pending
    expect(s.busy.value).toBe(false)
  })
  it('validates ports and strips unexpected secret fields from snapshots', async () => {
    api.getSocks.mockResolvedValue({
      ...snapshot(),
      users: [
        {
          ...snapshot().users[0],
          password: 'must-not-copy',
          hash: 'must-not-copy',
        },
      ],
    })
    const s = useSocksService()
    await s.load()
    expect(s.users.value[0]!.password).toBe('')
    expect(s.users.value[0]).not.toHaveProperty('hash')
    for (const value of [0, 65536, 3.5, Number.NaN]) {
      s.port.value = value
      expect(await s.save()).toBe(false)
    }
    expect(api.setSocks).not.toHaveBeenCalled()
  })
})
