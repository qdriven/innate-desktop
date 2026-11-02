/**
 * electron WebContentsView 工厂（W5.2 创建，W5.3 起挂导航守卫）：
 * - 独立持久分区 persist:innate-browser（与 Harness/console 默认 session 隔离）；
 * - contextIsolation: true、nodeIntegration: false、sandbox: true；
 * - 新窗口请求：http/https 交系统浏览器（用户明确选择的外链），其余一律拒绝；
 * - 导航守卫（W5.3）：页面内导航（will-frame-navigate）与重定向
 *   （will-redirect）的目标 URL 经守卫校验，不合法则 preventDefault
 *   并上报安全失败事件——不只检查地址栏初始输入；
 * - 事件经 subscribe 中性通道上报服务层，服务层不感知 electron。
 *
 * 禁止 executeJavaScript：本工厂与视图抽象都不提供任何页面脚本执行通道。
 *
 * W5.4：权限策略接线（见 attachPermissionPolicy）——本分区 session 一律拒绝
 * 权限请求，拒绝事件只记 origin+类型；仅挂 persist:innate-browser 分区，
 * Harness/console 默认 session 不继承。
 *
 * W5.5：受控下载接线（见 attachDownloadPolicy）——will-download 一律经
 * 系统保存对话框由用户确认路径（不写默认目录）；下载事件按来源
 * webContents 路由；close 前取消在途下载并清理临时状态。
 */
import { dialog, session, shell, WebContentsView } from 'electron'
import type { BrowserWindow, DownloadItem, Session, WebContents } from 'electron'
import { BROWSER_PARTITION } from '../shared/index.js'
import type { BrowserDescriptor } from '../shared/index.js'
import type {
  BrowserNavigationGuard,
  BrowserSurfaceView,
  BrowserViewBounds,
  BrowserViewEvent,
} from './index.js'
import { browserPermissionOrigin, denyBrowserPermission } from './permission.js'
import { createElectronExtractionPort } from './extraction-cdp.js'
import {
  mapDownloadItemState,
  normalizeDownloadPercent,
  sanitizeDownloadFilename,
} from './download.js'
import type { DownloadState } from './download.js'

/** 守卫拦截时的固定安全失败消息（不携带被拒 URL 或内部细节）。 */
const GUARD_REJECTED_MESSAGE = '导航被安全策略拒绝'

/** 权限 handler 每分区 session 只挂一次（同一 partition 复用同一 Session 对象）。 */
const policyAttachedSessions = new WeakSet<Session>()
/** 权限事件按来源 webContents 路由到对应视图的 emit（多标签共享同一分区 session）。 */
const viewEmitByWebContents = new WeakMap<WebContents, (event: BrowserViewEvent) => void>()

/**
 * 权限策略接线（W5.4）：只挂到 persist:innate-browser 分区 session——
 * Harness/console 的默认 session 不继承 browser handler，反之亦然。
 * request handler 与 check handler 一律拒绝并生成可诊断事件
 * （origin+类型，不记页面内容）。
 */
function attachPermissionPolicy(browserSession: Session): void {
  if (policyAttachedSessions.has(browserSession)) return
  policyAttachedSessions.add(browserSession)
  browserSession.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      const denied = denyBrowserPermission({
        origin: browserPermissionOrigin(webContents.getURL()),
        permission,
      })
      viewEmitByWebContents.get(webContents)?.({
        type: 'permission-denied',
        origin: denied.origin,
        permission: denied.permission,
      })
      callback(false)
    },
  )
  browserSession.setPermissionCheckHandler(
    (webContents, permission, requestingOrigin) => {
      if (!webContents) return false
      const denied = denyBrowserPermission({
        origin: browserPermissionOrigin(requestingOrigin),
        permission,
      })
      viewEmitByWebContents.get(webContents)?.({
        type: 'permission-denied',
        origin: denied.origin,
        permission: denied.permission,
      })
      return false
    },
  )
}

/** 下载 handler 每分区 session 只挂一次（同一 partition 复用同一 Session 对象）。 */
const downloadPolicyAttachedSessions = new WeakSet<Session>()
/** 下载事件按来源 webContents 路由到对应视图的 emit（多标签共享同一分区 session）。 */
const downloadsByWebContents = new WeakMap<WebContents, DownloadTracker[]>()

/** 单个在途/已结算下载的跟踪记录（close 前据此取消在途下载）。 */
interface DownloadTracker {
  item: DownloadItem
  /** 已发出终态事件则跳过后续（防止取消竞态重复结算）。 */
  settled: boolean
}

/**
 * 下载策略接线（W5.5）：只挂 persist:innate-browser 分区 session。
 * will-download 一律经系统保存对话框确认路径——不写默认目录、无隐式路径；
 * 对话框取消即 cancel。事件按来源 webContents 路由。
 */
function attachDownloadPolicy(browserSession: Session, parentWindow: BrowserWindow | null): void {
  if (downloadPolicyAttachedSessions.has(browserSession)) return
  downloadPolicyAttachedSessions.add(browserSession)
  browserSession.on('will-download', (_event, item, webContents) => {
    const filename = sanitizeDownloadFilename(item.getFilename())
    const origin = browserPermissionOrigin(webContents.getURL())
    const tracker: DownloadTracker = { item, settled: false }
    const trackers = downloadsByWebContents.get(webContents) ?? []
    trackers.push(tracker)
    downloadsByWebContents.set(webContents, trackers)
    viewEmitByWebContents.get(webContents)?.({
      type: 'download',
      state: 'started',
      filename,
      origin,
      percent: 0,
    })
    item.on('updated', () => {
      if (tracker.settled) return
      viewEmitByWebContents.get(webContents)?.({
        type: 'download',
        state: 'progress',
        filename,
        origin,
        percent: normalizeDownloadPercent(item.getPercentComplete()),
      })
    })
    item.once('done', () => {
      if (tracker.settled) return
      tracker.settled = true
      // done 为终态，此后不再有 updated；settled 标志防取消竞态重复结算。
      const next = downloadsByWebContents.get(webContents) ?? []
      next.splice(next.findIndex((entry) => entry.item === item), 1)
      if (next.length > 0) downloadsByWebContents.set(webContents, next)
      viewEmitByWebContents.get(webContents)?.({
        type: 'download',
        state: mapDownloadItemState(item.getState()),
        filename,
        origin,
        percent: normalizeDownloadPercent(item.getPercentComplete()),
      })
    })
    // 保存对话框由用户确认路径；取消则取消下载（内容不落盘）。
    void confirmSavePath(item, filename, parentWindow).then((saved) => {
      if (!saved) item.cancel()
    })
  })
}

/**
 * 系统保存对话框确认路径。父窗口存在则以其为父弹窗，否则父less。
 * 取消返回 false（不设置路径）；确认返回 true 并 setSavePath——
 * 写盘只由 main/session 处理，renderer 无文件写通道。
 */
async function confirmSavePath(
  item: DownloadItem,
  filename: string,
  parentWindow: BrowserWindow | null,
): Promise<boolean> {
  const options: Electron.SaveDialogOptions = {
    defaultPath: filename,
    title: '保存下载文件',
  }
  const result = parentWindow
    ? await dialog.showSaveDialog(parentWindow, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return false
  item.setSavePath(result.filePath)
  return true
}

export function createElectronBrowserView(
  descriptor: BrowserDescriptor,
  guard: BrowserNavigationGuard,
  options?: { parentWindow?: BrowserWindow | null },
): BrowserSurfaceView {
  const browserSession = session.fromPartition(BROWSER_PARTITION)
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const webContents = view.webContents
  // W5.4：权限策略只挂本分区 session（默认 session 的 Harness/console 不受影响）。
  attachPermissionPolicy(browserSession)
  // W5.5：下载策略同样只挂本分区 session（默认 session 不继承）。
  attachDownloadPolicy(browserSession, options?.parentWindow ?? null)
  downloadsByWebContents.set(webContents, [])
  webContents.setWindowOpenHandler(({ url: target }) => {
    // 用户明确选择的外链交系统浏览器；仅 http/https，其余协议一律拒绝。
    if (/^https?:\/\//i.test(target)) void shell.openExternal(target)
    return { action: 'deny' }
  })
  const listeners = new Set<(event: BrowserViewEvent) => void>()
  const emit = (event: BrowserViewEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }
  viewEmitByWebContents.set(webContents, emit)
  const rejectGuarded = (event: { preventDefault(): void }): void => {
    event.preventDefault()
    emit({ type: 'failed', errorCode: -3, message: GUARD_REJECTED_MESSAGE })
  }
  // Electron 43：will-navigate 已废弃，主框架导航用 will-frame-navigate；
  // will-redirect 覆盖 HTTP/JS 重定向的每次跳转（逐跳校验，最终地址再由
  // 服务层 navigated 事件兜底复验）。两类事件均为单参数 Event<Params>。
  webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) return
    if (!guard(event.url)) rejectGuarded(event)
  })
  webContents.on('will-redirect', (event) => {
    if (!event.isMainFrame) return
    if (!guard(event.url)) rejectGuarded(event)
  })
  webContents.on('did-start-loading', () => emit({ type: 'loading', loading: true }))
  webContents.on('did-stop-loading', () => emit({ type: 'loading', loading: false }))
  webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    emit({ type: 'failed', errorCode, message: errorDescription })
  })
  webContents.on('did-navigate', (_event, url) => emit({ type: 'navigated', url }))
  // electron 43：页面崩溃事件为 render-process-gone（reason: crashed/oom 等）
  webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'crashed') emit({ type: 'crashed' })
  })
  webContents.on('unresponsive', () => emit({ type: 'unresponsive', responsive: false }))
  webContents.on('responsive', () => emit({ type: 'unresponsive', responsive: true }))
  return {
    underlying: view,
    loadURL: (url) => webContents.loadURL(url),
    stop: () => webContents.stop(),
    close: () => webContents.close(),
    setBounds: (bounds) => view.setBounds(bounds),
    // W6：元素提取端口（CDP 只读域；不执行页面脚本）。
    extraction: createElectronExtractionPort(webContents),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    cancelDownloads: () => {
      // W5.5：close 前取消在途下载。事件同步上报，保证服务层在销毁
      // 会话前转发 cancelled；已结算的 tracker 跳过（防重复结算）。
      const trackers = downloadsByWebContents.get(webContents)
      if (!trackers || trackers.length === 0) return
      for (const tracker of trackers) {
        if (tracker.settled) continue
        tracker.settled = true
        try {
          tracker.item.cancel()
        } catch {
          // 取消竞态：item 已结算或销毁，忽略。
        }
        emit({
          type: 'download',
          state: 'cancelled',
          filename: sanitizeDownloadFilename(tracker.item.getFilename()),
          origin: browserPermissionOrigin(webContents.getURL()),
          percent: normalizeDownloadPercent(tracker.item.getPercentComplete()),
        })
      }
      downloadsByWebContents.delete(webContents)
    },
  }
}
