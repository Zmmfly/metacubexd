import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import {
  applyConfigPatch,
  CONFIG_OVERRIDE_KEYS,
  createConfigPersist,
  isConfigOverrideKey,
  useEndpointScopedKey,
  useUpdateConfigMutation,
} from '../useQueries'

// vi.hoisted: the @tanstack/vue-query mock factory executes while ../useQueries
// is imported, i.e. BEFORE this module's body, so the spies must already exist.
const { patch, controlApi, hasFeature, mutationOptions } = vi.hoisted(() => ({
  patch: vi.fn(),
  controlApi: {
    updateSettings: vi.fn(),
    setConfigSection: vi.fn(),
  },
  hasFeature: vi.fn(() => true),
  mutationOptions: { current: undefined as unknown },
}))

// useQueries.ts imports ./useApi at module load; stub it so importing the
// module under test has no side effects. `patch` is the live PATCH /configs hop.
vi.mock('../useApi', () => ({
  useRequest: () => ({ patch }),
  toggleRuleDisabledAPI: vi.fn(),
}))
vi.mock('../useControlApi', () => ({ useControlApi: () => controlApi }))
vi.mock('../useControlInfo', () => ({ useControlInfo: () => ({ hasFeature }) }))
// Capture the mutation options instead of mounting a real vue-query client —
// the repo intentionally keeps unit tests free of @vue/test-utils.
vi.mock('@tanstack/vue-query', () => ({
  useMutation: (options: unknown) => {
    mutationOptions.current = options
    return { mutate: vi.fn() }
  },
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}))

const mockEndpointStore = reactive({ selectedEndpoint: 'endpoint-a' })
vi.stubGlobal('useEndpointStore', () => mockEndpointStore)

describe('composables/useQueries', () => {
  beforeEach(() => {
    mockEndpointStore.selectedEndpoint = 'endpoint-a'
  })

  describe('useEndpointScopedKey', () => {
    it('appends the current endpoint to the base key', () => {
      const key = useEndpointScopedKey(['proxies'])
      expect(key.value).toEqual(['proxies', 'endpoint-a'])
    })

    it('updates reactively when the endpoint changes, so vue-query refetches under a new key', () => {
      const key = useEndpointScopedKey(['config'])
      expect(key.value).toEqual(['config', 'endpoint-a'])

      mockEndpointStore.selectedEndpoint = 'endpoint-b'

      expect(key.value).toEqual(['config', 'endpoint-b'])
    })
  })

  describe('applyConfigPatch', () => {
    it('hot-applies the change via the PATCH callback', async () => {
      const patch = vi.fn().mockResolvedValue(undefined)
      await applyConfigPatch('allow-lan', true, { patch })
      expect(patch).toHaveBeenCalledWith({ 'allow-lan': true })
    })

    it('persists the same change to the active profile when persist is supplied (#2070)', async () => {
      const patch = vi.fn().mockResolvedValue(undefined)
      const persist = vi.fn().mockResolvedValue(undefined)
      await applyConfigPatch('mode', 'global', { patch, persist })
      expect(patch).toHaveBeenCalledWith({ mode: 'global' })
      expect(persist).toHaveBeenCalledWith({ key: 'mode', value: 'global' })
    })

    it('skips persistence on a plain remote backend (no persist callback)', async () => {
      const patch = vi.fn().mockResolvedValue(undefined)
      await expect(
        applyConfigPatch('allow-lan', true, { patch }),
      ).resolves.toBeUndefined()
      expect(patch).toHaveBeenCalledOnce()
    })

    it('does not persist if the live PATCH itself fails', async () => {
      const patch = vi.fn().mockRejectedValue(new Error('network'))
      const persist = vi.fn()
      await expect(
        applyConfigPatch('allow-lan', true, { patch, persist }),
      ).rejects.toThrow('network')
      expect(persist).not.toHaveBeenCalled()
    })

    it('swallows a persistence failure — the live change already took effect', async () => {
      const patch = vi.fn().mockResolvedValue(undefined)
      const persist = vi
        .fn()
        .mockRejectedValue(new Error('409 no active profile'))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(
        applyConfigPatch('allow-lan', true, { patch, persist }),
      ).resolves.toBeUndefined()
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  describe('config override whitelist', () => {
    it('lists exactly the agent-mirrored keys', () => {
      expect([...CONFIG_OVERRIDE_KEYS]).toEqual([
        'allow-lan',
        'mode',
        'log-level',
        'unified-delay',
        'interface-name',
        'ipv6',
        'geodata-mode',
        'tcp-concurrent',
      ])
    })

    it('recognises whitelisted keys only', () => {
      expect(isConfigOverrideKey('mode')).toBe(true)
      expect(isConfigOverrideKey('tcp-concurrent')).toBe(true)
      expect(isConfigOverrideKey('dns')).toBe(false)
      expect(isConfigOverrideKey('tun')).toBe(false)
      expect(isConfigOverrideKey('mixed-port')).toBe(false)
    })
  })

  describe('createConfigPersist', () => {
    function makePersist() {
      const updateSettings = vi.fn().mockResolvedValue(undefined)
      const setConfigSection = vi.fn().mockResolvedValue(undefined)
      return {
        updateSettings,
        setConfigSection,
        persist: createConfigPersist({ updateSettings, setConfigSection }),
      }
    }

    it('writes a whitelisted key into settings.configOverrides', async () => {
      const { updateSettings, setConfigSection, persist } = makePersist()

      await persist({ key: 'mode', value: 'global' })

      expect(updateSettings).toHaveBeenCalledWith({
        configOverrides: { mode: 'global' },
      })
      expect(setConfigSection).not.toHaveBeenCalled()
    })

    it('deletes a whitelisted override when the value is null', async () => {
      const { updateSettings, persist } = makePersist()

      await persist({ key: 'allow-lan', value: null })

      expect(updateSettings).toHaveBeenCalledWith({
        configOverrideKeys: ['allow-lan'],
      })
    })

    it('deletes a whitelisted override when the value is undefined', async () => {
      const { updateSettings, persist } = makePersist()

      await persist({ key: 'interface-name', value: undefined })

      expect(updateSettings).toHaveBeenCalledWith({
        configOverrideKeys: ['interface-name'],
      })
    })

    it('keeps the profile-section write for non-whitelisted keys', async () => {
      const { updateSettings, setConfigSection, persist } = makePersist()
      const dns = { 'enhanced-mode': 'fake-ip' }

      await persist({ key: 'dns', value: dns })

      expect(setConfigSection).toHaveBeenCalledWith({
        key: 'dns',
        value: dns,
        restart: false,
      })
      expect(updateSettings).not.toHaveBeenCalled()
    })
  })

  describe('useUpdateConfigMutation persistence', () => {
    beforeEach(() => {
      vi.clearAllMocks()
      hasFeature.mockReturnValue(true)
      controlApi.updateSettings.mockResolvedValue({})
      controlApi.setConfigSection.mockResolvedValue({})
    })

    // Drives the captured mutationFn directly: the mocked useMutation hands us
    // the options object, so no real query client / component mount is needed.
    async function runMutation(key: string, value: unknown) {
      useUpdateConfigMutation()
      const { mutationFn } = mutationOptions.current as {
        mutationFn: (vars: { key: string; value: unknown }) => Promise<void>
      }
      await mutationFn({ key, value })
    }

    it('persists a whitelisted key into settings.configOverrides', async () => {
      await runMutation('mode', 'global')

      expect(patch).toHaveBeenCalledWith('configs', {
        json: { mode: 'global' },
      })
      expect(controlApi.updateSettings).toHaveBeenCalledWith({
        configOverrides: { mode: 'global' },
      })
      expect(controlApi.setConfigSection).not.toHaveBeenCalled()
    })

    it('removes a whitelisted override for a null value (delete path)', async () => {
      await runMutation('allow-lan', null)

      expect(controlApi.updateSettings).toHaveBeenCalledWith({
        configOverrideKeys: ['allow-lan'],
      })
      expect(controlApi.setConfigSection).not.toHaveBeenCalled()
    })

    it('persists a non-whitelisted key into the profile section', async () => {
      const dns = { 'enhanced-mode': 'fake-ip' }

      await runMutation('dns', dns)

      expect(controlApi.setConfigSection).toHaveBeenCalledWith({
        key: 'dns',
        value: dns,
        restart: false,
      })
      expect(controlApi.updateSettings).not.toHaveBeenCalled()
    })

    it('does not persist at all without the config-sections capability', async () => {
      hasFeature.mockReturnValue(false)

      await runMutation('mode', 'global')

      expect(patch).toHaveBeenCalledWith('configs', {
        json: { mode: 'global' },
      })
      expect(controlApi.updateSettings).not.toHaveBeenCalled()
      expect(controlApi.setConfigSection).not.toHaveBeenCalled()
    })
  })
})
