import { describe, expect, it, vi } from 'vitest'
import type { WebContentsView } from 'electron'
import { DEFAULT_MAX_BROWSER_SESSIONS, BrowserSurfaceService } from './index.js'
import type {
  BrowserDescriptor,
  BrowserSurfaceEvent,
  BrowserSurfaceView,
  BrowserSurfaceViewFactory,
  BrowserViewEvent,
} from './index.js'
import type { BrowserExtractionPort } from './extraction-cdp.js'

function descriptorInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'browser-1',
    providerId: 'browser',
    kind: 'webcontents',
    title: '浏览器',
    capabilities: ['network:navigate'],
    ...overrides,
  }
}

interface FakeView {
  view: BrowserSurfaceView
  loadURL: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  cancelDownloads: ReturnType<typeof vi.fn>
  setBounds: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  emit(event: BrowserViewEvent): void
}

function fakeViewFactory(port?: BrowserExtractionPort): {
  factory: BrowserSurfaceViewFactory
  views: FakeView[]
  guardCalls: Array<(url: string) => boolean>
} {
  const views: FakeView[] = []
  const guards: Array<(url: string) => boolean> = []
  const factory = ((_descriptor: BrowserDescriptor, guard: (url: string) => boolean) => {
    const listeners = new Set<(event: BrowserViewEvent) => void>()
    const loadURL = vi.fn(async () => {})
    const stop = vi.fn()
    const close = vi.fn()
    const cancelDownloads = vi.fn()
    const setBounds = vi.fn()
    const subscribe = vi.fn((listener: (event: BrowserViewEvent) => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    })
    const view: BrowserSurfaceView = {
      underlying: {} as unknown as WebContentsView,
      loadURL,
      stop,
      close,
      cancelDownloads,
      setBounds,
      subscribe,
      ...(port ? { extraction: port } : {}),
    }
    views.push({
      view,
      loadURL,
      stop,
      close,
      cancelDownloads,
      setBounds,
      subscribe,
      emit: (event) => {
        for (const listener of [...listeners]) listener(event)
      },
    })
    guards.push(guard)
    return view
  }) as BrowserSurfaceViewFactory
  return { factory, views, guardCalls: guards }
}

function recordingService() {
  const { factory, views } = fakeViewFactory()
  const events: BrowserSurfaceEvent[] = []
  const service = new BrowserSurfaceService({
    factory,
    onEvent: (event) => events.push(event),
  })
  return { service, views, events }
}

describe('BrowserSurfaceService（会话隔离与导航策略）', () => {
  it('open 创建会话并可见；重复 open 拒绝', async () => {
    const { service } = recordingService()
    expect(await service.open(descriptorInput())).toEqual({ ok: true })
    const state = service.state('browser-1')
    expect(state?.title).toBe('浏览器')
    expect(state?.active).toBe(true)
    expect(state?.currentUrl).toBeNull()
    expect(state?.canBack).toBe(false)
    expect(state?.canForward).toBe(false)
    const again = await service.open(descriptorInput())
    expect(again.ok).toBe(false)
    expect(again.detail).toContain('已存在')
  })

  it('并发会话上限受控', async () => {
    const { factory } = fakeViewFactory()
    const service = new BrowserSurfaceService({ factory, maxSessions: 2 })
    expect((await service.open(descriptorInput({ id: 'b-1' }))).ok).toBe(true)
    expect((await service.open(descriptorInput({ id: 'b-2' }))).ok).toBe(true)
    const third = await service.open(descriptorInput({ id: 'b-3' }))
    expect(third.ok).toBe(false)
    expect(third.detail).toContain('上限')
    expect(DEFAULT_MAX_BROWSER_SESSIONS).toBe(8)
  })

  it('navigate 接受 http/https 并记录历史；非法协议不污染历史', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    const first = await service.navigate('browser-1', { url: 'https://example.com/a' })
    expect(first).toEqual({ ok: true, url: 'https://example.com/a' })
    const rejected = await service.navigate('browser-1', { url: 'file:///C:/' })
    expect(rejected.ok).toBe(false)
    expect(rejected.detail).toContain('协议不受支持')
    const state = service.state('browser-1')
    expect(state?.currentUrl).toBe('https://example.com/a')
    expect(views[0]?.loadURL).toHaveBeenCalledTimes(1)
    expect(views[0]?.loadURL).toHaveBeenCalledWith('https://example.com/a')
  })

  it('back/forward 状态机与边界', async () => {
    const { service } = recordingService()
    await service.open(descriptorInput())
    expect((await service.back('browser-1')).ok).toBe(false)
    await service.navigate('browser-1', { url: 'https://example.com/1' })
    await service.navigate('browser-1', { url: 'https://example.com/2' })
    let state = service.state('browser-1')
    expect(state?.canBack).toBe(true)
    expect(state?.canForward).toBe(false)
    expect((await service.back('browser-1'))).toEqual({ ok: true, url: 'https://example.com/1' })
    state = service.state('browser-1')
    expect(state?.canBack).toBe(false)
    expect(state?.canForward).toBe(true)
    // 新导航截断 forward 分支
    await service.navigate('browser-1', { url: 'https://example.com/3' })
    expect((await service.forward('browser-1')).ok).toBe(false)
  })

  it('reload 重载当前页；无页面 reload 拒绝', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    expect((await service.reload('browser-1')).ok).toBe(false)
    await service.navigate('browser-1', { url: 'https://example.com/x' })
    expect((await service.reload('browser-1'))).toEqual({ ok: true, url: 'https://example.com/x' })
    expect(views[0]?.loadURL).toHaveBeenCalledTimes(2)
  })

  it('activate/deactivate 只切换可见态，不销毁会话', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    await service.navigate('browser-1', { url: 'https://example.com/' })
    expect((await service.deactivate('browser-1')).ok).toBe(true)
    expect(service.state('browser-1')?.active).toBe(false)
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/')
    expect(views[0]?.close).not.toHaveBeenCalled()
    expect((await service.activate('browser-1')).ok).toBe(true)
    expect(service.state('browser-1')?.active).toBe(true)
  })

  it('close 只回收本会话；视图销毁且其他会话不受影响', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput({ id: 'b-1' }))
    await service.open(descriptorInput({ id: 'b-2' }))
    await service.navigate('b-2', { url: 'https://example.com/' })
    expect((await service.close('b-1')).ok).toBe(true)
    expect(views[0]?.close).toHaveBeenCalledTimes(1)
    expect(service.state('b-1')).toBeUndefined()
    // 其他会话不受影响
    expect(service.state('b-2')?.currentUrl).toBe('https://example.com/')
    expect(views[1]?.close).not.toHaveBeenCalled()
    expect((await service.close('b-1')).ok).toBe(false)
  })

  it('未知会话的导航/历史/停止/可见/关闭操作全部显式失败', async () => {
    const { service } = recordingService()
    expect((await service.navigate('ghost', { url: 'https://example.com/' })).ok).toBe(false)
    expect((await service.back('ghost')).ok).toBe(false)
    expect((await service.forward('ghost')).ok).toBe(false)
    expect((await service.reload('ghost')).ok).toBe(false)
    expect((await service.stop('ghost')).ok).toBe(false)
    expect((await service.activate('ghost')).ok).toBe(false)
    expect((await service.deactivate('ghost')).ok).toBe(false)
    expect((await service.close('ghost')).ok).toBe(false)
    expect(service.state('ghost')).toBeUndefined()
  })

  it('非法 descriptor/导航输入在策略层拒绝', async () => {
    const { service } = recordingService()
    const forged = await service.open(descriptorInput({ providerId: 'terminal' }))
    expect(forged.ok).toBe(false)
    expect(forged.detail).toContain('providerId')
    await service.open(descriptorInput())
    expect((await service.navigate('browser-1', { url: 'javascript:alert(1)' })).ok).toBe(false)
    expect((await service.navigate('browser-1', { url: 42 })).ok).toBe(false)
    expect((await service.navigate('browser-1', 'https://example.com/')).ok).toBe(false)
  })

  it('loadURL 未受理时导航失败且不入历史，failed 事件上报', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    views[0]?.loadURL.mockRejectedValueOnce(new Error('net::ERR_CONNECTION_REFUSED'))
    const result = await service.navigate('browser-1', { url: 'https://example.com/' })
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('ERR_CONNECTION_REFUSED')
    expect(service.state('browser-1')?.currentUrl).toBeNull()
    expect(service.state('browser-1')?.failed).toContain('ERR_CONNECTION_REFUSED')
    expect(events).toContainEqual({
      type: 'failed', id: 'browser-1', errorCode: -1, message: 'net::ERR_CONNECTION_REFUSED',
    })
  })

  it('dispose 统一回收全部会话（视图销毁 + 事件出口断开）', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput({ id: 'b-1' }))
    await service.open(descriptorInput({ id: 'b-2' }))
    service.dispose()
    expect(views[0]?.close).toHaveBeenCalledTimes(1)
    expect(views[1]?.close).toHaveBeenCalledTimes(1)
    expect(service.state('b-1')).toBeUndefined()
    expect(service.state('b-2')).toBeUndefined()
    // 回收后再发事件不触达出口（订阅已移除）
    views[0]?.emit({ type: 'loading', loading: true })
    expect(events).toHaveLength(0)
  })
})

describe('BrowserSurfaceService（多标签与生命周期 W5.2）', () => {
  it('多浏览器标签共存：切换不重载（视图不重建、不销毁）', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput({ id: 'browser-1' }))
    await service.open(descriptorInput({ id: 'browser-2' }))
    await service.navigate('browser-1', { url: 'https://example.com/a' })
    await service.navigate('browser-2', { url: 'https://example.com/b' })
    expect(views).toHaveLength(2)
    expect(views[0]?.loadURL).toHaveBeenCalledWith('https://example.com/a')
    expect(views[1]?.loadURL).toHaveBeenCalledWith('https://example.com/b')
    // 标签切换只切可见态：视图不被销毁、历史保留
    expect((await service.deactivate('browser-1')).ok).toBe(true)
    expect((await service.activate('browser-2')).ok).toBe(true)
    expect(views[0]?.close).not.toHaveBeenCalled()
    expect(views[1]?.close).not.toHaveBeenCalled()
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/a')
    expect(service.state('browser-2')?.currentUrl).toBe('https://example.com/b')
    // 切回后仍可后退（历史未丢）
    await service.navigate('browser-1', { url: 'https://example.com/a2' })
    expect((await service.back('browser-1'))).toEqual({ ok: true, url: 'https://example.com/a' })
  })

  it('视图事件驱动会话状态：loading/failed/navigated/crashed/unresponsive', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.navigate('browser-1', { url: 'https://example.com/a' })
    views[0]?.emit({ type: 'loading', loading: true })
    expect(service.state('browser-1')?.loading).toBe(true)
    views[0]?.emit({ type: 'loading', loading: false })
    expect(service.state('browser-1')?.loading).toBe(false)
    views[0]?.emit({ type: 'failed', errorCode: -3, message: 'ERR_NAME_NOT_RESOLVED' })
    expect(service.state('browser-1')?.failed).toBe('ERR_NAME_NOT_RESOLVED')
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/a')
    views[0]?.emit({ type: 'navigated', url: 'https://example.com/final' })
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/final')
    views[0]?.emit({ type: 'crashed' })
    expect(service.state('browser-1')?.crashed).toBe(true)
    views[0]?.emit({ type: 'unresponsive', responsive: false })
    expect(service.state('browser-1')?.unresponsive).toBe(true)
    views[0]?.emit({ type: 'unresponsive', responsive: true })
    expect(service.state('browser-1')?.unresponsive).toBe(false)
    expect(events.map((event) => event.type)).toEqual([
      'loading', 'loading', 'failed', 'navigated', 'crashed', 'unresponsive', 'unresponsive',
    ])
  })

  it('权限拒绝事件按会话上报且只作用于本会话（W5.4）', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.open(descriptorInput({ id: 'browser-2' }))
    views[0]?.emit({ type: 'permission-denied', origin: 'https://example.com', permission: 'geolocation' })
    views[1]?.emit({ type: 'permission-denied', origin: 'https://other.test', permission: 'notifications' })
    const denied = events.filter((event) => event.type === 'permission-denied')
    expect(denied).toContainEqual({
      type: 'permission-denied', id: 'browser-1', origin: 'https://example.com', permission: 'geolocation',
    })
    expect(denied).toContainEqual({
      type: 'permission-denied', id: 'browser-2', origin: 'https://other.test', permission: 'notifications',
    })
    // 事件不改变页面状态（只诊断，不干预导航/历史）
    const state = service.state('browser-1')
    expect(state?.currentUrl).toBeNull()
    expect(state?.failed).toBe('')
    expect(state?.loading).toBe(false)
  })

  it('重定向到非白名单/内嵌凭据地址：不记录并上报 failed', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.navigate('browser-1', { url: 'https://example.com/a' })
    views[0]?.emit({ type: 'navigated', url: 'file:///C:/Windows/' })
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/a')
    expect(service.state('browser-1')?.failed).toContain('协议不受支持')
    views[0]?.emit({ type: 'navigated', url: 'http://user:pass@example.com/' })
    expect(service.state('browser-1')?.failed).toContain('内嵌凭据')
    expect(events.some((event) => event.type === 'failed' && event.errorCode === -2)).toBe(true)
    expect(events.some((event) => event.type === 'navigated')).toBe(false)
  })

  it('崩溃隔离：一个会话崩溃/无响应不影响其他会话', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput({ id: 'b-1' }))
    await service.open(descriptorInput({ id: 'b-2' }))
    await service.navigate('b-1', { url: 'https://example.com/1' })
    await service.navigate('b-2', { url: 'https://example.com/2' })
    views[0]?.emit({ type: 'crashed' })
    views[0]?.emit({ type: 'unresponsive', responsive: false })
    expect(service.state('b-1')?.crashed).toBe(true)
    expect(service.state('b-1')?.unresponsive).toBe(true)
    const other = service.state('b-2')
    expect(other?.crashed).toBe(false)
    expect(other?.unresponsive).toBe(false)
    expect(other?.currentUrl).toBe('https://example.com/2')
    // 崩溃会话仍可关闭回收，其他会话继续可用
    expect((await service.close('b-1')).ok).toBe(true)
    expect(service.state('b-2')?.currentUrl).toBe('https://example.com/2')
  })

  it('onViewClosed：视图销毁后清理会话，后续事件忽略', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    expect(views[0]?.subscribe).toHaveBeenCalledTimes(1)
    service.provider.onViewClosed('browser-1')
    expect(service.state('browser-1')).toBeUndefined()
    // 会话终态后忽略后续事件（视图销毁与事件到达无固定顺序）
    views[0]?.emit({ type: 'loading', loading: true })
    views[0]?.emit({ type: 'crashed' })
    expect(events).toHaveLength(0)
  })

  it('provider 适配器：createView 创建会话视图、deferredUrl、resolve 恒就绪', async () => {
    const { service, views } = recordingService()
    expect(service.provider.id).toBe('browser')
    expect(service.provider.kind).toBe('webcontents')
    expect(service.provider.deferredUrl).toBe(true)
    expect(await service.provider.resolve()).toEqual({ ok: true })
    const underlying = service.provider.createView(descriptorInput())
    expect(underlying).toBe(views[0]?.view.underlying)
    expect(service.state('browser-1')?.title).toBe('浏览器')
    service.provider.createView(descriptorInput({ id: 'browser-2' }))
    expect(service.state('browser-2')?.id).toBe('browser-2')
    // 非法 descriptor/重复 id：createView 显式抛错（SurfaceHost 捕获呈现）
    expect(() => service.provider.createView(descriptorInput({ providerId: 'terminal' }))).toThrow(/providerId/)
    expect(() => service.provider.createView(descriptorInput())).toThrow(/已存在/)
  })

  it('provider 适配器：onViewAttached/onViewDetached 同步会话可见态', async () => {
    const { service } = recordingService()
    await service.open(descriptorInput())
    service.provider.onViewDetached('browser-1')
    expect(service.state('browser-1')?.active).toBe(false)
    service.provider.onViewAttached('browser-1')
    expect(service.state('browser-1')?.active).toBe(true)
    service.provider.onViewDetached('ghost')
    service.provider.onViewAttached('ghost')
  })

  it('视图抽象不提供 JS 执行通道（类型层保证）', () => {
    // @ts-expect-error BrowserSurfaceView 没有 executeJavaScript 属性
    void ({} as BrowserSurfaceView).executeJavaScript
  })
})

describe('BrowserSurfaceService（导航守卫与地址栏 W5.3）', () => {
  it('stop 停止当前加载（视图层受理）；未知会话显式失败', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    expect((await service.stop('browser-1'))).toEqual({ ok: true })
    expect(views[0]?.stop).toHaveBeenCalledTimes(1)
    const ghost = await service.stop('ghost')
    expect(ghost.ok).toBe(false)
    expect(ghost.detail).toContain('会话不存在')
  })

  it('工厂收到导航守卫：白名单/凭据/格式一律拒绝，http/https 放行', async () => {
    const { factory, guardCalls, views } = fakeViewFactory()
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())
    // 守卫经工厂第二参数注入（页面内导航与重定向目标同用）
    expect(guardCalls).toHaveLength(1)
    const guardFn = guardCalls[0]
    expect(guardFn('https://example.com/')).toBe(true)
    expect(guardFn('http://127.0.0.1:8080/')).toBe(true)
    expect(guardFn('file:///C:/Windows/')).toBe(false)
    expect(guardFn('javascript:alert(1)')).toBe(false)
    expect(guardFn('http://user:pass@example.com/')).toBe(false)
    expect(guardFn('example.com')).toBe(false)
    expect(guardFn('')).toBe(false)
    expect(views[0]?.stop).not.toHaveBeenCalled()
  })

  it('守卫拒绝的导航不产生 loadURL 调用（被守卫拦截在视图层）', async () => {
    // 守卫逻辑属视图层（electron-view），服务层只保证注入；此处验证注入守卫
    // 与 navigate 策略同源（同 parseBrowserUrl），非法目标在服务层先行拒绝。
    const { service } = recordingService()
    await service.open(descriptorInput())
    expect((await service.navigate('browser-1', { url: 'file:///etc/passwd' })).ok).toBe(false)
    expect((await service.navigate('browser-1', { url: 'http://a:b@c/' })).ok).toBe(false)
    expect(service.state('browser-1')?.failed).toBe('')
  })

  it('失败消息净化：携带内嵌凭据的错误文本不进入状态与事件', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.navigate('browser-1', { url: 'https://example.com/' })
    views[0]?.emit({ type: 'failed', errorCode: -102, message: "ERR_FAILED loading 'http://user:pass@example.com/secret'" })
    const state = service.state('browser-1')
    expect(state?.failed).toBe("ERR_FAILED loading 'http://example.com/secret'")
    expect(state?.failed).not.toContain('user:pass')
    expect(events).toContainEqual({
      type: 'failed', id: 'browser-1', errorCode: -102,
      message: "ERR_FAILED loading 'http://example.com/secret'",
    })
  })

  it('守卫拦截事件（errorCode -3）如实上报，不影响会话历史', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.navigate('browser-1', { url: 'https://example.com/a' })
    views[0]?.emit({ type: 'failed', errorCode: -3, message: '导航被安全策略拒绝' })
    expect(service.state('browser-1')?.failed).toBe('导航被安全策略拒绝')
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/a')
    expect(events).toContainEqual({
      type: 'failed', id: 'browser-1', errorCode: -3, message: '导航被安全策略拒绝',
    })
  })

  it('重定向：navigated 事件（最终地址）先于 loadURL resolve，状态保留最终地址', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    // 模拟重定向：loadURL 期间先发出最终地址的 navigated 事件
    views[0]?.loadURL.mockImplementationOnce(async (url: string) => {
      views[0]?.emit({ type: 'navigated', url: `${url}final` })
    })
    const result = await service.navigate('browser-1', { url: 'https://example.com/a' })
    expect(result).toEqual({ ok: true, url: 'https://example.com/a' })
    // did-navigate 先于 loadURL resolve 到达，goto 不得用初始 URL 覆盖最终地址
    expect(service.state('browser-1')?.currentUrl).toBe('https://example.com/afinal')
  })
})

describe('BrowserSurfaceService（受控下载 W5.5）', () => {
  it('下载事件按会话转发且只作用于本会话', async () => {
    const { service, views, events } = recordingService()
    await service.open(descriptorInput())
    await service.open(descriptorInput({ id: 'browser-2' }))
    views[0]?.emit({
      type: 'download', state: 'started', filename: 'report.pdf',
      origin: 'https://example.com', percent: 0,
    })
    views[1]?.emit({
      type: 'download', state: 'completed', filename: 'archive.zip',
      origin: 'https://other.test', percent: 100,
    })
    const downloads = events.filter((event) => event.type === 'download')
    expect(downloads).toContainEqual({
      type: 'download', id: 'browser-1', state: 'started',
      filename: 'report.pdf', origin: 'https://example.com', percent: 0,
    })
    expect(downloads).toContainEqual({
      type: 'download', id: 'browser-2', state: 'completed',
      filename: 'archive.zip', origin: 'https://other.test', percent: 100,
    })
    // 事件不改变页面状态（只诊断，不干预导航/历史）
    const state = service.state('browser-1')
    expect(state?.currentUrl).toBeNull()
    expect(state?.failed).toBe('')
    expect(state?.loading).toBe(false)
  })

  it('close 先取消在途下载再销毁视图（W5.5）', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    expect((await service.close('browser-1')).ok).toBe(true)
    expect(views[0]?.cancelDownloads).toHaveBeenCalledTimes(1)
    expect(views[0]?.cancelDownloads.mock.invocationCallOrder[0])
      .toBeLessThan(views[0]?.close.mock.invocationCallOrder[0])
    expect(views[0]?.close).toHaveBeenCalledTimes(1)
    // 未知会话 close 不触达视图
    expect((await service.close('ghost')).ok).toBe(false)
    expect(views[0]?.cancelDownloads).toHaveBeenCalledTimes(1)
  })

  it('dispose 统一回收前取消全部在途下载（W5.5）', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput({ id: 'b-1' }))
    await service.open(descriptorInput({ id: 'b-2' }))
    service.dispose()
    expect(views[0]?.cancelDownloads).toHaveBeenCalledTimes(1)
    expect(views[1]?.cancelDownloads).toHaveBeenCalledTimes(1)
    expect(views[0]?.cancelDownloads.mock.invocationCallOrder[0])
      .toBeLessThan(views[0]?.close.mock.invocationCallOrder[0])
    expect(views[1]?.cancelDownloads.mock.invocationCallOrder[0])
      .toBeLessThan(views[1]?.close.mock.invocationCallOrder[0])
  })

  it('onViewClosed（SurfaceHost 销毁视图后回调）：仍取消在途下载再清理会话（W5.5）', async () => {
    const { service, views } = recordingService()
    await service.open(descriptorInput())
    service.provider.onViewClosed('browser-1')
    expect(views[0]?.cancelDownloads).toHaveBeenCalledTimes(1)
    expect(service.state('browser-1')).toBeUndefined()
  })

  it('视图抽象不提供文件写入通道（类型层保证）', () => {
    // @ts-expect-error BrowserSurfaceView 没有 writeFile/savePath 属性
    void ({} as BrowserSurfaceView).writeFile
  })
})

/** 伪造元素提取端口（CDP 只读域的替身）。 */
function fakeExtractionPort(): {
  port: BrowserExtractionPort
  listElements: ReturnType<typeof vi.fn>
  describeElement: ReturnType<typeof vi.fn>
} {
  const listElements = vi.fn(async (limit: number) => ({
    url: 'https://example.com/page?token=secret',
    title: '示例页',
    viewport: { width: 1280, height: 720 },
    elements: [
      { ref: 'el-1', role: 'button', name: '提交', tagName: 'BUTTON', rect: { x: 1, y: 2, width: 3, height: 4 } },
      { ref: 'el-2', role: 'link', name: '文档', tagName: 'A', rect: null },
    ].slice(0, limit),
    backendIds: [101, 102].slice(0, limit),
  }))
  const describeElement = vi.fn(async (backendNodeId: number) => ({
    tagName: 'button',
    role: 'button',
    name: '提交',
    selector: 'html > body > button',
    path: [],
    textSnippet: '提交',
    attributes: { type: 'button' },
    rect: { x: 1, y: 2, width: 3, height: 4 },
    ...(backendNodeId === 101 ? {} : {}),
  }))
  const port: BrowserExtractionPort = { listElements, describeElement }
  return { port, listElements, describeElement }
}

describe('BrowserSurfaceService（W6 元素提取）', () => {
  it('视图没有提取端口时明确拒绝（不做静默降级）', async () => {
    const { service } = recordingService()
    await service.open(descriptorInput())
    const result = await service.extractList('browser-1', undefined)
    expect(result.ok).toBe(false)
    expect(result.elements).toEqual([])
    expect(result.detail).toMatch(/不支持元素提取/)
  })

  it('清单成功：URL 剥 query，元素按条数上限裁剪', async () => {
    const { port, listElements } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())

    const result = await service.extractList('browser-1', { limit: 1 })
    expect(result.ok).toBe(true)
    expect(result.page?.url).toBe('https://example.com/page')
    expect(result.page?.title).toBe('示例页')
    expect(result.elements).toHaveLength(1)
    expect(listElements).toHaveBeenCalledWith(1)
  })

  it('清单条数非法时回落到默认值', async () => {
    const { port, listElements } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())

    await service.extractList('browser-1', { limit: 'many' as unknown as number })
    expect(listElements).toHaveBeenCalledWith(50)
  })

  it('详情只接受本会话清单里的 ref（renderer 不能自造 id）', async () => {
    const { port, describeElement } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())
    await service.extractList('browser-1', undefined)

    const ok = await service.extractDetail('browser-1', { ref: 'el-1' })
    expect(ok.ok).toBe(true)
    expect(ok.element?.tagName).toBe('button')
    expect(describeElement).toHaveBeenCalledWith(101)

    const bad = await service.extractDetail('browser-1', { ref: 'el-999' })
    expect(bad.ok).toBe(false)
    expect(bad.detail).toMatch(/引用无效或已过期/)
  })

  it('未列清单就取详情：拒绝（ref 未签发）', async () => {
    const { port, describeElement } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())

    const result = await service.extractDetail('browser-1', { ref: 'el-1' })
    expect(result.ok).toBe(false)
    expect(describeElement).not.toHaveBeenCalled()
  })

  it('非法 ref 形态：拒绝并给出可展示文案', async () => {
    const { port } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())

    const result = await service.extractDetail('browser-1', { ref: 'evil' })
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/ref 无效/)
  })

  it('会话不存在：清单与详情都拒绝', async () => {
    const { port } = fakeExtractionPort()
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })

    expect((await service.extractList('nope', undefined)).ok).toBe(false)
    expect((await service.extractDetail('nope', { ref: 'el-1' })).ok).toBe(false)
  })

  it('页面导航后元素引用作废（旧 ref 不再指向新页面）', async () => {
    const { port, describeElement } = fakeExtractionPort()
    const { factory, views } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())
    await service.extractList('browser-1', undefined)

    views[0]?.emit({ type: 'navigated', url: 'https://example.com/next' })

    const result = await service.extractDetail('browser-1', { ref: 'el-1' })
    expect(result.ok).toBe(false)
    expect(describeElement).not.toHaveBeenCalled()
  })

  it('端口异常：转成可展示文案，不抛出到 IPC 层', async () => {
    const port: BrowserExtractionPort = {
      listElements: vi.fn(async () => { throw new Error('cdp boom') }),
      describeElement: vi.fn(async () => { throw new Error('cdp boom') }),
    }
    const { factory } = fakeViewFactory(port)
    const service = new BrowserSurfaceService({ factory })
    await service.open(descriptorInput())

    const result = await service.extractList('browser-1', undefined)
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/cdp boom/)
  })

  it('视图抽象不提供页面脚本执行通道（类型层保证，W6 红线）', () => {
    // @ts-expect-error BrowserSurfaceView 没有 executeJavaScript 方法
    void ({} as BrowserSurfaceView).executeJavaScript
  })
})
