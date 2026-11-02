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
  it('控制台进入统一中栏槽：只提交安全 descriptor 与 bounds，不带 URL', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))

    await waitFor(() => expect(screen.getByTestId('surface-tabs')).toBeTruthy())
    expect(screen.getByRole('tab', { name: 'magpie 控制台' })).toBeTruthy()
    await waitFor(() => expect(apiMocks.surfaceShow).toHaveBeenCalled())
    const [descriptor, bounds] = apiMocks.surfaceShow.mock.calls[0] ?? []
    expect(descriptor).toEqual({
      id: 'magpie-console',
      providerId: 'magpie-console',
      kind: 'webcontents',
      title: 'magpie 控制台',
      capabilities: ['network:navigate'],
    })
    expect(JSON.stringify(descriptor)).not.toContain('url')
    expect(JSON.stringify(descriptor)).not.toContain('token')
    expect(bounds).toMatchObject({ x: expect.any(Number), y: expect.any(Number) })
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

  it('Harness 运行时标签在控制台页仍存在（同一中栏槽多标签并存）', async () => {
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'running', message: 'Harness 运行中' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('对话')).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))

    await waitFor(() => expect(screen.getByTestId('surface-tabs')).toBeTruthy())
    const tabs = screen.getAllByRole('tab').map((tab) => tab.textContent)
    expect(tabs).toContain('DeepSeek Harness')
    expect(tabs).toContain('magpie 控制台')
  })

  it('关闭标签只销毁对应 Surface，不影响其它标签', async () => {
    apiMocks.getHarnessState.mockResolvedValue({ phase: 'running' as const, message: 'Harness 运行中' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('对话')).toBeTruthy())
    fireEvent.click(screen.getByTitle('对话'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))
    await waitFor(() => expect(screen.getByRole('tab', { name: 'magpie 控制台' })).toBeTruthy())

    fireEvent.click(screen.getByLabelText('关闭 magpie 控制台'))
    await waitFor(() => expect(apiMocks.surfaceClose).toHaveBeenCalledWith('magpie-console'))
    expect(apiMocks.surfaceClose).not.toHaveBeenCalledWith('harness')
    await waitFor(() => expect(screen.getByRole('tab', { name: 'DeepSeek Harness' })).toBeTruthy())
  })
})

describe('W1c 运行时降级', () => {
  it('控制台 provider 打开失败：错误与恢复动作显式，壳与其它页面仍可用', async () => {
    apiMocks.surfaceShow.mockResolvedValue({ ok: false, detail: '控制台启动失败' })
    render(<App />)
    await waitFor(() => expect(screen.getByTitle('总览')).toBeTruthy())
    fireEvent.click(screen.getByTitle('模型配置'))

    await waitFor(() => expect(screen.getByTestId('surface-error')).toBeTruthy())
    expect(screen.getByText('控制台启动失败')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '启动 magpie 并重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '浏览器打开' })).toBeTruthy()

    // W3：工作区不再是导航页；返回总览页验证壳与内容页仍可用
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
    await waitFor(() => expect(screen.getByTestId('surface-tabs')).toBeTruthy())
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
