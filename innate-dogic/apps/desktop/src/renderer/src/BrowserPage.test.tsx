import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  BrowserExtractionDetailResult,
  BrowserExtractionListResult,
  BrowserSessionState,
} from '@dogic/plugin-browser'
import type { BrowserPanelApi } from '@dogic/plugin-browser/renderer'
import BrowserPage from './BrowserPage'
import { createBrowserProvider } from './surfaces/providers/browser'
import { SurfaceProviderRegistry } from './surfaces/provider-registry'
import { SurfaceTabs } from './surfaces/surface-tabs'

function makeApi(): BrowserPanelApi {
  return {
    browserNavigate: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
    browserBack: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
    browserForward: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
    browserReload: vi.fn(async () => ({ ok: true, url: 'https://example.com/' })),
    browserStop: vi.fn(async () => ({ ok: true })),
    browserState: vi.fn(async (): Promise<BrowserSessionState | null> => null),
    browserOnEvent: vi.fn(() => () => {}),
    browserExtractList: vi.fn(async (): Promise<BrowserExtractionListResult> => ({
      ok: true,
      elements: [],
    })),
    browserExtractDetail: vi.fn(async (): Promise<BrowserExtractionDetailResult> => ({ ok: true })),
    surfaceShow: vi.fn(async () => ({ ok: true })),
    surfaceHide: vi.fn(async () => true),
    surfaceBounds: vi.fn(async () => true),
    surfaceClose: vi.fn(async () => true),
  }
}

function makePage() {
  const tabs = new SurfaceTabs({ key: 'browser-tabs', storage: null })
  const registry = new SurfaceProviderRegistry()
  registry.register(createBrowserProvider(makeApi()))
  return {
    tabs,
    registry,
    onSwitchSurface: vi.fn(),
    onCloseSurface: vi.fn(),
  }
}

function pageProps(parts: ReturnType<typeof makePage>) {
  return {
    tabs: parts.tabs,
    providers: parts.registry,
    onSwitchSurface: parts.onSwitchSurface,
    onCloseSurface: parts.onCloseSurface,
  }
}

/** 工具栏的「新建浏览器」按钮（空态里另有一个同名按钮，取第一个）。 */
function newBrowserButton(): HTMLElement {
  return screen.getAllByRole('button', { name: '新建浏览器' })[0] as HTMLElement
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('BrowserPage（W6.8 入口与标签 id 唯一性）', () => {
  it('空态给出可点的「新建浏览器」入口', () => {
    const parts = makePage()
    render(<BrowserPage {...pageProps(parts)} />)
    expect(screen.getByRole('heading', { name: '浏览器' })).toBeTruthy()
    expect(newBrowserButton()).toBeTruthy()
    expect(parts.tabs.list()).toHaveLength(0)
  })

  it('点击「新建浏览器」派生 browser-1 标签并激活', async () => {
    const parts = makePage()
    render(<BrowserPage {...pageProps(parts)} />)

    fireEvent.click(newBrowserButton())

    await waitFor(() => expect(parts.tabs.list()).toHaveLength(1))
    expect(parts.tabs.list()[0]).toMatchObject({ id: 'browser-1', title: '浏览器 1' })
    expect(parts.tabs.active()?.id).toBe('browser-1')
    expect(screen.getByRole('tab', { name: '浏览器 1' })).toBeTruthy()
  })

  it('W6.8：页面重挂后再新建得到新标签（id 不撞既有标签）', async () => {
    const parts = makePage()

    const first = render(<BrowserPage {...pageProps(parts)} />)
    fireEvent.click(newBrowserButton())
    await waitFor(() => expect(parts.tabs.list()).toHaveLength(1))

    // 页面卸载再挂载：页内计数器归零，若仍按计数器派生 id 会命中 browser-1
    first.unmount()
    render(<BrowserPage {...pageProps(parts)} />)
    fireEvent.click(newBrowserButton())

    await waitFor(() => expect(parts.tabs.list()).toHaveLength(2))
    expect(parts.tabs.list().map((surface) => surface.id)).toEqual(['browser-1', 'browser-2'])
    expect(parts.tabs.active()?.id).toBe('browser-2')
    expect(screen.getByRole('tab', { name: '浏览器 1' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '浏览器 2' })).toBeTruthy()
  })

  it('W6.8：恢复出来的既有标签不影响新标签序号', async () => {
    const parts = makePage()
    // 模拟跨启动恢复出来的标签（快照里已有 browser-1）
    parts.tabs.open({
      id: 'browser-1',
      providerId: 'browser',
      kind: 'webcontents',
      title: '浏览器 1',
      capabilities: ['network:navigate'],
    })

    render(<BrowserPage {...pageProps(parts)} />)
    fireEvent.click(newBrowserButton())

    await waitFor(() => expect(parts.tabs.list()).toHaveLength(2))
    expect(parts.tabs.active()?.id).toBe('browser-2')
  })
})
