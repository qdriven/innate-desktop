/**
 * browser 契约（W5.1 定义，W5.2 起消费）：主进程与 renderer 共用的窄类型。
 *
 * 安全默认值（实现前固定，W5.2+ 消费）：
 * - 协议白名单仅 http/https；file/data/javascript/chrome 等默认拒绝，
 *   后续开放须另立评审（W5-browser.md §W5.1.3）；
 * - network:navigate 只表示导航，不自动授予下载、摄像头、麦克风、通知、
 *   剪贴板或任意 JS 执行；
 * - browser 与 Harness/console 使用不同 providerId 与持久 partition，
 *   认证 URL 不能转普通书签；
 * - renderer 只提交安全字段（id/url/标题），不提交 webContents、cookie
 *   或 session 对象；URL 一律经协议白名单与凭据检查。
 */
import { parseSurfaceDescriptor } from '@dogic/core/surface'
import type { SurfaceCapability } from '@dogic/core/surface'
import type {
  BrowserExtractionDetailRequest,
  BrowserExtractionDetailResult,
  BrowserExtractionListRequest,
  BrowserExtractionListResult,
} from './extraction.js'

// W6：元素提取契约（主进程与 renderer 共用）。
export type {
  BrowserElementDetail,
  BrowserElementRect,
  BrowserElementSummary,
  BrowserExtractionDetailRequest,
  BrowserExtractionDetailResult,
  BrowserExtractionListRequest,
  BrowserExtractionListResult,
  BrowserExtractionPage,
} from './extraction.js'

// W6.6：browser IPC 契约（版本化、宿主中立）——通道名、方法签名、能力声明。
// 契约归插件所有：desktop 的任意版本与其他插件都按这份清单接入。
export * from './ipc.js'

export const BROWSER_PROVIDER_ID = 'browser'

/** 浏览器持久分区：与 Harness/console 完全隔离（session.fromPartition 持久化）。 */
export const BROWSER_PARTITION = 'persist:innate-browser'

/** browser Surface 的 capability 声明：仅 network:navigate（Q3 消费导航，不授其他权限）。 */
export const BROWSER_CAPABILITY: SurfaceCapability = 'network:navigate'

/** 协议白名单：仅 http/https；file/data/javascript/chrome/about 等默认拒绝。 */
export const ALLOWED_BROWSER_PROTOCOLS = ['http:', 'https:'] as const

/** 地址栏 URL 长度上限。 */
export const MAX_URL_LENGTH = 4096

/** browser Surface 描述：复用 core 通用 Surface 生命周期，providerId/kind/capability 按 browser 收紧。 */
export interface BrowserDescriptor {
  id: string
  providerId: string
  kind: 'webcontents'
  title: string
  workspaceId?: string
  capabilities: SurfaceCapability[]
}

export interface BrowserOpenResult {
  ok: boolean
  detail?: string
}

export interface BrowserNavigateRequest {
  url: string
}

/** 导航结果：成功回传规范化 URL；失败只回可展示文本。 */
export interface BrowserNavigateResult {
  ok: boolean
  url?: string
  detail?: string
}

export interface BrowserHistoryState {
  currentUrl: string | null
  canBack: boolean
  canForward: boolean
}

/** 会话运行态（W5.2）：除历史外，页面加载/崩溃/无响应只影响本会话并如实上报。 */
export interface BrowserSessionState extends BrowserHistoryState {
  id: string
  title: string
  active: boolean
  loading: boolean
  failed: string
  crashed: boolean
  unresponsive: boolean
}

/**
 * 页面事件流（主进程 → renderer）：加载中/加载失败/主框架导航完成/崩溃/
 * 无响应恢复/权限拒绝（W5.4：origin+类型，不记页面内容）/下载
 * （W5.5：受控下载——只进用户确认路径，事件含脱敏文件名、来源 origin、
 * 进度与终态）。事件只携带可展示文本与规范化 URL，不携带 webContents
 * 或 session 对象；重定向最终地址的再校验在 W5.3 收紧（navigation guard）。
 */
export type DownloadState = 'started' | 'progress' | 'completed' | 'cancelled' | 'failed'

/** 下载展示字段（W5.5）：脱敏文件名、来源 origin、进度、状态——面板状态行消费。 */
export interface DownloadStatus {
  filename: string
  origin: string
  percent: number
  state: DownloadState
}

export type BrowserSurfaceEvent =
  | { type: 'loading'; id: string; loading: boolean }
  | { type: 'failed'; id: string; errorCode: number; message: string }
  | { type: 'navigated'; id: string; url: string }
  | { type: 'crashed'; id: string }
  | { type: 'unresponsive'; id: string; responsive: boolean }
  | { type: 'permission-denied'; id: string; origin: string; permission: string }
  | {
      type: 'download'
      id: string
      state: DownloadState
      filename: string
      origin: string
      percent: number
    }

/**
 * 错误页展示文本净化（W5.3）：错误消息可能携带页面自身 URL（入口已过白名单），
 * 但任何内嵌凭据一律剥离——错误页绝不暴露认证 query、凭据或内部堆栈。
 */
export function sanitizeBrowserDisplayText(input: string): string {
  // 剥离 //user:pass@ 形式的内嵌凭据（防御性：入口与重定向守卫已拒绝，此处兜底）。
  return input.replace(/\/\/[^/@\s]*@/g, '//')
}

/**
 * browser provider 最小接口（W5.1 定义，W5.2 起由 BrowserSurfaceService 实现）：
 * open/navigate/back/forward/reload/stop/activate/deactivate/close。
 * 输入一律为不可信 unknown，由实现方在策略层解析。
 */
export interface BrowserProvider {
  open(input: unknown): Promise<BrowserOpenResult>
  navigate(id: unknown, request: unknown): Promise<BrowserNavigateResult>
  back(id: unknown): Promise<BrowserNavigateResult>
  forward(id: unknown): Promise<BrowserNavigateResult>
  reload(id: unknown): Promise<BrowserNavigateResult>
  stop(id: unknown): Promise<BrowserOpenResult>
  activate(id: unknown): Promise<BrowserOpenResult>
  deactivate(id: unknown): Promise<BrowserOpenResult>
  close(id: unknown): Promise<BrowserOpenResult>
  state(id: unknown): BrowserSessionState | undefined
}

/**
 * preload 暴露给 renderer 的 browser 窄通道（W5.3 地址栏消费）：
 * 只提交安全字段（会话 id + 规范化 URL），事件由主进程主动推送，
 * renderer 无法伪造来源，也不持有 webContents/session 对象。
 */
export interface BrowserApi {
  browserNavigate(id: string, request: BrowserNavigateRequest): Promise<BrowserNavigateResult>
  browserBack(id: string): Promise<BrowserNavigateResult>
  browserForward(id: string): Promise<BrowserNavigateResult>
  browserReload(id: string): Promise<BrowserNavigateResult>
  browserStop(id: string): Promise<BrowserOpenResult>
  browserState(id: string): Promise<BrowserSessionState | null>
  browserOnEvent(cb: (event: BrowserSurfaceEvent) => void): () => void
  /**
   * W6：列出页面元素（提取元素·清单）。
   * renderer 只提交会话 id 与条数上限；元素引用由主进程签发，
   * renderer 不能自造 id，也不能指定 CDP 方法。
   */
  browserExtractList(id: string, request?: BrowserExtractionListRequest): Promise<BrowserExtractionListResult>
  /** W6：取单个元素详情（提取元素·详情）；ref 必须来自上一次清单。 */
  browserExtractDetail(id: string, request: BrowserExtractionDetailRequest): Promise<BrowserExtractionDetailResult>
}

const browserIdPattern = /^[A-Za-z0-9_-]{1,64}$/

function invalid(detail: string): never {
  throw new Error(detail)
}

/**
 * 解析不可信 browser descriptor。复用 core 通用白名单（kind/capability 全集），
 * 再按 browser 语义收紧：providerId 必须是 browser、kind 必须是 webcontents、
 * capability 只能是 network:navigate（browser 不得声明 process:execute 等）。
 */
export function parseBrowserDescriptor(input: unknown): BrowserDescriptor {
  const surface = parseSurfaceDescriptor(input)
  if (surface.providerId !== BROWSER_PROVIDER_ID) {
    invalid(`browser providerId 不受支持: ${surface.providerId}`)
  }
  if (surface.kind !== 'webcontents') invalid('browser kind 必须是 webcontents')
  if (!browserIdPattern.test(surface.id)) {
    invalid('browser id 必须是 1-64 位字母数字/下划线/连字符')
  }
  if (surface.title.length > 120) invalid('browser title 必须 ≤120 字符')
  const capabilities = surface.capabilities ?? [BROWSER_CAPABILITY]
  for (const capability of capabilities) {
    if (capability !== BROWSER_CAPABILITY) {
      invalid(`browser capability 不受支持: ${capability}`)
    }
  }
  return {
    id: surface.id,
    providerId: BROWSER_PROVIDER_ID,
    kind: 'webcontents',
    title: surface.title,
    ...(surface.workspaceId ? { workspaceId: surface.workspaceId } : {}),
    capabilities,
  }
}

/**
 * 解析不可信 URL：必须是带协议的完整地址，协议命中 http/https 白名单，
 * 且不允许内嵌凭据（认证 URL 不得经普通导航进入 browser）。
 * 返回规范化后的 URL（URL 解析器统一小写协议、补默认端口/路径）。
 */
export function parseBrowserUrl(input: unknown): string {
  if (typeof input !== 'string') invalid('browser url 必须是字符串')
  const raw = input.trim()
  if (raw.length === 0) invalid('browser url 不能为空')
  if (raw.length > MAX_URL_LENGTH) invalid(`browser url 超过 ${MAX_URL_LENGTH} 字符上限`)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    invalid('browser url 无法解析（需要带协议的完整地址）')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    invalid(`browser 协议不受支持: ${url.protocol}`)
  }
  if (url.username !== '' || url.password !== '') {
    invalid('browser url 不允许内嵌凭据')
  }
  return url.toString()
}
