import type { AppMode } from '@dogic/core'
import type { SurfaceDescriptor } from '@dogic/core/surface'

/** 中栏 Surface 标识；标签条本身不认识这些 id，映射只在 App 组合层。 */
export const HARNESS_SURFACE_ID = 'harness'
export const MAGPIE_CONSOLE_SURFACE_ID = 'magpie-console'

export const HARNESS_PROVIDER_ID = 'harness'
export const MAGPIE_CONSOLE_PROVIDER_ID = 'magpie-console'
export const TERMINAL_PROVIDER_ID = 'terminal'
export const BROWSER_PROVIDER_ID = 'browser'

export const harnessSurface = (): SurfaceDescriptor => ({
  id: HARNESS_SURFACE_ID,
  providerId: HARNESS_PROVIDER_ID,
  kind: 'webcontents',
  title: 'DeepSeek Harness',
  capabilities: ['agent:tools'],
})

export const magpieConsoleSurface = (): SurfaceDescriptor => ({
  id: MAGPIE_CONSOLE_SURFACE_ID,
  providerId: MAGPIE_CONSOLE_PROVIDER_ID,
  kind: 'webcontents',
  title: 'magpie 控制台',
  capabilities: ['network:navigate'],
})

/** terminal Surface（W4.4）：id 由终端页按打开顺序派生（terminal-1、terminal-2…）。 */
export const terminalSurface = (id: string, workspaceId: string, index: number): SurfaceDescriptor => ({
  id,
  providerId: TERMINAL_PROVIDER_ID,
  kind: 'terminal',
  title: `终端 ${index}`,
  workspaceId,
  capabilities: ['process:execute'],
})

/** browser Surface（W5.2）：id 由浏览器页按打开顺序派生（browser-1、browser-2…）。 */
export const browserSurface = (id: string, index: number): SurfaceDescriptor => ({
  id,
  providerId: BROWSER_PROVIDER_ID,
  kind: 'webcontents',
  title: `浏览器 ${index}`,
  capabilities: ['network:navigate'],
})

/**
 * 派生不与既有标签冲突的 Surface 序号（W6.8）。
 *
 * 浏览器页/终端页随导航卸载重挂，页内计数器会归零；若继续用计数器派生
 * id，就会与已存在的标签重号——注册表按 id 覆盖既有记录，于是「新建」
 * 既不新增标签也不新建会话，用户看到的是「点了没反应」（真实缺陷：
 * 标签快照跨启动恢复后，新建按钮永远命中同一个 id）。
 *
 * 改为按既有 id 集合取最小可用序号：跨页面、跨挂载、跨启动都唯一。
 */
export function nextSurfaceIndex(prefix: 'browser' | 'terminal', existingIds: readonly string[]): number {
  const used = new Set(existingIds)
  let index = 1
  while (used.has(`${prefix}-${index}`)) index += 1
  return index
}

/** Surface → 壳页面映射；simple 模式的控制台落在「设置」页，终端仅 dev 可见。 */
export function surfacePageId(providerId: string, mode: AppMode): string | undefined {
  if (providerId === HARNESS_PROVIDER_ID) return 'chat'
  if (providerId === MAGPIE_CONSOLE_PROVIDER_ID) return mode === 'simple' ? 'settings' : 'console'
  if (providerId === TERMINAL_PROVIDER_ID) return mode === 'dev' ? 'terminal' : undefined
  if (providerId === BROWSER_PROVIDER_ID) return mode === 'dev' ? 'browser' : undefined
  return undefined
}
