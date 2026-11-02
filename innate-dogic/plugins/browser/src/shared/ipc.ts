/**
 * browser 插件的 IPC 契约（W6.6 定义）。
 *
 * **契约归插件，不归宿主。** 通道名、方法签名、能力声明与版本号全部由本文件
 * 定义；宿主（desktop 的任意版本、其他插件）不复制通道映射，只做两件事：
 *
 *   1. 主进程侧：`registerBrowserIpc(host, createBrowserIpcHandlers(service))`
 *      —— 宿主提供自己的注册机制（Electron ipcMain、MessagePort、RPC……），
 *         插件负责把方法映射到契约通道；
 *   2. 渲染侧：`createBrowserApi(transport)`
 *      —— 宿主提供自己的传输（Electron ipcRenderer、进程内直调、跨插件 RPC）。
 *
 * 之所以要显式契约：本仓的 browser 可能被不同宿主消费——同一份插件代码要能
 * 跑在不同 desktop 版本上，也要能被别的插件复用。若通道名散落在各宿主
 * 源码里，插件升级与宿主升级就会互相踩；契约把「插件暴露什么、参数与返回
 * 是什么、需要什么能力、版本如何协商」固定成一份可核查的清单。
 *
 * 兼容性规则（fail closed）：
 * - 契约 major 与宿主 major 不一致 → 不兼容，宿主必须拒绝注册；
 * - 同 major 时宿主 minor ≥ 契约 minor → 兼容（宿主至少实现本契约）；
 * - 版本不可解析 → 视为不兼容。
 * 宁可拒绝注册，也不做「部分通道降级」——降级会让不同宿主行为不一致。
 *
 * 红线：契约内**不含任何页面脚本执行通道**（无 executeJavaScript / eval /
 * Runtime.*）。assertNoScriptChannel 在注册时与测试中双重强制。
 *
 * 本模块只含类型导入，编译产物无运行时依赖，可安全被 preload / 沙箱渲染
 * 进程直接引用。
 */
import type {
  BrowserApi,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserOpenResult,
  BrowserSessionState,
  BrowserSurfaceEvent,
} from './index.js'
import type {
  BrowserExtractionDetailRequest,
  BrowserExtractionDetailResult,
  BrowserExtractionListRequest,
  BrowserExtractionListResult,
} from './extraction.js'

/** 契约版本：语义化 major.minor。 */
export const BROWSER_IPC_CONTRACT_VERSION = '1.0'

/**
 * 调用通道（主进程 → 渲染进程为请求-应答；渲染进程 → 主进程为推送事件）。
 *
 * 通道名由插件定义并保持稳定：宿主按名字注册，不按顺序或下标绑定。
 * 新增方法是**向后兼容**的（契约 minor +1）；改名或改签名不是。
 */
export const BROWSER_IPC_CHANNELS = {
  navigate: 'innate:browserNavigate',
  back: 'innate:browserBack',
  forward: 'innate:browserForward',
  reload: 'innate:browserReload',
  stop: 'innate:browserStop',
  state: 'innate:browserState',
  extractList: 'innate:browserExtractList',
  extractDetail: 'innate:browserExtractDetail',
} as const

/** 页面事件推送通道（主进程主动推，渲染进程订阅）。 */
export const BROWSER_IPC_EVENT_CHANNEL = 'innate:browser-event'

export type BrowserIpcMethod = keyof typeof BROWSER_IPC_CHANNELS

/** 通道 → 方法的反查表（供按通道分发的宿主使用）。 */
export const BROWSER_IPC_METHOD_BY_CHANNEL: Readonly<Record<string, BrowserIpcMethod>> = {
  [BROWSER_IPC_CHANNELS.navigate]: 'navigate',
  [BROWSER_IPC_CHANNELS.back]: 'back',
  [BROWSER_IPC_CHANNELS.forward]: 'forward',
  [BROWSER_IPC_CHANNELS.reload]: 'reload',
  [BROWSER_IPC_CHANNELS.stop]: 'stop',
  [BROWSER_IPC_CHANNELS.state]: 'state',
  [BROWSER_IPC_CHANNELS.extractList]: 'extractList',
  [BROWSER_IPC_CHANNELS.extractDetail]: 'extractDetail',
}

/** 各方法的请求体（无请求体的方法为 undefined）。 */
export interface BrowserIpcRequestMap {
  navigate: BrowserNavigateRequest
  back: undefined
  forward: undefined
  reload: undefined
  stop: undefined
  state: undefined
  extractList: BrowserExtractionListRequest
  extractDetail: BrowserExtractionDetailRequest
}

/** 各方法的返回值。 */
export interface BrowserIpcResponseMap {
  navigate: BrowserNavigateResult
  back: BrowserNavigateResult
  forward: BrowserNavigateResult
  reload: BrowserNavigateResult
  stop: BrowserOpenResult
  state: BrowserSessionState | null
  extractList: BrowserExtractionListResult
  extractDetail: BrowserExtractionDetailResult
}

export type BrowserIpcMethodPayload<M extends BrowserIpcMethod> = BrowserIpcRequestMap[M]
export type BrowserIpcMethodResult<M extends BrowserIpcMethod> = BrowserIpcResponseMap[M]

/**
 * 契约授予的能力位。宿主据此判断是否放行某个方法：
 * - network:navigate：导航/历史（与 core SurfaceCapability 同名同义）；
 * - surface:read：读取会话状态；
 * - element:extract：读取页面元素（W6，纯 CDP 只读域，不含脚本执行）。
 */
export type BrowserIpcCapability = 'network:navigate' | 'surface:read' | 'element:extract'

export const BROWSER_IPC_METHOD_CAPABILITIES: Readonly<Record<BrowserIpcMethod, BrowserIpcCapability>> = {
  navigate: 'network:navigate',
  back: 'network:navigate',
  forward: 'network:navigate',
  reload: 'network:navigate',
  stop: 'network:navigate',
  state: 'surface:read',
  extractList: 'element:extract',
  extractDetail: 'element:extract',
}

/** 契约清单：版本、通道、能力与事件通道的单一事实源。 */
export interface BrowserIpcContract {
  readonly version: string
  readonly eventChannel: string
  readonly methods: readonly BrowserIpcMethod[]
  readonly channels: Readonly<Record<BrowserIpcMethod, string>>
  readonly capabilities: Readonly<Record<BrowserIpcMethod, BrowserIpcCapability>>
}

export const BROWSER_IPC_CONTRACT: BrowserIpcContract = {
  version: BROWSER_IPC_CONTRACT_VERSION,
  eventChannel: BROWSER_IPC_EVENT_CHANNEL,
  methods: Object.keys(BROWSER_IPC_CHANNELS) as BrowserIpcMethod[],
  channels: BROWSER_IPC_CHANNELS,
  capabilities: BROWSER_IPC_METHOD_CAPABILITIES,
}

/* ------------------------------------------------------------------ *
 * 版本协商
 * ------------------------------------------------------------------ */

export interface BrowserIpcVersion {
  major: number
  minor: number
}

/** 解析 major.minor 版本；不可解析返回 null（视为不兼容）。 */
export function parseBrowserIpcVersion(raw: unknown): BrowserIpcVersion | null {
  if (typeof raw !== 'string') return null
  const match = /^(\d+)\.(\d+)$/.exec(raw.trim())
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) return null
  return { major, minor }
}

/**
 * 宿主版本是否满足本契约：major 相同且宿主 minor ≥ 契约 minor。
 * 宿主 major 更高（未知通道语义）同样判为不兼容。
 */
export function isBrowserIpcVersionCompatible(
  hostVersion: unknown,
  contractVersion: string = BROWSER_IPC_CONTRACT_VERSION,
): boolean {
  const host = parseBrowserIpcVersion(hostVersion)
  const contract = parseBrowserIpcVersion(contractVersion)
  if (!host || !contract) return false
  if (host.major !== contract.major) return false
  return host.minor >= contract.minor
}

/** 不兼容即抛错（fail closed）：宿主不得降级到部分通道。 */
export function assertBrowserIpcCompatible(
  hostVersion: unknown,
  contractVersion: string = BROWSER_IPC_CONTRACT_VERSION,
): void {
  if (isBrowserIpcVersionCompatible(hostVersion, contractVersion)) return
  throw new Error(
    `browser IPC 契约版本不兼容：宿主 ${String(hostVersion)}，契约 ${contractVersion}`,
  )
}

/* ------------------------------------------------------------------ *
 * 红线：契约不含页面脚本执行通道
 * ------------------------------------------------------------------ */

const SCRIPT_CHANNEL_PATTERN = /execute|eval|script|runtime|cdp/i

/** 通道名是否疑似页面脚本执行入口（用于红线断言，非解析器）。 */
export function isScriptExecutionChannel(channel: string): boolean {
  return SCRIPT_CHANNEL_PATTERN.test(channel)
}

/** 命中即抛错：契约里不允许出现脚本执行通道。 */
export function assertNoScriptChannel(channels: readonly string[]): void {
  const offending = channels.filter((channel) => isScriptExecutionChannel(channel))
  if (offending.length > 0) {
    throw new Error(`browser IPC 契约不得包含页面脚本执行通道: ${offending.join(', ')}`)
  }
}

/* ------------------------------------------------------------------ *
 * 主进程侧：契约方法 → 处理器
 * ------------------------------------------------------------------ */

/**
 * 处理器映射：方法名 → (会话 id, 请求体) → 结果。
 *
 * id 与请求体一律按 `unknown` 接收——宿主传来的是不可信输入，是否合法由
 * 服务层判定（服务层只认字符串 id，并自行解析请求体）。
 */
export type BrowserIpcHandlerMap = {
  [M in BrowserIpcMethod]: (
    id: unknown,
    payload: unknown,
  ) => Promise<BrowserIpcMethodResult<M>>
}

/**
 * 宿主注册面：契约只要求「能按通道注册一个处理器」。
 * Electron ipcMain、MessagePort、跨插件 RPC 都能适配。
 */
export interface BrowserIpcHost {
  /** 宿主声明实现的契约版本；不兼容时注册失败（fail closed）。 */
  readonly contractVersion: string
  handle(channel: string, handler: (id: unknown, payload: unknown) => Promise<unknown>): void
}

export interface BrowserIpcRegistrationOptions {
  /** 允许暴露的方法；缺省为契约全部方法。 */
  allow?: readonly BrowserIpcMethod[]
}

/**
 * 把处理器映射注册到宿主。
 *
 * 顺序固定：先校验版本（不兼容直接抛），再校验方法集合（契约外的方法拒绝），
 * 最后逐个注册并复查红线（无脚本执行通道）。返回实际注册的方法名。
 */
export function registerBrowserIpc(
  host: BrowserIpcHost,
  handlers: BrowserIpcHandlerMap,
  options: BrowserIpcRegistrationOptions = {},
): BrowserIpcMethod[] {
  assertBrowserIpcCompatible(host.contractVersion)
  const allow = options.allow ?? BROWSER_IPC_CONTRACT.methods
  const unknown = allow.filter((method) => !BROWSER_IPC_CONTRACT.methods.includes(method))
  if (unknown.length > 0) {
    throw new Error(`browser IPC 注册了契约外的方法: ${unknown.join(', ')}`)
  }
  const registered: BrowserIpcMethod[] = []
  for (const method of allow) {
    const channel = BROWSER_IPC_CHANNELS[method]
    assertNoScriptChannel([channel])
    const handler = handlers[method] as (id: unknown, payload: unknown) => Promise<unknown>
    host.handle(channel, (id, payload) => handler(id, payload))
    registered.push(method)
  }
  return registered
}

/* ------------------------------------------------------------------ *
 * 渲染侧：契约 → BrowserApi
 * ------------------------------------------------------------------ */

/**
 * 传输抽象：契约只要求「按通道发起调用」与「按通道订阅推送」。
 * 宿主自选实现——Electron ipcRenderer、进程内直调、跨插件 RPC 皆可。
 */
export interface BrowserIpcTransport {
  invoke(channel: string, id: string, payload: unknown): Promise<unknown>
  subscribe(channel: string, listener: (payload: unknown) => void): () => void
}

/** 按方法分发的调用器（跨插件 RPC 场景：远端只认方法名与契约通道）。 */
export type BrowserIpcInvoker = <M extends BrowserIpcMethod>(
  method: M,
  id: string,
  payload: BrowserIpcMethodPayload<M>,
) => Promise<BrowserIpcMethodResult<M>>

/** 用传输构造 renderer 可见的 BrowserApi（契约的唯一渲染侧出口）。 */
export function createBrowserApi(transport: BrowserIpcTransport): BrowserApi {
  const call = async <M extends BrowserIpcMethod>(
    method: M,
    id: string,
    payload: unknown,
  ): Promise<BrowserIpcMethodResult<M>> => {
    const result = await transport.invoke(BROWSER_IPC_CHANNELS[method], id, payload)
    return result as BrowserIpcMethodResult<M>
  }
  return {
    browserNavigate: (id, request) => call('navigate', id, request),
    browserBack: (id) => call('back', id, undefined),
    browserForward: (id) => call('forward', id, undefined),
    browserReload: (id) => call('reload', id, undefined),
    browserStop: (id) => call('stop', id, undefined),
    browserState: (id) => call('state', id, undefined),
    browserExtractList: (id, request) => call('extractList', id, request),
    browserExtractDetail: (id, request) => call('extractDetail', id, request),
    browserOnEvent: (cb) =>
      transport.subscribe(BROWSER_IPC_EVENT_CHANNEL, (payload) => {
        cb(payload as BrowserSurfaceEvent)
      }),
  }
}

/** 按方法分发的调用器 → BrowserApi（跨插件 RPC 场景）。 */
export function createBrowserApiFromInvoker(invoker: BrowserIpcInvoker): BrowserApi {
  return createBrowserApi({
    invoke: async (channel, id, payload) => {
      const method = BROWSER_IPC_METHOD_BY_CHANNEL[channel]
      if (!method) throw new Error(`未知的 browser 契约通道: ${channel}`)
      return invoker(method as BrowserIpcMethod, id, payload as never)
    },
    subscribe: () => () => {
      /* 进程内直调无推送通道：事件订阅由宿主自行接入 */
    },
  })
}

export interface BrowserIpcLocalOptions {
  /** 事件订阅（进程内直调时由宿主注入推送源）。 */
  subscribe?: (listener: (payload: unknown) => void) => () => void
}

/**
 * 进程内直调：同一进程内的另一个插件直接消费服务，不必绕 IPC。
 * 走的是同一份契约（通道名与方法签名一致），因此换成跨进程传输时
 * 调用方代码无需改动。
 */
export function createBrowserApiFromHandlers(
  handlers: BrowserIpcHandlerMap,
  options: BrowserIpcLocalOptions = {},
): BrowserApi {
  return createBrowserApi({
    invoke: async (channel, id, payload) => {
      const method = BROWSER_IPC_METHOD_BY_CHANNEL[channel]
      if (!method) throw new Error(`未知的 browser 契约通道: ${channel}`)
      const handler = handlers[method] as (id: unknown, payload: unknown) => Promise<unknown>
      return handler(id, payload)
    },
    subscribe: (channel, listener) => {
      if (channel !== BROWSER_IPC_EVENT_CHANNEL) return () => {}
      return options.subscribe?.(listener) ?? (() => {})
    },
  })
}
