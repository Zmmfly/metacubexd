import type { SocksSnapshot, SocksTarget, SocksUser } from '~/types/control'
import { computed, ref } from 'vue'
import { toast } from 'vue-sonner'
import { useControlApi } from './useControlApi'
import { useControlInfo } from './useControlInfo'

declare function useI18n(): { t: (key: string) => string }
export type SocksDraftUser = Omit<SocksUser, 'id'> & {
  id?: string
  password: string
}
export const socksTargetValue = (proxy?: string, provider?: string) =>
  proxy ? JSON.stringify([proxy, provider ?? '']) : ''

export function useSocksService() {
  const api = useControlApi()
  const { hasFeature } = useControlInfo()
  const { t } = useI18n()
  const available = computed(() => hasFeature('socks-service'))
  const enabled = ref(false)
  const listen = ref('127.0.0.1')
  const port = ref(10808)
  const users = ref<SocksDraftUser[]>([])
  const targets = ref<SocksTarget[]>([])
  const status = ref<SocksSnapshot['status']>('disabled')
  const error = ref('')
  const busy = ref(false)
  const sync = (s: SocksSnapshot) => {
    enabled.value = s.enabled
    listen.value = s.listen
    port.value = s.port
    status.value = s.status
    error.value = s.error ?? ''
    // Explicit allowlist: snapshots never supply password material to the draft.
    users.value = s.users.map((u) => ({
      id: u.id,
      username: u.username,
      enabled: u.enabled,
      proxy: u.proxy,
      provider: u.provider,
      hasPassword: u.hasPassword,
      error: u.error,
      password: '',
    }))
  }
  const targetProblem = (u: SocksDraftUser) => {
    if (!u.proxy) return ''
    const target = targets.value.find(
      (x) =>
        socksTargetValue(x.name, x.provider) ===
        socksTargetValue(u.proxy, u.provider),
    )
    return target ? (target.unavailable ?? '') : t('socksMissingTarget')
  }
  const setTarget = (u: SocksDraftUser, value: string) => {
    if (busy.value) return
    if (!value) {
      u.proxy = undefined
      u.provider = undefined
      return
    }
    const target = targets.value.find(
      (x) => socksTargetValue(x.name, x.provider) === value,
    )
    if (!target || target.unavailable) return
    u.proxy = target.name
    u.provider = target.provider
  }
  const addUser = () => {
    if (!busy.value)
      users.value.push({
        username: '',
        enabled: true,
        hasPassword: false,
        password: '',
      })
  }
  const removeUser = (index: number) => {
    if (!busy.value) users.value.splice(index, 1)
  }
  const load = async () => {
    if (!available.value || busy.value) return false
    busy.value = true
    try {
      const [snapshot, result] = await Promise.all([
        api.getSocks(),
        api.getSocksTargets(),
      ])
      sync(snapshot)
      targets.value = result.targets
      return true
    } catch {
      // Never echo transport error text: it can contain submitted credentials.
      error.value = t('socksLoadFailed')
      toast.error(error.value)
      return false
    } finally {
      busy.value = false
    }
  }
  const save = async () => {
    if (!available.value || busy.value) return false
    if (
      !listen.value.trim() ||
      !Number.isInteger(port.value) ||
      port.value < 1 ||
      port.value > 65535 ||
      users.value.some(
        (u) => !u.username.trim() || ((!u.id || !u.hasPassword) && !u.password),
      )
    ) {
      error.value = t('socksInvalid')
      toast.error(error.value)
      return false
    }
    busy.value = true
    try {
      const snapshot = await api.setSocks({
        enabled: enabled.value,
        listen: listen.value.trim(),
        port: port.value,
        users: users.value.map((u) => ({
          ...(u.id ? { id: u.id } : {}),
          username: u.username,
          enabled: u.enabled,
          ...(u.proxy
            ? {
                proxy: u.proxy,
                ...(u.provider ? { provider: u.provider } : {}),
              }
            : {}),
          ...(u.password ? { password: u.password } : {}),
        })),
      })
      sync(snapshot)
      if (snapshot.status === 'error') {
        toast.error(t('socksApplyFailed'))
        return false
      }
      toast.success(t('socksSaved'))
      return true
    } catch {
      error.value = t('socksSaveFailed')
      toast.error(error.value)
      return false
    } finally {
      users.value.forEach((u) => {
        u.password = ''
      })
      busy.value = false
    }
  }
  return {
    available,
    enabled,
    listen,
    port,
    users,
    targets,
    status,
    error,
    busy,
    load,
    save,
    addUser,
    removeUser,
    setTarget,
    targetProblem,
  }
}
