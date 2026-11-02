import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  BrowserNavigateRequest,
  BrowserSessionState,
  BrowserSurfaceEvent,
  BrowserExtractionListResult,
  BrowserExtractionDetailResult,
} from '@dogic/plugin-browser'
import type { BrowserPanelApi, BrowserLayoutStore } from '@dogic/plugin-browser/renderer'
import { BrowserPanel, BrowserLayoutStore as LayoutStore } from '@dogic/plugin-browser/renderer'
import type { SurfaceDescriptor } from '@dogic/core/surface'
import type { ViewBounds } from '@dogic/core'

interface FakeBrowserApi {
  api: BrowserPanelApi
  navigate: ReturnType<typeof vi.fn>
  back: ReturnType<typeof vi.fn>
  forward: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  state: ReturnType<typeof vi.fn>
  show: ReturnType<typeof vi.fn>
  hide: ReturnType<typeof vi.fn>
  bounds: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  extractList: ReturnType<typeof vi.fn>
  extractDetail: ReturnType<typeof vi.fn>
  emit(event: BrowserSurfaceEvent): void
}

const DESCRIPTOR: SurfaceDescriptor = {
  id: 'browser-1',
  providerId: 'browser',
  kind: 'webcontents',
  title: '浏览器 1',
  capabilities: ['network:navigate'],
}

/** 伪造会话快照：事件/导航会改变快照，与主进程状态机行为一致（面板经 browserState 拉取）。 */
function makeState(overrides: Partial<BrowserSessionState> = {}): BrowserSessionState {
  return {
    id: 'browser-1',
    title: '浏览器 1',
    active: true,
    currentUrl: 'https://example.com/',
    canBack: false,
    canForward: false,
    loading: false,
    failed: '',
    crashed: false,
    unresponsive: false,
    ...overrides,
  }
}

function makeApi(
  initialState: BrowserSessionState | null = null,
  navigateOverride: { ok: boolean; url: string; detail?: string } | null = null,
  extractionOverride: {
    list?: Partial<BrowserExtractionListResult>
    detail?: Partial<BrowserExtractionDetailResult>
  } = {},
): FakeBrowserApi {
  const listeners = new Set<(event: BrowserSurfaceEvent) => void>()
  const current = { value: initialState }
  const navigate = vi.fn(async (_id: string, _request: BrowserNavigateRequest) => {
    const result = { ok: true, url: 'https://example.com/' }
    if (current.value) {
      current.value = { ...current.value, currentUrl: result.url, failed: '', crashed: false }
    }
    return result
  })
  if (navigateOverride) {
    navigate.mockImplementation(async () => navigateOverride)
  }
  const back = vi.fn(async () => ({ ok: true, url: 'https://example.com/back' }))
  const forward = vi.fn(async () => ({ ok: true, url: 'https://example.com/' }))
  const reload = vi.fn(async () => ({ ok: true, url: 'https://example.com/' }))
  const stop = vi.fn(async () => ({ ok: true }))
  const state = vi.fn(async () => current.value)
  const show = vi.fn(async (_descriptor: SurfaceDescriptor, _bounds: ViewBounds) => ({ ok: true }))
  const hide = vi.fn(async () => true)
  const bounds = vi.fn(async () => true)
  const close = vi.fn(async () => true)
  const onEvent = vi.fn((cb: (event: BrowserSurfaceEvent) => void) => {
    listeners.add(cb)
    return () => { listeners.delete(cb) }
  })
  const extractList = vi.fn(async (): Promise<BrowserExtractionListResult> => ({
    ok: true,
    page: { url: 'https://example.com/', title: '示例页', viewport: { width: 1280, height: 720 } },
    elements: [
      { ref: 'el-1', role: 'button', name: '提交', tagName: 'BUTTON', rect: { x: 1, y: 2, width: 3, height: 4 } },
      { ref: 'el-2', role: 'link', name: '文档', tagName: 'A', rect: null },
    ],
    ...extractionOverride.list,
  }))
  const extractDetail = vi.fn(async (): Promise<BrowserExtractionDetailResult> => ({
    ok: true,
    element: {
      tagName: 'button',
      role: 'button',
      name: '提交',
      selector: 'html > body > button',
      path: [],
      textSnippet: '提交表单',
      attributes: { type: 'button', title: '提交' },
      rect: { x: 1, y: 2, width: 3, height: 4 },
    },
    ...extractionOverride.detail,
  }))
  const api: BrowserPanelApi = {
    browserNavigate: navigate,
    browserBack: back,
    browserForward: forward,
    browserReload: reload,
    browserStop: stop,
    browserState: state,
    browserOnEvent: onEvent,
    browserExtractList: extractList,
    browserExtractDetail: extractDetail,
    surfaceShow: show,
    surfaceHide: hide,
    surfaceBounds: bounds,
    surfaceClose: close,
  }
  return {
    api, navigate, back, forward, reload, stop, state, show, hide, bounds, close,
    extractList, extractDetail,
    emit: (event) => {
      if (current.value) {
        current.value = {
          ...current.value,
          loading: event.type === 'loading' ? event.loading : current.value.loading,
          failed: event.type === 'failed' ? event.message : current.value.failed,
          currentUrl: event.type === 'navigated' ? event.url : current.value.currentUrl,
          crashed: event.type === 'crashed' ? true : current.value.crashed,
          unresponsive: event.type === 'unresponsive' ? event.responsive : current.value.unresponsive,
        }
      }
      for (const listener of [...listeners]) listener(event)
    },
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BrowserPanel（W5.3 地址栏与导航控制）', () => {
  it('挂载即挂载宿主视图（surfaceShow 收到 descriptor 与 bounds），卸载只摘除', async () => {
    const fake = makeApi(makeState())
    const onRequestClose = vi.fn()

    const { unmount } = render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={onRequestClose} />)

    await waitFor(() => expect(fake.show).toHaveBeenCalledTimes(1))
    const [descriptor, bounds] = fake.show.mock.calls[0] as [SurfaceDescriptor, ViewBounds]
    expect(descriptor).toMatchObject({ id: 'browser-1', providerId: 'browser', kind: 'webcontents' })
    expect(bounds).toMatchObject({ width: 0, height: 0 })
    expect(fake.close).not.toHaveBeenCalled()

    unmount()
    expect(fake.hide).toHaveBeenCalled()
  })

  it('active=false 挂载时即隐藏视图（标签切换不销毁）', () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active={false} onRequestClose={vi.fn()} />)
    expect(fake.show).not.toHaveBeenCalled()
    expect(fake.hide).toHaveBeenCalledWith('browser-1')
  })

  it('地址栏提交经 browserNavigate；成功后输入框同步当前 URL', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    const address = screen.getByPlaceholderText('输入 http/https 地址') as HTMLInputElement
    await waitFor(() => expect(address.value).toBe('https://example.com/'))

    fireEvent.change(address, { target: { value: 'https://example.com/a' } })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))

    await waitFor(() => expect(fake.navigate).toHaveBeenCalledTimes(1))
    expect(fake.navigate.mock.calls[0]?.[0]).toBe('browser-1')
    expect(fake.navigate.mock.calls[0]?.[1]).toMatchObject({ url: 'https://example.com/a' })
    // 成功后提示清空、输入框回到服务端当前 URL
    await waitFor(() => expect(address.value).toBe('https://example.com/'))
  })

  it('非法 URL 由服务端拒绝：回显安全 detail，不产生导航成功态', async () => {
    const fake = makeApi(makeState(), { ok: false, url: '', detail: 'browser 协议不受支持: file:' })
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    const address = screen.getByPlaceholderText('输入 http/https 地址') as HTMLInputElement
    await waitFor(() => expect(address.value).toBe('https://example.com/'))

    fireEvent.change(address, { target: { value: 'file:///C:/' } })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))

    await waitFor(() => expect(screen.getByText(/browser 协议不受支持/)).toBeTruthy())
    expect(fake.navigate).toHaveBeenCalledTimes(1)
  })

  it('后退/前进/刷新/停止按钮转发对应通道；按钮可用性跟随会话状态', async () => {
    const fake = makeApi(makeState({ canBack: true, canForward: true, loading: true }))
    const { unmount } = render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByTitle('后退').getAttribute('disabled')).toBeNull())

    fireEvent.click(screen.getByTitle('后退'))
    fireEvent.click(screen.getByTitle('前进'))
    fireEvent.click(screen.getByTitle('刷新'))
    fireEvent.click(screen.getByTitle('停止'))
    await waitFor(() => {
      expect(fake.back).toHaveBeenCalledWith('browser-1')
      expect(fake.forward).toHaveBeenCalledWith('browser-1')
      expect(fake.reload).toHaveBeenCalledWith('browser-1')
      expect(fake.stop).toHaveBeenCalledWith('browser-1')
    })
    unmount()

    // 无页面（currentUrl=null）时：← → ⟳ ⏹ 全部禁用
    const empty = makeApi(makeState({ currentUrl: null }))
    render(<BrowserPanel api={empty.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    await waitFor(() => {
      expect(screen.getByTitle('后退').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTitle('前进').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTitle('刷新').getAttribute('disabled')).not.toBeNull()
      expect(screen.getByTitle('停止').getAttribute('disabled')).not.toBeNull()
    })
  })

  it('loading 事件驱动进度条与停止按钮', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fake.emit({ type: 'loading', id: 'browser-1', loading: true })
    await waitFor(() => expect(screen.getByTitle('停止').getAttribute('disabled')).toBeNull())

    fake.emit({ type: 'loading', id: 'browser-1', loading: false })
    await waitFor(() => expect(screen.getByTitle('停止').getAttribute('disabled')).not.toBeNull())
  })

  it('failed 事件：提示显示服务端净化文案，提供重试/关闭标签', async () => {
    const fake = makeApi(makeState())
    const onRequestClose = vi.fn()
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={onRequestClose} />)

    fake.emit({ type: 'failed', id: 'browser-1', errorCode: -3, message: '导航被安全策略拒绝' })
    await waitFor(() => expect(screen.getByText(/导航被安全策略拒绝/)).toBeTruthy())
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭标签' })).toBeTruthy()

    // 重试 → reload
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => expect(fake.reload).toHaveBeenCalledWith('browser-1'))

    // 关闭标签 → 交回壳层（面板不销毁会话）
    fake.emit({ type: 'crashed', id: 'browser-1' })
    await waitFor(() => expect(screen.getByText(/页面已崩溃/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '关闭标签' }))
    expect(onRequestClose).toHaveBeenCalledTimes(1)
  })

  it('页面事件只作用于本 descriptor 的会话', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    fake.emit({ type: 'failed', id: 'browser-2', errorCode: -1, message: '其他标签失败' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(screen.queryByText(/其他标签失败/)).toBeNull()
  })

  it('permission-denied 事件：呈现脱敏拒绝文案（origin+类型）', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    fake.emit({ type: 'permission-denied', id: 'browser-1', origin: 'https://example.com', permission: 'geolocation' })
    await waitFor(() =>
      expect(screen.getByText(/已拒绝 https:\/\/example\.com 的 geolocation 权限请求/)).toBeTruthy(),
    )
    // 拒绝事件不驱动导航/历史状态变化
    expect(fake.reload).not.toHaveBeenCalled()
  })

  it('download 事件：呈现受控下载状态行（文件名/来源/进度/终态）', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)
    fake.emit({
      type: 'download', id: 'browser-1', state: 'started',
      filename: 'report.pdf', origin: 'https://example.com', percent: 0,
    })
    await waitFor(() => expect(screen.getByText(/等待保存位置/)).toBeTruthy())
    fake.emit({
      type: 'download', id: 'browser-1', state: 'progress',
      filename: 'report.pdf', origin: 'https://example.com', percent: 42,
    })
    await waitFor(() => expect(screen.getByText('42%')).toBeTruthy())
    fake.emit({
      type: 'download', id: 'browser-1', state: 'completed',
      filename: 'report.pdf', origin: 'https://example.com', percent: 100,
    })
    await waitFor(() => expect(screen.getByText('已完成')).toBeTruthy())
    // 文件名与来源 origin 行可见（脱敏字段，不自动执行内容）
    expect(screen.getByText('report.pdf')).toBeTruthy()
    expect(screen.getByText('https://example.com')).toBeTruthy()
    // 同文件名事件就地更新（单行），不驱动导航/历史状态变化
    expect(screen.getAllByText('report.pdf')).toHaveLength(1)
    expect(fake.reload).not.toHaveBeenCalled()
  })
})

describe('BrowserPanel（W5.6 安全浏览布局状态）', () => {
  /** 内存持久化后端。 */
  function memLayout(): { store: BrowserLayoutStore; data: Map<string, string> } {
    const data = new Map<string, string>()
    const store = new LayoutStore({
      key: 'test-browser-layout',
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v) },
        removeItem: (k: string) => { data.delete(k) },
      },
    })
    return { store, data }
  }

  it('挂载时消费恢复 URL：用户可见地重新导航，恢复后不再重复导航', async () => {
    const { store, data } = memLayout()
    // 上一会话保存的布局（普通 URL）
    store.saveUrl('browser-1', 'https://restore.example.com/')

    const fake = makeApi(makeState({ currentUrl: null }))
    const onRequestClose = vi.fn()
    const { unmount } = render(
      <BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={onRequestClose} layout={store} />,
    )

    await waitFor(() =>
      expect(fake.navigate).toHaveBeenCalledWith('browser-1', { url: 'https://restore.example.com/' }),
    )
    // 恢复是用户可见的重导航：恢复导航成功后提示清空
    await waitFor(() => expect(screen.queryByText(/正在恢复上次浏览的页面/)).toBeNull())
    // 恢复导航完成后，当前 URL 重新入布局（供下次会话恢复）
    await waitFor(() => expect(data.get('test-browser-layout')).toContain('example.com'))
    // 恢复只触发一次导航（导航后的保存不触发重导航）
    expect(fake.navigate).toHaveBeenCalledTimes(1)

    // 卸载清理布局记录（标签关闭不留残留）
    unmount()
    expect(store.consume('browser-1')).toBeUndefined()
    expect(fake.hide).toHaveBeenCalled()
  })

  it('挂载时布局为敏感 URL：不恢复导航，仅按新标签处理', async () => {
    const { store } = memLayout()
    // 敏感 URL 保存即拒绝（布局层已过滤）——验证不触发任何恢复导航
    store.saveUrl('browser-1', 'https://restore.example.com/?token=x')

    const fake = makeApi(makeState({ currentUrl: null }))
    const { unmount } = render(
      <BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} layout={store} />,
    )
    // 等待足以覆盖恢复时窗的时长
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(fake.navigate).not.toHaveBeenCalled()
    unmount()
  })

  it('导航/会话 URL 变化后保存当前普通 URL；卸载清理布局记录', async () => {
    const { store, data } = memLayout()
    const fake = makeApi(makeState({ currentUrl: null }))
    const { unmount } = render(
      <BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} layout={store} />,
    )

    // 地址栏提交新地址 → 会话 URL 变化 → 布局保存普通 URL
    fireEvent.change(screen.getByPlaceholderText('输入 http/https 地址'), {
      target: { value: 'https://example.com/a' },
    })
    fireEvent.click(screen.getByRole('button', { name: '前往' }))
    await waitFor(() => expect(fake.navigate).toHaveBeenCalledTimes(1))
    // 导航成功后服务端状态更新 → 布局保存新 URL 并持久化
    await waitFor(() => expect(data.get('test-browser-layout')).toContain('example.com'))
    // 布局中确实保存了当前 URL（用独立 store 读取，不干扰面板生命周期）
    const readBack = new LayoutStore({
      key: 'test-browser-layout',
      storage: {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v) },
        removeItem: (k: string) => { data.delete(k) },
      },
    })
    expect(readBack.consume('browser-1')).toBe('https://example.com/')

    // 卸载时清理布局记录
    unmount()
    expect(store.consume('browser-1')).toBeUndefined()
  })
})

describe('BrowserPanel（W6 元素提取）', () => {
  it('「提取元素」按钮：拉清单并渲染元素条目', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))

    await waitFor(() => expect(fake.extractList).toHaveBeenCalledTimes(1))
    expect(fake.extractList.mock.calls[0]?.[0]).toBe('browser-1')
    expect(screen.getByText('提交（button）')).toBeTruthy()
    expect(screen.getByText('文档（link）')).toBeTruthy()
  })

  it('点击元素条目：取详情并渲染详情卡片（标签/角色/名称/选择器/文本/属性）', async () => {
    const fake = makeApi(makeState())
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))
    await waitFor(() => expect(screen.getByText('提交（button）')).toBeTruthy())

    fireEvent.click(screen.getByText('提交（button）'))

    await waitFor(() => expect(fake.extractDetail).toHaveBeenCalledTimes(1))
    expect(fake.extractDetail.mock.calls[0]?.[0]).toBe('browser-1')
    expect(fake.extractDetail.mock.calls[0]?.[1]).toEqual({ ref: 'el-1' })
    await waitFor(() => expect(screen.getByText('html > body > button')).toBeTruthy())
    expect(screen.getByText('提交表单')).toBeTruthy()
    // 角色与属性值都是 'button'（详情卡片里出现多次）
    expect(screen.getAllByText('button').length).toBeGreaterThan(0)
  })

  it('清单失败：呈现主进程给出的可展示文案，不渲染元素', async () => {
    const fake = makeApi(makeState(), null, { list: { ok: false, elements: [], detail: '当前浏览器视图不支持元素提取' } })
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))

    await waitFor(() => expect(screen.getByText(/不支持元素提取/)).toBeTruthy())
    expect(fake.extractDetail).not.toHaveBeenCalled()
  })

  it('清单为空：提示页面没有可提取元素', async () => {
    const fake = makeApi(makeState(), null, { list: { ok: true, elements: [] } })
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))

    await waitFor(() => expect(screen.getByText(/没有可提取的元素/)).toBeTruthy())
  })

  it('详情失败：呈现主进程文案并清空详情卡片', async () => {
    const fake = makeApi(makeState(), null, {
      detail: { ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' },
    })
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))
    await waitFor(() => expect(screen.getByText('提交（button）')).toBeTruthy())
    fireEvent.click(screen.getByText('提交（button）'))

    await waitFor(() => expect(screen.getByText(/引用无效或已过期/)).toBeTruthy())
    expect(screen.queryByText('html > body > button')).toBeNull()
  })

  it('元素截图存在时渲染截图', async () => {
    const fake = makeApi(makeState(), null, {
      detail: {
        ok: true,
        element: {
          tagName: 'button',
          role: 'button',
          name: '提交',
          selector: null,
          path: [],
          textSnippet: '',
          attributes: {},
          rect: null,
          screenshot: { dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 20 },
        },
      },
    })
    render(<BrowserPanel api={fake.api} descriptor={DESCRIPTOR} active onRequestClose={vi.fn()} />)

    fireEvent.click(screen.getByTitle('提取元素'))
    await waitFor(() => expect(screen.getByText('提交（button）')).toBeTruthy())
    fireEvent.click(screen.getByText('提交（button）'))

    await waitFor(() => expect(screen.getByAltText('元素截图')).toBeTruthy())
  })
})
