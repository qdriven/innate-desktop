import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ConsoleStatusEvent, GatewayStatusEvent } from '@dogic/core'

// W1c：壳层多 Surface 标签、provider 中立 IPC 与运行时降级
interface StatusLike {
  gateway: { running: boolean; baseUrl: string; version: string; modelsCount: number }
  webUi: { running: boolean; url?: string }
  dsh: { installed: boolean; wiredFiles: string[]; hasGatewayKey: boolean; defaultModel?: string }
}
interface HarnessStateLike {
  phase: 'idle' | 'starting' | 'running' | 'failed' | 'stopped'
  message: string
  url?: string
}
interface ShowResultLike {
  ok: boolean
  detail?: string
}

const apiMocks = vi.hoisted(() => ({
  getMode: vi.fn(async (): Promise<'dev' | 'simple' | null> => 'dev'),
  setMode: vi.fn(async () => true),
  getStatus: vi.fn(async (): Promise<StatusLike> => ({
    gateway: { running: true, baseUrl: 'http://127.0.0.1:3425', version: '0.1.1230', modelsCount: 34 },
    webUi: { running: true, url: 'http://127.0.0.1:3430' },
    dsh: { installed: true, wiredFiles: ['cordis.patch.yml'], hasGatewayKey: true, defaultModel: 'm' },
  })),
  onHarnessState: vi.fn(() => () => {}),
  onGatewayStatus: vi.fn((_cb: (s: GatewayStatusEvent) => void) => () => {}),
  onConsoleStatus: vi.fn((_cb: (s: ConsoleStatusEvent) => void) => () => {}),
  getHarnessState: vi.fn(async (): Promise<HarnessStateLike> => ({ phase: 'idle', message: 'Harness 未运行' })),
  launchHarness: vi.fn(async () => ({ ok: true, port: 12345, detail: 'ok' })),
  stopHarness: vi.fn(async () => true),
  surfaceShow: vi.fn(async (_descriptor: unknown, _bounds: unknown): Promise<ShowResultLike> => ({ ok: true })),
  surfaceHide: vi.fn(async (_id: unknown) => true),
  surfaceBounds: vi.fn(async (_id: unknown, _bounds: unknown) => true),
  surfaceClose: vi.fn(async (_id: unknown) => true),
  winIsMaximized: vi.fn(async () => false),
  onWinMaximized: vi.fn(() => () => {}),
  winMin: vi.fn(async () => true),
  winToggleMax: vi.fn(async () => true),
  winClose: vi.fn(async () => true),
  openMagpieWeb: vi.fn(async () => true),
  openLogs: vi.fn(async () => ''),
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
}))

vi.mock('../api', () => ({ api: apiMocks }))
vi.mock('../plugin-registry', async () => {
  const React = await import('react')
  return {
    // W3：工作区侧栏迁至右栏常驻 Panel；mock 只验证挂载点，
    // 真实侧栏行为由 @dogic/plugin-workspace 组件测试覆盖。
    WorkspaceSidebar: () =>
      React.createElement('div', { 'data-testid': 'workspace-sidebar' }, 'workspace'),
    createWorkspaceDocumentProviders: () => [],
    WorkspaceDocumentContext: React.createContext(null),
  }
})

import App from '../App'

/** 每个用例显式复位 mock 实现，避免用例之间串味。 */
function useDefaults(): void {
  apiMocks.getMode.mockResolvedValue('dev')
  apiMocks.getStatus.mockResolvedValue({
    gateway: { running: true, baseUrl: 'http://127.0.0.1:3425', version: '0.1.1230', modelsCount: 34 },
    webUi: { running: true, url: 'http://127.0.0.1:3430' },
    dsh: { installed: true, wiredFiles: ['cordis.patch.yml'], hasGatewayKey: true, defaultModel: 'm' },
  })
  apiMocks.getHarnessState.mockResolvedValue({ phase: 'idle', message: 'Harness 未运行' })
  apiMocks.surfaceShow.mockResolvedValue({ ok: true })
  apiMocks.surfaceHide.mockResolvedValue(true)
  apiMocks.surfaceBounds.mockResolvedValue(true)
  apiMocks.surfaceClose.mockResolvedValue(true)
}
beforeEach(() => {
  localStorage.clear()
  useDefaults()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('W1c 壳层多 Surface 标签', () => {
  it('W6.9：控制台页为占位说明，不再创建 magpie 控制台 Surface（无原生视图）', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))

    await waitFor(() => expect(screen.getByText(/magpie 控制台在本阶段未集成/)).toBeTruthy())
    // 不再有任何 surface 提交：控制台原生视图是「点击没反应」的根因
    expect(apiMocks.surfaceShow).not.toHaveBeenCalled()
  })

  it('Harness 运行时成为对话页的一个标签，切换标签只换激活项', async () => {
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'running' as const, message: 'Harness 运行中' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('对话')).toBeTruthy())
    fireEvent.click(screen.getByTitle('对话'))

    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())
    await waitFor(() => expect(apiMocks.surfaceShow).toHaveBeenCalled())
    const descriptor = apiMocks.surfaceShow.mock.calls[0]?.[0]
    expect(descriptor).toMatchObject({ id: 'harness', providerId: 'harness', kind: 'webcontents' })
  })

  it('W6.9：Harness 标签跨控制台页导航保留，回到对话页重新可见', async () => {
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'running', message: 'Harness 运行中' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('对话')).toBeTruthy())
    fireEvent.click(screen.getByTitle('对话'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())

    // 控制台页现在是占位页（无中栏槽），标签保留在模型里
    fireEvent.click(screen.getByTitle('模型配置'))
    await waitFor(() => expect(screen.getByText(/magpie 控制台在本阶段未集成/)).toBeTruthy())
    expect(apiMocks.surfaceHide).toHaveBeenCalled()

    // 回到对话页：Harness 标签仍在并重新附着
    fireEvent.click(screen.getByTitle('对话'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())
  })

  it('关闭标签只销毁对应 Surface，不影响其它标签', async () => {
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'running' as const, message: 'Harness 运行中' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('对话')).toBeTruthy())
    fireEvent.click(screen.getByTitle('对话'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())

    // 浏览器页建 browser-1，两处 Surface 互不影响
    fireEvent.click(screen.getByTitle('浏览器'))
    await waitFor(() => expect(screen.getByRole('heading', { name: '浏览器' })).toBeTruthy())
    fireEvent.click(screen.getAllByRole('button', { name: '新建浏览器' })[0] as HTMLElement)
    await waitFor(() => expect(apiMocks.surfaceShow).toHaveBeenCalled())

    fireEvent.click(screen.getByLabelText('关闭 浏览器 1'))
    await waitFor(() => expect(apiMocks.surfaceClose).toHaveBeenCalledWith('browser-1'))
    expect(apiMocks.surfaceClose).not.toHaveBeenCalledWith('harness')
    fireEvent.click(screen.getByTitle('对话'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())
  })
})

describe('W1c 运行时降级', () => {
  it('W6.9：控制台页占位可用，壳与其它页面不受影响', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))

    await waitFor(() => expect(screen.getByText(/magpie 控制台在本阶段未集成/)).toBeTruthy())
    expect(screen.queryByTestId('surface-error')).toBeNull()

    fireEvent.click(screen.getByTitle('总览'))
    await waitFor(() => expect(screen.getByText('dsh × magpie 工作台')).toBeTruthy())
  })

  it('DSH 未安装：对话页给出明确提示，导航与其它页面不受影响', async () => {
    apiMocks.getMode.mockResolvedValueOnce('simple')
    apiMocks.getStatus.mockResolvedValue({
      gateway: { running: true, baseUrl: 'http://127.0.0.1:3425', version: '0.1.1230', modelsCount: 34 },
      webUi: { running: false },
      dsh: { installed: false, wiredFiles: [], hasGatewayKey: false },
    })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('设置')).toBeTruthy())
    expect(screen.getByText(/尚未安装 dsh/)).toBeTruthy()
    fireEvent.click(screen.getByTitle('设置'))
    await waitFor(() => expect(screen.getByText(/magpie 控制台在本阶段未集成/)).toBeTruthy())
  })

  it('Harness 启动失败：保留错误信息与查看日志入口，壳继续可用', async () => {
    apiMocks.getMode.mockResolvedValueOnce('simple')
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'failed' as const, message: 'Harness 启动失败 (code 1)' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('设置')).toBeTruthy())
    expect(screen.getByText(/Harness 启动失败/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看日志' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '查看日志' }))
    await waitFor(() => expect(apiMocks.openLogs).toHaveBeenCalled())
  })
})
