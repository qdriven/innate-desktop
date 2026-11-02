/**
 * 主进程 browser 会话服务（W5.2）：WebContents 生命周期 + 导航安全策略。
 *
 * W5.1 的 BrowserProvider 策略层在此升级为持有真实视图的服务：
 * - 会话与视图由本服务持有：SurfaceHost.show 经 provider.createView 创建
 *   视图（独立分区 + 安全 webPreferences，由宿主工厂注入），navigate/
 *   back/forward/reload 经视图加载并维护历史；
 * - 每次导航（含历史目标）一律经协议白名单与凭据检查；页面内导航与
 *   重定向目标由守卫（will-frame-navigate/will-redirect）拦截，不只检查
 *   地址栏初始输入；错误消息经净化，不暴露凭据或内部堆栈（W5.3）；
 * - 标签切换只 detach（SurfaceHost hide/show），不销毁会话（不重载）；
 * - 视图销毁由 SurfaceHost.close 完成，随后经 onViewClosed 回调清理本服务
 *   会话（订阅移除 + 会话移除）；
 * - 页面崩溃、无响应和加载失败只影响当前会话，事件经 onEvent 上报，
 *   renderer 呈现重试/关闭；
 * - 禁止 executeJavaScript：视图抽象不提供任何页面脚本执行通道；
 * - 并发会话上限受控；dispose 统一回收（应用退出/窗口关闭路径）。
 *
 * W5.4：权限策略（纯逻辑在 permission.ts，接线在 electron-view 分区 session）——
 * 一律拒绝权限请求，拒绝事件按会话上报（origin+类型），面板呈现可诊断提示。
 *
 * W5.5：受控下载（纯逻辑在 download.ts，接线在 electron-view 分区 session）——
 * 下载一律经系统保存对话框确认路径；下载事件按会话上报（脱敏文件名、来源
 * origin、进度、终态）；会话关闭/销毁前取消在途下载并清理临时状态。
 */
import type { BrowserWindow, WebContentsView } from 'electron'
import {
  BROWSER_PROVIDER_ID,
  parseBrowserDescriptor,
  parseBrowserUrl,
  sanitizeBrowserDisplayText,
} from '../shared/index.js'
import type {
  BrowserDescriptor,
  BrowserNavigateResult,
  BrowserOpenResult,
  BrowserProvider as IBrowserProvider,
  BrowserSessionState,
  BrowserSurfaceEvent,
  DownloadState,
} from '../shared/index.js'
import type {
  BrowserExtractionDetailResult,
  BrowserExtractionListResult,
} from '../shared/extraction.js'
import {
  parseExtractionDetailRequest,
  parseExtractionListRequest,
  sanitizeExtractedUrl,
} from './extraction.js'
import type { BrowserExtractionPort } from './extraction-cdp.js'

export type {
  BrowserDescriptor,
  BrowserNavigateResult,
  BrowserOpenResult,
  BrowserSessionState,
  BrowserSurfaceEvent,
  DownloadState,
} from '../shared/index.js'

/** 视图边界（与宿主 Rectangle 同构）。 */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** 视图事件：electron webContents 事件的中立抽象，服务层只依赖此接口。 */
export type BrowserViewEvent =
  | { type: 'loading'; loading: boolean }
  | { type: 'failed'; errorCode: number; message: string }
  | { type: 'navigated'; url: string }
  | { type: 'crashed' }
  | { type: 'unresponsive'; responsive: boolean }
  | { type: 'permission-denied'; origin: string; permission: string }
  | {
      type: 'download'
      state: DownloadState
      filename: string
      origin: string
      percent: number
    }

/**
 * 服务侧视图抽象（真实实现由宿主注入：electron WebContentsView 包装）。
 * 不提供 executeJavaScript 或任何页面脚本执行通道。
 */
export interface BrowserSurfaceView {
  /** 底层宿主视图：SurfaceHost 的 attach/setBounds/destroy 直接作用于它。 */
  readonly underlying: WebContentsView
  loadURL(url: string): Promise<void>
  /** 停止当前加载（W5.3 地址栏 stop）。 */
  stop(): void
  close(): void
  /**
   * W5.5：取消本视图全部在途下载（close 前调用）。取消事件经 subscribe
   * 通道同步上报，服务层在销毁会话前转发；已结算下载不受影响。
   */
  cancelDownloads(): void
  setBounds(bounds: BrowserViewBounds): void
  subscribe(listener: (event: BrowserViewEvent) => void): () => void
  /**
   * W6：元素提取端口（可选）。
   *
   * 端口由宿主实现（CDP 只读域），服务层只经它取元素清单与详情。
   * 端口**不提供**任何页面脚本执行能力——抽象层依旧没有 executeJavaScript。
   */
  readonly extraction?: BrowserExtractionPort
}

/** 导航守卫（W5.3）：页面内导航与重定向目标同样过协议白名单与凭据检查。 */
export type BrowserNavigationGuard = (url: string) => boolean

/**
 * 视图工厂（宿主注入）。第三参数可选：父窗口（系统保存对话框的父弹窗，
 * 下载时由桌面主进程传入主窗口）。
 */
export type BrowserSurfaceViewFactory = (
  descriptor: BrowserDescriptor,
  guard: BrowserNavigationGuard,
  options?: { parentWindow?: BrowserWindow | null },
) => BrowserSurfaceView

export interface BrowserSurfaceServiceOptions {
  factory: BrowserSurfaceViewFactory
  /** 页面事件出口（窄包装到 renderer；只含可展示文本与规范化 URL）。 */
  onEvent?: (event: BrowserSurfaceEvent) => void
  /** 并发会话上限（资源受控）。 */
  maxSessions?: number
}

interface Session {
  id: string
  descriptor: BrowserDescriptor
  view: BrowserSurfaceView
  unsubscribe: () => void
  history: string[]
  index: number
  displayedUrl: string | null
  /** 本次加载的初始 URL（goto 设置）：navigated 事件（含重定向最终地址）优先生效。 */
  pendingDisplay: string | null
  loading: boolean
  failed: string
  crashed: boolean
  unresponsive: boolean
  active: boolean
  /**
   * W6：元素提取引用表——ref → CDP backendNodeId。
   * renderer 只能引用本会话**最近一次清单**里的 ref，不能自造 id；
   * 会话关闭时随会话一并丢弃。
   */
  extractionRefs: Map<string, number>
}

/**
 * SurfaceHost provider 适配器（与 desktop surface-host 的 SurfaceRuntimeProvider
 * 结构兼容）：createView 创建本服务会话视图，视图销毁后经 onViewClosed 清理。
 */
export interface BrowserSurfaceProvider {
  readonly id: string
  readonly kind: 'webcontents'
  /** browser 创建视图但不立即加载 URL（初始空白页，URL 由后续导航决定）。 */
  readonly deferredUrl: true
  createView(input: unknown): WebContentsView
  resolve(): Promise<{ ok: boolean; url?: string; detail?: string }>
  onViewAttached(id: string): void
  onViewDetached(id: string): void
  onViewClosed(id: string): void
}

/** 默认并发会话上限。 */
export const DEFAULT_MAX_BROWSER_SESSIONS = 8

export class BrowserSurfaceService implements IBrowserProvider {
  private readonly sessions = new Map<string, Session>()
  private readonly factory: BrowserSurfaceViewFactory
  private readonly onEvent: (event: BrowserSurfaceEvent) => void
  private readonly maxSessions: number

  constructor(options: BrowserSurfaceServiceOptions) {
    this.factory = options.factory
    this.onEvent = options.onEvent ?? (() => {})
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_BROWSER_SESSIONS
  }

  /** SurfaceHost provider 适配器：视图生命周期由 SurfaceHost 驱动，会话状态由本服务维护。 */
  readonly provider: BrowserSurfaceProvider = {
    id: BROWSER_PROVIDER_ID,
    kind: 'webcontents',
    deferredUrl: true,
    createView: (input: unknown): WebContentsView => this.createSession(input).view.underlying,
    resolve: async () => ({ ok: true }),
    onViewAttached: (id: string): void => {
      const session = this.requireSession(id)
      if (session) session.active = true
    },
    onViewDetached: (id: string): void => {
      const session = this.requireSession(id)
      if (session) session.active = false
    },
    onViewClosed: (id: string): void => {
      const session = this.requireSession(id)
      if (session) {
        // W5.5：SurfaceHost 先销毁视图再回调；DownloadItem 属会话级，
        // 在会话删除前取消在途下载（事件同步上报给存活会话）。
        session.view.cancelDownloads()
        this.closeSession(session)
      }
    },
  }

  /** 直接创建会话（测试/直连入口）；attach 仍由 SurfaceHost.show 完成。 */
  async open(input: unknown): Promise<BrowserOpenResult> {
    try {
      this.createSession(input)
      return { ok: true }
    } catch (reason) {
      return { ok: false, detail: messageOf(reason) }
    }
  }

  async navigate(id: unknown, input: unknown): Promise<BrowserNavigateResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    let url: string
    try {
      url = parseBrowserUrl(extractUrl(input))
    } catch (reason) {
      return { ok: false, detail: messageOf(reason) }
    }
    return this.goto(session, url)
  }

  async back(id: unknown): Promise<BrowserNavigateResult> {
    return this.historyNav(id, -1)
  }

  async forward(id: unknown): Promise<BrowserNavigateResult> {
    return this.historyNav(id, 1)
  }

  async reload(id: unknown): Promise<BrowserNavigateResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    const current = session.index >= 0 ? session.history[session.index] : undefined
    if (current === undefined) return { ok: false, detail: '当前无页面可重载' }
    return this.goto(session, current)
  }

  async stop(id: unknown): Promise<BrowserOpenResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    session.view.stop()
    return { ok: true }
  }

  async activate(id: unknown): Promise<BrowserOpenResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    session.active = true
    return { ok: true }
  }

  async deactivate(id: unknown): Promise<BrowserOpenResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    session.active = false
    return { ok: true }
  }

  /** 直接关闭路径：销毁视图并清理本会话；SurfaceHost.close 路径经 onViewClosed 清理。 */
  async close(id: unknown): Promise<BrowserOpenResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    // W5.5：先取消在途下载（取消事件已同步上报），再销毁视图。
    session.view.cancelDownloads()
    session.view.close()
    this.closeSession(session)
    return { ok: true }
  }

  state(id: unknown): BrowserSessionState | undefined {
    const session = this.requireSession(id)
    if (!session) return undefined
    const currentUrl = session.displayedUrl
      ?? (session.index >= 0 ? (session.history[session.index] ?? null) : null)
    return {
      id: session.id,
      title: session.descriptor.title,
      active: session.active,
      loading: session.loading,
      failed: session.failed,
      crashed: session.crashed,
      unresponsive: session.unresponsive,
      currentUrl,
      canBack: session.index > 0,
      canForward: session.index < session.history.length - 1,
    }
  }

  /**
   * W6：列出页面元素（提取元素·清单）。
   *
   * 元素来源是页面的无障碍树与盒模型（CDP 只读域），不执行页面脚本。
   * 清单成功后本会话记录 ref → 元素 id 映射，供随后的详情请求引用。
   */
  async extractList(id: unknown, input: unknown): Promise<BrowserExtractionListResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, elements: [], detail: sessionError(id) }
    const port = session.view.extraction
    if (!port) return { ok: false, elements: [], detail: '当前浏览器视图不支持元素提取' }
    const { limit } = parseExtractionListRequest(input)
    try {
      const result = await port.listElements(limit)
      session.extractionRefs = new Map()
      result.elements.forEach((element, index) => {
        const backendNodeId = result.backendIds[index]
        if (typeof backendNodeId === 'number') session.extractionRefs.set(element.ref, backendNodeId)
      })
      return {
        ok: true,
        page: {
          url: sanitizeExtractedUrl(result.url),
          title: result.title.slice(0, 200),
          viewport: result.viewport,
        },
        elements: result.elements,
      }
    } catch (reason) {
      return { ok: false, elements: [], detail: messageOf(reason) }
    }
  }

  /**
   * W6：取单个元素详情（提取元素·详情）。
   *
   * 只接受本会话最近一次清单里的 ref——renderer 不能自造 id，
   * 也不能引用别的会话的元素。
   */
  async extractDetail(id: unknown, input: unknown): Promise<BrowserExtractionDetailResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    const port = session.view.extraction
    if (!port) return { ok: false, detail: '当前浏览器视图不支持元素提取' }
    let ref: string
    try {
      ref = parseExtractionDetailRequest(input).ref
    } catch (reason) {
      return { ok: false, detail: messageOf(reason) }
    }
    const backendNodeId = session.extractionRefs.get(ref)
    if (typeof backendNodeId !== 'number') {
      return { ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' }
    }
    try {
      const element = await port.describeElement(backendNodeId)
      if (!element) return { ok: false, detail: '提取详情失败：元素已失效' }
      return { ok: true, element }
    } catch (reason) {
      return { ok: false, detail: messageOf(reason) }
    }
  }

  /** 统一回收：应用退出/窗口关闭路径（销毁全部视图并清理会话）。 */
  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      // W5.5：先取消在途下载（事件同步上报），再销毁视图。
      session.view.cancelDownloads()
      session.view.close()
      this.closeSession(session)
    }
  }

  private createSession(input: unknown): Session {
    const descriptor = parseBrowserDescriptor(input)
    if (this.sessions.has(descriptor.id)) {
      throw new Error(`browser 会话已存在: ${descriptor.id}`)
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`browser 会话超过上限 ${this.maxSessions}`)
    }
    const view = this.factory(descriptor, this.guardNavigation)
    const unsubscribe = view.subscribe((event) => this.handleViewEvent(descriptor.id, event))
    const session: Session = {
      id: descriptor.id,
      descriptor,
      view,
      unsubscribe,
      history: [],
      index: -1,
      displayedUrl: null,
      pendingDisplay: null,
      loading: false,
      failed: '',
      crashed: false,
      unresponsive: false,
      active: true,
      extractionRefs: new Map<string, number>(),
    }
    this.sessions.set(descriptor.id, session)
    return session
  }

  private closeSession(session: Session): void {
    session.unsubscribe()
    this.sessions.delete(session.id)
  }

  /** 会话终态后忽略后续事件（视图销毁与事件到达无固定顺序）。 */
  private handleViewEvent(id: string, event: BrowserViewEvent): void {
    const session = this.sessions.get(id)
    if (!session) return
    switch (event.type) {
      case 'loading':
        session.loading = event.loading
        this.emit({ type: 'loading', id, loading: event.loading })
        break
      case 'failed':
        // 错误消息可能携带页面 URL（已过白名单）；净化兜底剥离任何内嵌凭据，
        // 错误页绝不暴露认证 query 或内部堆栈（W5.3）。
        session.failed = sanitizeBrowserDisplayText(event.message)
        session.loading = false
        this.emit({ type: 'failed', id, errorCode: event.errorCode, message: session.failed })
        break
      case 'navigated':
        // 重定向最终地址同样过白名单与凭据检查；不合法则不记录并上报失败
        // （W5.3 将在此基础上拦截主导航并细化外链规则）。
        try {
          session.displayedUrl = parseBrowserUrl(event.url)
          // 本次加载的最终地址以 navigated 为准（did-navigate 先于 loadURL
          // resolve 到达，goto 随后不得用初始 URL 覆盖）。
          session.pendingDisplay = null
          // W6：页面已换，元素引用作废——清单里的 ref 不再指向新页面。
          session.extractionRefs.clear()
          this.emit({ type: 'navigated', id, url: session.displayedUrl })
        } catch (reason) {
          session.failed = sanitizeBrowserDisplayText(messageOf(reason))
          this.emit({ type: 'failed', id, errorCode: -2, message: session.failed })
        }
        break
      case 'crashed':
        session.crashed = true
        session.loading = false
        this.emit({ type: 'crashed', id })
        break
      case 'unresponsive':
        session.unresponsive = !event.responsive
        this.emit({ type: 'unresponsive', id, responsive: event.responsive })
        break
      case 'permission-denied':
        // W5.4：权限拒绝事件按会话上报（origin+类型，不记页面内容），
        // 面板据此呈现可诊断提示；事件只作用于本会话。
        this.emit({ type: 'permission-denied', id, origin: event.origin, permission: event.permission })
        break
      case 'download':
        // W5.5：下载事件按会话转发（脱敏文件名、来源 origin、进度、终态），
        // 面板据此呈现受控下载状态行；事件只作用于本会话。
        this.emit({
          type: 'download',
          id,
          state: event.state,
          filename: event.filename,
          origin: event.origin,
          percent: event.percent,
        })
        break
    }
  }

  private async historyNav(id: unknown, delta: number): Promise<BrowserNavigateResult> {
    const session = this.requireSession(id)
    if (!session) return { ok: false, detail: sessionError(id) }
    const next = session.index + delta
    const target = session.history[next]
    if (next < 0 || next >= session.history.length || target === undefined) {
      return { ok: false, detail: delta < 0 ? '没有可后退的历史' : '没有可前进的历史' }
    }
    // 历史目标同样过白名单（伪造/污染的历史不绕过协议约束）
    return this.goto(session, target, next)
  }

  private async goto(session: Session, url: string, index?: number): Promise<BrowserNavigateResult> {
    let safe: string
    try {
      safe = parseBrowserUrl(url)
    } catch (reason) {
      return { ok: false, detail: messageOf(reason) }
    }
    session.loading = true
    session.failed = ''
    session.pendingDisplay = safe
    try {
      await session.view.loadURL(safe)
    } catch (reason) {
      session.loading = false
      session.failed = sanitizeBrowserDisplayText(messageOf(reason))
      this.emit({ type: 'failed', id: session.id, errorCode: -1, message: session.failed })
      return { ok: false, url: safe, detail: session.failed }
    }
    session.loading = false
    // 若 navigated 事件（含重定向最终地址）已更新 displayedUrl，保留最终地址；
    // 否则回落到初始 URL（loadURL 已受理但未触发 navigated 的少见情形）。
    session.displayedUrl = session.pendingDisplay ?? session.displayedUrl
    session.pendingDisplay = null
    if (index === undefined) {
      // 新导航截断 forward 分支；加载失败（did-fail-load 事件）不回滚历史，
      // 保留重试入口（reload 当前历史项）。
      session.history = session.history.slice(0, session.index + 1)
      session.history.push(safe)
      session.index = session.history.length - 1
    } else {
      session.index = index
    }
    return { ok: true, url: safe }
  }

  /**
   * 导航守卫（W5.3）：页面内导航（will-frame-navigate）与重定向
   * （will-redirect）的目标 URL 同样过协议白名单与凭据检查——不只检查
   * 地址栏初始输入。守卫由工厂注入 electron-view 使用。
   */
  private guardNavigation(url: string): boolean {
    try {
      parseBrowserUrl(url)
      return true
    } catch {
      return false
    }
  }

  private requireSession(id: unknown): Session | undefined {
    return typeof id === 'string' ? this.sessions.get(id) : undefined
  }

  private emit(event: BrowserSurfaceEvent): void {
    this.onEvent(event)
  }
}

function extractUrl(input: unknown): unknown {
  if (!input || typeof input !== 'object') throw new Error('导航请求必须是对象')
  const value = input as Partial<{ url: unknown }>
  if (typeof value.url !== 'string') throw new Error('导航请求 url 必须是字符串')
  return value.url
}

function sessionError(id: unknown): string {
  return `browser 会话不存在: ${String(id)}`
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
