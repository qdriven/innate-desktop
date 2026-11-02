import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX } from 'react'
import type { WorkspaceRoot } from '@dogic/plugin-workspace'
import { api } from './api'
import SurfaceSlot from './surfaces/SurfaceSlot'
import { TERMINAL_PROVIDER_ID, terminalSurface } from './surfaces/catalog'
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
 * - 无 root 时要求先选择目录（新建终端禁用）；
 * - 「新建终端」按打开顺序派生 terminal-N 标签 id；
 * - 标签切换只隐藏视图（store detach），进程与 scrollback 保留；
 * - simple 模式页面注册表不含终端（pagesForMode 门控），标签条不可见。
 */
export default function TerminalPage({ tabs, providers, onSwitchSurface, onCloseSurface }: Props): JSX.Element {
  const [root, setRoot] = useState<WorkspaceRoot | null>(null)
  const counterRef = useRef(0)
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

  const openTerminal = useCallback((): void => {
    if (!root) return
    counterRef.current += 1
    const id = `terminal-${counterRef.current}`
    tabs.open(terminalSurface(id, root.path, counterRef.current))
    tabs.activate(id)
  }, [root, tabs])

  const chooseRoot = useCallback(async (): Promise<void> => {
    const selected = await api.workspacePickRoot()
    if (selected) setRoot(selected)
  }, [])

  return (
    <div className="terminal-page">
      <div className="terminal-toolbar">
        <button type="button" className="primary" onClick={openTerminal} disabled={!root}>
          新建终端
        </button>
        {root && <span className="terminal-root-label">▣ {root.name}</span>}
      </div>
      {terminalSurfaces.length > 0 ? (
        <SurfaceSlot
          tabs={tabs}
          providers={providers}
          focusId={activeTerminal}
          fallback={<TerminalEmpty root={root} onChooseRoot={chooseRoot} />}
          onSwitch={onSwitchSurface}
          onClose={onCloseSurface}
        />
      ) : (
        <TerminalEmpty root={root} onChooseRoot={chooseRoot} />
      )}
    </div>
  )
}

function TerminalEmpty({ root, onChooseRoot }: { root: WorkspaceRoot | null; onChooseRoot(): Promise<void> }): JSX.Element {
  return (
    <div className="workspace-empty">
      {!root ? (
        <>
          <h2>打开一个工作区后再使用终端</h2>
          <p>终端进程的 cwd 固定在所选工作区内，不会落到任意目录。</p>
          <button type="button" className="primary" onClick={() => void onChooseRoot()}>选择目录</button>
        </>
      ) : (
        <>
          <h2>终端</h2>
          <p>点击上方「新建终端」在当前工作区中启动受控 shell。</p>
        </>
      )}
    </div>
  )
}
