# S12 · W6 浏览器元素提取（源编号 W6.0–W6.5）

## T12.1 W6.0 orca browser 研究归档与 arch-diagram 分析
- **状态**：done
- **做什么**：deepwiki.com/stablyai/orca 全量导出为 `docs/orca/*.md`（58 页 + 索引）；产出 `docs/orca/browser-module-analysis.md`（orca 五层结构图、两条提取路线时序图、7 条安全设计、本仓现状图、路线对比与取舍）。
- **功能**：路线选择有据——不抄 orca 的「注入 overlay 脚本」路线，走纯 CDP 只读域。
- **如何验证**：导出页数与导航一致；分析文档含 arch-diagram 与取舍结论。
- **预估 / 依赖**：0.5 天 / 需 S7
- **完成于**：2026-11-02

## T12.2 W6.1 提取策略纯模块
- **状态**：done
- **做什么**：`plugins/browser/src/main/extraction.ts`——属性白名单（去 `src`）、凭据形态脱敏、URL 净化（剥 query/hash）、长度预算、CDP 方法白名单（**不含 `Runtime.*`**）、不可信输入解析（条数夹取、ref 形态校验）。
- **功能**：安全默认值在实现前固定。
- **如何验证**：单测覆盖白名单、脱敏、净化、预算与 CDP 白名单红线（24/24）。
- **预估 / 依赖**：0.5 天 / T12.1
- **完成于**：2026-11-02

## T12.3 W6.2 CDP 提取器（只读域）
- **状态**：done
- **做什么**：`plugins/browser/src/main/extraction-cdp.ts`——AX 清单（`Accessibility.getFullAXTree`）、几何（`DOM.getBoxModel`）、属性（`DOM.describeNode`）、可见文本（`DOM.getOuterHTML`）、结构选择器（`DOM.getDocument`）、区域截图（`Page.captureScreenshot`）；操作前后临时 attach/detach。
- **功能**：真实页面能取到元素，且全程零页面脚本执行。
- **如何验证**：策略单测 + 真实桌面端到端。
- **预估 / 依赖**：1 天 / T12.2
- **完成于**：2026-11-02

## T12.4 W6.3 服务接线与窄通道
- **状态**：done
- **做什么**：`BrowserSurfaceService.extractList/extractDetail` + 会话引用表（只认本会话最近一次清单的 ref，导航后作废）；`innate:browserExtractList`/`innate:browserExtractDetail` 两个 IPC 窄通道与 preload 方法。
- **功能**：renderer 无法越权引用元素。
- **如何验证**：服务层单测（非法 ref、跨会话、导航作废、端口异常转文案）。
- **预估 / 依赖**：0.5 天 / T12.3
- **完成于**：2026-11-02

## T12.5 W6.4 面板交互
- **状态**：done
- **做什么**：`BrowserPanel` 工具栏「提取元素」按钮 → 元素清单（角色+名称）→ 详情卡片（标签/角色/名称/选择器/文本/属性/可选截图）+ 对应样式。
- **功能**：用户能在浏览器页完成一次完整提取。
- **如何验证**：面板单测覆盖清单、详情、失败、空清单与截图（19/19）。
- **预估 / 依赖**：0.5 天 / T12.4
- **完成于**：2026-11-02

## T12.6 W6.5 端到端验收与红线断言
- **状态**：done
- **做什么**：`tools/smoke-browser.ts` 新增 `/elements` 靶场与 5 项断言；修复两处观察到的既有缺陷（页面聚焦自己的最近一个 Surface；smoke 断言不硬编码检出目录名）。
- **功能**：W6 出口——提取元素在真实桌面可用，红线断言全绿。
- **如何验证**：smoke-browser 28/28；browser 110/110、desktop 132/132；全仓 typecheck 与 check:typescript 绿。
- **预估 / 依赖**：0.5 天 / T12.5
- **完成于**：2026-11-02

## T12.7 W6.6 browser 插件 IPC 契约
- **状态**：done
- **做什么**：契约归插件所有——`plugins/browser/src/shared/ipc.ts` 单一定义通道名、方法签名、能力声明与版本（1.0）；主进程 `registerBrowserIpc(host, handlers)`、渲染侧 `createBrowserApi(transport)` 两个宿主中立接入面；另有进程内直调与跨进程 RPC 两个适配器。桌面新增 `apps/desktop/src/main/browser-ipc.ts` 声明 `DESKTOP_BROWSER_IPC_VERSION` 并注册，`main/ipc.ts` 收编 8 条通道，`preload/index.ts` 改为由契约构造 BrowserApi。版本不兼容即拒绝注册（fail closed，不降级到部分通道）；红线（契约内无脚本执行通道）由注册时与单测双重断言。
- **功能**：换宿主或换 desktop 版本时只需声明版本号，不复制通道映射；契约漂移可被自动化断言发现。
- **如何验证**：契约单测 18 项 + 处理器工厂 3 项 + 桌面接线 4 项；真实桌面冒烟核对渲染壳 browser 窄通道集合 = 契约方法集；契约文档 `docs/browser-plugin-ipc-contract.md`。
- **预估 / 依赖**：0.5 天 / T12.6
- **完成于**：2026-11-02

## T12.8 W6.7 真实窗口复核：原生视图遮挡与按钮尺度
- **状态**：done
- **做什么**：OS 级抓屏复核真实窗口，发现并修复真缺陷——原生 `WebContentsView` 画在渲染层之上，而视图区绝对定位铺满整个面板，导致原生视图盖住地址栏与提取面板，新建浏览器（初始 about:blank 白屏）看起来「点了没反应」。修复：browser 视图区改为流内剩余空间；新建空白浏览器自动聚焦地址栏；`新建浏览器/新建终端` 由近黑实心改为浅底细边框并收小；窗口控件 46×36 → 32×28。
- **功能**：新建浏览器后地址栏立即可见可用；提取结果与页面同屏可见。
- **如何验证**：真实窗口截图 `evidence/W6/live/05-window-native.png`；smoke 新增回归断言「原生视图区在地址栏之下」；browser 131/131、desktop 136/136；smoke-browser 30/30。
- **预估 / 依赖**：0.5 天 / T12.7
- **完成于**：2026-11-02
