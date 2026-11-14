// README Authenticated SOCKS: compile and mount the actual SFC, not a parallel test template.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import {
  socksTargetValue,
  useSocksService,
} from '../composables/useSocksService'

const api = { getSocks: vi.fn(), getSocksTargets: vi.fn(), setSocks: vi.fn() }
let feature = true
vi.mock('../composables/useControlApi', () => ({ useControlApi: () => api }))
vi.mock('../composables/useControlInfo', () => ({
  useControlInfo: () => ({ hasFeature: () => feature }),
}))
vi.mock('vue-sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const source = readFileSync('components/SocksServicePanel.vue', 'utf8')
const { descriptor } = parse(source)
const compiled = compileScript(descriptor, {
  id: 'socks-test',
  inlineTemplate: true,
})
const js = ts.transpileModule(compiled.content, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const module = { exports: {} as { default?: Vue.Component } }
// Compile only the repository-owned SFC into a mountable component.
// eslint-disable-next-line no-new-func
new Function('require', 'exports', js)((name: string) => {
  if (name === 'vue') return Vue
  if (name === '~/composables/useSocksService')
    return { socksTargetValue, useSocksService }
  throw new Error(`Unexpected component import: ${name}`)
}, module.exports)

let app: Vue.App | undefined
let host: HTMLDivElement
const settle = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Vue.nextTick()
}
const mount = async () => {
  host = document.createElement('div')
  document.body.append(host)
  app = Vue.createApp(module.exports.default!)
  app.mount(host)
  await settle()
}
const snapshot = {
  enabled: false,
  listen: '127.0.0.1',
  port: 10808,
  status: 'disabled',
  users: [
    {
      id: 'id',
      username: 'alice',
      enabled: true,
      hasPassword: true,
      proxy: 'missing',
      error: 'account error',
    },
  ],
}

describe('rEADME Authenticated SOCKS panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    feature = true
    vi.stubGlobal('onMounted', Vue.onMounted)
    api.getSocks.mockResolvedValue(snapshot)
    api.getSocksTargets.mockResolvedValue({
      targets: [{ name: 'unsafe', type: 'group', unavailable: 'unsafe group' }],
    })
    api.setSocks.mockResolvedValue({
      ...snapshot,
      status: 'error',
      error: 'apply failed',
    })
  })
  afterEach(() => {
    app?.unmount()
    app = undefined
    host?.remove()
  })
  it('renders warnings, password semantics, errors and the missing disabled binding', async () => {
    await mount()
    expect(host.textContent).toContain('socksSecurity')
    expect(host.textContent).toContain('socksReload')
    expect(host.textContent).toContain('account error')
    const password = host.querySelector<HTMLInputElement>(
      'input[type="password"]',
    )!
    expect(password.placeholder).toBe('socksKeepPassword')
    expect(password.value).toBe('')
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe(
      socksTargetValue('missing'),
    )
    expect(
      [...host.querySelectorAll('option')].filter((o) => o.disabled).length,
    ).toBe(2)
    password.value = 'test-only-placeholder'
    password.dispatchEvent(new Event('input'))
    await Vue.nextTick()
    host.querySelector<HTMLButtonElement>('.btn-primary')!.click()
    await settle()
    expect(password.value).toBe('')
    expect(host.textContent).toContain('apply failed')
    expect(host.textContent).toContain('socksStatus_error')
  })
  it('adds and removes an account through buttons', async () => {
    await mount()
    const button = (key: string) =>
      [...host.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent === key,
      )!
    button('socksAddUser').click()
    await Vue.nextTick()
    expect(host.querySelectorAll('input[type="password"]').length).toBe(2)
    button('socksRemoveUser').click()
    await Vue.nextTick()
    expect(host.querySelectorAll('input[type="password"]').length).toBe(1)
    expect(
      host.querySelector<HTMLInputElement>('input[type="password"]')!
        .placeholder,
    ).toBe('socksNewPassword')
  })
  it('cannot newly enable an unavailable binding until an exit is explicitly fixed', async () => {
    api.getSocks.mockResolvedValue({
      ...snapshot,
      users: [{ ...snapshot.users[0], enabled: false }],
    })
    await mount()
    const checkbox = host.querySelector<HTMLInputElement>('input.checkbox')!
    expect(checkbox.disabled).toBe(true)
    const select = host.querySelector<HTMLSelectElement>('select')!
    select.value = ''
    select.dispatchEvent(new Event('change'))
    await Vue.nextTick()
    expect(checkbox.disabled).toBe(false)
  })

  it('renders nothing and sends no requests without the capability', async () => {
    feature = false
    await mount()
    expect(host.textContent).toBe('')
    expect(api.getSocks).not.toHaveBeenCalled()
  })
  it('disables all editable controls while loading', async () => {
    let resolve!: (value: unknown) => void
    api.getSocks.mockReturnValue(
      new Promise((r) => {
        resolve = r
      }),
    )
    await mount()
    expect(host.querySelector('fieldset')!.disabled).toBe(true)
    resolve(snapshot)
    await settle()
    expect(host.querySelector('fieldset')!.disabled).toBe(false)
  })
})
