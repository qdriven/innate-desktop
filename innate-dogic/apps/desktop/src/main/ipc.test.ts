import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'

const env = vi.hoisted(() => ({
  userDataDir: 'C:/fake-user-data',
  mode: 'dev' as 'dev' | 'simple' | null,
}))

const ipc = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return { handlers }
})

/** 记录调用的 TerminalService 桩：验证门控是否放行到服务端。 */
const terminal = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    TerminalService: class {
      registerProcessProfile(input: unknown) {
        calls.push({ method: 'registerProcessProfile', args: [input] })
        return { ok: true }
      }
      processProfileIds() {
        calls.push({ method: 'processProfileIds', args: [] })
        return ['echoer']
      }
      async execute(input: unknown) {
        calls.push({ method: 'execute', args: [input] })
        return { executionId: 'exec-1', ok: true }
      }
      async processResult(executionId: unknown) {
        calls.push({ method: 'processResult', args: [executionId] })
        return {
          executionId: String(executionId), ok: true, exitCode: 0, signal: null,
          durationMs: 1, stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false,
        }
      }
      async cancel(executionId: unknown) {
        calls.push({ method: 'cancel', args: [executionId] })
        return true
      }
      async setRoot() {
        return null
      }
      getRoot() {
        return null
      }
      async dispose() {}
    },
  }
})

/** 记录调用的 BrowserSurfaceService 桩：验证 browser 窄通道是否放行到服务端。 */
const browser = vi.hoisted(() => {
  const calls: Array<{ method: string; args: unknown[] }> = []
  return {
    calls,
    BrowserSurfaceService: class {
      provider = {
        id: 'browser',
        kind: 'webcontents',
        deferredUrl: true,
        resolve: async () => ({ ok: true }),
      }
      async navigate(id: unknown, request: unknown) {
        calls.push({ method: 'navigate', args: [id, request] })
        return { ok: true, url: 'https://example.com/' }
      }
      async back(id: unknown) {
        calls.push({ method: 'back', args: [id] })
        return { ok: true, url: 'https://example.com/' }
      }
      async forward(id: unknown) {
        calls.push({ method: 'forward', args: [id] })
        return { ok: true, url: 'https://example.com/' }
      }
      async reload(id: unknown) {
        calls.push({ method: 'reload', args: [id] })
        return { ok: true, url: 'https://example.com/' }
      }
      async stop(id: unknown) {
        calls.push({ method: 'stop', args: [id] })
        return { ok: true }
      }
      state(id: unknown) {
        calls.push({ method: 'state', args: [id] })
        return undefined
      }
      async extractList(id: unknown, request: unknown) {
        calls.push({ method: 'extractList', args: [id, request] })
        return { ok: true, elements: [] }
      }
      async extractDetail(id: unknown, request: unknown) {
        calls.push({ method: 'extractDetail', args: [id, request] })
        return { ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' }
      }
      dispose() {}
    },
  }
})

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => env.userDataDir) },
  BrowserWindow: class {
    isDestroyed = (): boolean => false
    webContents = { send: vi.fn() }
    on = vi.fn()
  },
  WebContentsView: class {},
  dialog: { showOpenDialog: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipc.handlers.set(channel, handler)
    }),
  },
  shell: { openExternal: vi.fn(), openPath: vi.fn() },
}))

vi.mock('@dogic/core', () => ({
  dshHome: () => 'C:/dsh',
  discoverGatewayPort: async () => undefined,
  fetchModels: async () => [],
  readMode: () => env.mode,
  readStatus: () => ({}),
  runChecks: () => [],
  smokeTest: async () => ({ ok: true }),
  writeMode: () => true,
  redactLaunchSecrets: (message: string) => message,
}))

vi.mock('@dogic/plugin-terminal/main', () => ({ TerminalService: terminal.TerminalService }))

vi.mock('@dogic/plugin-browser/main', () => ({ BrowserSurfaceService: browser.BrowserSurfaceService }))

vi.mock('@dogic/plugin-browser/main/electron', () => ({ createElectronBrowserView: vi.fn() }))

vi.mock('./harness', () => ({
  HarnessRuntime: class {
    getState = () => ({ phase: 'idle' })
    launch = async () => ({ ok: true })
    stop = async () => true
    on = vi.fn()
  },
}))

vi.mock('./launcher', () => ({
  disconnectDsh: async () => ({ ok: true, detail: 'ok' }),
  ensureMagpieConsole: async () => ({ ok: false, detail: '未启动' }),
  startMagpie: async () => ({ ok: false, detail: '未启动' }),
  // W2.5 接线（merge 后 registerIpc 直接消费）：网关/控制台状态事件订阅。
  getGateway: () => ({ status: () => ({ state: 'stopped' }), onStatusChange: vi.fn() }),
  getConsole: () => ({ getState: () => ({}), on: vi.fn() }),
}))

import { registerIpc } from './ipc'
import { DESKTOP_BROWSER_IPC_VERSION } from './browser-ipc'
import { BROWSER_IPC_CHANNELS, BROWSER_IPC_CONTRACT, isBrowserIpcVersionCompatible } from '@dogic/plugin-browser/ipc'

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipc.handlers.get(channel)
  if (!handler) throw new Error(`未注册的 channel: ${channel}`)
  return Promise.resolve(handler({}, ...args))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor 超时')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

describe('W4.6 process:execute 窄通道门控（desktop main）', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    terminal.calls.length = 0
    env.mode = 'dev'
    env.userDataDir = 'C:/fake-user-data'
  })

  it('dev 模式：process 通道转发服务端', async () => {
    registerIpc(new BrowserWindow({}))
    const ack = await invoke('innate:processExecute', { profileId: 'echoer', args: ['echo', 'x'] })
    expect(ack).toEqual({ executionId: 'exec-1', ok: true })
    expect(terminal.calls.some((call) => call.method === 'execute')).toBe(true)
    expect(await invoke('innate:processProfiles')).toEqual(['echoer'])
    expect(await invoke('innate:processCancel', 'exec-1')).toBe(true)
    expect(terminal.calls.some((call) => call.method === 'cancel')).toBe(true)
    const result = await invoke('innate:processResult', 'exec-1')
    expect(result).toMatchObject({ ok: true, exitCode: 0 })
  })

  it('simple 模式：process 通道全拒且不触达服务端', async () => {
    env.mode = 'simple'
    registerIpc(new BrowserWindow({}))
    const ack = await invoke('innate:processExecute', { profileId: 'echoer', args: [] })
    expect(ack).toEqual({ executionId: '', ok: false, detail: 'simple 模式不提供 process:execute' })
    const result = await invoke('innate:processResult', 'exec-1')
    expect(result).toMatchObject({ ok: false, detail: 'simple 模式不提供 process:execute' })
    expect(await invoke('innate:processProfiles')).toEqual([])
    expect(await invoke('innate:processProfileRegister', { id: 'x', command: 'cmd.exe', args: [] }))
      .toEqual({ ok: false, detail: 'simple 模式不提供 process:execute' })
    expect(await invoke('innate:processCancel', 'exec-1')).toBe(false)
    expect(terminal.calls).toHaveLength(0)
  })

  it('userData 白名单启动加载：process-profiles.json 注册进服务端', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dogic-ipc-'))
    try {
      await writeFile(path.join(dir, 'process-profiles.json'), JSON.stringify([
        { id: 'loader', command: 'cmd.exe', args: ['/c'] },
      ]))
      env.userDataDir = dir
      registerIpc(new BrowserWindow({}))
      await waitFor(() => terminal.calls.some((call) => call.method === 'registerProcessProfile'))
      const call = terminal.calls.find((item) => item.method === 'registerProcessProfile')
      expect(call?.args[0]).toMatchObject({ id: 'loader', command: 'cmd.exe' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('W5.2 browser 窄通道（desktop main）', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    terminal.calls.length = 0
    browser.calls.length = 0
    env.mode = 'dev'
    env.userDataDir = 'C:/fake-user-data'
  })

  it('browser 导航/历史/停止/状态通道转发服务端', async () => {
    registerIpc(new BrowserWindow({}))
    const nav = await invoke('innate:browserNavigate', 'browser-1', { url: 'https://example.com/' })
    expect(nav).toEqual({ ok: true, url: 'https://example.com/' })
    expect(browser.calls.some((call) => call.method === 'navigate')).toBe(true)
    expect(await invoke('innate:browserBack', 'browser-1')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(await invoke('innate:browserForward', 'browser-1')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(await invoke('innate:browserReload', 'browser-1')).toEqual({ ok: true, url: 'https://example.com/' })
    expect(await invoke('innate:browserStop', 'browser-1')).toEqual({ ok: true })
    expect(browser.calls.some((call) => call.method === 'stop')).toBe(true)
    expect(await invoke('innate:browserState', 'browser-1')).toBeNull()
    expect(browser.calls.some((call) => call.method === 'state')).toBe(true)
  })
})

describe('W6.6 browser IPC 契约接线（desktop main）', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    terminal.calls.length = 0
    browser.calls.length = 0
    env.mode = 'dev'
    env.userDataDir = 'C:/fake-user-data'
  })

  it('桌面声明的契约版本与插件契约兼容', () => {
    expect(isBrowserIpcVersionCompatible(DESKTOP_BROWSER_IPC_VERSION)).toBe(true)
  })

  it('契约全部通道在桌面注册（含元素提取），不额外新增通道', () => {
    registerIpc(new BrowserWindow({}))
    for (const method of BROWSER_IPC_CONTRACT.methods) {
      expect(ipc.handlers.has(BROWSER_IPC_CHANNELS[method])).toBe(true)
    }
    const browserChannels = [...ipc.handlers.keys()].filter((channel) => channel.startsWith('innate:browser'))
    expect(browserChannels.sort()).toEqual(
      Object.values(BROWSER_IPC_CHANNELS).sort(),
    )
  })

  it('元素提取经契约通道转发到服务层（renderer 只提交 id 与引用）', async () => {
    registerIpc(new BrowserWindow({}))
    expect(await invoke('innate:browserExtractList', 'browser-1', { limit: 20 }))
      .toEqual({ ok: true, elements: [] })
    const listCall = browser.calls.find((call) => call.method === 'extractList')
    expect(listCall?.args).toEqual(['browser-1', { limit: 20 }])
    expect(await invoke('innate:browserExtractDetail', 'browser-1', { ref: 'el-1' }))
      .toEqual({ ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' })
  })

  it('红线：契约通道集合里没有页面脚本执行入口', () => {
    registerIpc(new BrowserWindow({}))
    const browserChannels = [...ipc.handlers.keys()].filter((channel) => channel.startsWith('innate:browser'))
    expect(browserChannels.some((channel) => /execute|eval|script|runtime|cdp/i.test(channel))).toBe(false)
  })
})
