import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { JSX, ReactNode } from 'react'
import type {
  AppMode,
  CheckResult,
  ConsoleStatusEvent,
  GatewayStatusEvent,
  HarnessState,
  ModelInfo,
  SmokeResult,
  StatusSnapshot,
} from '@dogic/core'
import type { SurfaceDescriptor } from '@dogic/core/surface'
import type { WorkspaceContext } from '@dogic/plugin-workspace'
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@innate/ui'
import { api } from './api'
import ConsolePage from './ConsolePage'
import HarnessPage from './HarnessPage'
import ModeGate from './ModeGate'
import { createWorkspaceDocumentProviders, WorkspaceDocumentContext } from './plugin-registry'
import type { WorkspaceDocumentOpener } from './plugin-registry'
import BrowserPage from './BrowserPage'
import Titlebar from './Titlebar'
import { defaultPageId, pagesForMode, resolveActivePage } from './pages'
import ContentArea from './shell/ContentArea'
import RightPanelHost from './shell/RightPanelHost'
import ShellSidebar from './shell/ShellSidebar'
import SurfaceSlot from './surfaces/SurfaceSlot'
import TerminalPage from './TerminalPage'
import { SurfaceTabs } from './surfaces/surface-tabs'
import { createDesktopSurfaceProviders } from './surfaces/providers/desktop'
import type { SurfaceProviderRegistry } from './surfaces/provider-registry'
import {
  HARNESS_PROVIDER_ID,
  HARNESS_SURFACE_ID,
  MAGPIE_CONSOLE_PROVIDER_ID,
  MAGPIE_CONSOLE_SURFACE_ID,
  browserSurface,
  harnessSurface,
  magpieConsoleSurface,
  nextSurfaceIndex,
  surfacePageId,
  terminalSurface,
} from './surfaces/catalog'

/** 中栏 Surface 标签快照的持久化键；快照只含安全字段。 */
const SURFACE_TABS_KEY = 'innate.surface-tabs:center'

export default function App({ rightPanel = true }: { rightPanel?: boolean }): JSX.Element {
  const [tab, setTab] = useState('overview')
  const [mode, setMode] = useState<AppMode | null>(null)
  const [modeLoaded, setModeLoaded] = useState(false)
  const [status, setStatus] = useState<StatusSnapshot | null>(null)
  const [gatewayStatus, setGatewayStatus] = useState<GatewayStatusEvent | null>(null)
  const [consoleStatus, setConsoleStatus] = useState<ConsoleStatusEvent | null>(null)
  const [harness, setHarness] = useState<HarnessState>({ phase: 'idle', message: 'Harness 未运行' })
  const [harnessLoaded, setHarnessLoaded] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launchMsg, setLaunchMsg] = useState('')
  /** 当前工作区 root（W6.8）：主页展示并在终端启动时使用。 */
  const [workspaceRoot, setWorkspaceRoot] = useState<WorkspaceContext | null>(null)

  // 标签模型与 provider 注册表在整个壳生命周期内唯一；StrictMode 重挂载不影响语义。
  const tabsRef = useRef<SurfaceTabs | null>(null)
  if (!tabsRef.current) tabsRef.current = new SurfaceTabs({ key: SURFACE_TABS_KEY })
  const tabs = tabsRef.current
  const providersRef = useRef<SurfaceProviderRegistry | null>(null)
  if (!providersRef.current) {
    // 桌面 provider + workspace 文档 provider 同表注册；单个失败只降级该 Surface。
    const registry = createDesktopSurfaceProviders()
    for (const provider of createWorkspaceDocumentProviders(api)) {
      try {
        registry.register(provider)
      } catch (reason) {
        console.error('[surface] workspace document provider 注册失败，该 Surface 降级为不可用', reason)
      }
    }
    providersRef.current = registry
  }
  const providers = providersRef.current

  useEffect(() => {
    void api.getMode().then((m) => {
      setMode(m)
      setModeLoaded(true)
    })
  }, [])

  const chooseMode = useCallback(async (m: AppMode) => {
    await api.setMode(m)
    setMode(m)
    setTab(defaultPageId(m))
  }, [])

  // W2.5：事件驱动 + 低频 reconcile（替代 5s 全量轮询）。
  // 网关/控制台状态事件即发即更；30s 兜底只覆盖 dsh 接线等慢变化。
  const refresh = useCallback(async () => {
    setStatus(await api.getStatus())
  }, [])

  useEffect(() => {
    void refresh()
    const unGateway = api.onGatewayStatus((s) => {
      setGatewayStatus(s)
      void refresh()
    })
    const unConsole = api.onConsoleStatus(setConsoleStatus)
    const t = setInterval(() => void refresh(), 30_000)
    return () => {
      unGateway()
      unConsole()
      clearInterval(t)
    }
  }, [refresh])

  useEffect(() => {
    const unsubscribe = api.onHarnessState((state) => {
      setHarness(state)
      setHarnessLoaded(true)
    })
    void api.getHarnessState().then((state) => {
      setHarness(state)
      setHarnessLoaded(true)
    })
    return unsubscribe
  }, [])

  // 工作区 root 变化（W3.2）：关闭 workspaceId 与新 root 不一致的旧文档标签。
  // W6.8：同时刷新主页展示的 root（主页是终端启动的入口）。
  const refreshWorkspaceRoot = useCallback((): void => {
    void api.workspaceGetRoot().then(setWorkspaceRoot).catch(() => setWorkspaceRoot(null))
  }, [api])

  useEffect(() => { refreshWorkspaceRoot() }, [refreshWorkspaceRoot])

  useEffect(() => {
    const unsubscribe = api.workspaceOnRootChanged((changed) => {
      for (const surface of tabs.list()) {
        if (surface.providerId.startsWith('workspace-') && surface.workspaceId !== changed.rootPath) {
          tabs.close(surface.id)
        }
      }
      refreshWorkspaceRoot()
    })
    return unsubscribe
  }, [api, tabs, refreshWorkspaceRoot])

  const launch = async (): Promise<void> => {
    setLaunching(true)
    setLaunchMsg('启动中…')
    const r = await api.launchHarness()
    setLaunchMsg(r.detail)
    setLaunching(false)
    setHarness(await api.getHarnessState())
    if (r.ok) setTab('chat')
  }

  const gwOk = status?.gateway.running === true
  const wired = (status?.dsh.wiredFiles.length ?? 0) > 0
  const canLaunch = gwOk && status?.dsh.installed === true
  const harnessRunning = harness.phase === 'running'
  const resolvedTab = mode ? resolveActivePage(mode, tab)?.id : undefined

  // 激活项订阅：派生 wsActive（当前激活是 workspace-* provider）与活跃文档 descriptor。
  const activeSurfaceId = useSyncExternalStore(
    tabs.subscribe,
    () => tabs.active()?.id ?? '',
    () => '',
  )
  const activeRecord = activeSurfaceId ? tabs.get(activeSurfaceId) : undefined
  const wsActive = activeRecord !== undefined && activeRecord.providerId.startsWith('workspace-')

  // shell ↔ plugin 解耦契约：插件经 context 打开/聚焦工作区文档，不直接持有 SurfaceTabs。
  const openDocument = useCallback((descriptor: SurfaceDescriptor) => {
    tabs.open(descriptor)
    tabs.activate(descriptor.id)
  }, [tabs])

  /**
   * 主页快捷入口（W6.8）：从主页一步打开终端/浏览器。
   *
   * 一次点击完成「建 Surface + 切到对应页面」——用户不必先在左栏找入口、
   * 再在页面里点一次「新建」。标签 id 取不与既有标签冲突的序号（跨页面、
   * 跨挂载唯一），避免重建同名标签导致「点了没反应」。
   */
  const openBrowserSurface = useCallback((): void => {
    const index = nextSurfaceIndex('browser', tabs.list().map((surface) => surface.id))
    const id = `browser-${index}`
    tabs.open(browserSurface(id, index))
    tabs.activate(id)
    setTab('browser')
  }, [tabs])

  const openTerminalSurface = useCallback(async (): Promise<void> => {
    let root = workspaceRoot ?? (await api.workspaceGetRoot())
    if (!root) root = await api.workspacePickRoot()
    if (!root) return
    setWorkspaceRoot(root)
    const index = nextSurfaceIndex('terminal', tabs.list().map((surface) => surface.id))
    const id = `terminal-${index}`
    tabs.open(terminalSurface(id, root.path, index))
    tabs.activate(id)
    setTab('terminal')
  }, [tabs, workspaceRoot])

  const opener = useMemo<WorkspaceDocumentOpener>(() => ({
    openDocument,
    activeDocument: wsActive ? activeRecord : undefined,
  }), [openDocument, wsActive, activeRecord])

  // Harness 生命周期：运行中保留标签（可与控制台并存于同一中栏槽），
  // 停止/失败时摘掉标签；状态未加载前不动，避免重启后误删已恢复的标签。
  useLayoutEffect(() => {
    if (!harnessLoaded) return
    if (harnessRunning) {
      tabs.open(harnessSurface())
      return
    }
    if (tabs.has(HARNESS_SURFACE_ID)) tabs.close(HARNESS_SURFACE_ID)
  }, [harnessLoaded, harnessRunning, tabs])

  // 页面 ↔ Surface：对话/设置(控制台)落在统一中栏槽，内容页只摘掉 Harness/控制台激活，
  // 保留 workspace 文档激活（W3.4：文档标签在中栏跨内容页浮动）。
  useLayoutEffect(() => {
    if (resolvedTab === 'chat') {
      if (harnessRunning) {
        tabs.open(harnessSurface())
        tabs.activate(HARNESS_SURFACE_ID)
      } else {
        tabs.deactivate()
      }
      return
    }
    if (resolvedTab === 'console' || resolvedTab === 'settings') {
      if (providers.isDisabled(MAGPIE_CONSOLE_PROVIDER_ID)) {
        tabs.deactivate()
        return
      }
      tabs.open(magpieConsoleSurface())
      tabs.activate(MAGPIE_CONSOLE_SURFACE_ID)
      return
    }
    // 内容页（overview/models/tools）：摘掉 Harness/控制台激活，保留 workspace 文档激活。
    tabs.deactivateProvider(HARNESS_PROVIDER_ID)
    tabs.deactivateProvider(MAGPIE_CONSOLE_PROVIDER_ID)
  }, [resolvedTab, harnessRunning, tabs, providers])

  const switchSurface = useCallback((surface: SurfaceDescriptor) => {
    const page = surfacePageId(surface.providerId, mode ?? 'dev')
    if (page) setTab(page)
    tabs.activate(surface.id)
  }, [mode, tabs])

  const closeSurface = useCallback((surface: SurfaceDescriptor) => {
    const provider = providers.get(surface.providerId)
    void Promise.resolve(provider?.close?.(surface)).catch(() => undefined)
    tabs.close(surface.id)
    if (surface.providerId === HARNESS_PROVIDER_ID) {
      void api.stopHarness()
      setTab('chat')
      return
    }
    if (surface.providerId === MAGPIE_CONSOLE_PROVIDER_ID &&
        (resolvedTab === 'console' || resolvedTab === 'settings')) {
      setTab(harnessRunning ? 'chat' : defaultPageId(mode ?? 'dev'))
    }
  }, [providers, tabs, resolvedTab, harnessRunning, mode])

  const reconnectConsole = useCallback(() => {
    tabs.open(magpieConsoleSurface())
    tabs.activate(MAGPIE_CONSOLE_SURFACE_ID)
  }, [tabs])

  if (!modeLoaded) return <div className="app" />
  if (mode === null) return <ModeGate onChoose={(m) => void chooseMode(m)} />

  const pages = pagesForMode(mode)
  const activeTab = resolvedTab

  const contentBody = (
    <ContentBody
      activeTab={activeTab}
      tabs={tabs}
      providers={providers}
      onSwitchSurface={switchSurface}
      onCloseSurface={closeSurface}
      onReconnect={reconnectConsole}
      status={status}
      harness={harness}
      launching={launching}
      launchMsg={launchMsg}
      onLaunch={launch}
      onStop={() => void api.stopHarness()}
      onOpenSettings={() => setTab(mode === 'simple' ? 'settings' : 'console')}
      onLaunchMagpie={(detail) => setLaunchMsg(detail)}
      onOpenTerminal={() => void openTerminalSurface()}
      onOpenBrowser={openBrowserSurface}
      workspaceRoot={workspaceRoot}
      wsActive={wsActive}
    />
  )

  return (
    <div className="app">
      <Titlebar
        mode={mode}
        pageLabel={pages.find((page) => page.id === activeTab)?.label ?? ''}
        status={status}
        gatewayStatus={gatewayStatus}
        consoleStatus={consoleStatus}
        onStartGateway={() => {
          void api.startMagpie().then((r) => setLaunchMsg(r.detail))
        }}
        onSwitchMode={() => void chooseMode(mode === 'simple' ? 'dev' : 'simple')}
      />

      <div className="shell">
        <ShellSidebar
          pages={pages}
          activeId={activeTab}
          harnessPhase={harness.phase}
          onNavigate={setTab}
          onSwitchMode={() => void chooseMode(mode === 'simple' ? 'dev' : 'simple')}
        />

        <WorkspaceDocumentContext.Provider value={opener}>
          {mode === 'dev' && rightPanel ? (
            <ResizablePanelGroup orientation="horizontal" className="shell-main">
              <ResizablePanel defaultSize="78%" minSize="40%">
                {contentBody}
              </ResizablePanel>
              <ResizableHandle />
              <ResizablePanel defaultSize="22%" minSize="12%">
                <RightPanelHost />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : contentBody}
        </WorkspaceDocumentContext.Provider>
      </div>
    </div>
  )
}

interface ContentBodyProps {
  activeTab: string | undefined
  tabs: SurfaceTabs
  providers: SurfaceProviderRegistry
  onSwitchSurface(surface: SurfaceDescriptor): void
  onCloseSurface(surface: SurfaceDescriptor): void
  onReconnect(): void
  status: StatusSnapshot | null
  harness: HarnessState
  launching: boolean
  launchMsg: string
  onLaunch(): void
  onStop(): void
  onOpenSettings(): void
  /** 启动 magpie 的结果文案回写到 App 的 launchMsg（总览页展示）。 */
  onLaunchMagpie(detail: string): void
  /** 主页快捷入口（W6.8）：一步打开终端/浏览器。 */
  onOpenTerminal(): void
  onOpenBrowser(): void
  /** 当前工作区 root（主页展示；终端在其上启动）。 */
  workspaceRoot: WorkspaceContext | null
  /** 当前激活项是 workspace-* provider（W3.4）：内容页据此决定渲染文档槽还是页面内容。 */
  wsActive: boolean
}

/**
 * 中栏内容体（W3.4）：内容页在 wsActive 时渲染 contentMode 的 SurfaceSlot（文档标签浮动），
 * 否则渲染页面内容本身。chat/settings/console 页保持各自内部 SurfaceSlot 不变。
 */
function ContentBody({
  activeTab,
  tabs,
  providers,
  onSwitchSurface,
  onCloseSurface,
  onReconnect,
  status,
  harness,
  launching,
  launchMsg,
  onLaunch,
  onStop,
  onOpenSettings,
  onLaunchMagpie,
  onOpenTerminal,
  onOpenBrowser,
  workspaceRoot,
  wsActive,
}: ContentBodyProps): JSX.Element {
  const contentSlot = (fallback: ReactNode): JSX.Element => (
    <SurfaceSlot
      tabs={tabs}
      providers={providers}
      contentMode
      fallback={fallback}
      onSwitch={onSwitchSurface}
      onClose={onCloseSurface}
    />
  )
  return (
    <ContentArea>
      {activeTab === 'chat' && (
        <HarnessPage
          status={status}
          harness={harness}
          launching={launching}
          launchMsg={launchMsg}
          onLaunch={onLaunch}
          onStop={onStop}
          onOpenSettings={onOpenSettings}
          tabs={tabs}
          providers={providers}
          onSwitchSurface={onSwitchSurface}
          onCloseSurface={onCloseSurface}
        />
      )}
      {activeTab === 'settings' && (
        <ConsolePage
          tabs={tabs}
          providers={providers}
          onSwitchSurface={onSwitchSurface}
          onCloseSurface={onCloseSurface}
          onReconnect={onReconnect}
        />
      )}
      {activeTab === 'terminal' && (
        <TerminalPage
          tabs={tabs}
          providers={providers}
          onSwitchSurface={onSwitchSurface}
          onCloseSurface={onCloseSurface}
        />
      )}
      {activeTab === 'browser' && (
        <BrowserPage
          tabs={tabs}
          providers={providers}
          onSwitchSurface={onSwitchSurface}
          onCloseSurface={onCloseSurface}
        />
      )}
      {activeTab === 'overview' && (
        wsActive
          ? contentSlot(<OverviewContent status={status} harness={harness} launching={launching} launchMsg={launchMsg} onLaunch={onLaunch} onLaunchMagpie={onLaunchMagpie} onOpenTerminal={onOpenTerminal} onOpenBrowser={onOpenBrowser} workspaceRoot={workspaceRoot} />)
          : <OverviewContent status={status} harness={harness} launching={launching} launchMsg={launchMsg} onLaunch={onLaunch} onLaunchMagpie={onLaunchMagpie} onOpenTerminal={onOpenTerminal} onOpenBrowser={onOpenBrowser} workspaceRoot={workspaceRoot} />
      )}
      {activeTab === 'models' && (wsActive ? contentSlot(<ModelsTab />) : <ModelsTab />)}
      {activeTab === 'console' && (
        <ConsolePage
          tabs={tabs}
          providers={providers}
          onSwitchSurface={onSwitchSurface}
          onCloseSurface={onCloseSurface}
          onReconnect={onReconnect}
        />
      )}
      {activeTab === 'tools' && (wsActive ? contentSlot(<ToolsTab />) : <ToolsTab />)}
    </ContentArea>
  )
}

function Card(props: { title: string; ok: boolean; lines: string[]; actions?: JSX.Element }): JSX.Element {
  return (
    <div className={`card ${props.ok ? 'ok' : ''}`}>
      <h3>
        <span className={`dot ${props.ok ? 'ok' : 'bad'}`} /> {props.title}
      </h3>
      <ul>
        {props.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {props.actions && <div className="card-actions">{props.actions}</div>}
    </div>
  )
}

function SmallBtn(props: { onClick: () => void; label: string }): JSX.Element {
  return (
    <button className="small" onClick={props.onClick}>
      {props.label}
    </button>
  )
}

function Wizard(): JSX.Element {
  const [checks, setChecks] = useState<CheckResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const run = async (): Promise<void> => {
    setBusy(true)
    setChecks(await api.runChecks())
    setBusy(false)
  }
  useEffect(() => {
    void run()
  }, [])
  return (
    <div className="card wizard">
      <h3>
        集成检查
        <SmallBtn onClick={() => void run()} label={busy ? '检查中…' : '重新检查'} />
      </h3>
      {checks === null ? (
        <p className="dim">检查中…</p>
      ) : (
        <ul>
          {checks.map((c) => (
            <li key={c.id} className={c.passed ? 'pass' : 'fail'}>
              <span>{c.passed ? '✓' : '✗'} {c.title}</span>
              <span className="dim">{c.detail}</span>
              {c.hint && <span className="hint">→ {c.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function OverviewContent({
  status,
  harness,
  launching,
  launchMsg,
  onLaunch,
  onLaunchMagpie,
  onOpenTerminal,
  onOpenBrowser,
  workspaceRoot,
}: {
  status: StatusSnapshot | null
  harness: HarnessState
  launching: boolean
  launchMsg: string
  onLaunch(): void
  onLaunchMagpie(detail: string): void
  onOpenTerminal(): void
  onOpenBrowser(): void
  workspaceRoot: WorkspaceContext | null
}): JSX.Element {
  const gwOk = status?.gateway.running === true
  const wired = (status?.dsh.wiredFiles.length ?? 0) > 0
  const canLaunch = gwOk && status?.dsh.installed === true
  return (
    <main className="main">
      <section className="hero">
        <div className="hero-text">
          <h1>dsh × magpie 工作台</h1>
          <p>
            模型配置在 magpie 中统一进行；本宿主拉起 dsh Harness（Web UI），
            其模型流量自动经 magpie 网关路由。
          </p>
        </div>
        <div className="hero-actions">
          <button
            className="primary"
            disabled={!canLaunch || launching}
            onClick={() => void onLaunch()}
            title={canLaunch ? '' : '需要：magpie 网关运行 + dsh 已安装'}
          >
            {launching ? '启动中…' : harness.phase === 'running' ? '打开 Harness' : '启动 dsh Harness'}
          </button>
          {harness.phase === 'running' && (
            <button onClick={() => void api.stopHarness()}>停止 Harness</button>
          )}
        </div>
      </section>

      {/* W6.8：主页快捷入口——一步打开终端/浏览器（建 Surface + 切页）。 */}
      <section className="quick-launch">
        <div className="quick-launch-text">
          <h2>快速打开</h2>
          <p className="dim">
            终端在当前工作区 {workspaceRoot ? `▣ ${workspaceRoot.name}` : '（未选择，将先弹出目录选择）'} 中启动；浏览器为受控浏览 Surface。
          </p>
        </div>
        <div className="quick-launch-actions">
          <button type="button" onClick={onOpenTerminal}>打开终端</button>
          <button type="button" onClick={onOpenBrowser}>打开浏览器</button>
        </div>
      </section>
      {launchMsg && <p className="launch-msg">{launchMsg}</p>}
      {harness.phase !== 'idle' && (
        <p className={`harness-state ${harness.phase}`}>
          Harness：{harness.message}
        </p>
      )}

      <div className="cards">
        <Card
          title="magpie 网关"
          ok={gwOk}
          lines={
            gwOk
              ? [
                  `地址 ${status?.gateway.baseUrl}`,
                  `版本 ${status?.gateway.version}`,
                  `模型 ${status?.gateway.modelsCount ?? '?'} 个`,
                  `web 界面 ${status?.webUi.running ? '运行中' : '未运行'}`,
                ]
              : [status?.gateway.error ?? '未知']
          }
          actions={
            <>
              {!gwOk && (
                <SmallBtn
                  onClick={() => {
                    void api.startMagpie().then((r) => onLaunchMagpie(r.detail))
                  }}
                  label="启动 magpie"
                />
              )}
              <SmallBtn onClick={() => void api.openMagpieWeb()} label="打开配置界面" />
            </>
          }
        />
        <Card
          title="dsh 集成"
          ok={wired}
          lines={[
            `安装 ${status?.dsh.installed ? '已安装' : '未安装 (npm i -g @deepseek-ai/dsh)'}`,
            `接线 ${wired ? '已接线 magpie' : '未接线'}`,
            `凭据 ${status?.dsh.hasGatewayKey ? 'MAGPIE_GATEWAY_KEY 已写入' : '未写入'}`,
            `默认模型 ${status?.dsh.defaultModel ?? '未设置'}`,
          ]}
          actions={<SmallBtn onClick={() => void api.revealDshHome()} label="打开 ~/.dsh" />}
        />
        <Wizard />
      </div>
    </main>
  )
}

function ModelsTab(): JSX.Element {
  const [data, setData] = useState<{ models: ModelInfo[]; detail: string } | null>(null)
  const refresh = useCallback(async () => {
    const r = await api.getModels()
    setData({ models: r.models, detail: r.detail })
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return (
    <main className="main">
      <div className="table-head">
        <h2>模型目录（来自 magpie /v1/models）</h2>
        <SmallBtn onClick={() => void refresh()} label="刷新" />
      </div>
      {data === null ? (
        <p className="dim">加载中…</p>
      ) : data.models.length === 0 ? (
        <p className="dim">{data.detail}</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>模型</th>
              <th>归属</th>
              <th>上下文</th>
              <th>推理档位</th>
              <th>原生端点</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m) => (
              <tr key={m.id}>
                <td>
                  {m.displayName ?? m.id}
                  <div className="dim mono">{m.id}</div>
                </td>
                <td>{m.ownedBy ?? '-'}</td>
                <td>{m.contextWindow ? `${Math.round(m.contextWindow / 1000)}K` : '-'}</td>
                <td>{m.reasoning ? (m.reasoningLevels ?? []).join('/') || '是' : '否'}</td>
                <td className="mono">{(m.nativeEndpoints ?? []).join(', ') || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}

function ToolsTab(): JSX.Element {
  const [smoke, setSmoke] = useState<SmokeResult | null>(null)
  const [smokeBusy, setSmokeBusy] = useState(false)
  const [disc, setDisc] = useState('')
  return (
    <main className="main">
      <h2>工具</h2>
      <div className="tool-row">
        <div>
          <h3>冒烟测试</h3>
          <p className="dim">
            经网关发起一次 16 token 最小补全（key=magpie-dsh-innateos，用量可在 magpie Usage 页查看）。
          </p>
        </div>
        <button
          className="primary"
          disabled={smokeBusy}
          onClick={async () => {
            setSmokeBusy(true)
            setSmoke(await api.smokeTest())
            setSmokeBusy(false)
          }}
        >
          {smokeBusy ? '测试中…' : '运行'}
        </button>
      </div>
      {smoke && (
        <p className={smoke.ok ? 'launch-msg ok' : 'launch-msg bad'}>
          {smoke.ok ? '✓' : '✗'} [{smoke.model ?? '-'}] {smoke.detail}
        </p>
      )}
      <div className="tool-row">
        <div>
          <h3>断开 dsh 接线</h3>
          <p className="dim">执行 magpie dsh default，原子恢复 dsh 原始模型配置。</p>
        </div>
        <button
          onClick={async () => {
            const r = await api.disconnectDsh()
            setDisc(`${r.ok ? '✓' : '✗'} ${r.detail}${r.hint ? ` — ${r.hint}` : ''}`)
          }}
        >
          断开
        </button>
      </div>
      {disc && <p className="launch-msg">{disc}</p>}
      <div className="tool-row">
        <div>
          <h3>日志与配置</h3>
          <p className="dim">Harness 日志目录 / ~/.dsh 配置目录。</p>
        </div>
        <div className="row-btns">
          <button onClick={() => void api.openLogs()}>打开日志</button>
          <button onClick={() => void api.revealDshHome()}>打开 ~/.dsh</button>
        </div>
      </div>
    </main>
  )
}
