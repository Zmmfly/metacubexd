import { splitRuleFields } from '@metacubexd/config-editor'
import { toast } from 'vue-sonner'
import { useActiveProfileEditor } from './useActiveProfileEditor'

declare function useI18n(): { t: (key: string, named?: object) => string }

export function useRuleEditor() {
  const session = useActiveProfileEditor()
  const { t } = useI18n()
  const rules = ref<string[]>([])
  const state = ref<
    | 'idle'
    | 'ready'
    | 'unavailable'
    | 'no-active-profile'
    | 'conflict'
    | 'error'
  >('idle')

  const sync = () => session.replaceSections({ rules: rules.value })

  // Syncing re-serializes and re-parses the whole YAML document, which is far
  // too expensive to run on every keystroke once a profile holds thousands of
  // rules. Batch it instead: the draft document (diagnostics/dirty) trails
  // edits by at most SYNC_DELAY ms, while save() always flushes synchronously.
  const SYNC_DELAY = 300
  let syncTimer: ReturnType<typeof setTimeout> | undefined

  const cancelScheduledSync = () => {
    if (syncTimer !== undefined) {
      clearTimeout(syncTimer)
      syncTimer = undefined
    }
  }

  const scheduleSync = () => {
    cancelScheduledSync()
    syncTimer = setTimeout(() => {
      syncTimer = undefined
      sync()
    }, SYNC_DELAY)
  }

  const syncNow = () => {
    cancelScheduledSync()
    sync()
  }

  const isValid = (line: string): boolean => {
    if (!line.trim()) return false
    const fields = splitRuleFields(line)
    const minimumFields = fields[0]?.toUpperCase() === 'MATCH' ? 2 : 3
    return (
      fields.length >= minimumFields &&
      fields.every((field) => field.length > 0)
    )
  }

  const load = async () => {
    cancelScheduledSync()
    const result = await session.load()
    state.value = result
    if (result === 'ready' || result === 'conflict') {
      const section = session.data.value?.rules
      rules.value = Array.isArray(section)
        ? section.map((line) => String(line))
        : []
    } else {
      rules.value = []
    }
    if (result === 'error') {
      toast.error(t('rulesEditorLoadFailed'), {
        description: session.errorMessage.value,
      })
    }
    return result
  }

  // All mutators edit the array in place (O(1)-ish) and schedule a batched
  // document sync; copying the whole array per keystroke is wasteful at scale.
  const add = (line = '', index?: number) => {
    if (index === undefined || index >= rules.value.length) {
      rules.value.push(line)
    } else {
      rules.value.splice(Math.max(0, index), 0, line)
    }
    scheduleSync()
  }

  const update = (index: number, line: string) => {
    if (index < 0 || index >= rules.value.length) return
    rules.value[index] = line
    scheduleSync()
  }

  const remove = (index: number) => {
    if (index < 0 || index >= rules.value.length) return
    rules.value.splice(index, 1)
    scheduleSync()
  }

  const move = (from: number, to: number) => {
    if (from < 0 || from >= rules.value.length) return
    if (to < 0 || to >= rules.value.length) return
    if (from === to) return
    const [moved] = rules.value.splice(from, 1)
    if (moved === undefined) return
    rules.value.splice(to, 0, moved)
    scheduleSync()
  }

  const save = async (): Promise<boolean> => {
    if (!rules.value.every(isValid)) {
      toast.error(t('rulesEditorInvalid'))
      return false
    }
    syncNow()
    const result = await session.save()
    if (result === 'saved' || result === 'unchanged') return true
    if (result === 'conflict') {
      state.value = 'conflict'
      toast.error(t('routingEditorConflict'))
      return false
    }
    if (result === 'invalid') {
      toast.error(t('rulesEditorInvalid'))
      return false
    }
    toast.error(t('rulesEditorSaveFailed'), {
      description: session.errorMessage.value,
    })
    return false
  }

  return {
    available: session.available,
    rules,
    state,
    loading: session.loading,
    saving: session.saving,
    dirty: session.dirty,
    diagnostics: session.diagnostics,
    fullEditorPath: session.fullEditorPath,
    isValid,
    load,
    add,
    update,
    remove,
    move,
    save,
    /** Test hook: wait for the batched document sync to flush. */
    flushSync: syncNow,
  }
}
