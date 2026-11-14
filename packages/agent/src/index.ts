import type { ScriptRunner } from './script'
import type { CreateSupervisorOptions } from './supervisor'
import type {
  KernelManager,
  MihomoSupervisor,
  SystemProxyController,
  TunController,
} from './types'
import { join } from 'node:path'
import { createControlRouter } from './http'
import { MIHOMO_VERSION } from './kernel/assets'
import { createOperationQueue } from './operation-queue'
import { createProfileConfigEditor } from './profile-editor'
import { createProfileStore } from './profiles'
import { createProxiedFetch } from './proxy-fetch'
import { applyActiveRefresh } from './refresh-apply'
import { createProfileScheduler } from './scheduler'
import { createScriptRunner } from './script'
import { createAgentSettings, fillMissingConfigOverrides } from './settings'
import { createSocksService } from './socks-service'
import { createSupervisor } from './supervisor'
import { TunPreconditionError } from './tun'

export const AGENT_VERSION = '0.0.0'

export { createControlRouter } from './http'
export type { ControlRouterDeps } from './http'
export { MIHOMO_VERSION, mihomoAsset } from './kernel/assets'
export { fetchKernel, listMihomoVersions } from './kernel/fetch-kernel'
export { fetchGeoAssets, GEO_ASSET_URLS } from './kernel/geo'
export { mergeConfigs } from './merge'
export {
  createProfileConfigEditor,
  ProfileEditorConflictError,
  ProfileEditorValidationError,
} from './profile-editor'
export type {
  ProfileConfigEditor,
  ProfileConfigEditorOptions,
  ProfileEditorApplyResult,
  ProfileEditorPreview,
  ProfileEditorSnapshot,
} from './profile-editor'
export { createProfileStore } from './profiles'
export { createProxiedFetch } from './proxy-fetch'
export { applyActiveRefresh } from './refresh-apply'
export { createProfileScheduler } from './scheduler'
export type {
  ProfileRefreshResult,
  ProfileScheduler,
  ProfileSchedulerDeps,
} from './scheduler'
export { createScriptRunner } from './script'
export type {
  CreateScriptRunnerOptions,
  ScriptRun,
  ScriptRunner,
} from './script'
export {
  CONFIG_OVERRIDE_KEYS,
  createAgentSettings,
  DEFAULT_AGENT_SETTINGS,
} from './settings'
export type {
  AgentSettings,
  AgentSettingsStore,
  ConfigOverrides,
  ConfigOverrideValue,
} from './settings'
export { createSocksService } from './socks-service'
export type { SocksService } from './socks-service'
export type { SocksConfigInput, SocksSnapshot } from './socks-types'
export { createSupervisor } from './supervisor'
export type { CreateSupervisorOptions, SupervisorDeps } from './supervisor'
export { buildTunConfig, TunPreconditionError } from './tun'
export * from './types'
export { createWebdavClient } from './webdav'
export type { WebdavClient, WebdavClientOptions } from './webdav'

export type CreateAgentOptions = CreateSupervisorOptions & {
  profilesDir: string
  agentToken?: string
  // Runs enabled 'script' profiles during composition. Defaults to a real
  // worker-backed runner; tests inject a fake to avoid spawning workers.
  scriptRunner?: ScriptRunner
  systemProxy?: SystemProxyController // OS proxy controller; enables 'system-proxy'
  kernelManager?: KernelManager // kernel version mgmt; enables 'kernel-version'
  tunController?: TunController // TUN mode controller; enables 'tun'
}

export interface AgentInfo {
  hasAgent: true
  version: string
  platform: { os: string; arch: string }
  kernel: { bundled: boolean; path: string; version?: string }
  features: string[]
}

export function createAgent(opts: CreateAgentOptions) {
  const serialize = createOperationQueue()
  let supervisor: MihomoSupervisor
  let tunTransition = false
  const socks = createSocksService({
    filePath: join(opts.homeDir, 'socks-service.json'),
    activeConfigPath: opts.activeConfigPath,
    getKernelState: () => supervisor.getState(),
    validate: (path) => supervisor.validate(path),
    serialize,
  })
  // Fetch through the kernel's own mixed port for subscription/geo downloads
  // the user routes via proxy (network-restricted regions). Only available
  // when the kernel has a mixed port configured; TUN-only setups (mixedPort 0)
  // keep direct-only behavior.
  const proxyFetch = opts.mixedPort
    ? createProxiedFetch(`http://127.0.0.1:${opts.mixedPort}`)
    : undefined
  // Agent-level settings (server-wide, profile-independent). Built before the
  // profile store so the import hook below can seed instance-level config
  // overrides, and reused for the control router (one store per agent).
  const settings = createAgentSettings(join(opts.homeDir, 'settings.json'))
  const profiles = createProfileStore({
    dir: opts.profilesDir,
    activeConfigPath: opts.activeConfigPath,
    proxyFetch,
    // Without a runner, script profiles are silently skipped during compose —
    // the user's script transforms never apply. Default to a real one so the
    // feature works across every Runtime Form (server/desktop) out of the box.
    scriptRunner: opts.scriptRunner ?? createScriptRunner(),
    // A freshly imported subscription may already carry the panel-editable
    // switches (allow-lan, mode, …). Seed them as instance-level overrides so
    // the first refresh — which overwrites the profile file verbatim — does not
    // revert them. Keys that already have an override (a user's panel edit) win.
    onImportOverrides: async (values) => {
      await fillMissingConfigOverrides(settings, values)
    },
  })
  // Active-file writes share the lifecycle ordering boundary, including a
  // scheduled subscription refresh racing an authenticated SOCKS update.
  const setActive = profiles.setActive
  profiles.setActive = (id) => serialize(() => setActive(id))
  const nativeSupervisor = createSupervisor({
    ...opts,
    serialize,
    transformConfig: async (content) =>
      socks.prepareConfig(
        opts.transformConfig ? await opts.transformConfig(content) : content,
      ),
    onReady: async () => {
      await opts.onReady?.()
      await socks.activate()
    },
    // Fall back to the settings-backed override bag: the supervisor injects
    // these into active.yaml at spawn, so the panel-editable switches outlive a
    // subscription refresh. An explicit caller-supplied source stays
    // authoritative (tests / embedders).
    configOverrides:
      opts.configOverrides ??
      (() => settings.read().then((s) => s.configOverrides)),
  })
  const assertSidecarOwner = async () => {
    if (
      !tunTransition &&
      opts.tunController &&
      (await opts.tunController.status()).mode === 'tun'
    ) {
      throw new TunPreconditionError(
        'The TUN helper owns the kernel; disable TUN before using kernel start, stop or restart',
      )
    }
  }
  supervisor = {
    ...nativeSupervisor,
    start: () =>
      serialize(async () => {
        await assertSidecarOwner()
        return nativeSupervisor.start()
      }),
    stop: () =>
      serialize(async () => {
        await assertSidecarOwner()
        return nativeSupervisor.stop()
      }),
    restart: () =>
      serialize(async () => {
        await assertSidecarOwner()
        return nativeSupervisor.restart()
      }),
  }
  const profileEditor = createProfileConfigEditor({
    profiles,
    supervisor,
    homeDir: opts.homeDir,
  })
  supervisor.on('state', (state) => {
    if (state.status !== 'running') socks.suspend()
  })
  const { systemProxy, kernelManager } = opts
  // Desktop helper transitions do not pass through supervisor.start(). Serialize
  // the whole handoff and probe the same private generation before reopening.
  const originalTun = opts.tunController
  const tunController: TunController | undefined = originalTun
    ? {
        status: () => originalTun.status(),
        enable: (options) =>
          serialize(async () => {
            socks.suspend()
            tunTransition = true
            try {
              await originalTun.enable(options)
            } finally {
              tunTransition = false
              await socks.activate()
            }
          }),
        disable: () =>
          serialize(async () => {
            socks.suspend()
            tunTransition = true
            try {
              await originalTun.disable()
            } finally {
              tunTransition = false
              await socks.activate()
            }
          }),
        ...(originalTun.uninstall
          ? {
              uninstall: () =>
                serialize(async () => {
                  socks.suspend()
                  tunTransition = true
                  try {
                    await originalTun.uninstall!()
                  } finally {
                    tunTransition = false
                    await socks.activate()
                  }
                }),
            }
          : {}),
      }
    : undefined
  const info = (): AgentInfo => ({
    hasAgent: true,
    version: AGENT_VERSION,
    platform: { os: process.platform, arch: process.arch },
    kernel: {
      bundled: true,
      path: opts.binaryPath,
      // Fall back to the bundled kernel's version when the supervisor has not
      // observed a running kernel yet (fresh launch / stopped without ever
      // starting). Otherwise the dashboard shows "-" for the kernel version
      // until the kernel runs once, even though the bundled version is known.
      version: supervisor.getState().version ?? MIHOMO_VERSION,
    },
    features: [
      'profiles',
      'logs-sse',
      'kernel-control',
      // homeDir always exists, so geo-asset download is always available.
      'geo-assets',
      // WebDAV backup/restore is always available — credentials arrive per-request.
      'webdav-backup',
      // Runtime config viewer reads the activeConfigPath file — always available.
      'runtime-config',
      // Config-section editor reads/writes top-level keys of the active profile.
      'config-sections',
      'visual-config-editor',
      'socks-service',
      ...(systemProxy ? ['system-proxy'] : []),
      ...(kernelManager ? ['kernel-version'] : []),
      ...(tunController ? ['tun'] : []),
    ],
  })
  const router = createControlRouter({
    supervisor,
    profiles,
    profileEditor,
    info,
    homeDir: opts.homeDir,
    activeConfigPath: opts.activeConfigPath,
    token: opts.agentToken,
    systemProxy,
    kernelManager,
    tunController,
    geoProxyFetch: proxyFetch,
    settings,
    socks,
    serialize,
  })
  // Wire the auto-update scheduler to the same profiles store. NOT started here
  // — the server boot plugin starts it (the desktop builds its own scheduler so
  // it can surface per-refresh notifications, and does NOT start this one).
  //
  // Auto-update should take effect, not just refresh a stored file: when a
  // scheduled refresh hits the ACTIVE base, re-compose + restart so the running
  // kernel actually picks up the new subscription (#2107). Best-effort and
  // fire-and-forget (the scheduler never awaits onResult) — a failing apply must
  // not wedge the tick loop; the next tick retries.
  const scheduler = createProfileScheduler({
    profiles,
    onResult: (r) => {
      if (!r.ok) return
      // Auto-update should take effect, not just refresh a stored file: when a
      // scheduled refresh hits the ACTIVE base, re-compose + restart so the
      // running kernel picks up the new subscription (#2107). Best-effort and
      // fire-and-forget (the scheduler never awaits onResult) — a failing apply
      // must not wedge the tick loop; the next tick retries.
      void serialize(() =>
        applyActiveRefresh(profiles, supervisor, r.id),
      ).catch(() => {})
    },
  })
  return {
    supervisor,
    profiles,
    profileEditor,
    router,
    info,
    scheduler,
    systemProxy,
    kernelManager,
    tunController,
    socks,
    enqueueRuntimeOperation: serialize.enqueue ?? serialize,
    async dispose() {
      scheduler.stop()
      await socks.dispose()
      await serialize(async () => {
        if (tunController && (await tunController.status()).mode === 'tun')
          await tunController.disable()
        await supervisor.dispose()
      })
    },
  }
}
