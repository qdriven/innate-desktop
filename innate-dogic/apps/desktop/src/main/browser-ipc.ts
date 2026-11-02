/**
 * desktop 对 browser 插件 IPC 契约的宿主绑定（W6.6）。
 *
 * 桌面版本与插件契约**解耦**：桌面只声明自己实现了哪个契约版本，通道名与
 * 方法签名全部来自插件契约——桌面不复制映射，插件新增方法时桌面无需改代码；
 * 只有契约版本不兼容时才在这里 fail closed（拒绝注册，而不是降级到部分通道，
 * 否则不同宿主行为会不一致）。
 *
 * 其他宿主（别的插件、未来的 desktop 版本、测试替身）按同一份契约接入：
 * 主进程侧 registerBrowserIpc(host, createBrowserIpcHandlers(service))，
 * 渲染侧 createBrowserApi(transport)。
 */
import { ipcMain } from 'electron'
import { registerBrowserIpc } from '@dogic/plugin-browser/ipc'
import { createBrowserIpcHandlers } from '@dogic/plugin-browser/main/ipc'
import type { BrowserIpcService } from '@dogic/plugin-browser/main/ipc'

/**
 * 本桌面版本实现的 browser 契约版本。
 * 插件契约升级（minor +1）时，桌面确认支持后同步提升此值。
 */
export const DESKTOP_BROWSER_IPC_VERSION = '1.0'

/**
 * 把 browser 服务按契约注册到 Electron ipcMain。
 *
 * 契约通道固定为 `innate:browser*`；桌面不新增、不改名、不加后缀通道——
 * 契约里的每个方法都对应一条通道，参数与返回值由契约声明。
 * 版本不兼容 → 抛错（fail closed）。
 */
export function registerDesktopBrowserIpc(service: BrowserIpcService): void {
  registerBrowserIpc(
    {
      contractVersion: DESKTOP_BROWSER_IPC_VERSION,
      handle: (channel, handler) => {
        ipcMain.handle(channel, (_event, id: unknown, payload: unknown) => handler(id, payload))
      },
    },
    createBrowserIpcHandlers(service),
  )
}
