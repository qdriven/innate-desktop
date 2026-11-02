import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  // 与 electron.vite.config.ts 同源：测试直接吃 TS 源码，免去先 build 内部包。
  // react 别名：插件 renderer 源码（在插件包内）没有本地 react 依赖，
  // 测试环境下统一解析到桌面包自己的 react，保证同一模块实例。
  resolve: {
    alias: {
      '@dogic/core/surface': path.resolve(here, '../../packages/core/src/surface.ts'),
      '@dogic/core/redact': path.resolve(here, '../../packages/core/src/redact.ts'),
      '@dogic/core': path.resolve(here, '../../packages/core/src/index.ts'),
      '@dogic/kernel/browser': path.resolve(here, '../../packages/kernel/src/browser.ts'),
      '@dogic/kernel': path.resolve(here, '../../packages/kernel/src/index.ts'),
      '@dogic/plugin-workspace/main': path.resolve(here, '../../plugins/workspace/src/main/index.ts'),
      '@dogic/plugin-workspace/plugin': path.resolve(here, '../../plugins/workspace/src/plugin.ts'),
      '@dogic/plugin-workspace': path.resolve(here, '../../plugins/workspace/src/shared/index.ts'),
      '@dogic/plugin-terminal/main': path.resolve(here, '../../plugins/terminal/src/main/index.ts'),
      '@dogic/plugin-terminal/renderer': path.resolve(here, '../../plugins/terminal/src/renderer/index.ts'),
      '@dogic/plugin-terminal': path.resolve(here, '../../plugins/terminal/src/shared/index.ts'),
      '@dogic/plugin-browser/main/electron': path.resolve(here, '../../plugins/browser/src/main/electron-view.ts'),
      '@dogic/plugin-browser/main/ipc': path.resolve(here, '../../plugins/browser/src/main/ipc.ts'),
      '@dogic/plugin-browser/main': path.resolve(here, '../../plugins/browser/src/main/index.ts'),
      '@dogic/plugin-browser/renderer': path.resolve(here, '../../plugins/browser/src/renderer/index.ts'),
      '@dogic/plugin-browser/ipc': path.resolve(here, '../../plugins/browser/src/shared/ipc.ts'),
      '@dogic/plugin-browser': path.resolve(here, '../../plugins/browser/src/shared/index.ts'),
      // xterm 别名：插件源码与测试文件解析到同一模块实例，vi.mock 才能命中。
      '@xterm/xterm': path.resolve(here, '../../plugins/terminal/node_modules/@xterm/xterm'),
      '@xterm/addon-fit': path.resolve(here, '../../plugins/terminal/node_modules/@xterm/addon-fit'),
      'react': path.resolve(here, 'node_modules/react'),
      'react-dom': path.resolve(here, 'node_modules/react-dom'),
    },
  },
  test: {
    testTimeout: 20_000,
    passWithNoTests: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
  },
})
