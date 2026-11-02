import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { TerminalApi, TerminalDescriptor, TerminalEvent } from '@dogic/plugin-terminal'
import TerminalPage from './TerminalPage'
import { createTerminalProvider } from './surfaces/providers/terminal'
import { SurfaceProviderRegistry } from './surfaces/provider-registry'
import { SurfaceTabs } from './surfaces/surface-tabs'
import type { WorkspaceRoot } from '@dogic/plugin-workspace'

interface MockTerminal {
  element: HTMLElement | undefined
  options: Record<string, unknown>
  write: ReturnType<typeof vi.fn>
  open: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  getSelection: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
  loadAddon: ReturnType<typeof vi.fn>
}

const hoisted = vi.hoisted(() => {
  const terminals: unknown[] = []
  return { terminals }
})

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: class {
      element: HTMLElement | undefined
      options: Record<string, unknown> = {}
      write = vi.fn()
      open = vi.fn((element: HTMLElement): void => {
        // 真实 xterm.open：终端 DOM 是容器内的子元素，xterm.element 指向它。
        this.element = document.createElement('div')
        element.appendChild(this.element)
      })
      onData = vi.fn((): { dispose(): void } => ({ dispose: vi.fn() }))
      getSelection = vi.fn((): string => '')
      clear = vi.fn()
      dispose = vi.fn()
      loadAddon = vi.fn()
      constructor(options?: Record<string, unknown>) {
        this.options = options ?? {}
        hoisted.terminals.push(this)
      }
    },
  }
})

vi.mock('@xterm/addon-fit', () => {
  return {
    FitAddon: class {
      fit = vi.fn()
      proposeDimensions = vi.fn((): { cols: number; rows: number } => ({ cols: 80, rows: 24 }))
    },
  }
})

// TerminalPage 经 './api' 读取 window.innate：注入假工作区通道。
const innate = vi.hoisted(() => {
  return {
    workspaceGetRoot: vi.fn(async (): Promise<WorkspaceRoot | null> => null),
    workspacePickRoot: vi.fn(async (): Promise<WorkspaceRoot | null> => null),
  }
})

vi.mock('./api', () => ({ api: innate }))

interface FakeTerminalApi {
  api: TerminalApi
  create: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  input: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  emit(event: TerminalEvent): void
}

function makeApi(overrides: Partial<TerminalApi> = {}): FakeTerminalApi {
  const listeners = new Set<(event: TerminalEvent) => void>()
  const create = vi.fn(async (_descriptor: TerminalDescriptor): Promise<{ ok: boolean }> => ({ ok: true }))
  const close = vi.fn(async (): Promise<boolean> => true)
  const input = vi.fn(async (): Promise<boolean> => true)
  const resize = vi.fn(async (): Promise<boolean> => true)
  const onEvent = vi.fn((cb: (event: TerminalEvent) => void): (() => void) => {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  })
  const api: TerminalApi = {
    terminalCreate: create,
    terminalClose: close,
    terminalInput: input,
    terminalResize: resize,
    terminalOnEvent: onEvent,
    // W4.6 process:execute 窄通道桩（渲染端测试不直接消费）
    processProfileRegister: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
    processProfiles: vi.fn(async (): Promise<string[]> => []),
    processExecute: vi.fn(async (): Promise<{ executionId: string; ok: boolean }> => ({ executionId: 'exec-1', ok: true })),
    processResult: vi.fn(async (): Promise<{
      executionId: string; ok: boolean; exitCode: number | null; signal: string | null;
      durationMs: number; stdout: string; stderr: string; truncated: boolean;
      timedOut: boolean; cancelled: boolean;
    }> => ({
      executionId: 'exec-1', ok: true, exitCode: 0, signal: null, durationMs: 1,
      stdout: '', stderr: '', truncated: false, timedOut: false, cancelled: false,
    })),
    processCancel: vi.fn(async (): Promise<boolean> => true),
    ...overrides,
  }
  return {
    api,
    create,
    close,
    input,
    resize,
    emit: (event: TerminalEvent): void => {
      for (const listener of [...listeners]) listener(event)
    },
  }
}

const REPO_ROOT: WorkspaceRoot = { path: 'C:/repo', name: 'repo' }

/** 工具栏的「新建终端」按钮（空态里另有一个同名按钮，取第一个）。 */
function newTerminalButton(): HTMLElement {
  return screen.getAllByRole('button', { name: '新建终端' })[0] as HTMLElement
}

async function findNewTerminalButton(): Promise<HTMLElement> {
  const buttons = await screen.findAllByRole('button', { name: '新建终端' })
  return buttons[0] as HTMLElement
}

function makePage(root: WorkspaceRoot | null, fake: FakeTerminalApi) {
  innate.workspaceGetRoot.mockResolvedValue(root)
  innate.workspacePickRoot.mockResolvedValue(root)
  const tabs = new SurfaceTabs({ key: 'terminal-tabs', storage: null })
  const registry = new SurfaceProviderRegistry()
  registry.register(createTerminalProvider(fake.api))
  const onSwitchSurface = vi.fn()
  const onCloseSurface = vi.fn()
  return { tabs, registry, onSwitchSurface, onCloseSurface }
}

function pageProps(parts: ReturnType<typeof makePage>) {
  return {
    tabs: parts.tabs,
    providers: parts.registry,
    onSwitchSurface: parts.onSwitchSurface,
    onCloseSurface: parts.onCloseSurface,
  }
}

beforeEach(() => {
  hoisted.terminals.length = 0
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TerminalPage（W4.4）', () => {
  it('无 root：「新建终端」不是死按钮——点击进目录选择，取消则不建终端', async () => {
    const fake = makeApi()
    const parts = makePage(null, fake)

    render(<TerminalPage {...pageProps(parts)} />)

    expect(screen.getByText(/打开一个工作区后再使用终端/)).toBeTruthy()
    // W6.8：按钮不再是 disabled（原实现点击毫无反应）
    expect(newTerminalButton().getAttribute('disabled')).toBeNull()
    // 目录选择被取消 → 不建终端，也不报错
    fireEvent.click(newTerminalButton())
    await waitFor(() => expect(innate.workspacePickRoot).toHaveBeenCalled())
    expect(fake.create).not.toHaveBeenCalled()
    // 「选择目录」仍可单独使用：只更新 root 状态
    fireEvent.click(screen.getByRole('button', { name: '选择目录' }))
    await waitFor(() => expect(screen.getByText(/▣ repo|打开一个工作区后再使用终端/)).toBeTruthy())
    expect(fake.create).not.toHaveBeenCalled()
  })

  it('无 root：点击「新建终端」选定目录后立即建终端', async () => {
    const fake = makeApi()
    const parts = makePage(null, fake)
    innate.workspacePickRoot.mockResolvedValue(REPO_ROOT)

    render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(newTerminalButton())

    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))
    const descriptor = fake.create.mock.calls[0]?.[0] as TerminalDescriptor
    expect(descriptor).toMatchObject({ id: 'terminal-1-s1', title: '终端 1', workspaceId: 'C:/repo' })
  })

  it('有 root：新建终端派生 terminal-N 标签并渲染面板', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    render(<TerminalPage {...pageProps(parts)} />)
    const newButton = await findNewTerminalButton()
    expect(newButton.getAttribute('disabled')).toBeNull()
    expect(screen.getByText(/▣ repo/)).toBeTruthy()

    fireEvent.click(newButton)

    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))
    const descriptor = fake.create.mock.calls[0]?.[0] as TerminalDescriptor
    expect(descriptor).toMatchObject({ id: 'terminal-1-s1', title: '终端 1', workspaceId: 'C:/repo' })
    expect(screen.getByRole('tab', { name: '终端 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '复制' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '清屏' })).toBeTruthy()
  })

  it('W6.8：页面重挂后再新建终端得到新标签（id 不撞既有标签）', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    const first = render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))

    // 页面卸载再挂载（页内计数器归零的复现场景）
    first.unmount()
    render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())

    // 第二个终端必须是新标签 + 新会话，而不是复用 terminal-1
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(2))
    const second = fake.create.mock.calls[1]?.[0] as TerminalDescriptor
    expect(second.id).toBe('terminal-2-s2')
    expect(second.title).toBe('终端 2')
    expect(screen.getByRole('tab', { name: '终端 1' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '终端 2' })).toBeTruthy()
  })

  it('会话退出：显示退出提示与重开动作，重开关闭旧 PTY 并派生新 id', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))

    fake.emit({ terminalId: 'terminal-1-s1', exitCode: 0 })
    await waitFor(() => expect(screen.getByText(/会话已退出/)).toBeTruthy())
    expect(screen.getByRole('button', { name: '重开' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '重开' }))
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(2))
    expect(fake.close).toHaveBeenCalledWith('terminal-1-s1')
    const reopened = fake.create.mock.calls[1]?.[0] as TerminalDescriptor
    expect(reopened.id).toBe('terminal-1-s2')
    await waitFor(() => expect(screen.queryByText(/会话已退出/)).toBeNull())
    expect(screen.queryByRole('button', { name: '重开' })).toBeNull()
  })

  it('多个终端标签：切换不重建会话，关闭交回壳层', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    render(<TerminalPage {...pageProps(parts)} />)
    const newButton = await findNewTerminalButton()
    fireEvent.click(newButton)
    fireEvent.click(newButton)
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(2))

    // 切回第一个终端标签：不重新创建（detach 语义），只通知壳层
    fireEvent.click(screen.getByRole('tab', { name: '终端 1' }))
    expect(parts.onSwitchSurface).toHaveBeenCalledWith(expect.objectContaining({ id: 'terminal-1' }))
    expect(fake.create).toHaveBeenCalledTimes(2)

    // 面板内关闭只通知壳层（实际销毁由 provider.close 完成）
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(parts.onCloseSurface).toHaveBeenCalledTimes(1)

    // provider.close 才终止 PTY 并销毁 xterm
    const provider = parts.registry.get('terminal')
    await provider?.close?.({ id: 'terminal-1', providerId: 'terminal', kind: 'terminal', title: '终端 1' })
    expect(fake.close).toHaveBeenCalledWith('terminal-1-s1')
  })

  it('创建失败：显示失败浮层与服务端 detail，不留下就绪面板', async () => {
    const fake = makeApi()
    fake.create.mockResolvedValue({ ok: false, detail: '未选择工作区目录，请先选择工作区' })
    const parts = makePage(REPO_ROOT, fake)

    render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())

    await waitFor(() => expect(screen.getByText(/终端创建失败/)).toBeTruthy())
    expect(screen.getByText(/未选择工作区目录/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭标签' })).toBeTruthy()
  })

  it('页面卸载只 detach：会话保留，重新挂载直接复用', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    const { unmount } = render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))

    unmount()
    expect(fake.close).not.toHaveBeenCalled()

    render(<TerminalPage {...pageProps(parts)} />)
    await waitFor(() => expect(screen.getByRole('tab', { name: '终端 1' })).toBeTruthy())
    expect(fake.create).toHaveBeenCalledTimes(1) // 复用既有会话
  })

  it('键盘输入经 terminalInput，清屏向 PTY 发送换页符', async () => {
    const fake = makeApi()
    const parts = makePage(REPO_ROOT, fake)

    render(<TerminalPage {...pageProps(parts)} />)
    fireEvent.click(await findNewTerminalButton())
    await waitFor(() => expect(fake.create).toHaveBeenCalledTimes(1))

    // xterm onData 回调（面板已订阅）→ terminalInput
    const xterm = hoisted.terminals[0] as MockTerminal
    await waitFor(() => expect(xterm.onData).toHaveBeenCalled())
    const onDataHandler = xterm.onData.mock.calls[0]?.[0] as ((data: string) => void) | undefined
    expect(typeof onDataHandler).toBe('function')
    onDataHandler?.('echo hi\r')
    await waitFor(() => expect(fake.input).toHaveBeenCalledWith('terminal-1-s1', 'echo hi\r'))

    fireEvent.click(screen.getByRole('button', { name: '清屏' }))
    await waitFor(() => expect(fake.input).toHaveBeenCalledWith('terminal-1-s1', '\x0c'))
  })
})
