# W6：浏览器元素提取（提取元素）

## 阶段目标

在既有受控 browser Surface（W5）之上补齐**元素提取**能力：把页面里的元素以
「角色 + 名称 + 结构选择器 + 可见文本 + 白名单属性」的形式取出来，供人和
Agent 使用，同时**不放宽** W5 立下的红线（无 `executeJavaScript`、renderer
只拿安全字段、协议白名单、权限全拒）。

**前置**：W5 全绿。

**来源**：issue [#11](https://github.com/qdriven/innate-desktop/issues/11)——
「开始 review 当前项目，考虑如何优化浏览器效果，需要增加 1. 提取元素」，
并要求参考 deepwiki/stablyai/orca 的 browser 部分。

## W6.0 研究：orca browser 模块与路线选择

- **改动位置**：`docs/orca/`（deepwiki 全量导出 + 分析）、`docs/susu/plan/phases/W6-browser-extraction.md`。
- **实施**：
  1. 下载 deepwiki.com/stablyai/orca 的全部页面，落为 `docs/orca/*.md`
     （58 页，含 `8.1-integrated-browser-pane`）。
  2. 用 arch-diagram 分析 orca browser 模块骨架与两条提取路线，
     见 [`docs/orca/browser-module-analysis.md`](../../orca/browser-module-analysis.md)。
  3. 结论：orca 的「人工点选取元素」必须往页面注入 overlay 脚本
     （`executeJavaScript`），与本仓红线正面冲突；orca 的「Agent snapshot」
     走纯 CDP（`Accessibility.getFullAXTree`），可直接借用。
- **验证**：导出页数与目录索引一致；分析文档给出路线对比与取舍依据。
- **完成标准**：路线选择有依据，且不靠改红线实现。

## W6.1 元素提取策略纯模块

- **改动位置**：`plugins/browser/src/main/extraction.ts`。
- **实施**：
  1. 属性白名单（结构性属性 + 全部 `aria-*`；去掉 `src`）。
  2. 凭据形态脱敏（`access_token`/`api_key`/`client_secret`/`csrf`/`password`…）。
  3. URL 净化：仅 http/https，剥 query 与 hash。
  4. 长度预算（逐字段截断）与条目数上限。
  5. **CDP 方法白名单**：只含 DOM / Accessibility / Page 只读方法，
     **不含 `Runtime.*`**（等价于页面脚本执行）。
  6. 不可信输入解析：清单条数夹取、详情 ref 必须是 `el-<n>` 形态。
- **验证**：单测覆盖白名单、脱敏、URL 净化、预算、CDP 白名单红线。
- **完成标准**：策略在实现前固定，且可独立于 electron 测试。

## W6.2 CDP 提取器（只读域，不执行页面脚本）

- **改动位置**：`plugins/browser/src/main/extraction-cdp.ts`。
- **实施**：
  1. 元素清单：`Accessibility.getFullAXTree` 取 role/name，
     `DOM.getBoxModel` 取几何，按条数上限截断。
  2. 元素详情：`DOM.describeNode`（属性）、`DOM.getOuterHTML`（可见文本）、
     `DOM.getDocument`（结构选择器）、`Page.captureScreenshot`（区域截图）。
  3. 每次操作前临时 attach、操作后立刻 detach——CDP 通道不在会话期间常驻。
  4. renderer 不能指定 CDP 方法名，只能请求「列清单」「取详情」。
- **验证**：单测（策略侧）+ electron spike（真实页面取元素）。
- **完成标准**：能在真实页面取到元素，且全程无 `Runtime.*` 调用。

## W6.3 服务接线与窄通道

- **改动位置**：`plugins/browser/src/main/index.ts`（会话 + 引用表）、
  `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`。
- **实施**：
  1. 服务层维护 `ref → backendNodeId` 引用表：**只接受本会话最近一次清单里的 ref**，
     renderer 不能自造 id，也不能引用别的会话的元素。
  2. 页面导航后引用作废（旧 ref 不再指向新页面）。
  3. IPC 窄通道 `innate:browserExtractList` / `innate:browserExtractDetail`；
     preload 只暴露这两个方法，不暴露 CDP 方法名或脚本执行通道。
- **验证**：服务层单测（非法 ref、跨会话、导航后作废、端口异常转文案）。
- **完成标准**：renderer 无法越权引用元素。

## W6.4 面板交互

- **改动位置**：`plugins/browser/src/renderer/BrowserPanel.tsx`、`styles.css`。
- **实施**：
  1. 工具栏「提取元素」按钮 → 拉清单 → 渲染元素条目（角色 + 名称）。
  2. 点击条目 → 取详情 → 渲染详情卡片（标签/角色/名称/选择器/文本/属性/截图）。
  3. 失败一律呈现主进程给出的可展示文案，不渲染半成品。
- **验证**：面板单测覆盖清单、详情、失败、空清单与截图。
- **完成标准**：用户能在浏览器页完成一次完整「提取元素」。

## W6.5 端到端验收与红线断言

- **改动位置**：`tools/smoke-browser.ts`、证据。
- **实施**：
  1. 本地受控 HTTP 站增加 `/elements` 靶场（按钮/链接/文本框/凭据形态属性）。
  2. 真实宿主里验证：清单列出可交互元素、详情含标签与结构选择器、
     凭据形态属性脱敏为 `[redacted]`。
  3. 红线断言：渲染壳 `window.innate` 无页面脚本执行通道；
     browser 窄通道集合无脚本执行入口。
  4. 修复一处观察到的浏览器体验缺陷：回到浏览器页时统一中栏槽里活跃的
     可能是终端 Surface，导致浏览器页渲染出终端——改为页面聚焦**自己**
     的最近一个 Surface（浏览器页与终端页同处理）。
  5. 修复 smoke 断言对检出目录名的硬编码依赖（换 worktree 即误报）。
- **验证**：smoke-browser 28/28；全量门禁；W4/W5 回归。
- **完成标准**：提取元素在真实桌面可用，红线断言全绿。

## W6.6 browser 插件 IPC 契约（版本化、宿主中立）

- **改动位置**：`plugins/browser/src/shared/ipc.ts`（契约）、
  `plugins/browser/src/main/ipc.ts`（处理器工厂）、
  `apps/desktop/src/main/browser-ipc.ts`（宿主绑定）、
  `apps/desktop/src/main/ipc.ts`、`apps/desktop/src/preload/index.ts`、
  `docs/browser-plugin-ipc-contract.md`。
- **来源**：issue #11 追加要求——「当前 plugin browser 需要考虑 ipc 接口需要
  定义一下，可能会连接不同的 plugin，或者 desktop version」。
- **实施**：
  1. 契约归插件所有：通道名、方法签名、能力声明、版本号单一定义在
     `shared/ipc.ts`；桌面不再手写 `innate:browser*` 通道。
  2. 契约面：`BROWSER_IPC_CONTRACT`（版本 / 方法 / 通道 / 能力）+
     `BROWSER_IPC_METHOD_CAPABILITIES`（`network:navigate`、`surface:read`、
     `element:extract`）。
  3. 宿主注册面：`registerBrowserIpc(host, handlers)`——宿主只提供
     「按通道注册处理器」的机制（Electron ipcMain、MessagePort、RPC 皆可）；
     渲染侧 `createBrowserApi(transport)` 由契约构造 BrowserApi。
  4. 跨宿主接入：`createBrowserApiFromHandlers`（同进程直调）、
     `createBrowserApiFromInvoker`（跨进程按方法名分发）。
  5. 版本协商（fail closed）：宿主声明实现的契约版本；major 不一致或
     同 major 而宿主 minor 更低 → 拒绝注册，**不降级到部分通道**；
     `allow` 可裁剪暴露面。
  6. 红线入契约：契约内不含任何页面脚本执行通道，注册时与单测双重断言。
- **验证**：契约单测 18 项 + 处理器工厂单测 3 项 + 桌面接线单测 4 项
  （版本兼容 / 通道齐备且不新增 / 提取通道转发 / 红线复核）；
  真实桌面冒烟核对渲染壳 browser 窄通道集合 = 契约方法集。
- **完成标准**：宿主与插件之间只有一份契约；换宿主或换 desktop 版本时
  只需声明版本号，不复制通道映射；契约漂移可被自动化断言发现。

## W6.7 真实窗口复核：原生视图遮挡与按钮尺度

- **改动位置**：`apps/desktop/src/renderer/src/styles.css`、
  `plugins/browser/src/renderer/BrowserPanel.tsx`、`tools/smoke-browser.ts`。
- **来源**：issue #11 追加反馈——「点击新建浏览器没有任何反应」「放大按钮、
  新建浏览器按钮都太大，黑色太深」。
- **实施**：
  1. **原生视图遮挡（真缺陷）**：原生 `WebContentsView` 永远画在渲染层之上，
     而 `.surface-view-area` 原是 `position:absolute; inset:0`——铺满整个
     `.surface-view`，于是原生视图盖住地址栏、提示行与提取面板。新建的浏览器
     初始是 `about:blank`（白屏），地址栏又被盖住，**看起来就是「点了没反应」**。
     修复：browser 的视图区改为 flex 流内的剩余空间
     （`.browser-surface .surface-view-area { position: relative; flex: 1 }`），
     地址栏与面板在上、原生视图在下。
     附：新建的空白浏览器自动聚焦地址栏，用户可直接输入地址。
  2. **按钮尺度**：`新建浏览器 / 新建终端` 从近黑实心块改为浅底 + 细边框
     （`.terminal-toolbar button.primary`），尺寸同步收小；窗口控件
     （最小化/最大化/关闭）从 46×36 收窄到 32×28，titlebar 占位同步收窄
     （`--window-controls-width: 138px → 96px`）。
  3. **可核查性**：新增真实窗口截图（OS 级抓屏，含原生视图——CDP 截图拍不到
     原生视图层）到 `docs/susu/plan/evidence/W6/live/`；smoke 新增回归断言
     「原生视图区在地址栏之下」。
- **验证**：单元测试 browser 131/131、desktop 136/136；smoke-browser 30/30；
  真实窗口截图确认地址栏、提取面板与页面三者同时可见。
- **完成标准**：新建浏览器后地址栏立即可见可用；按钮尺度与壳内其它控件一致。

## 阶段回退

移除 browser 的两个提取窄通道与面板入口即可回到 W5 基线；
提取能力是纯增量，不改动导航、权限、下载与布局策略。
