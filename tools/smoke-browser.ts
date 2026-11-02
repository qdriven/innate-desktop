#!/usr/bin/env node
/**
 * W5.7 端到端与便携验收——browser 冒烟。
 *
 * 拉起真实 Electron 宿主（dev 构建 + 独立 user-data + 远程调试端口），驱动
 * 浏览器 Surface（地址栏面板 + 独立分区 WebContentsView）经本地受控 HTTP
 * 测试站验证：导航、外链、权限、受控下载、布局恢复、标签生命周期、bounds；
 * 并交替切换终端/文档页验证 bounds 与生命周期隔离。
 *
 * 红线断言：访客视图（browser WebContentsView）不持有任何通用脚本执行通道——
 * 渲染壳 window.innate 无 executeJavaScript 通道；浏览器目标不向其执行脚本
 * （本脚本全程不经任何方式向访客视图注入脚本）。
 *
 * 运行前先构建：pnpm --filter @dogic/desktop build && pnpm --filter @dogic/plugin-browser build
 * 运行：tsx tools/smoke-browser.ts
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

interface CdpTarget {
  id: string
  type: string
  url: string
  title?: string
  webSocketDebuggerUrl: string
}
interface CdpMessage {
  id?: number
  result?: unknown
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  ?? path.join(root, 'docs/susu/plan/evidence/W5/e2e')
mkdirSync(outDir, { recursive: true })
const appDir = path.join(root, 'innate-dogic/apps/desktop')
const electron = path.join(appDir, 'node_modules/electron/dist/electron.exe')
const smokeUserData = path.join(appDir, 'dist-package/smoke-user-data-browser')
const debugPort = 20_000 + (process.pid % 30_000)
const launchArgs = [appDir, `--user-data-dir=${smokeUserData}`]
const env: NodeJS.ProcessEnv = { ...process.env, INNATE_WORKSPACE_ROOT: root }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [...launchArgs, `--remote-debugging-port=${debugPort}`], { env, stdio: 'pipe' })
child.stderr.on('data', (data: Buffer) => process.stderr.write(data))
const watchdog = setTimeout(() => {
  console.error('[smoke-browser] watchdog timeout, forcing exit')
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  process.exit(3)
}, 900_000)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 加载 browser 插件的 IPC 契约清单（插件构建产物）——契约归插件所有，
 * 桌面与其它宿主都按它接入；冒烟据此核对渲染壳暴露面没有漂移。
 */
async function loadBrowserContract(): Promise<{ methods: string[]; channels: Record<string, string> }> {
  const moduleUrl = pathToFileURL(
    path.join(root, 'innate-dogic/plugins/browser/dist/shared/ipc.js'),
  ).href
  const mod = (await import(moduleUrl)) as {
    BROWSER_IPC_CONTRACT: { methods: string[]; channels: Record<string, string> }
  }
  return mod.BROWSER_IPC_CONTRACT
}
let ws: WebSocket | undefined
const pending = new Map<number, { resolve: (value: unknown) => void }>()
let seq = 0
function cdp<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws) return reject(new Error('CDP WebSocket 未连接'))
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时（30s）`))
    }, 30_000)
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value as T) } })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate<T>(expression: string): Promise<T | undefined> {
  const response = await cdp<{ result?: { value?: unknown } }>('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })
  return response.result?.value as T | undefined
}
async function shot(name: string): Promise<void> {
  const response = await cdp<{ data?: string }>('Page.captureScreenshot', { format: 'png' })
  if (!response.data) throw new Error(`截图失败: ${name}`)
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(response.data, 'base64'))
  console.log(`[smoke-browser] saved ${name}.png`)
}
async function targets(): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json`)
  return await response.json() as CdpTarget[]
}
/** 指定 CDP target 内执行表达式（仅用于读取访客视图的页面标题，非脚本注入）。 */
async function evalTarget<T>(target: CdpTarget, expression: string): Promise<T | undefined> {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP target 连接超时（30s）: ${target.url}`)), 30_000)
    socket.onopen = () => { clearTimeout(timer); resolve() }
    socket.onerror = () => { clearTimeout(timer); reject(new Error(`CDP target 连接失败: ${target.url}`)) }
  })
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP target 求值超时（30s）: ${target.url}`)), 30_000)
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === 9002) {
        clearTimeout(timer)
        resolve((message.result as { result?: { value?: unknown } } | undefined)?.result?.value as T | undefined)
      }
    }
    socket.onclose = () => { clearTimeout(timer); reject(new Error(`CDP target 连接已关闭: ${target.url}`)) }
    socket.send(JSON.stringify({ id: 9002, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }))
  })
  socket.close()
  return value
}

const passed: string[] = []
const failed: string[] = []
function record(name: string, ok: boolean, detail?: string): void {
  ;(ok ? passed : failed).push(name)
  console.log(`[smoke-browser] ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
}
async function waitFor(predicate: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(500)
  }
  return await predicate()
}
/** 轮询浏览器面板状态行文本（通知/下载行）。 */
async function pollPanel(marker: string, attempts = 40): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const text = await evaluate<string>("document.querySelector('.browser-surface')?.innerText ?? ''") ?? ''
    if (text.includes(marker)) return text
    await sleep(500)
  }
  return await evaluate<string>("document.querySelector('.browser-surface')?.innerText ?? ''") ?? ''
}
/** 在指定 CDP 目标内轮询页面文本（等待内容真正加载，规避 about:blank 瞬态）。 */
async function pollTargetText(target: CdpTarget, needle: RegExp, attempts = 20): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const text = await evalTarget<string>(target, 'document.title + " || " + (document.body?.innerText ?? "").slice(0, 80)') ?? ''
    if (needle.test(text)) return text
    await sleep(500)
  }
  return await evalTarget<string>(target, 'document.title + " || " + (document.body?.innerText ?? "").slice(0, 80)') ?? ''
}

/**
 * 地址栏提交导航：React 受控 <input> 不接受裸键事件（CDP char 不驱动 onChange）。
 * 经原生 value setter + input 事件驱动 React 状态，再提交表单（前往按钮）。
 * 绝不向访客视图注入脚本——只操作渲染壳地址栏 DOM。
 */
async function typeAddress(url: string): Promise<void> {
  await evaluate(`(() => {
    const el = document.querySelector('.browser-address')
    if (!el) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, ${JSON.stringify(url)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await evaluate("document.querySelector('.browser-go')?.click()")
}

// ---------------- 本地受控 HTTP 测试站 ----------------
function startTestSite(): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      res.setHeader('content-type', 'text/html; charset=utf-8')
      if (url.pathname === '/evil') {
        // 页面加载后脚本导航到内嵌凭据地址（守卫拦截；URL 含凭据不记录）
        res.end(`<!doctype html><html><body><h1>evil</h1><script>window.addEventListener("load",()=>{setTimeout(()=>{location.href="http://user:pass@127.0.0.1:${(server.address() as { port: number }).port}/"},100)})</script></body></html>`)
        return
      }
      if (url.pathname === '/open') {
        // 页面内 window.open 外链（交系统浏览器，应用内不新建 webContents）
        res.end('<!doctype html><html><body><h1>opener</h1><script>window.open("https://example.com/", "_blank")</script></body></html>')
        return
      }
      if (url.pathname === '/perm') {
        // 页面逐类请求权限（geolocation/notifications）——全拒并记录 origin+类型
        res.end(`<!doctype html><html><body><h1>perm</h1><script>window.addEventListener("load",()=>{setTimeout(()=>{
          try { navigator.geolocation.getCurrentPosition(()=>{},()=>{}) } catch {}
          try { Notification.requestPermission() } catch {}
        },100)})</script></body></html>`)
        return
      }
      if (url.pathname === '/dl') {
        // 常规下载（Content-Disposition attachment 触发 will-download）
        res.setHeader('content-disposition', 'attachment; filename="report.txt"')
        res.setHeader('content-type', 'application/octet-stream')
        res.end('download-body-content')
        return
      }
      if (url.pathname === '/elements') {
        // 元素提取靶场：可交互元素 + 一个带凭据形态属性的元素
        res.end(`<!doctype html><html><body>
<h1>elements</h1>
<button id="submit-btn" type="button">提交订单</button>
<a href="/elements#doc" id="doc-link">使用说明</a>
<input id="pwd" type="text" name="api_key" placeholder="令牌">
<input id="real-pwd" type="password" placeholder="密码">
</body></html>`)
        return
      }
      res.end('<!doctype html><html><body><h1>innate-browser-smoke</h1></body></html>')
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

async function main(): Promise<void> {
  const site = await startTestSite()
  const port = (site.address() as { port: number }).port
  const siteUrl = `http://127.0.0.1:${port}/`
  console.log('[smoke-browser] 本地测试站:', siteUrl)

  // 等待渲染页就绪
  let page: CdpTarget | undefined
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      const list = await targets()
      page = list.find((t) => t.type === 'page' && t.url && !t.url.startsWith('devtools'))
      if (page) break
    } catch { /* 等待调试端口 */ }
  }
  if (!page) throw new Error('未找到渲染进程页面')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.resolve(message.result ?? message)
      pending.delete(message.id)
    }
  }
  await new Promise<void>((resolve) => { if (ws) ws.onopen = () => resolve() })
  await sleep(4_000)
  await evaluate('window.innate.setMode(\'dev\')')
  await evaluate('location.reload()')
  await sleep(4_000)
  // 清掉上次运行残留的 Surface 标签/布局快照，避免陈旧标签（如终端 1）抢占激活项
  await evaluate("localStorage.removeItem('innate.surface-tabs:center'); localStorage.removeItem('innate.browser-layout:center')")
  await evaluate('location.reload()')
  await sleep(3_500)

  // ---- 红线断言：渲染壳无通用脚本执行通道 ----
  // 红线核心：访客视图不得被通用脚本执行通道触达——渲染壳 window.innate 不
  // 暴露 executeJavaScript/executeScript（亦无注入访客视图的通道）。
  // 注：不按 /exec|script/ 匹配通道名——processExecute 是 W4 受 profile 门控的
  // 窄通道（指定命令、非通用 shell），非红线；红线特指访客视图脚本执行。
  const hasExecute = await evaluate<boolean>("Boolean(window.innate) && typeof window.innate.executeJavaScript === 'function'")
  record('红线：渲染壳 window.innate 无 executeJavaScript 通道', hasExecute === false)
  const executeScriptKeys = await evaluate<string[]>("Object.keys(window.innate ?? {}).filter(k => /executejavascript|executescript|injectscript|webcontents\.execute/i.test(k))")
  record('红线：渲染壳通道集合无脚本执行入口（访客视图不可被注入执行）',
    Array.isArray(executeScriptKeys) && executeScriptKeys.length === 0,
    `offenders=[${(executeScriptKeys ?? []).join(',')}]`)

  // ---- 打开浏览器页 + 新建浏览器 Surface ----
  await evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.getAttribute('title')==='浏览器')?.click()")
  await sleep(2_000)
  const browserNavOk = await evaluate<boolean>("Boolean(document.querySelector('.terminal-toolbar button.primary'))")
  record('浏览器页可打开（工具栏就绪）', browserNavOk === true)
  await evaluate("document.querySelector('.terminal-toolbar button.primary')?.click()")
  await sleep(2_000)
  const panelReady = await evaluate<boolean>("Boolean(document.querySelector('.browser-surface .browser-address'))")
  record('新建浏览器：地址栏面板挂载', panelReady === true)
  await shot('browser-panel')
  // 浏览器目标初始为 about:blank 或空 URL（deferredUrl）
  const pageUrl = page?.url ?? ''
  const browserBlank = async (): Promise<CdpTarget | undefined> =>
    (await targets()).find((t) => t.type === 'page' && t.url !== pageUrl && (t.url === '' || t.url === 'about:blank' || t.url.startsWith('http://127.0.0.1:')))
  const blankTarget = await waitFor(async () => Boolean(await browserBlank()))
  record('浏览器 WebContentsView 作为独立 CDP 目标出现（独立分区）', blankTarget === true)

  // ---- 导航：地址栏提交 → 本地站点加载 ----
  await typeAddress(siteUrl)
  const navTarget = async (): Promise<CdpTarget | undefined> =>
    (await targets()).find((t) => t.type === 'page' && (t.url === siteUrl || t.url.startsWith('http://127.0.0.1:')))
  const loaded = await waitFor(async () => Boolean(await navTarget()))
  record('导航：地址栏提交 → 本地站点加载完成', loaded === true)
  const t1 = await navTarget()
  const pageTitle = t1 ? await pollTargetText(t1, /innate-browser-smoke/) : ''
  record('导航：访客视图真实内容加载（本地站点，非公网）', /innate-browser-smoke/.test(pageTitle ?? ''), pageTitle ?? '(空)')
  await shot('browser-nav')
  await evaluate("document.querySelector('.surface-view-area')?.scrollIntoView()")
  await sleep(300)

  // ---- 布局恢复（W5.6）：先导航使快照持久化 → 种子恢复 URL → reload → 挂载消费重导航 ----
  const layoutKey = 'innate.browser-layout:center'
  const layoutSeed = JSON.stringify({
    version: 1, activeId: 'browser-1',
    tabs: [{ id: 'browser-1', url: `${siteUrl}restore` }],
  })
  await evaluate(`localStorage.setItem('${layoutKey}', ${JSON.stringify(layoutSeed)})`)
  await evaluate('location.reload()')
  await sleep(3_000)
  await evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.getAttribute('title')==='浏览器')?.click()")
  await sleep(2_500)
  // 布局恢复触发了 browserNavigate → /restore 落在默认页（非专用路由），仍加载本地站点根
  const restoreLoaded = await waitFor(async () =>
    Boolean((await targets()).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url))), 15_000)
  const restoreAddress = await evaluate<string>("document.querySelector('.browser-address')?.value ?? ''") ?? ''
  // 恢复判据：本地站点目标加载 + 地址栏呈现恢复 URL（提示在导航成功后清除，故不依赖面板文案）
  record('布局恢复：挂载消费快照 → 用户可见重导航（重新加载本地站点）',
    restoreLoaded && /127\.0\.0\.1/.test(restoreAddress), restoreAddress.slice(0, 60))
  // 恢复后普通 URL 重新入布局（供下次会话），敏感 URL 不入快照
  const layoutAfter = await evaluate<string>(`localStorage.getItem('${layoutKey}') ?? ''`) ?? ''
  record('布局恢复：普通 URL 持久化、不含敏感字段',
    layoutAfter.includes('127.0.0.1') && !/token=|[?&](secret|password|key)=|user:pass@/i.test(layoutAfter),
    layoutAfter.slice(0, 120))
  await shot('browser-restore')

  // ---- 页面内导航守卫：脚本导航到内嵌凭据地址被拦截 ----
  const evilUrl = `${siteUrl}evil`
  await typeAddress(evilUrl)
  const evilNotice = await pollPanel('导航被安全策略拒绝', 30)
  record('导航守卫：页面内导航到内嵌凭据地址被拦截（安全文案）', /导航被安全策略拒绝/.test(evilNotice), evilNotice.slice(0, 80))
  const evilNoCredential = await evaluate<string>("document.querySelector('.browser-address')?.value ?? ''") ?? ''
  record('导航守卫：凭据地址不回显到地址栏', !evilNoCredential.includes('user:pass@'))

  // ---- 外链：window.open 交系统浏览器，应用内不新建 webContents ----
  const targetsBefore = (await targets()).filter((t) => t.type === 'page').length
  await typeAddress(`${siteUrl}open`)
  await sleep(3_000)
  const targetsAfter = (await targets()).filter((t) => t.type === 'page').length
  record('外链：window.open 交系统浏览器，应用内不新建 WebContents', targetsAfter === targetsBefore,
    `before=${targetsBefore} after=${targetsAfter}`)
  const openTarget = (await targets()).find((t) => t.type === 'page' && t.url === `${siteUrl}open`)
  const openTitle = openTarget ? await evalTarget<string>(openTarget, 'document.title + " || " + (document.body?.innerText ?? "").slice(0, 40)') : ''
  record('外链：opener 页留在应用内（外链本身交系统浏览器）', /opener/.test(openTitle ?? ''), openTitle ?? '(空)')

  // ---- 权限：页面逐类请求权限全拒，面板呈现脱敏拒绝文案 ----
  await typeAddress(`${siteUrl}perm`)
  const permNotice = await pollPanel('已拒绝', 30)
  record('权限：页面权限请求全部拒绝，面板呈现脱敏拒绝文案', /已拒绝 .*的 .*权限请求/.test(permNotice), permNotice.slice(0, 100))
  await shot('browser-permission')

  // ---- 元素提取（W6）：CDP 只读域取清单与详情，全程不向访客视图注入脚本 ----
  await typeAddress(`${siteUrl}elements`)
  await waitFor(async () => Boolean((await targets()).find((t) => t.type === 'page' && t.url === `${siteUrl}elements`)))
  await evaluate("document.querySelector('.browser-surface [title=\"提取元素\"]')?.click()")
  const listShown = await waitFor(async () => {
    const text = await evaluate<string>("document.querySelector('.browser-elements')?.innerText ?? ''") ?? ''
    return text.includes('提交订单')
  }, 25_000)
  const listText = await evaluate<string>("document.querySelector('.browser-elements')?.innerText ?? ''") ?? ''
  record('元素提取：清单列出页面可交互元素（角色+名称）', listShown, listText.replace(/\n/g, ' ').slice(0, 120))
  // 点选元素 → 详情卡片（标签/选择器/文本）
  await evaluate("[...document.querySelectorAll('.browser-element')].find(b=>b.textContent?.includes('提交订单'))?.click()")
  const detailShown = await waitFor(async () => {
    const text = await evaluate<string>("document.querySelector('.browser-element-detail')?.innerText ?? ''") ?? ''
    return text.length > 0
  }, 25_000)
  const detailText = await evaluate<string>("document.querySelector('.browser-element-detail')?.innerText ?? ''") ?? ''
  record('元素提取：详情含标签与结构选择器', detailShown && /button/.test(detailText) && />/.test(detailText),
    detailText.replace(/\n/g, ' ').slice(0, 140))
  // 凭据形态属性脱敏：name="api_key" 的输入框
  await evaluate("[...document.querySelectorAll('.browser-element')].find(b=>b.textContent?.includes('令牌'))?.click()")
  const redactedShown = await waitFor(async () => {
    const text = await evaluate<string>("document.querySelector('.browser-element-detail')?.innerText ?? ''") ?? ''
    return text.includes('[redacted]')
  }, 25_000)
  const redactedText = await evaluate<string>("document.querySelector('.browser-element-detail')?.innerText ?? ''") ?? ''
  record('元素提取：凭据形态属性脱敏为 [redacted]', redactedShown, redactedText.replace(/\n/g, ' ').slice(0, 140))
  await shot('browser-extraction')

  // ---- 红线断言：渲染壳无脚本执行通道；访客视图无通用脚本执行入口 ----
  // processExecute 是 W4 terminal 的受控 process:execute 能力（profile 白名单 +
  // 审计脱敏，独立于浏览器），不是页面脚本执行通道——按设计排除。
  const SCRIPT_CHANNEL = /execute|eval|script|runjs/i
  const ALLOWED_NON_SCRIPT = new Set(['processExecute'])
  const innateKeys = await evaluate<string[]>("Object.keys(window.innate ?? {})") ?? []
  const scriptish = innateKeys.filter((k) => SCRIPT_CHANNEL.test(k) && !ALLOWED_NON_SCRIPT.has(k))
  record('红线：渲染壳 window.innate 无页面脚本执行通道', scriptish.length === 0,
    scriptish.length ? scriptish.join(',') : `共 ${innateKeys.length} 个通道（processExecute 为 terminal 受控能力）`)
  // browser 窄通道单独复核：浏览器侧不得有任何脚本执行入口
  const browserKeys = innateKeys.filter((k) => k.startsWith('browser'))
  const browserScriptish = browserKeys.filter((k) => SCRIPT_CHANNEL.test(k))
  record('红线：browser 窄通道集合无脚本执行入口', browserScriptish.length === 0,
    browserScriptish.join(',') || browserKeys.join(','))

  // ---- 契约一致性（W6.6）：渲染壳暴露的 browser 窄通道 = 插件契约方法集 ----
  // 契约归插件所有：preload 由契约构造，桌面不手写通道。若渲染壳的通道集合
  // 与契约方法集不一致，说明宿主与插件漂移。
  const contract = await loadBrowserContract()
  const contractApiKeys = [
    ...contract.methods.map((m) => `browser${m.charAt(0).toUpperCase()}${m.slice(1)}`),
    'browserOnEvent',
  ].sort()
  const browserApiKeys = [...browserKeys].sort()
  record('契约：渲染壳 browser 窄通道与插件契约方法集一致',
    JSON.stringify(browserApiKeys) === JSON.stringify(contractApiKeys),
    `${browserApiKeys.join(',')}${JSON.stringify(browserApiKeys) === JSON.stringify(contractApiKeys) ? '' : ` ≠ 契约 ${contractApiKeys.join(',')}`}`)

  // ---- 受控下载：事件到达面板（下载状态行），不自动执行内容 ----
  await typeAddress(`${siteUrl}dl`)
  const dlStarted = await waitFor(async () => {
    const text = await evaluate<string>("document.querySelector('.browser-surface')?.innerText ?? ''") ?? ''
    return /等待保存位置|report\.txt|已完成|已取消/.test(text)
  }, 20_000)
  record('受控下载：下载事件到达面板（状态行）', dlStarted === true,
    (await evaluate<string>("document.querySelector('.browser-downloads')?.innerText ?? ''")) ?? '(无下载行)')
  // 关闭 Surface 取消在途下载（清理临时状态）
  await evaluate("document.querySelector('[aria-label=\"关闭 浏览器 1\"]')?.click()")
  await sleep(2_000)

  // ---- 标签生命周期：多个浏览器并存 + 切换不重载 + 关闭隔离 ----
  // reload 后 counter 复位；先关掉恢复出来的浏览器，再连开两个新浏览器。
  await evaluate("document.querySelector('[aria-label=\"关闭 浏览器 1\"]')?.click()")
  await sleep(1_500)
  await evaluate("document.querySelector('.terminal-toolbar button.primary')?.click()")
  await sleep(1_500)
  await evaluate("document.querySelector('.terminal-toolbar button.primary')?.click()")
  await sleep(2_000)
  const tabLabels = await evaluate<string[]>("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '')") ?? []
  record('多浏览器标签：两个浏览器标签共存', tabLabels.filter((l) => l.includes('浏览器')).length >= 2, tabLabels.join(' | '))
  const firstLabel = tabLabels.find((l) => l.includes('浏览器')) ?? ''
  const secondLabel = tabLabels.filter((l) => l.includes('浏览器'))[1] ?? ''
  // 导航第二个浏览器到本地站点，然后切回第一个验证 detach 不销毁
  await evaluate(`[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('浏览器') && b.textContent === ${JSON.stringify(secondLabel.trim())})?.click()`)
  await sleep(1_000)
  await typeAddress(siteUrl)
  await waitFor(async () => Boolean((await targets()).find((t) => t.type === 'page' && t.url === siteUrl)))
  // 切回第一个浏览器（detach 不销毁，URL 未变）
  await evaluate(`[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('浏览器') && b.textContent === ${JSON.stringify(firstLabel.trim())})?.click()`)
  await sleep(2_000)
  record('标签切换：detach 不销毁会话（切换后仍可见）', await evaluate<boolean>("Boolean(document.querySelector('.browser-surface'))") === true)
  // 关闭第二个浏览器：只销毁其视图，第一个保留
  await evaluate(`[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('浏览器') && b.textContent === ${JSON.stringify(secondLabel.trim())})?.click()`)
  await sleep(500)
  await evaluate(`document.querySelector('[aria-label=\"关闭 ${secondLabel.trim()}\"]')?.click()`)
  await sleep(2_000)
  const afterClose = await evaluate<string[]>("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '')") ?? []
  record('关闭隔离：关闭后标签移除、另一浏览器保留',
    !afterClose.some((l) => l.trim() === secondLabel.trim()) && afterClose.some((l) => l.includes('浏览器')), afterClose.join(' | '))
  await shot('browser-lifecycle')

  // ---- bounds：浏览器 Surface 视图随中栏区域尺寸 ----
  // 关闭浏览器 2 后浏览器 1 激活；轮询等待面板挂载（.surface-view-area 出现）。
  const boundsHolder: { value: { width: number; height: number } | null } = { value: null }
  await waitFor(async () => {
    const value = await evaluate<{ width: number; height: number } | null>(`(() => {
      const r = document.querySelector('.surface-view-area')?.getBoundingClientRect()
      return r ? { width: Math.round(r.width), height: Math.round(r.height) } : null
    })()`)
    if (value !== null && value !== undefined && value.width > 0 && value.height > 0) {
      boundsHolder.value = value
      return true
    }
    return false
  }, 10_000)
  const bounds = boundsHolder.value
  record('bounds：浏览器 Surface 视图区域有正尺寸',
    bounds !== null && bounds.width > 0 && bounds.height > 0,
    bounds !== null ? JSON.stringify(bounds) : '(未挂载)')
  if (bounds !== null) {
    writeFileSync(path.join(outDir, 'browser-bounds.json'), JSON.stringify(bounds, null, 2))
  }

  // ---- 交替切换：终端/文档页往返，验证生命周期隔离 ----
  // 终端页：新建终端 → PTY 可交互 → 切回浏览器，浏览器会话保留
  await evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.getAttribute('title')==='终端')?.click()")
  await sleep(2_000)
  const terminalRoot = (await evaluate<string>("document.querySelector('.terminal-root-label')?.textContent ?? ''")) ?? ''
  // 工作区根名随检出目录而变（worktree/分支名），只断言「已加载一个根目录」，
  // 不绑定具体目录名——否则换 worktree 就误报。
  record('交替切换：终端页加载工作区根（与浏览器并存于统一中栏槽）',
    terminalRoot.trim().length > 0, terminalRoot.slice(0, 40))
  await evaluate("document.querySelector('.terminal-page > .terminal-toolbar > button.primary')?.click()")
  await sleep(1_500)
  const terminalReady = await evaluate<boolean>("Boolean(document.querySelector('.terminal-area textarea'))")
  record('交替切换：终端 PTY 面板就绪', terminalReady === true)
  // 切回浏览器：浏览器 Surface 会话保留（detach 不销毁，URL 未变）
  await evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.getAttribute('title')==='浏览器')?.click()")
  await sleep(2_000)
  record('交替切换：切回浏览器后 Surface 会话保留（未销毁）', await evaluate<boolean>("Boolean(document.querySelector('.browser-surface'))") === true)
  // 将浏览器 1 显式导航回本地站点，确保便携检查时视图挂载在本地 URL（detach/attach 后仍可导航）
  await typeAddress(siteUrl)
  await sleep(2_000)

  // ---- 便携目录检查：独立分区、无孤儿 view/进程 ----
  // 浏览器视图是独立于渲染壳的 CDP 目标，URL 为本地站点（任意路径）；
  // 存活即 attach 状态，孤儿判定由关闭/退出统一回收（本脚本已验证关闭隔离）。
  const browserViewTarget = await waitFor(async () =>
    Boolean((await targets()).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url))), 10_000)
    ? (await targets()).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url))
    : undefined
  record('便携检查：浏览器视图存活（独立 CDP 目标，attach 状态）', browserViewTarget !== undefined,
    browserViewTarget?.url ?? '(无本地站点目标)')

  if (site.listening) site.close()
  writeFileSync(path.join(outDir, 'smoke-browser.json'), JSON.stringify({
    passed: passed.length, failed: failed.length, failedNames: failed,
  }, null, 2))
}

try {
  await main()
} catch (error) {
  console.error('[smoke-browser] FAILED:', error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  try { await cdp('Browser.close'); await sleep(2_000) } catch { /* 已断开 */ }
  try { ws?.close() } catch { /* ignore */ }
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  console.log(`[smoke-browser] 通过 ${passed.length} / ${passed.length + failed.length}`)
  if (failed.length > 0) {
    console.log(`[smoke-browser] 失败: ${failed.join(', ')}`)
    process.exitCode = 1
  }
  setTimeout(() => process.exit(process.exitCode ?? 0), 1_000).unref()
}
