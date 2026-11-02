#!/usr/bin/env node
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

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
interface EvaluateResult {
  result?: { value?: unknown }
}
interface HarnessLaunchResult {
  ok: boolean
  detail?: string
  url?: string
  port?: number
}
interface DesktopWindowBounds {
  left?: number
  top?: number
  width?: number
  height?: number
  windowState?: string
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const withHarness = process.argv.includes('--with-harness')
const packaged = process.argv.includes('--packaged')
const outDir = process.argv.slice(2).find((arg) => !arg.startsWith('--'))
  ?? path.join(root, 'docs/susu/plan/evidence/W0/smoke')
mkdirSync(outDir, { recursive: true })
const appDir = path.join(root, 'innate-dogic/apps/desktop')
const electron = packaged
  ? path.join(appDir, 'dist-package/portable/DSH InnateOS/DSH InnateOS.exe')
  : path.join(appDir, 'node_modules/electron/dist/electron.exe')
// 独立 userData 与进程相关调试端口，避免正式预览或上次残留实例造成冲突。
const smokeUserData = path.join(appDir, `dist-package/smoke-user-data-${packaged ? 'packaged' : 'dev'}`)
const debugPort = 20_000 + (process.pid % 30_000)
const launchArgs = packaged ? [`--user-data-dir=${smokeUserData}`] : [appDir, `--user-data-dir=${smokeUserData}`]
const repoName = path.basename(root)
// 预览断言用包名而不是目录名：工作区副本目录名可能与包名不同（如 w1c-2）。
const packageName = ((): string => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf-8')) as { name?: string }
    return pkg.name ?? repoName
  } catch {
    return repoName
  }
})()
const env: NodeJS.ProcessEnv = { ...process.env, INNATE_WORKSPACE_ROOT: root }
// 本机 magpie 控制台冷启动实测 40–160s（杀软扫描 + bun 冷启），冒烟放宽控制台启动上限。
env.INNATE_MAGPIE_CONSOLE_TIMEOUT_MS ??= '240000'
// dsh 冷启动实测 ~25s（慢机器更久），冒烟放宽就绪上限。
env.INNATE_HARNESS_READY_TIMEOUT_MS ??= '240000'
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [...launchArgs, `--remote-debugging-port=${debugPort}`], { env, stdio: 'pipe' })
child.stderr.on('data', (data: Buffer) => process.stderr.write(data))
const watchdog = setTimeout(() => {
  console.error('[smoke] watchdog timeout, forcing exit')
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  process.exit(3)
}, withHarness ? (packaged ? 1_800_000 : 1_200_000) : 900_000)

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
let ws: WebSocket | undefined
const pending = new Map<number, { resolve: (value: unknown) => void }>()
const execFileAsync = promisify(execFile)
let seq = 0
function cdp<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!ws) return reject(new Error('CDP WebSocket 未连接'))
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP ${method} 超时（30s）`))
    }, 30_000)
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value as T)
      },
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
async function evaluate<T>(expression: string): Promise<T | undefined> {
  const response = await cdp<EvaluateResult>('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  return response.result?.value as T | undefined
}
async function shot(name: string): Promise<void> {
  const response = await cdp<{ data?: string }>('Page.captureScreenshot', { format: 'png' })
  if (!response.data) throw new Error(`截图失败: ${name}`)
  writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(response.data, 'base64'))
  console.log(`[smoke] saved ${name}.png`)
}
// W4.4：向当前焦点终端（xterm textarea）逐字符敲入文本并回车。
// Enter 用 keyDown/keyUp（type=char 不映射为回车）。
async function typeIntoTerminal(text: string): Promise<void> {
  // 等待 xterm textarea 挂载完成（重开后新 xterm 重建需要时间）再聚焦，
  // 否则按键会落在已 disposed 的旧 textarea 上丢失。
  for (let i = 0; i < 20; i++) {
    const ready = await evaluate<boolean>("Boolean(document.querySelector('.terminal-area textarea'))") ?? false
    if (ready) break
    await sleep(500)
  }
  await evaluate("document.querySelector('.terminal-area textarea')?.focus()")
  for (const char of text) {
    await cdp('Input.dispatchKeyEvent', { type: 'char', text: char })
    await sleep(30)
  }
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
  await cdp('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  })
}
// 轮询终端面板 innerText 直到包含标记（PTY 冷启动 + echo 回显需要时间）。
async function pollTerminalText(marker: string, attempts = 40): Promise<string> {
  let text = ''
  for (let i = 0; i < attempts; i++) {
    text = await evaluate<string>("document.querySelector('.terminal-area')?.innerText ?? ''") ?? ''
    if (text.includes(marker)) return text
    await sleep(500)
  }
  return text
}
// 等待新 PTY 的 cmd 提示符出现（banner + prompt 行尾 '>'）：提示符出现即 shell 已就绪可接收输入。
async function waitTerminalReady(attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const text = await evaluate<string>("document.querySelector('.terminal-area')?.innerText ?? ''") ?? ''
    if (/>\s*$/m.test(text)) return
    await sleep(500)
  }
  throw new Error('终端提示符未出现（PTY 未就绪）')
}
const nativeWindowType = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class W1aNativeWindow {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$script:h = (Get-Process -Id ${child.pid}).MainWindowHandle
if ($script:h -eq 0) { throw '未找到 Electron 主窗口句柄' }
`
async function runNativeWindow(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', `${nativeWindowType}\n${script}`,
  ])
  return stdout.trim()
}
async function getWindowBounds(): Promise<DesktopWindowBounds> {
  const output = await runNativeWindow(`
$r = New-Object W1aNativeWindow+RECT
if (-not [W1aNativeWindow]::GetWindowRect($script:h, [ref]$r)) { throw 'GetWindowRect 失败' }
@{ left=$r.Left; top=$r.Top; width=$r.Right-$r.Left; height=$r.Bottom-$r.Top } | ConvertTo-Json -Compress
`)
  return JSON.parse(output) as DesktopWindowBounds
}
async function setWindowBounds(bounds: DesktopWindowBounds): Promise<void> {
  if ([bounds.left, bounds.top, bounds.width, bounds.height].some((value) => value === undefined)) {
    throw new Error(`窗口 bounds 不完整: ${JSON.stringify(bounds)}`)
  }
  await runNativeWindow(`
if (-not [W1aNativeWindow]::SetWindowPos($script:h, [IntPtr]::Zero, ${bounds.left}, ${bounds.top}, ${bounds.width}, ${bounds.height}, 0x0014)) { throw 'SetWindowPos 失败' }
`)
}
async function saveElementBounds(selector: string, name: string): Promise<void> {
  const bounds = await evaluate(`(() => {
    const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect()
    return r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null
  })()`)
  if (!bounds) throw new Error(`未找到 bounds 元素: ${selector}`)
  writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(bounds, null, 2))
  console.log(`[smoke] saved ${name}.json`)
}
async function targets(): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json`)
  return await response.json() as CdpTarget[]
}
/** 在指定 target（Harness/控制台 WebContents）内执行表达式，用于验证其独立页面状态。 */
async function evalTarget<T>(target: CdpTarget, expression: string): Promise<T | undefined> {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP target 连接超时（30s）: ${target.url}`)), 30_000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`CDP target 连接失败: ${target.url}`))
    }
  })
  const value = await new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP target 求值超时（30s）: ${target.url}`)), 30_000)
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === 9002) {
        clearTimeout(timer)
        const result = (message.result as { result?: { value?: unknown } } | undefined)?.result?.value
        resolve(result as T | undefined)
      }
    }
    socket.onclose = () => {
      clearTimeout(timer)
      reject(new Error(`CDP target 连接已关闭: ${target.url}`))
    }
    socket.send(JSON.stringify({
      id: 9002,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
    }))
  })
  socket.close()
  return value
}
async function shotTarget(target: CdpTarget, name: string): Promise<void> {
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP target 连接超时（30s）: ${target.url}`)), 30_000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error(`CDP target 连接失败: ${target.url}`))
    }
  })
  const response = await new Promise<{ data?: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`CDP 截图超时（30s）: ${target.url}`)), 30_000)
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === 9001) {
        clearTimeout(timer)
        resolve(message.result as { data?: string })
      }
    }
    socket.onclose = () => {
      clearTimeout(timer)
      reject(new Error(`CDP target 连接已关闭: ${target.url}`))
    }
    socket.send(JSON.stringify({ id: 9001, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  if (response.data) {
    writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(response.data, 'base64'))
    console.log(`[smoke] saved ${name}.png`)
  }
  socket.close()
}

/** 回收本次冒烟拉起的 dsh web：它以 detached 方式启动，不在 electron 进程树内。 */
async function killSmokeDsh(): Promise<void> {
  const script = [
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
    `  Where-Object { $_.CommandLine -like '*${root}*' -and $_.CommandLine -like '*dsh*' } |`,
    '  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
  ].join(' ')
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 30_000 })
  } catch {
    /* 清理失败不阻塞冒烟结论 */
  }
}

try {
  let availableTargets: CdpTarget[] = []
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    try {
      availableTargets = await targets()
      if (availableTargets.some((target) => target.type === 'page' && target.url)) break
    } catch { /* 等待调试端口 */ }
  }
  const page = availableTargets.find((target) => target.type === 'page' && target.url && !target.url.startsWith('devtools'))
  if (!page) throw new Error('未找到渲染进程页面')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)?.resolve(message.result ?? message)
      pending.delete(message.id)
    }
  }
  await new Promise<void>((resolve) => {
    if (ws) ws.onopen = () => resolve()
  })
  await sleep(4_000)
  await evaluate('window.innate.setMode(\'dev\')')
  await evaluate('location.reload()')
  await sleep(4_000)

  const initialWindow = await getWindowBounds()
  const resizedBounds = {
    ...initialWindow,
    width: (initialWindow.width ?? 1_200) + 64,
    height: (initialWindow.height ?? 800) + 32,
  }
  await setWindowBounds(resizedBounds)
  await sleep(500)
  const resizedWindow = await getWindowBounds()
  if (resizedWindow.width === initialWindow.width && resizedWindow.height === initialWindow.height) {
    throw new Error('窗口 resize 未生效')
  }
  await setWindowBounds(initialWindow)
  await sleep(500)
  const restoredWindow = await getWindowBounds()
  writeFileSync(path.join(outDir, 'window-bounds.json'), JSON.stringify({
    before: initialWindow, resized: resizedWindow, restored: restoredWindow,
  }, null, 2))
  console.log('[smoke] 窗口尺寸、resize 与恢复证据已保存')

  await shot('overview')
  const windowControls = await evaluate<number>('document.querySelectorAll(\'.window-controls-btn\').length')
  if (windowControls !== 3) throw new Error('Orca 顶栏窗口控制按钮缺失')
  await evaluate('document.querySelector(\'[aria-label="应用菜单"]\')?.click()')
  const menuItems = await evaluate<string[]>('[...document.querySelectorAll(\'.app-menu-popover [role="menuitem"]\')].map(b=>b.textContent)')
  if (!Array.isArray(menuItems) || menuItems.length !== 3) throw new Error('Orca 顶栏应用菜单不可用')
  await shot('app-menu')
  await evaluate('document.dispatchEvent(new KeyboardEvent(\'keydown\', { key: \'Escape\', bubbles: true }))')
  console.log('[smoke] Orca 顶栏菜单与窗口控制通过')
  const titlebar = await evaluate<{
    tabs: boolean; statusEmpty: boolean; rightPanelSlot: boolean; noPill: boolean; controlSizes: number[][]
  }>(`(() => ({
    tabs: Boolean(document.querySelector('#titlebar-tabs')),
    statusEmpty: document.querySelector('#titlebar-status-slot')?.childNodes.length === 0,
    rightPanelSlot: Boolean(document.querySelector('#titlebar-right-panel-slot')),
    noPill: !document.querySelector('.titlebar .pill'),
    controlSizes: [...document.querySelectorAll('.window-controls-btn')].map((button) => {
      const r = button.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]
    })
  }))()`)
  // W6.7：窗口控件收小到 32×28（用户要求「按钮变小、黑色变浅」）。
  if (!titlebar?.tabs || !titlebar.statusEmpty || !titlebar.rightPanelSlot || !titlebar.noPill ||
      titlebar.controlSizes.length !== 3 || titlebar.controlSizes.some(([w, h]) => w !== 32 || h !== 28)) {
    throw new Error(`TitlebarStrip 三区/空槽/窗口控件尺寸不符合契约: ${JSON.stringify(titlebar)}`)
  }
  await evaluate('document.querySelector(\'[aria-label="最大化"]\')?.click()')
  await sleep(500)
  if (!await evaluate<boolean>("Boolean(document.querySelector('[aria-label=\"还原\"]'))")) throw new Error('最大化窗口控制未生效')
  await evaluate("document.querySelector('#titlebar-tabs')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))")
  await sleep(500)
  if (!await evaluate<boolean>("Boolean(document.querySelector('[aria-label=\"最大化\"]'))")) throw new Error('双击标签槽未还原窗口')
  console.log('[smoke] TitlebarStrip 空槽、3×46 控件、最大化与双击还原通过')
  console.log('[smoke] nav:', await evaluate('[...document.querySelectorAll(\'.nav-item\')].map(b=>b.textContent)'))

  const themeEvidence: Record<string, unknown> = {}
  for (const colorMode of ['light', 'dark'] as const) {
    await evaluate(`localStorage.setItem('color-mode', '${colorMode}'); window.dispatchEvent(new Event('innate-theme-storage'))`)
    await sleep(400)
    const applied = await evaluate<{ colorMode: string; darkClass: boolean; bodyBackground: string; bodyFont: string; card: string }>(`(() => ({
      colorMode: localStorage.getItem('color-mode'),
      darkClass: document.documentElement.classList.contains('dark'),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      bodyFont: getComputedStyle(document.body).fontFamily,
      card: getComputedStyle(document.documentElement).getPropertyValue('--card').trim()
    }))()`)
    if (!applied || applied.colorMode !== colorMode || applied.darkClass !== (colorMode === 'dark')) {
      throw new Error(`ThemeProvider 未正确应用 ${colorMode}: ${JSON.stringify(applied)}`)
    }
    if (!applied.bodyBackground || applied.bodyBackground === 'rgba(0, 0, 0, 0)' || !applied.card || !applied.bodyFont.includes('Geist')) {
      throw new Error(`产品语义 token 或 Geist 未生效: ${JSON.stringify(applied)}`)
    }
    themeEvidence[colorMode] = applied
    await shot(`theme-${colorMode}`)
  }
  writeFileSync(path.join(outDir, 'theme.json'), JSON.stringify(themeEvidence, null, 2))
  await evaluate("localStorage.setItem('color-mode', 'light'); window.dispatchEvent(new Event('innate-theme-storage'))")
  console.log('[smoke] ThemeProvider .dark、语义 token 与 Geist 明暗证据已保存')

  await evaluate('[...document.querySelectorAll(\'.nav-item\')].find(b=>b.textContent.includes(\'模型配置\'))?.click()')
  const consoleTarget = async (): Promise<CdpTarget | undefined> => (await targets()).find((target) =>
    target.type === 'page' && target.url.startsWith('http://127.0.0.1:'))
  for (let i = 0; i < 60; i++) {
    await sleep(5_000)
    const view = await consoleTarget()
    console.log(`[smoke] t+${(i + 1) * 5}s view target:`, view ? `${view.url} | ${view.title}` : '(none)')
    if (view?.title) break
  }
  const viewTarget = await consoleTarget()
  if (!viewTarget) {
    const fallback = await evaluate("document.querySelector('.surface-error')?.textContent")
    throw new Error(`未找到受管 magpie 控制台 target；页面状态: ${String(fallback ?? '无错误说明')}`)
  }
  const viewSocket = new WebSocket(viewTarget.webSocketDebuggerUrl)
  await new Promise<void>((resolve) => { viewSocket.onopen = () => resolve() })
  const readViewBody = async (): Promise<string> => {
    const evalId = ++seq
    const value = await new Promise<unknown>((resolve) => {
      viewSocket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as CdpMessage
        if (message.id === evalId) resolve((message.result as EvaluateResult | undefined)?.result?.value)
      }
      viewSocket.send(JSON.stringify({
        id: evalId,
        method: 'Runtime.evaluate',
        params: { expression: "document.title + ' || ' + (document.body?.innerText ?? '').slice(0, 1000)", returnByValue: true },
      }))
    })
    return typeof value === 'string' ? value : ''
  }
  // 控制台是 SPA：target 出现不等于导航已渲染，轮询到真实导航出现为止。
  let bodyText = ''
  for (let i = 0; i < 90; i++) {
    bodyText = await readViewBody()
    console.log(`[smoke] console view content t+${i * 3}s:`, bodyText.slice(0, 120))
    if (/this link's key is not|unauthorized|HTTP 401/i.test(bodyText)) break
    if (/Agents|Providers|Sessions|Library|Settings|Usage|供应商|资源库|设置|用量/i.test(bodyText)) break
    await sleep(3_000)
  }
  console.log('[smoke] console view content:', bodyText.slice(0, 200))
  if (/this link's key is not|unauthorized|HTTP 401/i.test(bodyText)) throw new Error('magpie 控制台认证失败')
  if (!/Agents|Providers|Sessions|Library|Settings|Usage|供应商|资源库|设置|用量/i.test(bodyText)) {
    throw new Error('magpie 控制台实际导航未加载')
  }
  const viewShotId = ++seq
  const viewShot = await new Promise<{ data?: string }>((resolve) => {
    viewSocket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === viewShotId) resolve(message.result as { data?: string })
    }
    viewSocket.send(JSON.stringify({ id: viewShotId, method: 'Page.captureScreenshot', params: { format: 'png' } }))
  })
  if (!viewShot.data) throw new Error('magpie 控制台截图失败')
  writeFileSync(path.join(outDir, 'console-view.png'), Buffer.from(viewShot.data, 'base64'))
  console.log('[smoke] saved console-view.png')
  viewSocket.close()
  await shot('console')
  await saveElementBounds('.surface-view-area', 'console-bounds')
  const consoleFallback = await evaluate("document.querySelector('.surface-error')?.textContent")
  if (consoleFallback) throw new Error(`magpie 控制台壳层回退: ${String(consoleFallback)}`)
  console.log('[smoke] 受管 magpie 控制台认证与真实内容通过')

  // W1c：控制台进入统一中栏槽，标签条只认安全 descriptor
  const tabStrip = await evaluate<{ tabs: string[]; current: string }>(`(() => ({
    tabs: [...document.querySelectorAll('.surface-tab [role="tab"]')].map((b) => b.textContent ?? ''),
    current: document.querySelector('.surface-tab.current [role="tab"]')?.textContent ?? '',
  }))()`)
  if (!tabStrip?.tabs.includes('magpie 控制台')) {
    throw new Error(`中栏 Surface 标签缺失: ${JSON.stringify(tabStrip)}`)
  }
  console.log('[smoke] 统一中栏标签条:', tabStrip.tabs.join(' | '), '当前:', tabStrip.current)

  // W1c 安全负路径：伪造 providerId 与未运行的 Harness 都必须被主进程拒绝
  const forged = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.surfaceShow({ id: 'forged', providerId: 'forged', kind: 'webcontents', title: '伪造' }, { x: 0, y: 0, width: 10, height: 10 })",
  )
  if (forged?.ok) throw new Error('伪造 providerId 未被拒绝')
  const harnessBeforeLaunch = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.surfaceShow({ id: 'harness', providerId: 'harness', kind: 'webcontents', title: 'DeepSeek Harness' }, { x: 0, y: 0, width: 10, height: 10 })",
  )
  if (harnessBeforeLaunch?.ok) throw new Error('Harness 未运行时不应打开 Surface')
  console.log('[smoke] 伪造 providerId / 未就绪 provider 均被拒绝，壳仍可用')

  // W1a 基线：hide/show 后必须复用同一控制台 target（重建会换端口 → URL 必变）
  const consoleUrlBefore = viewTarget.url
  await evaluate("window.innate.surfaceHide('magpie-console')")
  await sleep(1_000)
  await evaluate("window.innate.surfaceShow({ id: 'magpie-console', providerId: 'magpie-console', kind: 'webcontents', title: 'magpie 控制台' }, { x: 8, y: 64, width: 900, height: 600 })")
  await sleep(2_000)
  const viewTarget2 = await consoleTarget()
  if (!viewTarget2 || viewTarget2.url !== consoleUrlBefore) {
    throw new Error(`控制台 hide/show 后 target 重建或 URL 变化: ${viewTarget2?.url ?? '(none)'}`)
  }
  await shotTarget(viewTarget2, 'console-view-reshow')
  console.log('[smoke] 控制台 hide/show 复用同一 target（URL 未变）通过')
  const dom = await evaluate<string>("document.querySelector('.app')?.outerHTML")
  writeFileSync(path.join(outDir, 'console.dom.html'), dom ?? '')

  await evaluate("window.innate.setMode('simple')")
  await evaluate('location.reload()')
  await sleep(5_000)
  const simpleNav = await evaluate<string[]>("[...document.querySelectorAll('.nav-item')].map(b=>b.getAttribute('title'))")
  console.log('[smoke] simple nav:', simpleNav)
  const simpleOk = Array.isArray(simpleNav) && simpleNav.length === 2 && simpleNav.includes('对话') && simpleNav.includes('设置')
  if (!simpleOk) throw new Error('simple 模式页面门控不符合预期')
  if (simpleNav.includes('终端')) throw new Error('simple 模式出现终端导航（门控失效）')
  console.log('[smoke] simple 模式门控通过')
  // W4.6：simple 模式下 process:execute 窄通道必须全拒（主进程门控，不触达服务端）
  const simpleProcess = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processExecute({ profileId: 'echoer', args: [] })",
  )
  if (simpleProcess?.ok) throw new Error('simple 模式 process:execute 未被拒绝')
  if (simpleProcess?.detail !== 'simple 模式不提供 process:execute') {
    throw new Error(`simple 模式 process 拒绝 detail 不符合预期: ${simpleProcess?.detail ?? ''}`)
  }
  const simpleCancel = await evaluate<boolean>("window.innate.processCancel('exec-1')")
  if (simpleCancel) throw new Error('simple 模式 processCancel 未被拒绝')
  console.log('[smoke] simple 模式 process:execute 门控全拒通过')
  await shot('simple-home')
  console.log('[smoke] simple hero:', await evaluate("document.querySelector('.simple-hero')?.textContent?.slice(0, 120)"))
  let harnessPort: number | undefined
  let harnessUrlBefore: string | undefined
  if (withHarness) {
    const installed = await evaluate<boolean>('window.innate.getStatus().then(s => s.dsh.installed)')
    if (!installed) throw new Error('桌面端仍未识别 dsh 安装')
    const launched = await evaluate<HarnessLaunchResult>('window.innate.launchHarness()')
    console.log('[smoke] Harness launch:', { ok: launched?.ok, port: launched?.port, detail: launched?.detail })
    if (!launched?.ok) {
      // W1c.3 降级证据：启动失败必须显式可见且壳继续可用
      await sleep(2_000)
      const degraded = await evaluate<{ hint: string; logs: boolean; nav: number }>(`(() => ({
        hint: document.querySelector('.simple-hint, .launch-msg')?.textContent ?? '',
        logs: Boolean([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('查看日志'))),
        nav: document.querySelectorAll('.nav-item').length,
      }))()`)
      await shot('harness-degraded')
      console.log('[smoke] Harness 降级状态:', JSON.stringify(degraded))
      if (!degraded?.logs) throw new Error('Harness 启动失败后缺少「查看日志」恢复入口')
      if (!degraded.nav) throw new Error('Harness 启动失败后壳导航不可用')
      throw new Error(`Harness 启动失败: ${launched?.detail ?? '未知错误'}（降级证据已保存）`)
    }
    await sleep(3_000)
    const embedded = await evaluate<boolean>("Boolean(document.querySelector('.surface-view'))")
    if (!embedded) throw new Error('Harness 未嵌入当前对话标签页')
    const harnessTarget = (await targets()).find((target) => target.url.includes(`:${launched.port}/`))
    if (!harnessTarget) throw new Error('未找到 Harness Surface target')
    // W1a 基线：在 Harness 页面设存活标记，稍后跨 simple 重载与 dev 导航验证「URL 未变不 reload」
    await evalTarget(harnessTarget, 'window.__w1aMarker = Date.now(); "set"')
    harnessPort = launched.port
    harnessUrlBefore = harnessTarget.url
    await shotTarget(harnessTarget, 'harness-view')
    await shot('harness-tab')
    await saveElementBounds('.surface-view-area', 'harness-bounds')
    console.log('[smoke] Harness 内嵌标签启动通过（保持运行，存活断言见后）')
  }

  await evaluate("window.innate.setMode('dev')")
  await evaluate('location.reload()')
  await sleep(3_000)
  const devNav = await evaluate<string[]>("[...document.querySelectorAll('.nav-item')].map(b=>b.getAttribute('title'))")
  console.log('[smoke] dev nav:', devNav)
  // W3：工作区不再是中栏导航项（迁至右栏常驻 Panel）；W4/W5 新增终端与浏览器导航项
  if (!Array.isArray(devNav) || devNav.length !== 7 || devNav.includes('工作区') || !devNav.includes('对话') || !devNav.includes('终端') || !devNav.includes('浏览器')) {
    throw new Error('dev 模式页面门控不符合预期（W3：工作区迁至右栏；W4/W5：终端/浏览器导航项）')
  }
  const rightPanelReady = await evaluate<boolean>("Boolean(document.querySelector('.right-panel'))")
  if (!rightPanelReady) throw new Error('dev 右栏工作区面板未渲染')

  // W1c：Harness 与控制台共用同一中栏槽——交替切换不重载，关闭一个不影响另一个
  if (harnessPort !== undefined) {
    const consoleUrl = consoleUrlBefore
    await evaluate('[...document.querySelectorAll(\'.nav-item\')].find(b=>b.getAttribute(\'title\')===\'模型配置\')?.click()')
    await sleep(3_000)
    const bothTabs = await evaluate<string[]>("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '')") ?? []
    console.log('[smoke] 多 Surface 标签:', bothTabs.join(' | '))
    if (!bothTabs.includes('DeepSeek Harness') || !bothTabs.includes('magpie 控制台')) {
      throw new Error(`统一中栏槽未同时承载 Harness 与控制台: ${JSON.stringify(bothTabs)}`)
    }
    await shot('surface-tabs')

    // 切到 Harness 标签：URL 不变、存活标记仍在（= 未 reload）
    await evaluate("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('DeepSeek Harness'))?.click()")
    await sleep(2_000)
    const harnessAfterSwitch = (await targets()).find((target) => target.url.includes(`:${harnessPort}/`))
    if (!harnessAfterSwitch) throw new Error('切换标签后 Harness target 消失')
    if (harnessAfterSwitch.url !== harnessUrlBefore) throw new Error(`切换标签后 Harness URL 变化: ${harnessAfterSwitch.url}`)
    const markerAfterSwitch = await evalTarget<number>(harnessAfterSwitch, 'Number(window.__w1aMarker ?? 0)')
    if (!markerAfterSwitch) throw new Error('切换标签后 Harness 被 reload（存活标记丢失）')

    // 切回控制台标签：控制台 target 复用，URL 不变
    await evaluate("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('magpie 控制台'))?.click()")
    await sleep(2_000)
    const consoleAfterSwitch = (await targets()).find((target) => target.type === 'page' && target.url === consoleUrl)
    if (!consoleAfterSwitch) throw new Error(`切换标签后控制台 target 消失或重建: ${consoleUrl ?? '(none)'}`)
    await shot('surface-tabs-switched')

    // 关闭控制台标签：只销毁控制台视图，Harness 仍存活
    await evaluate("document.querySelector('[aria-label=\"关闭 magpie 控制台\"]')?.click()")
    await sleep(2_000)
    const consoleAfterClose = (await targets()).find((target) => target.type === 'page' && target.url === consoleUrl)
    if (consoleAfterClose) throw new Error('关闭控制台标签后其视图仍存活')
    const harnessAfterClose = (await targets()).find((target) => target.url.includes(`:${harnessPort}/`))
    if (!harnessAfterClose) throw new Error('关闭控制台标签后 Harness 消失（违反关闭隔离）')
    const tabsAfterClose = await evaluate<string[]>("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '')") ?? []
    if (tabsAfterClose.includes('magpie 控制台')) throw new Error(`关闭后控制台标签仍在: ${JSON.stringify(tabsAfterClose)}`)
    console.log('[smoke] 多 Surface 交替切换不重载、关闭一个不影响另一个通过')

    // W1c 安全：renderer 状态与标签快照都不含认证 URL / token
    const harnessStateJson = await evaluate<string>('window.innate.getHarnessState().then((s) => JSON.stringify(s))') ?? ''
    const tabsSnapshot = await evaluate<string>("localStorage.getItem('innate.surface-tabs:center') ?? ''") ?? ''
    for (const [name, value] of [['harness state', harnessStateJson], ['surface snapshot', tabsSnapshot]] as const) {
      if (/token=|[?&]k=|api[-_]?key/i.test(value)) throw new Error(`${name} 含认证信息: ${value.slice(0, 200)}`)
      if (/https?:\/\/127\.0\.0\.1:\d+\/\?/.test(value)) throw new Error(`${name} 含认证 URL: ${value.slice(0, 200)}`)
    }
    console.log('[smoke] renderer 状态与 Surface 快照均无 token/认证 URL')
  }

  // W3：工作区迁至 dev 右栏常驻 Panel（不再是中栏导航页）
  await sleep(2_000)
  const workspaceRoot = await evaluate<string>("document.querySelector('.workspace-root-switch')?.textContent")
  if (!workspaceRoot?.includes(repoName)) throw new Error(`工作区根目录未加载: ${workspaceRoot}`)
  const fileTreeReady = await evaluate<boolean>("Boolean(document.querySelector('.file-tree-row[title=\"package.json\"]'))")
  if (!fileTreeReady) throw new Error('右栏文件树未加载')
  await evaluate("document.querySelector('.file-tree-row[title=\"package.json\"]')?.click()")
  await sleep(800)
  // W3.4：文件点击在中栏打开文档标签（surface-tab）并渲染预览
  const surfaceTabReady = await evaluate<boolean>("Boolean(document.querySelector('.surface-tab [role=\"tab\"]'))")
  if (!surfaceTabReady) throw new Error('文件点击未在中栏打开文档标签')
  const textPreview = await evaluate<string>("document.querySelector('.text-preview')?.textContent")
  if (!textPreview?.includes(packageName)) throw new Error('文本文件预览失败')
  let syntaxReady = false
  for (let i = 0; i < 10; i++) {
    syntaxReady = await evaluate<boolean>("Boolean(document.querySelector('.code-preview .shiki span[style*=\"--shiki-dark\"]'))") ?? false
    if (syntaxReady) break
    await sleep(300)
  }
  if (!syntaxReady) throw new Error('代码语法高亮未加载')
  await shot('workspace-file')
  await evaluate("localStorage.setItem('color-mode', 'dark'); window.dispatchEvent(new Event('innate-theme-storage'))")
  await sleep(300)
  const darkSyntaxReady = await evaluate<boolean>("document.documentElement.classList.contains('dark') && getComputedStyle(document.querySelector('.code-preview .shiki')).getPropertyValue('--shiki-dark').trim().length > 0")
  if (!darkSyntaxReady) throw new Error('暗色代码语法高亮主题未加载')
  await shot('workspace-file-dark')
  await evaluate("localStorage.setItem('color-mode', 'light'); window.dispatchEvent(new Event('innate-theme-storage'))")
  // W3.6：UI 状态快照（root + 展开目录）与中栏文档标签快照均安全持久化（无 URL/token）
  const uiPersisted = await evaluate<boolean>(`Object.keys(localStorage).some((key) => {
    if (!key.startsWith('innate.workspace.ui:')) return false
    const value = JSON.parse(localStorage.getItem(key) ?? '{}')
    return value.version === 1 && typeof value.root === 'string' && value.root.length > 0
  })`)
  if (!uiPersisted) throw new Error('工作区 UI 状态快照未安全持久化')
  const tabsPersisted = await evaluate<boolean>(`(() => {
    const value = JSON.parse(localStorage.getItem('innate.surface-tabs:center') ?? '{}')
    return value.version === 1 && value.surfaces?.some((surface: { id: string; url?: string }) => surface.id.startsWith('file:') && !surface.url)
  })()`)
  if (!tabsPersisted) throw new Error('中栏文档标签快照未安全持久化')
  await evaluate('location.reload()')
  await sleep(3_000)
  // 重启恢复：root 经 ui:* 恢复；文档标签经 surface-tabs:center 恢复并激活
  const restoredRoot = await evaluate<string>("document.querySelector('.workspace-root-switch')?.textContent")
  if (!restoredRoot?.includes(repoName)) throw new Error('重启后工作区 root 未恢复')
  const restoredPreview = await evaluate<string>("document.querySelector('.text-preview')?.textContent")
  if (!restoredPreview?.includes(packageName)) throw new Error('重启后文档标签预览恢复失败')
  console.log('[smoke] 工作区 UI/文档快照与重启恢复通过')
  await evaluate("document.querySelector('.file-tree-row[title=\"README.md\"]')?.click()")
  await sleep(800)
  const markdownReady = await evaluate<boolean>("Boolean(document.querySelector('.markdown-preview'))")
  if (!markdownReady) throw new Error('Markdown 预览失败')
  await shot('workspace-markdown')
  await evaluate('[...document.querySelectorAll(\'.workspace-activity button\')].find(b=>b.textContent===\'Git\')?.click()')
  let gitReady = false
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    gitReady = await evaluate<boolean>("Boolean(document.querySelector('.git-panel'))") ?? false
    if (gitReady) break
  }
  if (!gitReady) throw new Error('Git 状态面板未加载')
  await evaluate("document.querySelector('.git-change-row')?.click()")
  let diffReady = false
  for (let i = 0; i < 20; i++) {
    await sleep(300)
    diffReady = await evaluate<boolean>("Boolean(document.querySelector('.diff-preview'))") ?? false
    if (diffReady) break
  }
  if (!diffReady) throw new Error('Git diff 预览失败')
  await shot('workspace-git')
  console.log('[smoke] 文件树、文本/Markdown 预览与只读 Git diff 通过')

  // W4.4：终端 Surface（真实 PTY + xterm）——交互、多标签切换保留、退出重开、伪造负路径
  await evaluate("localStorage.setItem('color-mode', 'dark'); window.dispatchEvent(new Event('innate-theme-storage'))")
  await sleep(300)
  await evaluate("[...document.querySelectorAll('.nav-item')].find(b=>b.getAttribute('title')==='终端')?.click()")
  await sleep(2_000)
  const terminalRootLabel = await evaluate<string>("document.querySelector('.terminal-root-label')?.textContent ?? ''")
  if (!terminalRootLabel?.includes(repoName)) throw new Error(`终端页未加载工作区根: ${terminalRootLabel}`)
  await shot('terminal-page')

  await evaluate("document.querySelector('.terminal-page > .terminal-toolbar > button.primary')?.click()")
  await sleep(1_500)
  const terminalReady = await evaluate<boolean>("Boolean(document.querySelector('.terminal-area textarea'))")
  if (!terminalReady) throw new Error('新建终端后未出现 xterm 面板')
  const firstTabLabel = await evaluate<string>("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '').join('|')")
  if (!firstTabLabel?.includes('终端 1')) throw new Error(`终端标签命名不符合预期: ${firstTabLabel}`)

  await waitTerminalReady()
  await typeIntoTerminal('echo smoke-terminal-ok')
  const terminalOutput = await pollTerminalText('smoke-terminal-ok')
  if (!terminalOutput.includes('smoke-terminal-ok')) throw new Error(`终端 echo 输出未捕获: ${terminalOutput.slice(-300)}`)
  await shot('terminal-output')
  console.log('[smoke] 终端 PTY 交互通过')

  // 第二个终端 + 切回第一个：detach 只隐藏视图，scrollback 保留
  await evaluate("document.querySelector('.terminal-page > .terminal-toolbar > button.primary')?.click()")
  await sleep(1_500)
  await evaluate("[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].find(b=>b.textContent?.includes('终端 1'))?.click()")
  await sleep(1_500)
  const retained = await evaluate<boolean>("document.querySelector('.terminal-area')?.innerText?.includes('smoke-terminal-ok') ?? false")
  if (!retained) throw new Error('标签切换后终端 scrollback 未保留')
  console.log('[smoke] 多终端标签切换保留通过')

  // W4.7：PTY resize 通道 + 标签关闭生命周期（关闭一个不影响另一个）
  const resizeOk = await evaluate<boolean>(
    "window.innate.terminalResize('terminal-1-s1', { cols: 100, rows: 30 })",
  )
  if (!resizeOk) throw new Error('terminalResize 通道未生效')
  console.log('[smoke] 终端 PTY resize 通道通过')
  await evaluate("document.querySelector('[aria-label=\"关闭 终端 2\"]')?.click()")
  await sleep(1_500)
  const tabsAfterClose = await evaluate<string[]>(
    "[...document.querySelectorAll('.surface-tab [role=\"tab\"]')].map(b=>b.textContent ?? '')",
  ) ?? []
  if (tabsAfterClose.some((label) => label.includes('终端 2'))) {
    throw new Error(`关闭终端 2 后标签仍在: ${JSON.stringify(tabsAfterClose)}`)
  }
  if (!tabsAfterClose.some((label) => label.includes('终端 1'))) {
    throw new Error(`关闭终端 2 后终端 1 标签丢失: ${JSON.stringify(tabsAfterClose)}`)
  }
  console.log('[smoke] 终端标签关闭生命周期通过（终端 2 移除、终端 1 保留）')

  // exit 后显示退出提示；重开派生新 PTY 并可再次交互
  await typeIntoTerminal('exit')
  let exited = false
  for (let i = 0; i < 30 && !exited; i++) {
    exited = await evaluate<boolean>("Boolean(document.querySelector('.terminal-exited'))") ?? false
    if (!exited) await sleep(500)
  }
  if (!exited) throw new Error('exit 后未显示会话退出提示')
  await shot('terminal-exited')
  await evaluate("document.querySelector('.terminal-actions button.primary')?.click()")
  await waitTerminalReady()
  await typeIntoTerminal('echo smoke-reopen-ok')
  let reopenOutput = await pollTerminalText('smoke-reopen-ok')
  if (!reopenOutput.includes('smoke-reopen-ok')) {
    // 输入与 PTY 就绪竞争：重敲一次再判定
    await waitTerminalReady()
    await typeIntoTerminal('echo smoke-reopen-ok')
    reopenOutput = await pollTerminalText('smoke-reopen-ok')
  }
  if (!reopenOutput.includes('smoke-reopen-ok')) throw new Error(`重开后终端不可交互: ${reopenOutput.slice(-300)}`)
  console.log('[smoke] 会话退出提示与重开通过')

  // W4.4 安全负路径：伪造 workspaceId 的 terminalCreate 必须被服务端拒绝
  const forgedTerminal = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.terminalCreate({ id: 'forged-term', providerId: 'terminal', kind: 'terminal', title: '伪造', cols: 80, rows: 24, profile: { id: 'default' }, workspaceId: 'C:/nowhere' })",
  )
  if (forgedTerminal?.ok) throw new Error('伪造 workspaceId 的 terminalCreate 未被拒绝')
  console.log('[smoke] 伪造 workspaceId 被拒绝，终端负路径通过')

  // W4.7 安全：伪造 capability 的 Surface descriptor 必须被解析层拒绝
  const forgedCapability = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.surfaceShow({ id: 'magpie-console', providerId: 'magpie-console', kind: 'webcontents', title: '伪造能力', capabilities: ['shell:exec'] }, { x: 0, y: 0, width: 10, height: 10 })",
  )
  if (forgedCapability?.ok) throw new Error('伪造 capability 未被拒绝')
  if (!forgedCapability?.detail?.includes('capability')) {
    throw new Error(`伪造 capability 拒绝 detail 不符合预期: ${forgedCapability?.detail ?? ''}`)
  }
  console.log('[smoke] 伪造 capability 被拒绝，Surface 能力白名单通过')

  // W4.6：受控 process:execute 窄通道 E2E——profile 注册、受理回执、结果取回、负路径
  const registerProfile = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processProfileRegister({ id: 'echoer', command: 'cmd.exe', args: ['/c'] })",
  )
  if (!registerProfile?.ok) throw new Error(`process profile 注册失败: ${registerProfile?.detail ?? ''}`)
  const profiles = await evaluate<string[]>('window.innate.processProfiles()')
  if (!Array.isArray(profiles) || !profiles.includes('echoer')) {
    throw new Error(`process profile 白名单未生效: ${JSON.stringify(profiles)}`)
  }
  console.log('[smoke] process profile 注册与白名单通过')

  const ack = await evaluate<{ executionId: string; ok: boolean; detail?: string }>(
    "window.innate.processExecute({ profileId: 'echoer', args: ['echo', 'smoke-process-ok'] })",
  )
  if (!ack?.ok || !ack.executionId) {
    throw new Error(`processExecute 受理回执不符合预期: ${JSON.stringify(ack)}`)
  }
  let processOutcome: {
    ok: boolean; exitCode: number | null; stdout: string; timedOut: boolean; cancelled: boolean; detail?: string
  } | undefined
  for (let i = 0; i < 30 && !processOutcome?.ok; i++) {
    processOutcome = await evaluate(`window.innate.processResult('${ack.executionId}')`)
    if (!processOutcome?.ok) await sleep(500)
  }
  if (!processOutcome?.ok) throw new Error(`process 执行未成功: ${JSON.stringify(processOutcome)}`)
  if (processOutcome.exitCode !== 0) throw new Error(`process 退出码非零: ${JSON.stringify(processOutcome)}`)
  if (processOutcome.timedOut || processOutcome.cancelled) {
    throw new Error(`process 终态异常: ${JSON.stringify(processOutcome)}`)
  }
  if (!processOutcome.stdout.includes('smoke-process-ok')) {
    throw new Error(`process stdout 未捕获: ${JSON.stringify(processOutcome)}`)
  }
  console.log('[smoke] process:execute 正路径（受理→结果→stdout）通过')

  // 负路径：未注册 profile / cwd 逃逸 / 非法 profile 注册 / 未知 executionId
  const ghostProfile = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processExecute({ profileId: 'ghost', args: ['echo', 'x'] })",
  )
  if (ghostProfile?.ok) throw new Error('未注册 profile 未被拒绝')
  const escapeCwd = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processExecute({ profileId: 'echoer', args: ['echo', 'x'], cwdRelative: '../..' })",
  )
  if (escapeCwd?.ok) throw new Error('cwd 逃逸未被拒绝')
  const badProfile = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processProfileRegister({ id: 'bad', command: 'cmd.exe &', args: [] })",
  )
  if (badProfile?.ok) throw new Error('含非法字符的 profile 未被拒绝')
  const ghostResult = await evaluate<{ ok: boolean; detail?: string }>(
    "window.innate.processResult('ghost-exec')",
  )
  if (ghostResult?.ok) throw new Error('未知 executionId 未被拒绝')
  console.log('[smoke] process 负路径（未注册 profile/cwd 逃逸/非法 profile/未知执行）全拒通过')

  if (harnessPort !== undefined) {
    // W1a 基线：跨 simple 重载与 dev 多页导航后，Harness 仍是同一页面（URL 未变 + 存活标记在 = 未 reload）
    const t2 = (await targets()).find((target) => target.url.includes(`:${harnessPort}/`))
    if (!t2) throw new Error('Harness target 在导航/重载后消失（违反 detach 不销毁）')
    if (t2.url !== harnessUrlBefore) throw new Error(`Harness URL 变化: ${t2.url}`)
    // 先回到对话页重新附着：分离中的 WebContentsView 会被 Chromium 冻结，CDP 不回包
    await evaluate('[...document.querySelectorAll(\'.nav-item\')].find(b=>b.getAttribute(\'title\')===\'对话\')?.click()')
    await sleep(2_000)
    const embedded = await evaluate<boolean>("Boolean(document.querySelector('.surface-view'))")
    if (!embedded) throw new Error('dev 导航回对话页后 Harness 未重新附着')
    let marker = 0
    for (let i = 0; i < 5 && !marker; i++) {
      try {
        marker = await evalTarget<number>(t2, 'Number(window.__w1aMarker ?? 0)') ?? 0
      } catch (reason) {
        console.log('[smoke] Harness 存活标记读取重试:', String(reason))
      }
      if (!marker) await sleep(2_000)
    }
    if (!marker) throw new Error('Harness 页面被 reload（存活标记丢失）')
    await shotTarget(t2, 'harness-view-after-nav')
    const stopped = await evaluate('window.innate.stopHarness()')
    console.log('[smoke] Harness 跨导航/重载存活（URL 未变、未 reload、重新附着）；显式停止:', JSON.stringify(stopped))
  }
  console.log('[smoke] OK')
} catch (error) {
  console.error('[smoke] FAILED:', error)
  process.exitCode = 1
} finally {
  clearTimeout(watchdog)
  // 优雅关闭：让应用自己跑 window-all-closed 清理（受管 magpie 控制台、Harness 子进程）
  try {
    await cdp('Browser.close')
    await sleep(2_000)
  } catch {
    /* 已断开则直接强杀 */
  }
  try { ws?.close() } catch { /* ignore */ }
  spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await killSmokeDsh()
  setTimeout(() => process.exit(process.exitCode ?? 0), 1_000).unref()
}
