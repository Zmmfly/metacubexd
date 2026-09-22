// packages/ui/composables/useGeoAssets.ts
import { toast } from 'vue-sonner'
import { useControlApi } from './useControlApi'
import { useControlInfo } from './useControlInfo'

// `useI18n` is auto-imported by @nuxtjs/i18n (no explicit import). In unit
// tests it is provided as a global stub via test/setup.ts.
declare function useI18n(): { t: (key: string, named?: object) => string }

// Geo asset updater (capability-gated 'geo-assets'). One button POSTs
// geo/update which downloads the geoip/geosite/mmdb databases into the kernel
// home dir. Success/failure surface via toast — never swallowed.
export function useGeoAssets() {
  const api = useControlApi()
  const { hasFeature } = useControlInfo()
  const { t } = useI18n()

  const available = computed(() => hasFeature('geo-assets'))
  const updating = ref(false)

  // Per-file idle timeout (seconds) for geo downloads, persisted server-side
  // via /api/control/settings. The transfer aborts only after this long with
  // NO bytes arriving; a slow-but-progressing download always completes.
  const idleTimeoutSec = ref(60)
  const settingsLoaded = ref(false)
  const settingsSaving = ref(false)

  const loadSettings = async () => {
    try {
      const settings = await api.getSettings()
      idleTimeoutSec.value = Math.round(settings.geoIdleTimeoutMs / 1000)
    } catch {
      // Older agent without the settings endpoint — keep the local default.
    } finally {
      settingsLoaded.value = true
    }
  }

  const saveIdleTimeout = async () => {
    if (settingsSaving.value) return
    settingsSaving.value = true
    try {
      const settings = await api.updateSettings({
        geoIdleTimeoutMs: Math.round(idleTimeoutSec.value * 1000),
      })
      idleTimeoutSec.value = Math.round(settings.geoIdleTimeoutMs / 1000)
    } catch (e) {
      toast.error(t('geoSettingsSaveFailed'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      settingsSaving.value = false
    }
  }

  const update = async (useProxy?: boolean) => {
    updating.value = true
    try {
      const res = await api.updateGeoAssets(useProxy)
      toast.success(t('geoUpdateSuccess'), {
        description: res.files.join(', '),
      })
    } catch (e) {
      toast.error(t('geoUpdateFailed'), {
        description: e instanceof Error ? e.message : String(e),
      })
    } finally {
      updating.value = false
    }
  }

  return {
    available,
    updating,
    update,
    idleTimeoutSec,
    settingsLoaded,
    settingsSaving,
    loadSettings,
    saveIdleTimeout,
  }
}
