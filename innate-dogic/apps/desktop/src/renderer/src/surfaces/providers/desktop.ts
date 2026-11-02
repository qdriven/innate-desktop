import { api } from '../../api'
import { BROWSER_PROVIDER_ID, HARNESS_PROVIDER_ID } from '../catalog'
import { SurfaceProviderRegistry } from '../provider-registry'
import type { SurfaceProvider } from '../provider-registry'
import { createTerminalProvider } from './terminal'
import { createWebContentsProvider } from './webcontents'
import { createBrowserProvider } from './browser'
import { BrowserLayoutStore, DEFAULT_BROWSER_LAYOUT_KEY } from '@dogic/plugin-browser/renderer'

/**
 * 桌面端 provider 注册表（W1c.2 / W1c.3）。
 *
 * 注册失败只让该 Surface 不可用，壳、导航与其它 provider 照常工作；
 * 未注册的 provider 在标签条上显示明确错误，不静默跳过。
 */
export function createDesktopSurfaceProviders(): SurfaceProviderRegistry {
  const registry = new SurfaceProviderRegistry()

  // W5.6：浏览器布局持久化——renderer 本地 localStorage 快照（普通 URL +
  // 标签 id + activeId；敏感 URL 拒绝入快照）。与核心 SurfaceTabs 快照分离
  // （核心快照不含 URL）。
  let layout: BrowserLayoutStore | undefined
  try {
    if (typeof localStorage !== 'undefined') {
      layout = new BrowserLayoutStore({ key: DEFAULT_BROWSER_LAYOUT_KEY, storage: localStorage })
    }
  } catch {
    layout = undefined
  }

  const factories: Array<() => SurfaceProvider> = [
    () => createWebContentsProvider({
      id: HARNESS_PROVIDER_ID,
      actions: [{ label: '查看日志', run: () => api.openLogs() }],
    }),
    () => createTerminalProvider(api),
    // browser Surface（W5.3）：地址栏面板 + 宿主视图生命周期；导航守卫在 main 侧执行。
    () => createBrowserProvider(api, layout),
    // W6.9：magpie 控制台 provider 已摘除（原生视图遮挡/吞点击根因）。
  ]
  for (const factory of factories) {
    try {
      registry.register(factory())
    } catch (reason) {
      console.error('[surface] provider 注册失败，该 Surface 降级为不可用', reason)
    }
  }
  return registry
}
