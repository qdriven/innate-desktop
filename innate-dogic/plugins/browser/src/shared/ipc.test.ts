import { describe, expect, it } from 'vitest'
import {
  BROWSER_IPC_CHANNELS,
  BROWSER_IPC_CONTRACT,
  BROWSER_IPC_CONTRACT_VERSION,
  BROWSER_IPC_EVENT_CHANNEL,
  BROWSER_IPC_METHOD_BY_CHANNEL,
  BROWSER_IPC_METHOD_CAPABILITIES,
  assertBrowserIpcCompatible,
  assertNoScriptChannel,
  createBrowserApi,
  createBrowserApiFromHandlers,
  createBrowserApiFromInvoker,
  isBrowserIpcVersionCompatible,
  isScriptExecutionChannel,
  parseBrowserIpcVersion,
  registerBrowserIpc,
} from './ipc.js'
import type {
  BrowserIpcHandlerMap,
  BrowserIpcHost,
  BrowserIpcMethod,
} from './ipc.js'

function fakeHost(version = BROWSER_IPC_CONTRACT_VERSION): BrowserIpcHost & {
  channels: Map<string, (id: unknown, payload: unknown) => Promise<unknown>>
} {
  const channels = new Map<string, (id: unknown, payload: unknown) => Promise<unknown>>()
  return {
    contractVersion: version,
    channels,
    handle: (channel, handler) => {
      channels.set(channel, handler)
    },
  }
}

function fakeHandlers(): BrowserIpcHandlerMap & { calls: Array<[string, unknown, unknown]> } {
  const calls: Array<[string, unknown, unknown]> = []
  return {
    calls,
    navigate: async (id, payload) => {
      calls.push(['navigate', id, payload])
      return { ok: true, url: 'https://example.com/' }
    },
    back: async (id) => {
      calls.push(['back', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    forward: async (id) => {
      calls.push(['forward', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    reload: async (id) => {
      calls.push(['reload', id, undefined])
      return { ok: true, url: 'https://example.com/' }
    },
    stop: async (id) => {
      calls.push(['stop', id, undefined])
      return { ok: true }
    },
    state: async (id) => {
      calls.push(['state', id, undefined])
      return null
    },
    extractList: async (id, payload) => {
      calls.push(['extractList', id, payload])
      return { ok: true, elements: [] }
    },
    extractDetail: async (id, payload) => {
      calls.push(['extractDetail', id, payload])
      return { ok: false, detail: '提取详情引用无效或已过期，请重新列出元素' }
    },
  }
}

describe('browser IPC 契约清单（W6.6）', () => {
  it('契约版本与通道名固定（跨宿主一致的事实源）', () => {
    expect(BROWSER_IPC_CONTRACT_VERSION).toBe('1.0')
    expect(BROWSER_IPC_CONTRACT.version).toBe('1.0')
    expect(BROWSER_IPC_CONTRACT.eventChannel).toBe('innate:browser-event')
    expect(BROWSER_IPC_CHANNELS).toEqual({
      navigate: 'innate:browserNavigate',
      back: 'innate:browserBack',
      forward: 'innate:browserForward',
      reload: 'innate:browserReload',
      stop: 'innate:browserStop',
      state: 'innate:browserState',
      extractList: 'innate:browserExtractList',
      extractDetail: 'innate:browserExtractDetail',
    })
  })

  it('每个方法都有唯一通道与能力声明', () => {
    const channels = BROWSER_IPC_CONTRACT.methods.map((m) => BROWSER_IPC_CHANNELS[m])
    expect(new Set(channels).size).toBe(channels.length)
    for (const method of BROWSER_IPC_CONTRACT.methods) {
      expect(BROWSER_IPC_METHOD_CAPABILITIES[method]).toBeTruthy()
    }
    expect(BROWSER_IPC_METHOD_CAPABILITIES.navigate).toBe('network:navigate')
    expect(BROWSER_IPC_METHOD_CAPABILITIES.state).toBe('surface:read')
    expect(BROWSER_IPC_METHOD_CAPABILITIES.extractList).toBe('element:extract')
  })

  it('通道→方法反查表与契约一致', () => {
    for (const method of BROWSER_IPC_CONTRACT.methods) {
      expect(BROWSER_IPC_METHOD_BY_CHANNEL[BROWSER_IPC_CHANNELS[method]]).toBe(method)
    }
    expect(Object.keys(BROWSER_IPC_METHOD_BY_CHANNEL)).toHaveLength(BROWSER_IPC_CONTRACT.methods.length)
  })
})

describe('红线：契约不含页面脚本执行通道（W6.6）', () => {
  it('契约全部通道均非脚本执行入口', () => {
    const channels = [
      ...BROWSER_IPC_CONTRACT.methods.map((m) => BROWSER_IPC_CHANNELS[m]),
      BROWSER_IPC_EVENT_CHANNEL,
    ]
    expect(() => assertNoScriptChannel(channels)).not.toThrow()
    for (const channel of channels) {
      expect(isScriptExecutionChannel(channel)).toBe(false)
    }
  })

  it('脚本执行通道名被识别并拒绝', () => {
    for (const channel of [
      'innate:browserExecuteJavaScript',
      'innate:browserEval',
      'innate:browserRunScript',
      'innate:browserRuntimeEvaluate',
      'innate:browserCdp',
    ]) {
      expect(isScriptExecutionChannel(channel)).toBe(true)
    }
    expect(() => assertNoScriptChannel(['innate:browserNavigate', 'innate:browserEval']))
      .toThrow(/不得包含页面脚本执行通道/)
  })
})

describe('版本协商（fail closed）', () => {
  it('版本解析：非法输入返回 null', () => {
    expect(parseBrowserIpcVersion('1.0')).toEqual({ major: 1, minor: 0 })
    expect(parseBrowserIpcVersion(' 2.15 ')).toEqual({ major: 2, minor: 15 })
    expect(parseBrowserIpcVersion('1')).toBeNull()
    expect(parseBrowserIpcVersion('1.x')).toBeNull()
    expect(parseBrowserIpcVersion(1)).toBeNull()
    expect(parseBrowserIpcVersion(null)).toBeNull()
  })

  it('同 major 且宿主 minor 不低于契约即兼容', () => {
    expect(isBrowserIpcVersionCompatible('1.0')).toBe(true)
    expect(isBrowserIpcVersionCompatible('1.1')).toBe(true)
    expect(isBrowserIpcVersionCompatible('1.7')).toBe(true)
    expect(isBrowserIpcVersionCompatible('0.9')).toBe(false)
    expect(isBrowserIpcVersionCompatible('2.0')).toBe(false)
    expect(isBrowserIpcVersionCompatible('x')).toBe(false)
  })

  it('不兼容即抛错（不做部分通道降级）', () => {
    expect(() => assertBrowserIpcCompatible('1.0')).not.toThrow()
    expect(() => assertBrowserIpcCompatible('0.9')).toThrow(/契约版本不兼容/)
    expect(() => assertBrowserIpcCompatible('2.0')).toThrow(/契约版本不兼容/)
    expect(() => assertBrowserIpcCompatible(undefined)).toThrow(/契约版本不兼容/)
  })
})

describe('registerBrowserIpc（宿主注册面）', () => {
  it('默认注册契约全部方法', () => {
    const host = fakeHost()
    const registered = registerBrowserIpc(host, fakeHandlers())
    expect(registered).toEqual([...BROWSER_IPC_CONTRACT.methods])
    expect(host.channels.size).toBe(BROWSER_IPC_CONTRACT.methods.length)
    expect(host.channels.has('innate:browserNavigate')).toBe(true)
    expect(host.channels.has('innate:browserExtractDetail')).toBe(true)
  })

  it('allow 可裁剪暴露面（宿主可只开一部分能力）', () => {
    const host = fakeHost()
    const registered = registerBrowserIpc(host, fakeHandlers(), { allow: ['navigate', 'state'] })
    expect(registered).toEqual(['navigate', 'state'])
    expect([...host.channels.keys()]).toEqual(['innate:browserNavigate', 'innate:browserState'])
  })

  it('版本不兼容 → 拒绝注册（fail closed）', () => {
    const host = fakeHost('0.9')
    expect(() => registerBrowserIpc(host, fakeHandlers())).toThrow(/契约版本不兼容/)
    expect(host.channels.size).toBe(0)
  })

  it('契约外的方法拒绝注册', () => {
    const host = fakeHost()
    expect(() =>
      registerBrowserIpc(host, fakeHandlers(), { allow: ['executeJavaScript' as BrowserIpcMethod] }),
    ).toThrow(/契约外的方法/)
    expect(host.channels.size).toBe(0)
  })

  it('注册后的处理器按契约转发 id 与请求体', async () => {
    const host = fakeHost()
    const handlers = fakeHandlers()
    registerBrowserIpc(host, handlers)
    const navigate = host.channels.get('innate:browserNavigate')
    expect(await navigate?.('browser-1', { url: 'https://example.com/' }))
      .toEqual({ ok: true, url: 'https://example.com/' })
    expect(handlers.calls[0]).toEqual(['navigate', 'browser-1', { url: 'https://example.com/' }])
  })
})

describe('createBrowserApi（渲染侧出口）', () => {
  it('按契约通道发起调用并透传参数', async () => {
    const calls: Array<[string, string, unknown]> = []
    const api = createBrowserApi({
      invoke: async (channel, id, payload) => {
        calls.push([channel, id, payload])
        if (channel === BROWSER_IPC_CHANNELS.state) return null
        if (channel === BROWSER_IPC_CHANNELS.extractList) return { ok: true, elements: [] }
        return { ok: true, url: 'https://example.com/' }
      },
      subscribe: () => () => {},
    })

    await api.browserNavigate('browser-1', { url: 'https://example.com/' })
    await api.browserBack('browser-1')
    await api.browserState('browser-1')
    await api.browserExtractList('browser-1', { limit: 20 })

    expect(calls[0]).toEqual(['innate:browserNavigate', 'browser-1', { url: 'https://example.com/' }])
    expect(calls[1]).toEqual(['innate:browserBack', 'browser-1', undefined])
    expect(calls[2]).toEqual(['innate:browserState', 'browser-1', undefined])
    expect(calls[3]).toEqual(['innate:browserExtractList', 'browser-1', { limit: 20 }])
  })

  it('事件订阅走契约事件通道', () => {
    const subscribed: string[] = []
    const api = createBrowserApi({
      invoke: async () => null,
      subscribe: (channel) => {
        subscribed.push(channel)
        return () => {}
      },
    })
    const off = api.browserOnEvent(() => {})
    expect(subscribed).toEqual([BROWSER_IPC_EVENT_CHANNEL])
    expect(typeof off).toBe('function')
  })
})

describe('跨宿主接入（进程内直调与 RPC 分发）', () => {
  it('进程内直调：另一个插件按契约消费同一份服务', async () => {
    const handlers = fakeHandlers()
    const api = createBrowserApiFromHandlers(handlers)
    const nav = await api.browserNavigate('browser-1', { url: 'https://example.com/' })
    expect(nav).toEqual({ ok: true, url: 'https://example.com/' })
    expect(handlers.calls[0]).toEqual(['navigate', 'browser-1', { url: 'https://example.com/' }])
  })

  it('进程内直调：事件订阅由宿主注入推送源', () => {
    const seen: unknown[] = []
    const api = createBrowserApiFromHandlers(fakeHandlers(), {
      subscribe: (listener) => {
        listener({ type: 'navigated', id: 'browser-1', url: 'https://example.com/' })
        return () => {}
      },
    })
    api.browserOnEvent((event) => seen.push(event))
    expect(seen).toEqual([{ type: 'navigated', id: 'browser-1', url: 'https://example.com/' }])
  })

  it('RPC 分发：按方法名而非通道名调用（远端只认契约方法）', async () => {
    const seen: Array<[string, string, unknown]> = []
    const api = createBrowserApiFromInvoker(async (method, id, payload) => {
      seen.push([method, id, payload])
      return { ok: true, url: 'https://example.com/' } as never
    })
    await api.browserForward('browser-1')
    expect(seen[0]).toEqual(['forward', 'browser-1', undefined])
  })
})
