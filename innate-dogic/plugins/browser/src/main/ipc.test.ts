import { describe, expect, it } from 'vitest'
import { createBrowserIpcHandlers } from './ipc.js'
import type { BrowserIpcService } from './ipc.js'

function fakeService(): BrowserIpcService & { calls: Array<[string, unknown, unknown]> } {
  const calls: Array<[string, unknown, unknown]> = []
  return {
    calls,
    async navigate(id, request) {
      calls.push(['navigate', id, request])
      return { ok: true, url: 'https://example.com/' }
    },
    async back(id) {
      calls.push(['back', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    async forward(id) {
      calls.push(['forward', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    async reload(id) {
      calls.push(['reload', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    async stop(id) {
      calls.push(['stop', id, undefined])
      return { ok: true }
    },
    state(id) {
      calls.push(['state', id, undefined])
      return undefined
    },
    async extractList(id, request) {
      calls.push(['extractList', id, request])
      return { ok: true, elements: [] }
    },
    async extractDetail(id, request) {
      calls.push(['extractDetail', id, request])
      return { ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' }
    },
  }
}

describe('createBrowserIpcHandlers（契约 → 服务层）', () => {
  it('每个契约方法都映射到服务层对应能力', async () => {
    const service = fakeService()
    const handlers = createBrowserIpcHandlers(service)
    await handlers.navigate('browser-1', { url: 'https://example.com/' })
    await handlers.back('browser-1', undefined)
    await handlers.forward('browser-1', undefined)
    await handlers.reload('browser-1', undefined)
    await handlers.stop('browser-1', undefined)
    await handlers.state('browser-1', undefined)
    await handlers.extractList('browser-1', { limit: 10 })
    await handlers.extractDetail('browser-1', { ref: 'el-1' })
    expect(service.calls.map((call) => call[0])).toEqual([
      'navigate',
      'back',
      'forward',
      'reload',
      'stop',
      'state',
      'extractList',
      'extractDetail',
    ])
  })

  it('id 与请求体原样透传给服务层（不可信输入由服务层判定）', async () => {
    const service = fakeService()
    const handlers = createBrowserIpcHandlers(service)
    await handlers.navigate(123, { url: 'https://example.com/' })
    expect(service.calls[0]).toEqual(['navigate', 123, { url: 'https://example.com/' }])
  })

  it('state 无会话时对外统一为 null（契约用 null 表示缺失）', async () => {
    const handlers = createBrowserIpcHandlers(fakeService())
    expect(await handlers.state('browser-1', undefined)).toBeNull()
  })
})
