import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 直接从 TS 源码打包内部包：保持 main/preload/renderer 使用同一插件实现。
const coreSrc = resolve(__dirname, '../../packages/core/src/index.ts')
const kernelSrc = resolve(__dirname, '../../packages/kernel/src')
const workspaceSrc = resolve(__dirname, '../../plugins/workspace/src')
const serviceGatewaySrc = resolve(__dirname, '../../services/model-gateway/src/index.ts')
const terminalSrc = resolve(__dirname, '../../plugins/terminal/src')
const browserSrc = resolve(__dirname, '../../plugins/browser/src')
const aliases = {
  '@dogic/core/surface': resolve(__dirname, '../../packages/core/src/surface.ts'),
  '@dogic/core/redact': resolve(__dirname, '../../packages/core/src/redact.ts'),
  '@dogic/core': coreSrc,
  '@dogic/kernel/browser': resolve(kernelSrc, 'browser.ts'),
  '@dogic/kernel': resolve(kernelSrc, 'index.ts'),
  '@dogic/syntax-highlighting': resolve(__dirname, '../../packages/syntax-highlighting/src/index.ts'),
  '@dogic/service-model-gateway': serviceGatewaySrc,
  '@dogic/plugin-workspace/main': resolve(workspaceSrc, 'main/index.ts'),
  '@dogic/plugin-workspace/plugin': resolve(workspaceSrc, 'plugin.ts'),
  '@dogic/plugin-workspace/renderer': resolve(workspaceSrc, 'renderer/index.ts'),
  '@dogic/plugin-workspace': resolve(workspaceSrc, 'shared/index.ts'),
  '@dogic/plugin-terminal/main': resolve(terminalSrc, 'main/index.ts'),
  '@dogic/plugin-terminal/renderer': resolve(terminalSrc, 'renderer/index.ts'),
  '@dogic/plugin-terminal': resolve(terminalSrc, 'shared/index.ts'),
  '@dogic/plugin-browser/main/electron': resolve(browserSrc, 'main/electron-view.ts'),
  '@dogic/plugin-browser/main/ipc': resolve(browserSrc, 'main/ipc.ts'),
  '@dogic/plugin-browser/main': resolve(browserSrc, 'main/index.ts'),
  '@dogic/plugin-browser/renderer': resolve(browserSrc, 'renderer/index.ts'),
  '@dogic/plugin-browser/ipc': resolve(browserSrc, 'shared/ipc.ts'),
  '@dogic/plugin-browser': resolve(browserSrc, 'shared/index.ts'),
}
const bundled = ['@dogic/core', '@dogic/kernel', '@dogic/plugin-workspace', '@dogic/service-model-gateway', '@dogic/plugin-terminal', '@dogic/plugin-browser', '@dogic/syntax-highlighting']

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    resolve: { alias: aliases },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: bundled })],
    resolve: { alias: aliases },
  },
  renderer: {
    plugins: [tailwindcss(), react()],
    resolve: {
      // 插件 renderer 源码（TS 直链）没有本地 react：统一从桌面包解析，
      // 保证自动 JSX 运行时（react/jsx-runtime）与单一 React 实例。
      dedupe: ['react', 'react-dom'],
      alias: aliases,
    },
  },
})
