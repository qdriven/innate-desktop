import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import {
  dshHome,
  discoverGatewayPort,
  fetchModels,
  readMode,
  readStatus,
  runChecks,
  smokeTest,
  writeMode,
  redactLaunchSecrets,
} from '@dogic/core'
import type {
  AppMode,
  GatewayStatusEvent,
  GatewayStatusState,
  HarnessLaunchResult,
  HarnessState,
} from '@dogic/core'
import { WorkspaceService } from '@dogic/plugin-workspace/main'
import { TerminalService } from '@dogic/plugin-terminal/main'
import { BrowserSurfaceService } from '@dogic/plugin-browser/main'
import { createElectronBrowserView } from '@dogic/plugin-browser/main/electron'
import { BROWSER_IPC_EVENT_CHANNEL } from '@dogic/plugin-browser/ipc'
import { HarnessRuntime } from './harness'
import { registerDesktopBrowserIpc } from './browser-ipc'
import { SurfaceHost } from './surface-host'
import { ensureMagpieConsole, getConsole, getGateway, startMagpie } from './launcher'

export const harness = new HarnessRuntime()

/** renderer 可见的 Harness 状态：不含认证 URL，message 里的 URL 也已脱敏。 */
function publicHarnessState(state: HarnessState): HarnessState {
  const safe = { ...state }
  delete safe.url
  safe.message = redactLaunchSecrets(safe.message)
  return safe
}

/** 启动结果同理：URL 只留在主进程，renderer 只拿到端口与可展示文本。 */
function publicLaunchResult(result: HarnessLaunchResult): HarnessLaunchResult {
  const safe = { ...result }
  delete safe.url
  return safe
}

export function registerIpc(mainWindow: BrowserWindow): void {
  const surfaces = new SurfaceHost(mainWindow)
  const workspace = new WorkspaceService(path.join(app.getPath('userData'), 'workspace.json'))
  // root 变更事件转发：service 内监听器异常隔离，单个订阅者不阻断主流程。
  const unsubscribeRoot = workspace.onRootChanged((changed) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('innate:workspace-root-changed', changed)
  })
  // 主进程 PTY Terminal（W4.3）：事件出口窄包装到 renderer；root 由工作区服务驱动。
  const terminal = new TerminalService({
    onEvent: (event) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send('innate:terminal-event', event)
    },
  })
  // 独立 Browser Surface（W5.2）：会话/历史由 BrowserSurfaceService 维护，
  // 视图经 provider.createView 创建（独立分区 + 安全 webPreferences），
  // 页面事件窄包装到 renderer（不含 webContents/session 对象）。
  // W5.5：下载保存对话框以主窗口为父弹窗（受控下载路径确认）。
  const browser = new BrowserSurfaceService({
    factory: (descriptor, guard) => createElectronBrowserView(descriptor, guard, { parentWindow: mainWindow }),
    onEvent: (event) => {
      if (!mainWindow.isDestroyed()) mainWindow.webContents.send(BROWSER_IPC_EVENT_CHANNEL, event)
    },
  })
  mainWindow.on('closed', () => {
    unsubscribeRoot()
    surfaces.dispose()
    browser.dispose()
    void terminal.dispose()
  })
  // 启动时同步已保存的工作区 root（W4.5 订阅语义的先行接线）。
  void (async () => {
    const saved = await workspace.getRoot()
    if (saved) await terminal.setRoot(saved.path)
  })()

  // 认证 URL 只在对应 runtime provider 内解析；renderer 只提交安全 descriptor。
  surfaces.registerProvider({
    id: 'harness',
    kind: 'webcontents',
    resolve: async () => {
      const state = harness.getState()
      if (state.phase !== 'running' || !state.url) {
        return { ok: false, detail: 'Harness 尚未运行，请先启动对话' }
      }
      return { ok: true, url: state.url }
    },
  })
  surfaces.registerProvider({
    id: 'magpie-console',
    kind: 'webcontents',
    resolve: async () => {
      const ready = await ensureMagpieConsole()
      if (!ready.ok || !ready.url) return { ok: false, detail: ready.detail }
      return { ok: true, url: ready.url }
    },
  })
  surfaces.registerProvider(browser.provider)

  ipcMain.handle('innate:status', () => readStatus())

  ipcMain.handle('innate:winMin', () => mainWindow.minimize())
  ipcMain.handle('innate:winToggleMax', () => {
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('innate:winClose', () => mainWindow.close())
  ipcMain.handle('innate:winIsMaximized', () => mainWindow.isMaximized())
  const sendMaximizeState = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('innate:win-maximized', mainWindow.isMaximized())
    }
  }
  mainWindow.on('maximize', sendMaximizeState)
  mainWindow.on('unmaximize', sendMaximizeState)

  ipcMain.handle('innate:getMode', () => readMode(app.getPath('userData')))
  ipcMain.handle('innate:setMode', (_e, mode: AppMode) => {
    writeMode(app.getPath('userData'), mode)
    return true
  })

  ipcMain.handle('innate:models', async () => {
    const port = await discoverGatewayPort()
    if (port === undefined) return { ok: false as const, models: [], detail: '网关未运行' }
    try {
      const models = await fetchModels(port)
      return { ok: true as const, models, detail: `${models.length} 个模型` }
    } catch (e) {
      return { ok: false as const, models: [], detail: String(e) }
    }
  })

  ipcMain.handle('innate:checks', () => runChecks())
  ipcMain.handle('innate:smoke', (_e, model?: string) => smokeTest(model))

  ipcMain.handle('innate:openMagpieWeb', async () => {
    const ready = await ensureMagpieConsole()
    if (!ready.ok || !ready.url) return ready
    await shell.openExternal(ready.url)
    return { ok: true, detail: '已在浏览器打开受管控制台' }
  })

  ipcMain.handle('innate:startMagpie', () => startMagpie())

  // provider 中立的 Surface 窄接口：安全 descriptor + bounds，无 URL、无进程句柄。
  ipcMain.handle('innate:surfaceShow', (_e, descriptor: unknown, bounds: unknown) =>
    surfaces.show(descriptor, bounds))
  ipcMain.handle('innate:surfaceHide', (_e, id: unknown) => surfaces.hide(id))
  ipcMain.handle('innate:surfaceBounds', (_e, id: unknown, bounds: unknown) => surfaces.setBounds(id, bounds))
  ipcMain.handle('innate:surfaceClose', (_e, id: unknown) => surfaces.close(id))

  // browser 窄通道（W5.2/W6.6）：按插件 IPC 契约注册——通道名、方法签名与
  // 能力声明全部来自契约，桌面只声明自己实现的契约版本；版本不兼容即 fail closed。
  registerDesktopBrowserIpc(browser)

  ipcMain.handle('innate:revealDshHome', () => shell.openPath(dshHome()))
  ipcMain.handle('innate:openLogs', () => shell.openPath(path.join(app.getPath('userData'), 'logs')))

  // 接线/配额操作全部经类型化 gateway facade（execFile 参数数组 + 超时 + 参数白名单），
  // 不新增第二套直调；断开结果显式返回恢复结果/失败原因/下一步 hint。
  ipcMain.handle('innate:disconnectDsh', async () => {
    try {
      await getGateway().unwireDsh(dshHome())
      return {
        ok: true as const,
        detail: '已请求断开（magpie 将恢复 dsh 原配置）',
        hint: '断开后 dsh 使用其原默认模型；重新接线请在 magpie 控制台操作',
      }
    } catch (e) {
      return {
        ok: false as const,
        detail: `CLI 执行失败: ${String(e)}`,
        hint: '可在 magpie Agents 页对 dsh 手动 Disconnect',
      }
    }
  })

  ipcMain.handle('innate:wireDsh', async (_e, model: string) => {
    try {
      const stdout = await getGateway().wireDsh(model, dshHome())
      return { ok: true as const, detail: `已接线 ${model}：${stdout.trim() || '无输出'}` }
    } catch (e) {
      return {
        ok: false as const,
        detail: `接线失败: ${String(e)}`,
        hint: '模型名需为 <provider>/<model> 白名单字符',
      }
    }
  })

  ipcMain.handle('innate:quota', async () => {
    const quota = await getGateway().quota()
    return { ok: quota !== null, detail: quota?.trim() ?? '配额不可用（magpie CLI 未响应）' }
  })

  ipcMain.handle('innate:harnessState', () => publicHarnessState(harness.getState()))
  ipcMain.handle('innate:launchHarness', async () =>
    publicLaunchResult(await harness.launch(app.getPath('userData'))))
  ipcMain.handle('innate:stopHarness', () => {
    surfaces.close('harness')
    void harness.stop()
    return true
  })

  ipcMain.handle('innate:workspaceGetRoot', async () => {
    const saved = await workspace.getRoot()
    if (saved || !process.env.INNATE_WORKSPACE_ROOT) return saved
    // env 回退：以 env 为 source 设 root，触发 root-changed 事件
    const root = await workspace.setRoot(process.env.INNATE_WORKSPACE_ROOT, 'env')
    await terminal.setRoot(root.path)
    return root
  })
  ipcMain.handle('innate:workspacePickRoot', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择工作区目录',
      properties: ['openDirectory'],
    })
    const selected = result.filePaths[0]
    if (result.canceled || !selected) return null
    const root = await workspace.setRoot(selected, 'picker')
    await terminal.setRoot(root.path)
    return root
  })
  ipcMain.handle('innate:workspaceSetRoot', async (_e, root: string, source?: 'saved' | 'env' | 'picker') => {
    const saved = await workspace.setRoot(root, source ?? 'picker')
    await terminal.setRoot(saved.path)
    return saved
  })
  ipcMain.handle('innate:workspaceList', (_e, root: string, relative?: string) => workspace.list(root, relative))
  ipcMain.handle('innate:workspaceRead', (_e, root: string, relative: string) => workspace.read(root, relative))
  ipcMain.handle('innate:workspaceGitStatus', (_e, root: string) => workspace.gitStatus(root))
  ipcMain.handle('innate:workspaceGitDiff', (_e, root: string, relative: string) => workspace.gitDiff(root, relative))

  // 主进程 PTY Terminal 窄通道（W4.3）：renderer 只提交安全字段，事件由主进程推送。
  ipcMain.handle('innate:terminalCreate', (_e, descriptor: unknown) => terminal.create(descriptor))
  ipcMain.handle('innate:terminalInput', (_e, terminalId: unknown, data: unknown) => terminal.input(terminalId, data))
  ipcMain.handle('innate:terminalResize', (_e, terminalId: unknown, size: unknown) => terminal.resize(terminalId, size))
  ipcMain.handle('innate:terminalClose', (_e, terminalId: unknown) => terminal.close(terminalId))

  // W4.6 受控 process:execute 窄通道：profile 白名单 + 结构化请求；simple 模式全拒。
  // 白名单来源：userData/process-profiles.json（可编辑 JSON 数组）+ 显式注册（受控开发入口）。
  void (async () => {
    try {
      const raw = await readFile(path.join(app.getPath('userData'), 'process-profiles.json'), 'utf8')
      const parsed: unknown = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        for (const item of parsed) terminal.registerProcessProfile(item)
      }
    } catch {
      /* 无白名单文件/格式非法：跳过（白名单为空时执行一律拒绝） */
    }
  })()
  const isSimple = (): boolean => readMode(app.getPath('userData')) === 'simple'
  const simpleDetail = 'simple 模式不提供 process:execute'
  ipcMain.handle('innate:processProfileRegister', (_e, profile: unknown) => {
    if (isSimple()) return { ok: false, detail: simpleDetail }
    return terminal.registerProcessProfile(profile)
  })
  ipcMain.handle('innate:processProfiles', () => {
    if (isSimple()) return []
    return terminal.processProfileIds()
  })
  ipcMain.handle('innate:processExecute', (_e, request: unknown) => {
    if (isSimple()) return { executionId: '', ok: false, detail: simpleDetail }
    return terminal.execute(request)
  })
  ipcMain.handle('innate:processResult', (_e, executionId: unknown) => {
    if (isSimple()) {
      return {
        executionId: '', ok: false, exitCode: null, signal: null, durationMs: 0,
        stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false,
        detail: simpleDetail,
      }
    }
    return terminal.processResult(executionId)
  })
  ipcMain.handle('innate:processCancel', (_e, executionId: unknown) => {
    if (isSimple()) return false
    return terminal.cancel(executionId)
  })

  harness.on('state', (state) => {
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send('innate:harness-state', publicHarnessState(state))
  })

  // 网关/控制台状态事件 → renderer 状态 pill（W2.5：事件驱动 + 低频 reconcile，替代无意义重复轮询）。
  // 事件脱敏：认证查询串不进事件；url 仅 running 时为回环地址；message 过 redactLaunchSecrets。
  const sendGatewayStatus = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('innate:gateway-status', publicGatewayStatus(getGateway().status()))
    }
  }
  getGateway().onStatusChange(sendGatewayStatus)
  sendGatewayStatus()

  const sendConsoleStatus = (): void => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('innate:console-status', getConsole().getState())
    }
  }
  getConsole().on('state', sendConsoleStatus)
  sendConsoleStatus()
}

/** renderer 可见的网关状态事件：脱敏（认证查询串不进事件；url 仅 running 时为回环地址）。 */
function publicGatewayStatus(status: {
  state: string
  url?: string
  message?: string
  recoverable?: boolean
}): GatewayStatusEvent {
  const event: GatewayStatusEvent = {
    state: status.state as GatewayStatusState,
    recoverable: status.recoverable ?? true,
  }
  if (status.state === 'running') event.url = status.url
  if (status.message) event.message = redactLaunchSecrets(status.message)
  return event
}

