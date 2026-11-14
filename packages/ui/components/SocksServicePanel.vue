<script setup lang="ts">
import {
  socksTargetValue,
  useSocksService,
} from '~/composables/useSocksService'

const { t } = useI18n()
const service = useSocksService()
const {
  available,
  enabled,
  listen,
  port,
  users,
  targets,
  status,
  error,
  busy,
} = service
onMounted(() => {
  void service.load()
})
</script>

<template>
  <div
    v-if="available"
    class="rounded-xl border border-base-content/10 bg-base-200 p-4"
  >
    <h2 class="mb-3 font-semibold">{{ t('socksTitle') }}</h2>
    <p class="mb-3 text-sm opacity-60">{{ t('socksDescription') }}</p>
    <p class="mb-3 alert text-sm alert-warning">{{ t('socksSecurity') }}</p>
    <p class="mb-3 text-sm">{{ t('socksReload') }}</p>
    <p role="status" class="mb-3 text-sm">
      {{ t('socksStatus') }}: {{ t(`socksStatus_${status}`) }}
    </p>
    <p v-if="error" role="alert" class="mb-3 text-error">{{ error }}</p>
    <fieldset :disabled="busy" class="flex flex-col gap-3">
      <label class="flex items-center gap-2">
        <input
          v-model="enabled"
          type="checkbox"
          class="toggle toggle-primary"
        />
        {{ t('socksEnable') }}
      </label>
      <div class="flex flex-wrap gap-3">
        <label class="flex flex-col gap-1 text-sm">
          {{ t('socksListen') }}
          <input
            v-model="listen"
            class="input-bordered input"
            spellcheck="false"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('socksPort') }}
          <input
            v-model.number="port"
            type="number"
            min="1"
            max="65535"
            class="input-bordered input"
          />
        </label>
      </div>
      <div
        v-for="(user, index) in users"
        :key="user.id ?? `new-${index}`"
        class="flex flex-col gap-3 rounded-lg border border-base-content/10 p-3"
      >
        <label class="flex items-center gap-2 text-sm">
          <input
            v-model="user.enabled"
            :disabled="!user.enabled && !!service.targetProblem(user)"
            type="checkbox"
            class="checkbox checkbox-sm"
          />
          {{ t('socksUserEnable') }}
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('socksUsername') }}
          <input
            v-model="user.username"
            autocomplete="off"
            spellcheck="false"
            class="input-bordered input"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('socksPassword') }}
          <input
            v-model="user.password"
            type="password"
            autocomplete="new-password"
            :placeholder="
              t(user.hasPassword ? 'socksKeepPassword' : 'socksNewPassword')
            "
            class="input-bordered input"
          />
        </label>
        <label class="flex flex-col gap-1 text-sm">
          {{ t('socksTarget') }}
          <select
            :value="socksTargetValue(user.proxy, user.provider)"
            class="select-bordered select w-full"
            @change="
              service.setTarget(
                user,
                ($event.target as HTMLSelectElement).value,
              )
            "
          >
            <option value="">{{ t('socksFollow') }}</option>
            <option
              v-if="
                user.proxy &&
                !targets.some(
                  (x) =>
                    socksTargetValue(x.name, x.provider) ===
                    socksTargetValue(user.proxy, user.provider),
                )
              "
              :value="socksTargetValue(user.proxy, user.provider)"
              disabled
            >
              {{ user.proxy }} {{ user.provider }} —
              {{ t('socksMissingTarget') }}
            </option>
            <option
              v-for="target in targets"
              :key="socksTargetValue(target.name, target.provider)"
              :value="socksTargetValue(target.name, target.provider)"
              :disabled="!!target.unavailable"
            >
              {{ target.name }}
              {{ target.provider ? `(${target.provider})` : '' }} ·
              {{ target.type }}
              {{ target.unavailable ? `— ${target.unavailable}` : '' }}
            </option>
          </select>
        </label>
        <p
          v-if="service.targetProblem(user)"
          role="alert"
          class="text-sm text-warning"
        >
          {{ service.targetProblem(user) }}
        </p>
        <p v-if="user.error" role="alert" class="text-sm text-error">
          {{ user.error }}
        </p>
        <button
          type="button"
          class="btn self-start btn-outline btn-sm"
          @click="service.removeUser(index)"
        >
          {{ t('socksRemoveUser') }}
        </button>
      </div>
      <button
        type="button"
        class="btn self-start btn-outline btn-sm"
        @click="service.addUser()"
      >
        {{ t('socksAddUser') }}
      </button>
      <div class="flex gap-2">
        <button
          type="button"
          class="btn btn-primary btn-sm"
          @click="service.save()"
        >
          {{ t('socksSave') }}
        </button>
        <button type="button" class="btn btn-sm" @click="service.load()">
          {{ t('socksRefresh') }}
        </button>
        <span
          v-if="busy"
          class="loading loading-sm loading-spinner"
          :aria-label="t('socksBusy')"
        />
      </div>
    </fieldset>
  </div>
</template>
