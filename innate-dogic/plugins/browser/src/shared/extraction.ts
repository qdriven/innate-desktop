/**
 * 元素提取契约（W6）：主进程与 renderer 共用的窄类型。
 *
 * 设计前提（见 docs/orca/browser-module-analysis.md）：
 * - 提取全程**不执行页面脚本**——只用 Chrome DevTools Protocol 的
 *   DOM / Accessibility / Page.captureScreenshot 三个域；
 * - renderer 拿不到 CDP 内部 id：主进程用不透明 `ref` 做映射，
 *   renderer 只能引用主进程刚刚枚举出来的元素；
 * - 元素属性走白名单、凭据形态脱敏、URL 剥 query/hash，
 *   长度按预算截断（与 orca GRAB_BUDGET 同型但更严）；
 * - 提取结果只描述「结构与文本」，不携带页面 DOM 全文、cookie、
 *   表单值或任何认证状态。
 */

/** 元素几何（CSS 像素，视口坐标）。 */
export interface BrowserElementRect {
  x: number
  y: number
  width: number
  height: number
}

/** 元素清单条目：主进程枚举后交给 renderer 的安全摘要。 */
export interface BrowserElementSummary {
  /** 不透明引用（主进程维护映射，renderer 不能反推 CDP 内部 id）。 */
  ref: string
  /** 无障碍角色（button/link/textbox…）。 */
  role: string
  /** 无障碍名称（可见文案）。 */
  name: string
  /** 标签名（大写，如 BUTTON）。 */
  tagName: string
  /** 视口几何；拿不到时为 null。 */
  rect: BrowserElementRect | null
}

/** 页面上下文：URL 已剥 query 与 hash（可能带凭据），只保留 origin+path。 */
export interface BrowserExtractionPage {
  url: string
  title: string
  viewport: {
    width: number
    height: number
  }
}

/** 元素详情：属性白名单 + 脱敏 + 预算后的可展示结果。 */
export interface BrowserElementDetail {
  tagName: string
  role: string | null
  name: string | null
  /** 结构选择器（主进程由 DOM 树推导，不执行页面脚本）。 */
  selector: string | null
  /** 祖先语义路径（role/name 链）。 */
  path: string[]
  /** 元素可见文本片段。 */
  textSnippet: string
  /** 白名单属性（已脱敏）。 */
  attributes: Record<string, string>
  rect: BrowserElementRect | null
  /** 元素区域截图（可选；超过预算则省略）。 */
  screenshot?: {
    dataUrl: string
    width: number
    height: number
  }
}

/** 元素清单结果。 */
export interface BrowserExtractionListResult {
  ok: boolean
  page?: BrowserExtractionPage
  elements: BrowserElementSummary[]
  detail?: string
}

/** 元素详情结果。 */
export interface BrowserExtractionDetailResult {
  ok: boolean
  page?: BrowserExtractionPage
  element?: BrowserElementDetail
  detail?: string
}

/** 提取清单请求（renderer → 主进程）。 */
export interface BrowserExtractionListRequest {
  limit?: number
}

/** 提取详情请求（renderer → 主进程）。 */
export interface BrowserExtractionDetailRequest {
  ref: string
}
