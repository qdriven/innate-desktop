/**
 * 元素提取的 CDP 绑定（W6）：只用 Chrome DevTools Protocol 取数。
 *
 * 红线（与 W5 的「禁止 executeJavaScript」一致）：
 * - **不执行任何页面脚本**：不调用 `Runtime.evaluate`、不用
 *   `webContents.executeJavaScript`、不往页面注入任何代码；
 * - 只发白名单内的只读 CDP 方法（见 extraction.ts 的
 *   BROWSER_EXTRACTION_CDP_METHODS）：DOM / Accessibility / Page 只读域；
 * - 每次操作前临时 attach、结束后立刻 detach——CDP 通道只在用户
 *   触发的提取动作期间存在，不常驻；
 * - renderer 不能指定方法名，只能请求「列清单」或「取详情」。
 */
import type { WebContents } from 'electron'
import {
  clampElementDetail,
  clampElementSummary,
  isAllowedExtractionCdpMethod,
  makeElementRef,
  sanitizeExtractedUrl,
} from './extraction.js'
import type { BrowserElementDetail, BrowserElementSummary } from '../shared/extraction.js'

/** CDP 协议版本（Electron 43 支持 1.3）。 */
const CDP_PROTOCOL_VERSION = '1.3'

/** 视为「可交互」的无障碍角色（清单优先收录这些）。 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
])

/** CDP 返回的 AX 节点（只取需要的字段）。 */
interface AxNode {
  nodeId?: string
  parentId?: string
  childIds?: string[]
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  backendDOMNodeId?: number
}

/** CDP 返回的 DOM 节点（只取需要的字段）。 */
interface DomNode {
  nodeId?: number
  backendNodeId?: number
  nodeName?: string
  localName?: string
  attributes?: string[]
  children?: DomNode[]
  parentId?: number
}

/** CDP 返回的盒模型。 */
interface BoxModel {
  content?: number[]
  border?: number[]
}

/** 提取端口（由视图实现注入，服务层消费）。 */
export interface BrowserExtractionPort {
  /** 枚举页面元素（AX 树 + 盒模型）。 */
  listElements(limit: number): Promise<{
    url: string
    title: string
    viewport: { width: number; height: number }
    elements: BrowserElementSummary[]
    /** 主进程内部用的 backendNodeId（不发给 renderer）。 */
    backendIds: number[]
  }>
  /** 取元素详情（含属性、文本、几何与可选区域截图）。 */
  describeElement(backendNodeId: number): Promise<BrowserElementDetail | null>
}

/** CDP 客户端：attach/detach 生命周期 + 白名单方法派发。 */
class CdpClient {
  constructor(private readonly webContents: WebContents) {}

  async run<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (!isAllowedExtractionCdpMethod(method)) {
      throw new Error(`CDP 方法不在提取白名单内: ${method}`)
    }
    const debuggerApi = this.webContents.debugger
    const attached = debuggerApi.isAttached()
    if (!attached) {
      debuggerApi.attach(CDP_PROTOCOL_VERSION)
    }
    try {
      return (await debuggerApi.sendCommand(method, params ?? {})) as T
    } finally {
      if (!attached && debuggerApi.isAttached()) {
        try {
          debuggerApi.detach()
        } catch {
          /* 视图销毁等竞态：忽略 */
        }
      }
    }
  }
}

/** 读取 AX 节点的字符串值（CDP 的 value 可能是字符串或对象）。 */
function axString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const inner = (value as { value?: unknown }).value
    if (typeof inner === 'string') return inner
  }
  return ''
}

/** 由盒模型算出视口矩形。 */
function rectFromBoxModel(model: BoxModel | undefined): {
  x: number
  y: number
  width: number
  height: number
} | null {
  const quad = model?.content ?? model?.border
  if (!quad || quad.length < 8) return null
  const xs = [quad[0], quad[2], quad[4], quad[6]]
  const ys = [quad[1], quad[3], quad[5], quad[7]]
  const x = Math.min(...xs)
  const y = Math.min(...ys)
  return {
    x,
    y,
    width: Math.max(...xs) - x,
    height: Math.max(...ys) - y,
  }
}

/** 在 DOM 树里定位 backendNodeId，并自底向上拼出结构选择器。 */
function buildSelector(root: DomNode | undefined, backendNodeId: number): string | null {
  if (!root) return null
  const parentOf = new Map<number, DomNode>()
  const walk = (node: DomNode): void => {
    for (const child of node.children ?? []) {
      if (typeof child.nodeId === 'number') parentOf.set(child.nodeId, node)
      walk(child)
    }
  }
  walk(root)
  const byBackendId = new Map<number, DomNode>()
  const collect = (node: DomNode): void => {
    if (typeof node.backendNodeId === 'number') byBackendId.set(node.backendNodeId, node)
    for (const child of node.children ?? []) collect(child)
  }
  collect(root)
  let current: DomNode | undefined = byBackendId.get(backendNodeId)
  if (!current) return null
  const parts: string[] = []
  let guard = 0
  while (current && guard < 32) {
    guard += 1
    const tag = (current.localName ?? current.nodeName ?? '').toLowerCase()
    if (!tag) break
    const parent: DomNode | undefined = typeof current.nodeId === 'number'
      ? parentOf.get(current.nodeId)
      : undefined
    const siblings: DomNode[] = (parent?.children ?? []).filter((child: DomNode) => {
      const childTag = (child.localName ?? child.nodeName ?? '').toLowerCase()
      return childTag === tag
    })
    if (siblings.length > 1) {
      const index = siblings.indexOf(current) + 1
      parts.unshift(`${tag}:nth-of-type(${index})`)
    } else {
      parts.unshift(tag)
    }
    if (!parent) break
    current = parent
  }
  return parts.join(' > ') || null
}

/** 由外层 HTML 粗取可见文本（去标签、压空白）。 */
function textFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 创建 CDP 提取端口。视图实现（electron-view）在建视图时创建本端口并挂到视图上。
 */
export function createElectronExtractionPort(webContents: WebContents): BrowserExtractionPort {
  const client = new CdpClient(webContents)

  return {
    async listElements(limit) {
      const url = webContents.getURL()
      const title = webContents.getTitle()
      const metrics = await client.run<{
        cssLayoutViewport?: { clientWidth?: number; clientHeight?: number }
      }>('Page.getLayoutMetrics')
      const viewport = {
        width: metrics.cssLayoutViewport?.clientWidth ?? 0,
        height: metrics.cssLayoutViewport?.clientHeight ?? 0,
      }

      await client.run('Accessibility.enable')
      const ax = await client.run<{ nodes?: AxNode[] }>('Accessibility.getFullAXTree')
      const nodes = ax.nodes ?? []
      const byId = new Map<string, AxNode>()
      for (const node of nodes) {
        if (node.nodeId) byId.set(node.nodeId, node)
      }

      // 先按角色/名称筛出候选，再取盒模型（盒模型是逐节点调用，需限量）。
      const candidates: { node: AxNode; role: string; name: string }[] = []
      for (const node of nodes) {
        if (node.ignored === true) continue
        if (typeof node.backendDOMNodeId !== 'number') continue
        const role = axString(node.role?.value)
        const name = axString(node.name?.value).trim()
        if (!role && !name) continue
        const interactive = INTERACTIVE_ROLES.has(role.toLowerCase())
        if (!interactive && name.length === 0) continue
        candidates.push({ node, role, name })
      }
      candidates.sort((a, b) => b.name.length - a.name.length)

      await client.run('DOM.enable')
      const elements: BrowserElementSummary[] = []
      const backendIds: number[] = []
      for (const candidate of candidates) {
        if (elements.length >= limit) break
        const backendNodeId = candidate.node.backendDOMNodeId as number
        let rect: { x: number; y: number; width: number; height: number } | null = null
        try {
          const box = await client.run<{ model?: BoxModel }>('DOM.getBoxModel', { backendNodeId })
          rect = rectFromBoxModel(box.model)
        } catch {
          rect = null
        }
        const described = await describeNode(client, backendNodeId)
        const summary = clampElementSummary({
          role: candidate.role,
          name: candidate.name,
          tagName: described?.tagName ?? '',
          rect,
        })
        if (!summary) continue
        elements.push({ ref: makeElementRef(elements.length + 1), ...summary })
        backendIds.push(backendNodeId)
      }
      return { url, title, viewport, elements, backendIds }
    },

    async describeElement(backendNodeId) {
      const described = await describeNode(client, backendNodeId)
      if (!described) return null
      let rect: { x: number; y: number; width: number; height: number } | null = null
      try {
        const box = await client.run<{ model?: BoxModel }>('DOM.getBoxModel', { backendNodeId })
        rect = rectFromBoxModel(box.model)
      } catch {
        rect = null
      }
      let selector: string | null = null
      try {
        const document = await client.run<{ root?: DomNode }>('DOM.getDocument', { depth: -1 })
        selector = buildSelector(document.root, backendNodeId)
      } catch {
        selector = null
      }
      let html = ''
      try {
        const outer = await client.run<{ outerHTML?: string }>('DOM.getOuterHTML', { backendNodeId })
        html = outer.outerHTML ?? ''
      } catch {
        html = ''
      }
      const detail = clampElementDetail({
        tagName: described.tagName,
        role: described.role,
        name: described.name,
        selector,
        path: described.path,
        textSnippet: textFromHtml(html),
        attributes: described.attributes,
        rect,
        screenshot: await captureElementScreenshot(client, rect),
      })
      return detail
    },
  }
}

/** 取节点的结构信息（标签名、属性、语义路径）。 */
async function describeNode(
  client: CdpClient,
  backendNodeId: number,
): Promise<{
  tagName: string
  role: string | null
  name: string | null
  path: string[]
  attributes: Record<string, string>
} | null> {
  let node: DomNode | undefined
  try {
    const result = await client.run<{ node?: DomNode }>('DOM.describeNode', { backendNodeId })
    node = result.node
  } catch {
    return null
  }
  if (!node) return null
  const attributes: Record<string, string> = {}
  const flat = node.attributes ?? []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const key = flat[i]
    const value = flat[i + 1]
    if (typeof key === 'string' && typeof value === 'string') attributes[key] = value
  }
  const tagName = (node.nodeName ?? node.localName ?? '').toLowerCase()
  return {
    tagName,
    role: typeof attributes.role === 'string' ? attributes.role : null,
    name: typeof attributes.aria_label === 'string'
      ? attributes.aria_label
      : typeof attributes.title === 'string'
        ? attributes.title
        : null,
    path: [],
    attributes,
  }
}

/** 元素区域截图；失败或无几何时省略（截图是可选增强）。 */
async function captureElementScreenshot(
  client: CdpClient,
  rect: { x: number; y: number; width: number; height: number } | null,
): Promise<{ dataUrl: string; width: number; height: number } | undefined> {
  if (!rect || rect.width <= 0 || rect.height <= 0) return undefined
  try {
    const shot = await client.run<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      clip: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        scale: 1,
      },
    })
    if (!shot.data) return undefined
    return {
      dataUrl: `data:image/png;base64,${shot.data}`,
      width: rect.width,
      height: rect.height,
    }
  } catch {
    return undefined
  }
}

/** 导出净化 URL 供视图层复用（页面 URL 一律剥 query/hash）。 */
export { sanitizeExtractedUrl }
