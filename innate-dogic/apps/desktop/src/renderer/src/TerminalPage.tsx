import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import type { WorkspaceRoot } from '@dogic/plugin-workspace'
import { api } from './api'
import SurfaceSlot from './surfaces/SurfaceSlot'
import { TERMINAL_PROVIDER_ID, nextSurfaceIndex, terminalSurface } from './surfaces/catalog'
import type { SurfaceDescriptor } from '@dogic/core/surface'
import type { SurfaceProviderRegistry } from './surfaces/provider-registry'
import type { SurfaceTabs } from './surfaces/surface-tabs'

interface Props {
  tabs: SurfaceTabs
  providers: SurfaceProviderRegistry
  onSwitchSurface(descriptor: SurfaceDescriptor): void
  onCloseSurface(descriptor: SurfaceDescriptor): void
}

/**
 * 终端页（W4.4）：terminal 是统一中栏槽里的独立 Surface。
 *
 * - 无 root 时「新建终端」不再是死按钮：点击直接弹目录选择，选定后立即
 *   建终端（W6.8：原先 disabled 的按钮在用户眼里就是「点了没反应」）；
 * - 「新建终端」按**不与既有标签冲突**的序号派生 terminal-N 标签 id；
 * - 标签切换只隐藏视图（store detach），进程与 scrollback 保留；
 * - simple 模式页面注册表不含终端（pagesForMode 门控），标签条不可见。
 */
export default function TerminalPage({ tabs, providers, onSwitchSurface, onCloseSurface }: Props): JSX.Element {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  useSyncExternalStore(tabs.subscribe, tabs.getRevision, tabs.getRevision)
  const snapshot = tabs.snapshot()
  const terminalSurfaces = snapshot.surfaces.filter((surface) => surface.providerId === TERMINAL_PROVIDER_ID)
  /**
   * 本页要展示的终端 Surface。
   *
   * 统一中栏槽里活跃的可能是别的页面的 Surface（如浏览器页开着 browser）——
   * 此时本页聚焦自己的最近一个 Surface，而不是把别的页面的 Surface 渲染在
   * 终端页里（与浏览器页同一处理）。
   */
  const activeTerminal = (() => {
    if (terminalSurfaces.length === 0) return undefined
    if (snapshot.activeId && terminalSurfaces.some((surface) => surface.id === snapshot.activeId)) {
      return snapshot.activeId
    }
    return terminalSurfaces[terminalSurfaces.length - 1]?.id
  })()

  useEffect(() => {
    void api.workspaceGetRoot().then(setRoot).catch(() => setRoot(null))
  }, [])

  /**
   * 新建终端（W6.8）。
   *
   * 没有工作区 root 时先弹目录选择：选定即建终端，取消则什么都不做。
   * 标签 id 取不与既有标签冲突的序号——页内计数器在页面重挂后归零，
   * 会与恢复出来的既有标签撞 id，于是「新建」不产生新标签也不起新进程。
   */
  const openTerminal = useCallback(async (): Promise<void> => {
    let target = root
    if (!target) {
      const selected = await api.workspacePickRoot()
      if (!selected) return
      target = selected
      setRoot(selected)
    }
    const index = nextSurfaceIndex('terminal', tabs.list().map((surface) => surface.id))
    const id = `terminal-${index}`
    tabs.open(terminalSurface(id, target.path, index))
    tabs.activate(id)
  }, [root, tabs])

  const chooseRoot = useCallback(async (): Promise<void> => {
    const selected = await api.workspacePickRoot()
    if (selected) setRoot(selected)
  }, [])

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <button type="button" className="primary" onClick={() => void openTerminal()}>
          新建终端
        </button>
        {root && <span className="terminal-root-label">▣ {root.name}</span>}
      </div>
      {terminalSurfaces.length > 0 ? (
        <SurfaceSlot
          tabs={tabs}
          providers={providers}
          focusId={activeTerminal}
          fallback={<TerminalEmpty root={root} onChooseRoot={chooseRoot} onOpen={() => void openTerminal()} />}
          onSwitch={onSwitchSurface}
          onClose={onCloseSurface}
        />
      ) : (
        <TerminalEmpty root={root} onChooseRoot={chooseRoot} onOpen={() => void openTerminal()} />
      )}
    </div>
  )
}

/**
 * 空态也给出可点的入口（W6.8）：没有工作区时点「新建终端」直接进入
 * 目录选择，不再需要用户先找到另一个按钮。
 */
function TerminalEmpty({
  root,
  onChooseRoot,
  onOpen,
}: {
  root: WorkspaceRoot | null
  onChooseRoot(): Promise<void>
  onOpen(): void
}): JSX.Element {
  return (
    <div className="workspace-empty">
      {!root ? (
        <>
          <h2>打开一个工作区后再使用终端</h2>
          <p>终端进程的 cwd 固定在所选工作区内，不会落到任意目录。</p>
          <div className="row-btns">
            <button type="button" className="primary" onClick={onOpen}>新建终端</button>
            <button type="button" onClick={() => void onChooseRoot()}>选择目录</button>
          </div>
        </>
      ) : (
        <>
          <h2>终端</h2>
          <p>在当前工作区中启动受控 shell：点击「新建终端」。</p>
          <button type="button" className="primary" onClick={onOpen}>新建终端</button>
        </>
      )}
    </div>
  )
}
