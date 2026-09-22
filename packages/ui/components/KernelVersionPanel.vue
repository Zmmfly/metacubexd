<!-- packages/ui/components/KernelVersionPanel.vue -->
<script setup lang="ts">
import {
  IconChevronDown,
  IconCpu,
  IconDatabase,
  IconDownload,
} from '@tabler/icons-vue'

const { t } = useI18n()
const kernelVersions = useKernelVersions()
const geo = useGeoAssets()

const {
  available: versionsAvailable,
  versions,
  current,
  bundled,
  selected,
  loading,
  switching,
} = kernelVersions
const { available: geoAvailable, updating } = geo
const { idleTimeoutSec, settingsLoaded, settingsSaving } = geo

// The whole card renders when at least one of its capabilities is present.
const cardVisible = computed(
  () => versionsAvailable.value || geoAvailable.value,
)

// Collapse the parent <details class="dropdown"> after a menu action.
const closeDropdown = (event: Event) => {
  const details = (event.currentTarget as HTMLElement).closest('details')
  details?.removeAttribute('open')
}

// Geo update via proxy from the dropdown (plain button click stays direct).
const onGeoUpdateViaProxy = (event: Event) => {
  closeDropdown(event)
  geo.update(true)
}

onMounted(() => {
  if (versionsAvailable.value) kernelVersions.load()
  if (geoAvailable.value) void geo.loadSettings()
})
</script>

<template>
  <div
    v-if="cardVisible"
    class="rounded-xl border border-base-content/10 bg-base-200 p-4"
  >
    <!-- Kernel version manager -->
    <template v-if="versionsAvailable">
      <div class="mb-3 flex items-center justify-between gap-2">
        <span class="flex items-center gap-2 font-semibold text-base-content">
          <IconCpu :size="18" />
          {{ t('kernelVersionManager') }}
        </span>
      </div>

      <div class="mb-3 grid grid-cols-2 gap-2 text-sm">
        <div class="flex flex-col">
          <span class="text-base-content/60">{{
            t('kernelVersionCurrent')
          }}</span>
          <span class="tabular-nums">{{ current ?? '-' }}</span>
        </div>
        <div class="flex flex-col">
          <span class="text-base-content/60">{{
            t('kernelVersionBundled')
          }}</span>
          <span class="tabular-nums">{{ bundled || '-' }}</span>
        </div>
      </div>

      <label class="mb-1 flex flex-col gap-1 text-sm">
        <span class="text-base-content/60">{{ t('kernelVersionSelect') }}</span>
        <select
          v-model="selected"
          class="select-bordered select w-full select-sm"
          :disabled="loading || switching || versions.length === 0"
        >
          <option v-for="v in versions" :key="v" :value="v">
            {{ v }}{{ v === current ? ` (${t('kernelVersionActive')})` : '' }}
          </option>
        </select>
      </label>

      <div class="mt-3 flex flex-wrap gap-2">
        <Button
          class="btn-primary btn-sm"
          :icon="IconDownload"
          :loading="switching"
          :disabled="loading || switching || !selected || selected === current"
          @click="kernelVersions.switch()"
        >
          {{ t('kernelVersionSwitch') }}
        </Button>
      </div>
    </template>

    <!-- Geo databases -->
    <template v-if="geoAvailable">
      <div
        class="flex items-center justify-between gap-2"
        :class="{
          'mt-4 border-t border-base-content/10 pt-4': versionsAvailable,
        }"
      >
        <span class="flex items-center gap-2 font-semibold text-base-content">
          <IconDatabase :size="18" />
          {{ t('geoAssets') }}
        </span>
        <div class="flex items-center">
          <Button
            class="rounded-r-none btn-secondary btn-sm"
            :icon="IconDownload"
            :loading="updating"
            :disabled="updating"
            @click="geo.update()"
          >
            {{ t('geoUpdate') }}
          </Button>
          <details class="dropdown dropdown-end">
            <summary
              class="btn flex h-8 min-h-8 w-6 items-center justify-center rounded-none rounded-r-lg border-0 bg-secondary p-0 text-secondary-content"
              :class="[
                updating
                  ? 'btn-disabled cursor-wait !bg-base-content/10'
                  : 'cursor-pointer',
              ]"
              :title="t('profilesRefreshOptions')"
              :aria-disabled="updating"
              @click.stop="updating ? $event.preventDefault() : undefined"
            >
              <IconChevronDown :size="14" />
            </summary>
            <ul
              class="menu dropdown-content z-30 w-44 rounded-lg border border-base-content/10 bg-base-100 p-1 shadow-lg"
            >
              <li>
                <button class="text-xs" @click="onGeoUpdateViaProxy">
                  {{ t('geoUpdateViaProxy') }}
                </button>
              </li>
            </ul>
          </details>
        </div>
      </div>
      <p class="mt-2 text-sm text-base-content/60">
        {{ t('geoAssetsDescription') }}
      </p>

      <!-- Per-file idle timeout for geo downloads (server-side setting): the
           transfer aborts only after this long with NO bytes arriving, so a
           slow-but-progressing weak-network download always completes. -->
      <label
        v-if="settingsLoaded"
        class="mt-2 flex w-fit items-center gap-2 text-sm"
      >
        <span class="text-base-content/60">
          {{ t('geoIdleTimeout') }}
        </span>
        <input
          v-model.number="idleTimeoutSec"
          type="number"
          min="1"
          max="3600"
          class="input-bordered input w-20 input-xs"
          :disabled="settingsSaving"
          @change="geo.saveIdleTimeout"
        />
        <span class="text-xs text-base-content/50">
          {{ t('geoIdleTimeoutUnit') }}
        </span>
      </label>
    </template>
  </div>
</template>
