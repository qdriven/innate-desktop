import { contextBridge, ipcRenderer } from 'electron'
import type {
  CheckResult,
  ConsoleStatusEvent,
  GatewayStatusEvent,
  HarnessLaunchResult,
  HarnessState,
  ModelInfo,
  SmokeResult,
  StatusSnapshot,
  ViewBounds,
} from '@dogic/core'
import type { AppMode } from '@dogic/core'
import type { SurfaceDescriptor, SurfaceShowResult } from '@dogic/core/surface'
import type { WorkspaceApi, WorkspaceContext, WorkspaceRootChanged } from '@dogic/plugin-workspace'
import type { TerminalApi, TerminalDescriptor, TerminalEvent, TerminalShowResult } from '@dogic/plugin-terminal'
import type { ProcessExecuteAck, ProcessProfile, ProcessRequest, ProcessResult } from '@dogic/plugin-terminal'
import type { BrowserApi } from '@dogic/plugin-browser'
import { createBrowserApi } from '@dogic/plugin-browser/ipc'

/**
 * browser 窄通道（W5.3/W6/W6.6）：按插件 IPC 契约构造——通道名与参数签名
 * 来自契约，preload 只提供 Electron 的传输实现。
 * renderer 只提交安全字段（会话 id + 规范化 URL / 条数上限 / 清单引用）；
 * 无 webContents/session 对象、无页面脚本执行通道。
 */
const browserApi: BrowserApi = createBrowserApi({
  invoke: (channel, id, payload) => ipcRenderer.invoke(channel, id, payload),
  subscribe: (channel, listener) => {
    const handler = (_e: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },
})

const api = {
  getStatus: (): Promise<StatusSnapshot> => ipcRenderer.invoke('innate:status'),
  winMin: (): Promise<void> => ipcRenderer.invoke('innate:winMin'),
  winToggleMax: (): Promise<void> => ipcRenderer.invoke('innate:winToggleMax'),
  winClose: (): Promise<void> => ipcRenderer.invoke('innate:winClose'),
  winIsMaximized: (): Promise<boolean> => ipcRenderer.invoke('innate:winIsMaximized'),
  onWinMaximized: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: unknown, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('innate:win-maximized', listener)
    return () => ipcRenderer.removeListener('innate:win-maximized', listener)
  },
  getMode: (): Promise<AppMode | null> => ipcRenderer.invoke('innate:getMode'),
  setMode: (mode: AppMode): Promise<boolean> => ipcRenderer.invoke('innate:setMode', mode),
  getModels: (): Promise<{ ok: boolean; models: ModelInfo[]; detail: string }> =>
    ipcRenderer.invoke('innate:models'),
  runChecks: (): Promise<CheckResult[]> => ipcRenderer.invoke('innate:checks'),
  smokeTest: (model?: string): Promise<SmokeResult> => ipcRenderer.invoke('innate:smoke', model),
  openMagpieWeb: (): Promise<boolean> => ipcRenderer.invoke('innate:openMagpieWeb'),
  startMagpie: (): Promise<{ ok: boolean; detail: string }> =>
    ipcRenderer.invoke('innate:startMagpie'),
  // provider 中立的 Surface 窄接口（无认证 URL、无进程句柄）
  surfaceShow: (descriptor: SurfaceDescriptor, bounds: ViewBounds): Promise<SurfaceShowResult> =>
    ipcRenderer.invoke('innate:surfaceShow', descriptor, bounds),
  surfaceHide: (id: string): Promise<boolean> => ipcRenderer.invoke('innate:surfaceHide', id),
  surfaceBounds: (id: string, bounds: ViewBounds): Promise<boolean> =>
    ipcRenderer.invoke('innate:surfaceBounds', id, bounds),
  surfaceClose: (id: string): Promise<boolean> => ipcRenderer.invoke('innate:surfaceClose', id),
  revealDshHome: (): Promise<string> => ipcRenderer.invoke('innate:revealDshHome'),
  openLogs: (): Promise<string> => ipcRenderer.invoke('innate:openLogs'),
  /** 断开 dsh 接线（经 gateway facade；返回恢复结果/失败原因/下一步 hint） */
  disconnectDsh: (): Promise<{ ok: boolean; detail: string; hint?: string }> =>
    ipcRenderer.invoke('innate:disconnectDsh'),
  /** 接线 dsh（用户动作触发；模型名白名单校验在 facade 层） */
  wireDsh: (model: string): Promise<{ ok: boolean; detail: string; hint?: string }> =>
    ipcRenderer.invoke('innate:wireDsh', model),
  /** 配额/用量（经 gateway facade） */
  quota: (): Promise<{ ok: boolean; detail: string }> => ipcRenderer.invoke('innate:quota'),
  launchHarness: (): Promise<HarnessLaunchResult> => ipcRenderer.invoke('innate:launchHarness'),
  getHarnessState: (): Promise<HarnessState> => ipcRenderer.invoke('innate:harnessState'),
  stopHarness: (): Promise<boolean> => ipcRenderer.invoke('innate:stopHarness'),
  onHarnessState: (cb: (state: HarnessState) => void): (() => void) => {
    const listener = (_e: unknown, state: HarnessState): void => cb(state)
    ipcRenderer.on('innate:harness-state', listener)
    return () => ipcRenderer.removeListener('innate:harness-state', listener)
  },
  /** 网关状态事件（W2.5；脱敏：无认证查询串） */
  onGatewayStatus: (cb: (status: GatewayStatusEvent) => void): (() => void) => {
    const listener = (_e: unknown, status: GatewayStatusEvent): void => cb(status)
    ipcRenderer.on('innate:gateway-status', listener)
    return () => ipcRenderer.removeListener('innate:gateway-status', listener)
  },
  /** 控制台生命周期事件（W2.5；不含认证 URL） */
  onConsoleStatus: (cb: (status: ConsoleStatusEvent) => void): (() => void) => {
    const listener = (_e: unknown, status: ConsoleStatusEvent): void => cb(status)
    ipcRenderer.on('innate:console-status', listener)
    return () => ipcRenderer.removeListener('innate:console-status', listener)
  },
  workspaceGetRoot: (): Promise<WorkspaceContext | null> => ipcRenderer.invoke('innate:workspaceGetRoot'),
  workspacePickRoot: (): Promise<WorkspaceContext | null> => ipcRenderer.invoke('innate:workspacePickRoot'),
  workspaceList: (root: string, relative?: string) => ipcRenderer.invoke('innate:workspaceList', root, relative),
  workspaceRead: (root: string, relative: string) => ipcRenderer.invoke('innate:workspaceRead', root, relative),
  workspaceGitStatus: (root: string) => ipcRenderer.invoke('innate:workspaceGitStatus', root),
  workspaceGitDiff: (root: string, relative: string) => ipcRenderer.invoke('innate:workspaceGitDiff', root, relative),
  workspaceOnRootChanged: (cb: (changed: WorkspaceRootChanged) => void): (() => void) => {
    const listener = (_e: unknown, changed: WorkspaceRootChanged): void => cb(changed)
    ipcRenderer.on('innate:workspace-root-changed', listener)
    return () => ipcRenderer.removeListener('innate:workspace-root-changed', listener)
  },
  // 主进程 PTY Terminal 窄通道（W4.3）：只提交安全字段，事件由主进程推送。
  terminalCreate: (descriptor: TerminalDescriptor): Promise<TerminalShowResult> =>
    ipcRenderer.invoke('innate:terminalCreate', descriptor),
  terminalInput: (terminalId: string, data: string): Promise<boolean> =>
    ipcRenderer.invoke('innate:terminalInput', terminalId, data),
  terminalResize: (terminalId: string, size: { cols: number; rows: number }): Promise<boolean> =>
    ipcRenderer.invoke('innate:terminalResize', terminalId, size),
  terminalClose: (terminalId: string): Promise<boolean> => ipcRenderer.invoke('innate:terminalClose', terminalId),
  terminalOnEvent: (cb: (event: TerminalEvent) => void): (() => void) => {
    const listener = (_e: unknown, event: TerminalEvent): void => cb(event)
    ipcRenderer.on('innate:terminal-event', listener)
    return () => ipcRenderer.removeListener('innate:terminal-event', listener)
  },
  // 受控 process:execute 窄通道（W4.6）：profile 白名单 + 结构化请求；
  // 受理即返回执行 id，结果经 processResult 取回，simple 模式由主进程门控拒绝。
  processProfileRegister: (profile: ProcessProfile): Promise<TerminalShowResult> =>
    ipcRenderer.invoke('innate:processProfileRegister', profile),
  processProfiles: (): Promise<string[]> => ipcRenderer.invoke('innate:processProfiles'),
  processExecute: (request: ProcessRequest): Promise<ProcessExecuteAck> =>
    ipcRenderer.invoke('innate:processExecute', request),
  processResult: (executionId: string): Promise<ProcessResult> =>
    ipcRenderer.invoke('innate:processResult', executionId),
  processCancel: (executionId: string): Promise<boolean> =>
    ipcRenderer.invoke('innate:processCancel', executionId),
  // browser 窄通道（W5.3/W6/W6.6）：契约构造，preload 只提供传输实现。
  ...browserApi,
} satisfies WorkspaceApi & TerminalApi & BrowserApi & Record<string, unknown>

contextBridge.exposeInMainWorld('innate', api)
export type InnateApi = typeof api
