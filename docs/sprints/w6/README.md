---
schemaVersion: 1.0.0
id: sprint-w6
title: W6：浏览器元素提取（提取元素）
createdAt: 2026-11-02T04:00:00.000Z
updatedAt: 2026-11-02T12:00:00.000Z
status: done
repository: qdriven/innate-desktop
sourceKind: file
sourcePath: docs/susu/plan/phases/W6-browser-extraction.md
issueNumber: "11"
issueUrl: https://github.com/qdriven/innate-desktop/issues/11
issueState: open
issueTitle: 请合并当前项目的所有分支
issueUpdatedAt: 2026-11-02T00:00:00.000Z
---

## 任务上下文

### 问题

受控浏览器（W5）能导航、能下载、能拒绝权限，但**取不到页面里的元素**：
Agent 与人都无法把「页面上的某个按钮/输入框」作为上下文拿进来。
issue #11 要求 review 浏览器效果并补上**提取元素**，同时把
deepwiki/stablyai/orca 的 browser 内容落成 markdown 归档并做模块分析。

### 目标

在不放宽 W5 红线（无 `executeJavaScript`、renderer 只拿安全字段）的前提下，
用**纯 CDP 只读域**实现元素提取：清单 + 详情 + 属性白名单脱敏 + 结构选择器 +
可选区域截图；并完成 orca 研究的归档与 arch-diagram 分析。

### 范围

- orca deepwiki 全量导出到 `docs/orca/` + arch-diagram 模块分析
- 提取策略纯模块（白名单/脱敏/预算/CDP 方法白名单）
- CDP 提取器（AX 清单 + DOM 详情 + 区域截图）
- 服务层引用表 + IPC/preload 窄通道
- 面板交互（提取按钮 + 元素清单 + 详情卡片）
- 端到端验收与红线断言
- browser 插件 IPC 契约（版本化、宿主中立）+ 桌面按契约接入

### 非目标

- 不抄 orca 的「往页面注入 overlay 脚本」路线（与本仓红线冲突）
- 不做对外 CDP WebSocket 代理（orca 的 `CdpWsProxy`，超出当前产品面）
- 不做系统浏览器 cookie 导入（与隔离设计相悖）
- 不做多浏览器 profile 分区（v2 再议）
- 不改导航/权限/下载/布局策略

### 依赖

W5 全绿（已 done）。

### 假设

- Electron 43 的 `webContents.debugger` 可对 `WebContentsView` 附加 CDP
- 本地受控 HTTP 靶场足以覆盖元素提取的真实链路

### 未决问题

- 区域截图目前是可选增强（超预算即省略）；是否要独立预算策略待 v1.2 议
- 提取结果如何交给 Agent（Q3 的 capability 路由）不在本 Sprint

## 全局上下文

### 摘要

innate-desktop 唯一前向仓；plan（docs/susu/plan/）为执行源；本 Sprint 为
W6 浏览器元素提取的拆解与实施单元。W5 已交付受控 browser Surface。

### 来源

- docs/susu/plan/phases/W6-browser-extraction.md
- docs/susu/plan/phases/W5-browser.md
- docs/susu/plan/README.md
- issue #11

### 约束

- 一 task 一提交；并发协作协议见 plan README §5 第 7 条
- 测试基线只增不减；认证信息不进证据
- **红线**：browser 视图抽象不得出现页面脚本执行通道

### 全局更新

- 需要：否
- 计划：收口时回写 plan README §4 与投影

## 设计影响

### 是否受影响

否（纯增量：新增提取窄通道，不改导航/权限/下载/布局语义）

### 现状行为

browser Surface 只能导航与呈现；页面元素对壳层不可见。

### 目标行为

面板可拉出页面元素清单并逐个查看详情（结构选择器、可见文本、白名单属性、
可选区域截图）；提取全程不执行页面脚本。

### 决策

1. **走纯 CDP，不抄 orca 的注入脚本路线**——本仓红线明确「视图抽象不提供
   任何页面脚本执行通道」，orca 的 AI Grab 必须注入 overlay 脚本；
   路线对比与依据见 `docs/orca/browser-module-analysis.md`。
2. **CDP 方法白名单不含 `Runtime.*`**——`Runtime.evaluate` 等价于脚本执行。
3. **不透明 ref 绑定会话**——renderer 只能引用主进程刚签发的元素，
   不能自造 id、不能跨会话。
4. **属性白名单 + 凭据形态脱敏 + URL 净化 + 长度预算**——直接沿用 orca
   `GRAB_BUDGET` / `GRAB_SAFE_ATTRIBUTE_NAMES` / `GRAB_SECRET_PATTERNS` 的
   思路，但去掉 `src`、去掉宽泛词匹配。
5. **IPC 契约归插件，不归宿主**——通道名与签名单一定义在
   `plugins/browser/src/shared/ipc.ts`；桌面只声明自己实现的契约版本，
   版本不兼容即拒绝注册（fail closed，不降级到部分通道）；契约内无脚本
   执行通道，由注册时与单测双重断言。

### 风险

- CDP attach 可能与 DevTools 冲突（用户打开 DevTools 时提取失败）——
  失败转可展示文案，不影响浏览。
- AX 树在超大页面上较重——按条数上限（默认 50，上限 100）截断。
- 页面导航后旧元素引用失效——已在服务层作废并要求重新列清单。

### 全局影响

无

## 分解任务

- T1 task-local-w6-1-extraction.md — W6 元素提取（研究 + 策略 + CDP + 接线 + 面板 + 验收）
- T2 task-local-w6-2-ipc-contract.md — W6.6 browser 插件 IPC 契约（版本化、宿主中立）

## Spec 关联

- S1 [none] docs/susu/plan/phases/W6-browser-extraction.md — Sprint 级验收定义

## 交付记录

- 2026-11-02 **done**：W6.0–W6.5 全部完成。
  - **W6.0 研究**：deepwiki.com/stablyai/orca 全量导出为 `docs/orca/*.md`
    （58 页 + 索引 README），arch-diagram 分析见
    `docs/orca/browser-module-analysis.md`（orca browser 五层骨架、两条提取
    路线时序图、orca 的 7 条安全设计、本仓现状图与差距表）。
  - **W6.1 策略**：`plugins/browser/src/main/extraction.ts`——属性白名单、
    凭据脱敏、URL 净化、长度预算、CDP 方法白名单（无 `Runtime.*`）、
    不可信输入解析。单元测试 24/24。
  - **W6.2 CDP**：`plugins/browser/src/main/extraction-cdp.ts`——AX 清单 +
    `DOM.getBoxModel` 几何 + `DOM.describeNode` 属性 + `DOM.getOuterHTML`
    可见文本 + `DOM.getDocument` 结构选择器 + `Page.captureScreenshot`
    区域截图；操作前后临时 attach/detach。
  - **W6.3 接线**：服务层 `extractList`/`extractDetail` + 会话引用表
    （只认本会话最近一次清单、导航后作废）+ `innate:browserExtractList`/
    `innate:browserExtractDetail` 两个窄通道 + preload 两个方法。
    服务层单测 41/41（含 9 项提取专项）。
  - **W6.4 面板**：`BrowserPanel` 工具栏「提取元素」按钮 → 元素清单 →
    详情卡片（标签/角色/名称/选择器/文本/属性/截图）+ 样式。面板单测 19/19。
  - **W6.5 验收**：`tools/smoke-browser.ts` 新增 `/elements` 靶场与 5 项断言
    （清单、详情+选择器、凭据属性脱敏、渲染壳无页面脚本执行通道、
    browser 窄通道无脚本执行入口）——**28/28 全绿**。
    另修两处观察到的缺陷：① 回到浏览器页时统一中栏槽里活跃的可能是终端
    Surface（浏览器页渲染出终端）→ 页面改为聚焦自己的最近一个 Surface
    （浏览器页与终端页同处理）；② smoke 断言硬编码检出目录名（换 worktree
    即误报）→ 改为只断言「已加载一个根目录」。
  - 全量门禁：browser 110/110、desktop 132/132、全仓 typecheck 绿、
    `check:typescript` 通过。model-gateway 的 6 项失败为**既有失败**
    （需真实 magpie 二进制，已在基线复现），与本 Sprint 无关。
  - 证据见 `docs/susu/plan/evidence/W6/extraction.md`。

- 2026-11-02 **done**：W6.6 browser 插件 IPC 契约（issue #11 追加要求
  「当前 plugin browser 需要考虑 ipc 接口需要定义一下，可能会连接不同的
  plugin，或者 desktop version」）。
  - **契约归插件**：`plugins/browser/src/shared/ipc.ts` 单一定义 8 个调用方法
    + 1 个事件通道、方法签名、能力声明（`network:navigate` /
    `surface:read` / `element:extract`）与契约版本 `1.0`；桌面不再手写
    `innate:browser*` 通道。
  - **宿主中立双侧接入面**：主进程 `registerBrowserIpc(host, handlers)`
    （宿主只提供「按通道注册处理器」的机制）；渲染侧 `createBrowserApi(transport)`
    由契约构造 BrowserApi；另有 `createBrowserApiFromHandlers`（同进程直调）
    与 `createBrowserApiFromInvoker`（跨进程按方法名分发）两个跨宿主适配器。
  - **版本协商 fail closed**：宿主声明实现的契约版本；major 不一致或宿主
    minor 更低即拒绝注册，不降级到部分通道；`allow` 可裁剪暴露面。
  - **红线入契约**：契约内无任何页面脚本执行通道，注册时与单测双重断言。
  - 验收：契约单测 18 项 + 处理器工厂 3 项 + 桌面接线 4 项；browser 131/131、
    desktop 136/136；smoke-browser 新增「渲染壳 browser 窄通道集合 = 契约
    方法集」的一致性断言。
  - 契约文档：`docs/browser-plugin-ipc-contract.md`。
  - 证据见 `docs/susu/plan/evidence/W6/extraction.md`。

- 2026-11-02 **done**：W6.7 真实窗口复核（issue #11 追加反馈「点击新建浏览器没有
  任何反应」「放大按钮、新建浏览器按钮都太大，黑色太深」）。
  - **发现真缺陷**：原生 `WebContentsView` 画在渲染层之上，而视图区
    `position:absolute; inset:0` 铺满整个面板——原生视图盖住地址栏与提取
    面板；新建浏览器初始是 `about:blank` 白屏且地址栏被盖，**看起来就是
    「点了没反应」**。此前的证据截图拍不到这一层（CDP 只拍渲染进程）。
  - **修复**：browser 视图区改为 flex 流内剩余空间；新建的空白浏览器自动
    聚焦地址栏；`新建浏览器/新建终端` 由近黑实心改为浅底细边框并收小；
    窗口控件 46×36 → 32×28（titlebar 占位 138px → 96px）。
  - **验收方式升级**：改用 OS 级抓屏拍真实窗口（含原生视图层），
    证据 `docs/susu/plan/evidence/W6/live/05-window-native.png`；
    smoke 新增回归断言「原生视图区在地址栏之下」；smoke-browser 30/30。

## 来源原文

### 本地文件：docs/susu/plan/phases/W6-browser-extraction.md

> （本 Sprint 自建卡：来源为 issue #11 的「优化浏览器效果 + 增加提取元素」
> 与 deepwiki/stablyai/orca 研究要求。）

### Issue

> https://github.com/qdriven/innate-desktop/issues/11
>
> 1. 请合并当前项目的所有分支
> 2. 合并之后启动进行观察
> 3. 开始 review 当前项目，考虑如何优化浏览器效果，需要增加
>    1. 提取元素
>    2. 从 deepwiki/stablyai/orca 上面去了解关于 orca browser 这部分内容
>    3. download deepwiki/stablyai/orca 的内容，全部变成 markdown 文件，保留到 docs/orca 目录
>    4. 同时进行分析模块的重点，使用 arch-diagram 分析
