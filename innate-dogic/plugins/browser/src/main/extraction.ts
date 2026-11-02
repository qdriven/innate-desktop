/**
 * 元素提取策略（W6）：纯逻辑，不依赖 electron。
 *
 * 取自 orca 的 AI Grab 安全设计（docs/orca/browser-module-analysis.md §1.3），
 * 但更严：orca 的「人工点选」必须往页面注入脚本，本模块对应的路线
 * **完全不执行页面脚本**——主进程只用 CDP 的 DOM / Accessibility /
 * Page.captureScreenshot 三个域取数。
 *
 * 规则：
 * - 属性白名单：只保留结构性属性与全部 aria-*，其余丢弃；
 * - 凭据形态脱敏：命中凭据关键字的值替换为 `[redacted]`；
 * - URL 净化：仅 http/https，剥除 query 与 hash（认证信息不进结果）；
 * - 长度预算：逐字段截断，避免单页元素把上下文撑爆；
 * - 双层校验：CDP 返回值在本模块钳制一次，主进程边界再钳制一次
 *   （同 orca clampGrabPayload 的做法）；
 * - CDP 方法白名单：不含 Runtime.*——任何可执行页面脚本的方法都不允许。
 */

/** 提取预算（逐字段长度上限）。 */
export const BROWSER_EXTRACTION_BUDGET = {
  /** 元素可见文本片段上限。 */
  textSnippetMaxLength: 200,
  /** 结构选择器上限。 */
  selectorMaxLength: 700,
  /** 无障碍名称上限。 */
  nameMaxLength: 200,
  /** 角色上限。 */
  roleMaxLength: 100,
  /** 标签名上限。 */
  tagNameMaxLength: 50,
  /** 祖先路径项数上限。 */
  pathMaxEntries: 10,
  /** 属性条目数上限。 */
  attributeMaxEntries: 24,
  /** 属性值上限（class 单独更严）。 */
  attributeValueMaxLength: 500,
  /** class 属性值上限。 */
  classValueMaxLength: 200,
  /** 清单元素数上限。 */
  elementMaxEntries: 100,
  /** 清单默认元素数。 */
  defaultElementLimit: 50,
  /** 元素区域截图字节上限（超过则省略截图）。 */
  screenshotMaxBytes: 2 * 1024 * 1024,
} as const

/**
 * 可保留的属性名白名单。
 * 与 orca 的 GRAB_SAFE_ATTRIBUTE_NAMES 同型，去掉 src（图片地址常带签名参数）。
 */
export const BROWSER_SAFE_ATTRIBUTE_NAMES: ReadonlySet<string> = new Set([
  'id',
  'class',
  'name',
  'type',
  'role',
  'href',
  'alt',
  'title',
  'placeholder',
  'for',
  'action',
  'method',
])

/**
 * 凭据形态关键字：命中即脱敏。
 * 刻意不做「code/state」这类宽泛匹配——它们会误伤普通 CSS class。
 */
export const BROWSER_SECRET_PATTERNS: readonly string[] = [
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'client_secret',
  'oauth_state',
  'x-amz-',
  'session_id',
  'sessionid',
  'csrf',
  'secret',
  'password',
  'passwd',
]

/**
 * 元素提取允许的 CDP 方法白名单。
 * 刻意**不含** Runtime.*（等价于页面脚本执行），也不含 Page.navigate 等副作用方法。
 */
export const BROWSER_EXTRACTION_CDP_METHODS: ReadonlySet<string> = new Set([
  'DOM.enable',
  'DOM.getDocument',
  'DOM.describeNode',
  'DOM.getBoxModel',
  'DOM.getOuterHTML',
  'Accessibility.enable',
  'Accessibility.getFullAXTree',
  'Page.enable',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
])

/** 判断某个 CDP 方法是否在提取白名单内。 */
export function isAllowedExtractionCdpMethod(method: string): boolean {
  return BROWSER_EXTRACTION_CDP_METHODS.has(method)
}

/** 截断文本，超长时补「(truncated)」标记。 */
export function clampText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  return `${text.slice(0, max)} (truncated)`
}

/** 归一化数值：非有限数回落到 0。 */
function clampNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** 判定字符串是否含凭据形态。 */
export function containsSecretPattern(value: string): boolean {
  const lower = value.toLowerCase()
  return BROWSER_SECRET_PATTERNS.some((pattern) => lower.includes(pattern))
}

/**
 * 净化提取结果里的 URL：仅 http/https，并剥除 query 与 hash。
 * 认证 URL（含 token 的 query）因此不会进入提取结果。
 */
export function sanitizeExtractedUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return ''
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  url.search = ''
  url.hash = ''
  return url.toString()
}

/** 属性白名单过滤 + 凭据脱敏 + URL 净化 + 长度预算。 */
export function clampExtractedAttributes(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object') return {}
  const filtered: Record<string, string> = {}
  let count = 0
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= BROWSER_EXTRACTION_BUDGET.attributeMaxEntries) break
    const name = key.toLowerCase()
    const isAria = name.startsWith('aria-')
    if (!isAria && !BROWSER_SAFE_ATTRIBUTE_NAMES.has(name)) continue
    const text = typeof value === 'string' ? value : ''
    if (containsSecretPattern(text)) {
      filtered[name] = '[redacted]'
    } else if (name === 'href' || name === 'action') {
      filtered[name] = sanitizeExtractedUrl(text)
    } else if (name === 'class') {
      filtered[name] = clampText(text, BROWSER_EXTRACTION_BUDGET.classValueMaxLength)
    } else {
      filtered[name] = clampText(text, BROWSER_EXTRACTION_BUDGET.attributeValueMaxLength)
    }
    count += 1
  }
  return filtered
}

/** 几何钳制：非有限值归零。 */
export function clampExtractedRect(input: unknown): {
  x: number
  y: number
  width: number
  height: number
} | null {
  if (!input || typeof input !== 'object') return null
  const rect = input as Record<string, unknown>
  return {
    x: clampNumber(rect.x),
    y: clampNumber(rect.y),
    width: clampNumber(rect.width),
    height: clampNumber(rect.height),
  }
}

/** 生成不透明元素引用（1 起始）。 */
export function makeElementRef(index: number): string {
  return `el-${index}`
}

/** 解析元素引用回序号；非法返回 null。 */
export function parseElementRef(raw: unknown): number | null {
  if (typeof raw !== 'string') return null
  const match = /^el-(\d{1,6})$/.exec(raw)
  if (!match) return null
  const index = Number(match[1])
  if (!Number.isInteger(index) || index < 1) return null
  return index
}

/**
 * 解析元素清单请求（不可信输入）：limit 缺省取默认值，
 * 非法或超限一律夹到 [1, elementMaxEntries]。
 */
export function parseExtractionListRequest(input: unknown): { limit: number } {
  const raw = (input && typeof input === 'object'
    ? (input as { limit?: unknown }).limit
    : undefined)
  const fallback = BROWSER_EXTRACTION_BUDGET.defaultElementLimit
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return { limit: fallback }
  const limit = Math.floor(raw)
  if (limit < 1) return { limit: 1 }
  if (limit > BROWSER_EXTRACTION_BUDGET.elementMaxEntries) {
    return { limit: BROWSER_EXTRACTION_BUDGET.elementMaxEntries }
  }
  return { limit }
}

/** 解析元素详情请求（不可信输入）：ref 必须是 `el-<n>` 形态。 */
export function parseExtractionDetailRequest(input: unknown): { ref: string } {
  const raw = input && typeof input === 'object'
    ? (input as { ref?: unknown }).ref
    : undefined
  if (typeof raw !== 'string') throw new Error('提取详情 ref 必须是字符串')
  if (!parseElementRef(raw)) throw new Error('提取详情 ref 无效')
  return { ref: raw }
}

/** 校验元素清单条目（不可信输入）；结构非法返回 null。 */
export function clampElementSummary(input: unknown): {
  role: string
  name: string
  tagName: string
  rect: { x: number; y: number; width: number; height: number } | null
} | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const role = typeof raw.role === 'string' ? raw.role : ''
  const name = typeof raw.name === 'string' ? raw.name : ''
  const tagName = typeof raw.tagName === 'string' ? raw.tagName : ''
  if (role === '' && name === '' && tagName === '') return null
  return {
    role: clampText(role, BROWSER_EXTRACTION_BUDGET.roleMaxLength),
    name: clampText(name, BROWSER_EXTRACTION_BUDGET.nameMaxLength),
    tagName: clampText(tagName, BROWSER_EXTRACTION_BUDGET.tagNameMaxLength),
    rect: clampExtractedRect(raw.rect),
  }
}

/** 校验元素详情（不可信输入）；结构非法返回 null。 */
export function clampElementDetail(input: unknown): {
  tagName: string
  role: string | null
  name: string | null
  selector: string | null
  path: string[]
  textSnippet: string
  attributes: Record<string, string>
  rect: { x: number; y: number; width: number; height: number } | null
  screenshot?: { dataUrl: string; width: number; height: number }
} | null {
  if (!input || typeof input !== 'object') return null
  const raw = input as Record<string, unknown>
  const tagName = typeof raw.tagName === 'string' ? raw.tagName : ''
  if (tagName === '') return null
  const role = typeof raw.role === 'string' && raw.role !== ''
    ? clampText(raw.role, BROWSER_EXTRACTION_BUDGET.roleMaxLength)
    : null
  const name = typeof raw.name === 'string' && raw.name !== ''
    ? clampText(raw.name, BROWSER_EXTRACTION_BUDGET.nameMaxLength)
    : null
  const selector = typeof raw.selector === 'string' && raw.selector !== ''
    ? clampText(raw.selector, BROWSER_EXTRACTION_BUDGET.selectorMaxLength)
    : null
  const path = Array.isArray(raw.path)
    ? raw.path
        .filter((item): item is string => typeof item === 'string')
        .slice(0, BROWSER_EXTRACTION_BUDGET.pathMaxEntries)
        .map((item) => clampText(item, BROWSER_EXTRACTION_BUDGET.nameMaxLength))
    : []
  const textSnippet = clampText(
    typeof raw.textSnippet === 'string' ? raw.textSnippet : '',
    BROWSER_EXTRACTION_BUDGET.textSnippetMaxLength,
  )
  const attributes = clampExtractedAttributes(raw.attributes)
  const rect = clampExtractedRect(raw.rect)
  const screenshotRaw = raw.screenshot
  let screenshot: { dataUrl: string; width: number; height: number } | undefined
  if (screenshotRaw && typeof screenshotRaw === 'object') {
    const shot = screenshotRaw as Record<string, unknown>
    const dataUrl = typeof shot.dataUrl === 'string' ? shot.dataUrl : ''
    // 超过字节预算则省略截图（上下文预算优先）。
    if (dataUrl.startsWith('data:image/png') && dataUrl.length <= BROWSER_EXTRACTION_BUDGET.screenshotMaxBytes) {
      screenshot = {
        dataUrl,
        width: clampNumber(shot.width),
        height: clampNumber(shot.height),
      }
    }
  }
  return {
    tagName: clampText(tagName, BROWSER_EXTRACTION_BUDGET.tagNameMaxLength),
    role,
    name,
    selector,
    path,
    textSnippet,
    attributes,
    rect,
    ...(screenshot ? { screenshot } : {}),
  }
}
