import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConsoleStatusEvent, GatewayStatusEvent } from '@dogic/core'

// App 依赖的窗口 API 全量 mock（W1b F2-V1：窗口调用、轮询一次、卸载清理）
const apiMocks = vi.hoisted(() => ({
  getMode: vi.fn(async (): Promise<'dev' | 'simple' | null> => 'dev'),
  setMode: vi.fn(async () => true),
  getStatus: vi.fn(async () => ({
    gateway: { running: true, baseUrl: 'http://127.0.0.1:3425', version: '0.1.1230', modelsCount: 34 },
    webUi: { running: true, url: 'http://127.0.0.1:3430' },
    dsh: { installed: true, wiredFiles: ['cordis.patch.yml'], hasGatewayKey: true, defaultModel: 'm' },
  })),
  onHarnessState: vi.fn(() => () => {}),
  onGatewayStatus: vi.fn((_cb: (s: GatewayStatusEvent) => void) => () => {}),
  onConsoleStatus: vi.fn((_cb: (s: ConsoleStatusEvent) => void) => () => {}),
  getHarnessState: vi.fn(async () => ({ phase: 'idle' as const, message: 'Harness 未运行' })),
  launchHarness: vi.fn(async () => ({ ok: true, port: 12345, url: 'http://127.0.0.1:12345', detail: 'ok' })),
  stopHarness: vi.fn(async () => true),
  surfaceShow: vi.fn(async () => ({ ok: true })),
  surfaceHide: vi.fn(async () => true),
  surfaceBounds: vi.fn(async () => true),
  surfaceClose: vi.fn(async () => true),
  winIsMaximized: vi.fn(async () => false),
  onWinMaximized: vi.fn(() => () => {}),
  winMin: vi.fn(async () => true),
  winToggleMax: vi.fn(async () => true),
  winClose: vi.fn(async () => true),
  openMagpieWeb: vi.fn(async () => true),
  openLogs: vi.fn(async () => true),
  startMagpie: vi.fn(async () => ({ ok: true, detail: 'ok' })),
  runChecks: vi.fn(async () => []),
  getModels: vi.fn(async () => ({ ok: true, models: [], detail: '' })),
  smokeTest: vi.fn(async () => ({ ok: true, detail: '' })),
  disconnectDsh: vi.fn(async () => ({ ok: true, detail: '' })),
  revealDshHome: vi.fn(async () => ''),
  // W3：root 变更订阅（关闭旧 root 文档标签）
  workspaceOnRootChanged: vi.fn(() => () => {}),
  // W6.8：主页展示并使用当前工作区 root
  workspaceGetRoot: vi.fn(async (): Promise<{ path: string; name: string } | null> => null),
  workspacePickRoot: vi.fn(async (): Promise<{ path: string; name: string } | null> => null),
  // 主页快捷入口落到真实 Surface：browser/terminal 的窄通道桩
  browserNavigate: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
  browserBack: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
  browserForward: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
  browserReload: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
  browserStop: vi.fn(async () => ({ ok: true })),
  browserState: vi.fn(async () => null),
  browserOnEvent: vi.fn(() => () => {}),
  browserExtractList: vi.fn(async () => ({ ok: true, elements: [] })),
  browserExtractDetail: vi.fn(async () => ({ ok: true })),
  terminalCreate: vi.fn(async () => ({ ok: true })),
  terminalClose: vi.fn(async () => true),
  terminalInput: vi.fn(async () => true),
  terminalResize: vi.fn(async () => true),
  terminalOnEvent: vi.fn(() => () => {}),
}))

vi.mock('../api', () => ({ api: apiMocks }))

// 终端面板在 jsdom 里需要 xterm 桩（真实 xterm 依赖 canvas/DOM 测量）。
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element: HTMLElement | undefined
    options: Record<string, unknown> = {}
    write = vi.fn()
    open = vi.fn((element: HTMLElement): void => {
      this.element = document.createElement('div')
      element.appendChild(this.element)
    })
    onData = vi.fn((): { dispose(): void } => ({ dispose: vi.fn() }))
    getSelection = vi.fn((): string => '')
    clear = vi.fn()
    dispose = vi.fn()
    loadAddon = vi.fn()
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn()
    proposeDimensions = vi.fn((): { cols: number; rows: number } => ({ cols: 80, rows: 24 }))
  },
}))
vi.mock('../plugin-registry', async () => {
  const React = await import('react')
  return {
    // W3：工作区不再是中栏导航页，而是 dev 模式常驻右栏 Panel；mock 只验证挂载点，
    // 真实侧栏行为由 @dogic/plugin-workspace 组件测试覆盖。
    WorkspaceSidebar: () =>
      React.createElement('div', { 'data-testid': 'workspace-sidebar' }, 'workspace'),
    createWorkspaceDocumentProviders: () => [],
    WorkspaceDocumentContext: React.createContext(null),
  }
})

import App from '../App'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// 工作区 root 桩默认「未选择」：用例需要时各自覆盖（clearAllMocks 不清实现）。
beforeEach(() => {
  apiMocks.workspaceGetRoot.mockResolvedValue(null)
  apiMocks.workspacePickRoot.mockResolvedValue(null)
})

describe('W1b App 壳组合（T2/T3）', () => {
  it('dev：三栏结构（Sidebar 原语 + ContentArea + RightPanelHost），默认页总览，窗口控制走原有 API', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    expect(container.querySelector('[data-sidebar="sidebar"]')).not.toBeNull()
    expect(container.querySelector('.content')).not.toBeNull()
    expect(screen.getByTestId('right-panel')).not.toBeNull()
    // W3：右栏常驻工作区侧栏（非导航页）
    expect(screen.getByTestId('workspace-sidebar')).not.toBeNull()
    expect((container.querySelector('.nav-item.current') as HTMLElement | null)?.title).toBe('总览')
    // 被动 effect（窗口状态）在负载下可能晚一拍：等待而非瞬时断言
    await waitFor(() => expect(apiMocks.winIsMaximized).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: '最小化' }))
    expect(apiMocks.winMin).toHaveBeenCalled()
  })

  it('点击导航切换既有页面；卸载时清理轮询订阅（F2-V1）', async () => {
    const { unmount } = render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    fireEvent.click(screen.getByTitle('工具'))
    await waitFor(() => expect(screen.getByRole('heading', { name: '工具' })).toBeTruthy())
    const intervalsBefore = (apiMocks.getStatus.mock.calls.length as number) > 0
    expect(intervalsBefore).toBe(true)
    unmount()
    const callsAtUnmount = apiMocks.getStatus.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 卸载后轮询不再触发
    expect(apiMocks.getStatus.mock.calls.length).toBe(callsAtUnmount)
  })

  it('W2.5：网关状态事件即发即更 pill，并触发一次 reconcile refresh', async () => {
    render(<App />)
    // W3：工作区不再是导航页（dev 右栏常驻），等待任一 dev 内容入口即视为壳已渲染
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    const callsBefore = apiMocks.getStatus.mock.calls.length
    apiMocks.onGatewayStatus.mock.calls[0]?.[0]({ state: 'not-running' })
    await waitFor(() => expect(screen.getByTestId('pill-gateway').textContent).toContain('网关未运行'))
    await waitFor(() => expect(apiMocks.getStatus.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('simple：右栏不渲染、开发入口隐藏，对话默认页（F1-V3/T3-V3）', async () => {
    apiMocks.getMode.mockResolvedValueOnce('simple')
    const { container } = render(<App />)
    await waitFor(() => expect(screen.queryByTitle('设置')).not.toBeNull())
    expect(screen.queryByTestId('right-panel')).toBeNull()
    // W3：工作区不再作为导航页出现（dev 右栏常驻，simple 完全不可见）
    expect(screen.queryByTitle('工作区')).toBeNull()
    await waitFor(() => {
      expect((container.querySelector('.nav-item[data-current="true"]') as HTMLElement | null)?.title).toBe('对话')
    })
  })

  it('RightPanelHost 可拆卸：rightPanel=false 时导航与页面不受影响（T3 F1-V2）', async () => {
    const { container } = render(<App rightPanel={false} />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    expect(screen.queryByTestId('right-panel')).toBeNull()
    fireEvent.click(screen.getByTitle('工具'))
    await waitFor(() => expect(screen.getByRole('heading', { name: '工具' })).toBeTruthy())
    expect(container.querySelector('.content')).not.toBeNull()
  })

  it('W6.8：主页（总览）给出「打开终端/打开浏览器」入口', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    expect(screen.getByRole('button', { name: '打开终端' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '打开浏览器' })).toBeTruthy()
  })

  it('W6.8：主页点「打开浏览器」建浏览器标签并切到浏览器页', async () => {
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '打开浏览器' }))

    await waitFor(() => expect(screen.getByRole('tab', { name: '浏览器 1' })).toBeTruthy())
    expect((container.querySelector('.nav-item.current') as HTMLElement | null)?.title).toBe('浏览器')
  })

  it('W6.8：主页点「打开终端」用当前工作区建终端标签并切到终端页', async () => {
    apiMocks.workspaceGetRoot.mockResolvedValue({ path: 'C:/repo', name: 'repo' })
    const { container } = render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: '打开终端' }))

    await waitFor(() => expect(screen.getByRole('tab', { name: '终端 1' })).toBeTruthy())
    expect((container.querySelector('.nav-item.current') as HTMLElement | null)?.title).toBe('终端')
    expect(apiMocks.terminalCreate).toHaveBeenCalledTimes(1)
  })
})
