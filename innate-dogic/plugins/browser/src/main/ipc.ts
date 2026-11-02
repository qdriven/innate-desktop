/**
 * browser 契约的主进程侧处理器工厂（W6.6）。
 *
 * 服务层（BrowserSurfaceService）实现的是**能力**，契约实现的是**接口**。
 * 本文件把两者接起来：任何宿主——desktop 的任意版本、别的插件、测试替身
 * ——只要拿到处理器映射，就能按契约通道对外服务，不必复制通道名或方法签名。
 *
 * 处理器一律按 `unknown` 接收 id 与请求体：宿主传来的是不可信输入，
 * 合法性由服务层判定（服务层只认字符串会话 id，并自行解析请求体）。
 */
import type {
  BrowserNavigateResult,
  BrowserOpenResult,
  BrowserSessionState,
} from '../shared/index.js'
import type {
  BrowserExtractionDetailResult,
  BrowserExtractionListResult,
} from '../shared/extraction.js'
import type { BrowserIpcHandlerMap } from '../shared/ipc.js'

/** 服务层需提供的最小面（BrowserSurfaceService 天然满足）。 */
export interface BrowserIpcService {
  navigate(id: unknown, request: unknown): Promise<BrowserNavigateResult>
  back(id: unknown): Promise<BrowserNavigateResult>
  forward(id: unknown): Promise<BrowserNavigateResult>
  reload(id: unknown): Promise<BrowserNavigateResult>
  stop(id: unknown): Promise<BrowserOpenResult>
  state(id: unknown): BrowserSessionState | undefined
  extractList(id: unknown, request: unknown): Promise<BrowserExtractionListResult>
  extractDetail(id: unknown, request: unknown): Promise<BrowserExtractionDetailResult>
}

/**
 * 构造契约处理器映射。
 *
 * 契约里没有脚本执行方法（无 executeJavaScript / eval / Runtime.*）：
 * 元素提取只经 extractList / extractDetail 两条只读通道。
 */
export function createBrowserIpcHandlers(service: BrowserIpcService): BrowserIpcHandlerMap {
  return {
    navigate: (id, payload) => service.navigate(id, payload),
    back: (id) => service.back(id),
    forward: (id) => service.forward(id),
    reload: (id) => service.reload(id),
    stop: (id) => service.stop(id),
    // 契约对外统一用 null 表示「无此会话」（服务层内部用 undefined）。
    state: async (id) => service.state(id) ?? null,
    extractList: (id, payload) => service.extractList(id, payload),
    extractDetail: (id, payload) => service.extractDetail(id, payload),
  }
}
