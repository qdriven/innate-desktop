# W6 证据：浏览器元素提取（提取元素）

日期：2026-11-02 · 对应 issue [#11](https://github.com/qdriven/innate-desktop/issues/11) ·
Sprint 记录 [`docs/sprints/w6/README.md`](../../../sprints/w6/README.md) ·
计划卡 [`docs/susu/plan/phases/W6-browser-extraction.md`](../../phases/W6-browser-extraction.md)

---

## 1. orca 研究归档（W6.0）

### 1.1 deepwiki 全量导出

deepwiki 的页面把整份 wiki 嵌在 Next.js RSC flight 流里（每个页面是一个
`T<hexlen>,<markdown>` 文本行）。导出脚本据此解析，一次页面加载即取全部页面。

| 项 | 值 |
| --- | --- |
| 来源 | <https://deepwiki.com/stablyai/orca> |
| 导出页数 | **58 页**（侧栏导航全量，含 12 个顶层节 + 46 个子页） |
| 落盘 | `docs/orca/*.md`（每页一个文件，文件名沿用 deepwiki slug） |
| 索引 | `docs/orca/README.md`（页面清单 + 标题 + 原始 URL） |
| 文件头 | YAML frontmatter：`title` / `source` / `section` / `depth` / `retrieved` |
| 正文处理 | 去掉页首「Relevant source files」清单，保留正文与页尾 Sources |
| 浏览器相关页 | `8-browser-pane-and-ai-agent-features.md`、`8.1-integrated-browser-pane.md` |

> 抓取说明：deepwiki 对无浏览器 UA 的请求返回 Vercel 安全校验页（HTTP 429 +
> "This request requires a challenge"）。导出脚本带常规浏览器 UA 并带退避重试，
> 命中则退避重来；页面缓存到本地，重跑不重复请求。

### 1.2 arch-diagram 分析

`docs/orca/browser-module-analysis.md` 给出：

- orca browser 的**五层结构图**（BrowserManager / BrowserSessionRegistry /
  BrowserPane / AgentBrowserBridge+CdpWsProxy / grab guest script）；
- **两条提取路线的时序图**：
  - 路径 A「Agent snapshot」——纯 CDP `Accessibility.getFullAXTree`，**不执行页面脚本**；
  - 路径 B「人工 AI Grab」——`executeJavaScript` 注入 overlay 脚本后点选元素；
- orca grab 路径的 **7 条安全设计**（属性白名单、凭据形态脱敏、URL 净化、
  guest+main 双层校验、长度预算、调用方授权、计算样式白名单）；
- 本仓 browser 现状 **arch-diagram** 与差距表；
- **三路线对比**（甲：注入脚本 / 乙：CDP `DOM.getNodeForLocation` / 丙：AX 清单）
  与取舍结论。

**结论**：路径 B 与本仓红线（`plugins/browser/src/main/index.ts`：
「视图抽象不提供任何页面脚本执行通道」）正面冲突，**不抄**；本仓走纯 CDP 路线，
沿用 orca 的安全设计（白名单 / 脱敏 / 净化 / 预算 / 双层校验）。

---

## 2. 提取能力实现（W6.1–W6.4）

### 2.1 落地形态

```text
innate-dogic/plugins/browser/src/
├─ shared/extraction.ts        新增：主进程与 renderer 共用的提取契约
├─ main/extraction.ts          新增：策略纯模块（白名单/脱敏/预算/CDP 白名单）
├─ main/extraction-cdp.ts      新增：CDP 提取器（只读域）
├─ main/index.ts               修改：服务层 extractList/extractDetail + 会话引用表
├─ main/electron-view.ts       修改：视图挂载提取端口
├─ shared/index.ts             修改：BrowserApi 增加两个窄通道
└─ renderer/BrowserPanel.tsx   修改：「提取元素」按钮 + 元素清单 + 详情卡片

innate-dogic/apps/desktop/src/
├─ main/ipc.ts                 修改：innate:browserExtractList / innate:browserExtractDetail
├─ preload/index.ts            修改：browserExtractList / browserExtractDetail
├─ renderer/src/BrowserPage.tsx    修改：页面聚焦自己的最近一个 Surface
├─ renderer/src/TerminalPage.tsx   修改：同上
└─ renderer/src/styles.css     修改：元素清单与详情卡片样式
```

### 2.2 取数路径（全程零页面脚本）

| 用途 | CDP 方法 | 域 |
| --- | --- | --- |
| 元素清单（角色/名称） | `Accessibility.enable`、`Accessibility.getFullAXTree` | 只读 |
| 元素几何 | `DOM.enable`、`DOM.getBoxModel` | 只读 |
| 元素属性 | `DOM.describeNode` | 只读 |
| 可见文本 | `DOM.getOuterHTML` | 只读 |
| 结构选择器 | `DOM.getDocument` | 只读 |
| 区域截图 | `Page.enable`、`Page.getLayoutMetrics`、`Page.captureScreenshot` | 只读 |

白名单常量 `BROWSER_EXTRACTION_CDP_METHODS` 只含上表方法；
**不含 `Runtime.*`**（`Runtime.evaluate` 等价于页面脚本执行），
也不含 `Page.navigate` / `Input.*` 等有副作用的方法。
renderer 不能指定方法名，只能请求「列清单」或「取详情」。

### 2.3 安全规则（对齐 orca，更严）

| 规则 | 本仓取值 | orca 取值 |
| --- | --- | --- |
| 属性白名单 | 结构性属性 + 全部 `aria-*`，**去掉 `src`** | 同款但保留 `src` |
| 凭据形态脱敏 | `access_token`/`api_key`/`client_secret`/`oauth_state`/`session_id`/`csrf`/`secret`/`password`/`passwd`… | 同款 |
| 宽泛词 | 不匹配 `code`/`state`（会误伤普通 CSS class） | 同款 |
| URL 净化 | 仅 http/https，剥 query 与 hash | 同款 |
| 长度预算 | 文本 200B / 选择器 700B / 路径 900B / 属性 24 项 / 元素 100 项 | 同款（更严的 class 上限 200B） |
| 双层校验 | CDP 返回值钳制一次 + main 边界再钳制一次 | 同款 |
| 引用绑定 | 不透明 `el-<n>` ref 绑定会话，只认本会话最近一次清单 | orca 用 backendDOMNodeId |

### 2.4 会话引用表（防越权）

- 清单成功后，服务层记录 `ref → backendNodeId`；
- 详情请求的 ref 必须命中该表，否则拒绝并提示「重新列出元素」；
- 页面导航（`navigated` 事件）后引用作废——旧 ref 不再指向新页面；
- 会话关闭时随会话一并丢弃。

---

## 3. 验证结果

### 3.1 单元测试

| 套件 | 命令 | 结果 | 基线 |
| --- | --- | --- | --- |
| 提取策略（新增） | `vitest run src/main/extraction.test.ts` | **24/24** | — |
| browser 服务层 | `vitest run src/main/index.test.ts` | **41/41**（含 9 项提取专项） | 32 |
| browser 包合计 | `vitest run` | **131/131**（含契约 18 项 + 处理器工厂 3 项） | 76 |
| desktop 面板（浏览器页） | `vitest run src/renderer/src/surfaces/providers/browser.test.tsx` | **19/19**（含 6 项提取专项） | 13 |
| desktop 包合计 | `vitest run` | **136/136**（含桌面接线 4 项） | 100 |

提取策略单测覆盖：URL 净化（query/hash 剥除、非 http(s) 清空）、
属性白名单与 `aria-*` 放行、凭据形态脱敏、href/action 净化、
class 与属性条目上限、**CDP 白名单不含 `Runtime.*`**（红线）、
ref 互逆与非法 ref 拒绝、清单条数夹取、摘要/详情钳制、
非 PNG 或超预算截图丢弃。

服务层提取专项覆盖：视图无端口时明确拒绝、清单 URL 剥 query、条数上限与
回落、详情只认清单 ref、未列清单即拒绝、非法 ref 文案、会话不存在、
**导航后引用作废**、端口异常转可展示文案（不抛到 IPC 层）、
**视图抽象无 `executeJavaScript`（类型层红线断言）**。

### 3.2 端到端（真实 Electron 宿主 + 本地受控 HTTP 靶场）

`tools/smoke-browser.ts` 新增 `/elements` 靶场（按钮 / 链接 / 文本框 /
带凭据形态属性 `name="api_key"` 的输入框）与 5 项断言。

```text
[smoke-browser] ✓ 元素提取：清单列出页面可交互元素（角色+名称） — elements（heading） … 提交订单（button） 使用说明（link） … 令牌（textbox） 密码（textbox）
[smoke-browser] ✓ 元素提取：详情含标签与结构选择器 — 标签 button 选择器 html > body > button 文本 提交订单 id submit-btn type button
[smoke-browser] ✓ 元素提取：凭据形态属性脱敏为 [redacted] — 标签 input 选择器 html > body > input:nth-of-type(1) id pwd type text name [redacted] placeholder 令牌
[smoke-browser] ✓ 红线：渲染壳 window.innate 无页面脚本执行通道 — 共 54 个通道（processExecute 为 terminal 受控能力）
[smoke-browser] ✓ 红线：browser 窄通道集合无脚本执行入口 — browserNavigate,browserBack,browserForward,browserReload,browserStop,browserState,browserOnEvent,browserExtractList,browserExtractDetail
```

**smoke-browser 28/28 全绿**（基线 23/23；新增 5 项断言全部通过）。
W6.6 追加契约一致性断言后为 **29/29**（见 §3.5.6）。
证据产物：`docs/susu/plan/evidence/W5/e2e/browser-extraction.png`、
`smoke-browser.json`（`{"passed":28,"failed":0,"failedNames":[]}`）。

> 注：`processExecute` 是 W4 terminal 的受控 `process:execute` 能力
> （profile 白名单 + 审计脱敏），独立于浏览器，**不是**页面脚本执行通道；
> 红线断言按此精确区分，不做宽泛正则误报。

### 3.3 全量门禁

```text
pnpm build            → 全包构建通过
pnpm -r typecheck     → 全包 typecheck 通过（14 个包 Done）
pnpm exec tsc -p tools/tsconfig.json --noEmit → No errors found
pnpm check:typescript → ✓ 产品源码与工具均为 TypeScript
pnpm -r test          → browser 131/131、desktop 136/136、workspace 55/55、
                        core 44/44、kernel 28/28、sdk 9/9、services/model-gateway 8/8、
                        theme 10/10、syntax-highlighting 3/3、project-canvas 4/4
```

`pnpm verify` 退出码为 1，**唯一失败项**是
`innate-dogic/plugins/model-gateway` 的 6 项 `MagpieCli (real binary)` 测试
（需真实 magpie 二进制，本机未就绪）。该失败在**改动前的基线上完全一致**
（已用 `git stash` 剥离本 Sprint 改动复跑确认，失败集合相同），与本次工作无关。
`plugins/terminal` 的 node-pty 测试在本沙箱因 `AttachConsole failed` 无法运行，
同为环境限制。

### 3.4 观察中发现的两个既有缺陷（本次一并修复）

1. **回到浏览器页渲染出终端**（W6.5 期间发现）：
   统一中栏槽里活跃的 Surface 可能是别的页面的（如终端页建过终端），
   此时浏览器页的 `focusId` 落空，`SurfaceSlot` 回落渲染活跃项——浏览器页
   里出现的是终端；随后的地址栏操作全部落空。
   修复：页面改为聚焦**自己**的最近一个 Surface（浏览器页与终端页同处理），
   `SurfaceSlot` 的 `focusId` 语义（“当前页面期望展示的 Surface”）由此坐实。
2. **smoke 断言硬编码检出目录名**：
   `smoke-browser` 断言终端工作区根匹配 `/innate-desktop|implement-w4-w5/`，
   换 worktree 检出即误报（本次检出为 `issue-11`）。
   修复：改为只断言「已加载一个根目录」，不绑定目录名。

修复前后的 smoke-browser 对比（同一环境）：

| | 基线 | 修复后 |
| --- | --- | --- |
| 通过 | 20/23 | **28/28** |
| 失败 | 交替切换×2、便携检查×1 | 无 |

---

## 3.5 browser 插件 IPC 契约（W6.6）

### 3.5.1 问题与解法

browser 的 IPC 通道原先散落在桌面宿主源码里（`apps/desktop/src/main/ipc.ts` 与
`preload/index.ts` 各写一遍字符串），插件本身没有对外接口定义。插件一旦被
**别的插件**或**另一个 desktop 版本**消费，就没有可依据的接入点：宿主只能抄
通道名，抄错无从发现，插件升级也会静默漂移。

解法：**契约归插件，不归宿主**。通道名、方法签名、能力声明与版本号单一定义
在 `plugins/browser/src/shared/ipc.ts`；桌面只声明自己实现的契约版本。

```text
innate-dogic/plugins/browser/src/
├─ shared/ipc.ts               新增：IPC 契约（通道/签名/能力/版本/红线）
└─ main/ipc.ts                 新增：契约 → 服务层的处理器工厂

innate-dogic/apps/desktop/src/
├─ main/browser-ipc.ts         新增：宿主绑定（声明版本 + 注册到 ipcMain）
├─ main/ipc.ts                 修改：8 条 innate:browser* 通道收编为契约注册
└─ preload/index.ts            修改：BrowserApi 改由契约构造

docs/browser-plugin-ipc-contract.md   新增：契约文档
```

### 3.5.2 契约清单（v1.0）

| 方法 | 通道 | 能力 |
| --- | --- | --- |
| `navigate` / `back` / `forward` / `reload` / `stop` | `innate:browser{Navigate,Back,Forward,Reload,Stop}` | `network:navigate` |
| `state` | `innate:browserState` | `surface:read` |
| `extractList` | `innate:browserExtractList` | `element:extract` |
| `extractDetail` | `innate:browserExtractDetail` | `element:extract` |
| （事件推送） | `innate:browser-event` | — |

### 3.5.3 宿主中立接入面

| 侧 | 入口 | 宿主实现的东西 |
| --- | --- | --- |
| 主进程 | `registerBrowserIpc(host, createBrowserIpcHandlers(service))` | 「按通道注册处理器」的机制（Electron ipcMain / MessagePort / RPC 皆可） |
| 渲染 | `createBrowserApi(transport)` | 传输（`ipcRenderer.invoke` / 进程内直调 / 跨插件 RPC） |
| 同进程直调 | `createBrowserApiFromHandlers(handlers)` | 无需传输 |
| 跨进程 RPC | `createBrowserApiFromInvoker(invoker)` | 按方法名分发 |

### 3.5.4 版本协商（fail closed）

宿主声明实现的契约版本（桌面：`DESKTOP_BROWSER_IPC_VERSION = '1.0'`）：

| 宿主版本 | 对契约 `1.0` | 结论 |
| --- | --- | --- |
| `1.0` / `1.7` | 兼容 | 同 major 且宿主 minor ≥ 契约 minor |
| `0.9` | 不兼容 | 宿主太旧，缺契约方法 → **拒绝注册** |
| `2.0` | 不兼容 | 宿主 major 更高，通道语义未知 → **拒绝注册** |
| 不可解析 | 不兼容 | 视为不兼容 |

不兼容即抛错，**不做部分通道降级**——降级会让不同宿主行为不一致。

### 3.5.5 红线入契约

契约内不含任何页面脚本执行通道（无 `executeJavaScript` / `eval` / `Runtime.*`
/ CDP 方法名入口）；`assertNoScriptChannel()` 在**注册时**与**单测中**双重强制。

### 3.5.6 验证

| 套件 | 结果 |
| --- | --- |
| `plugins/browser/src/shared/ipc.test.ts`（新增） | **18/18**：清单固定、通道唯一、能力声明、通道反查、版本矩阵、注册面（默认/裁剪/拒绝契约外方法）、渲染侧出口、进程内直调、RPC 分发、红线断言 |
| `plugins/browser/src/main/ipc.test.ts`（新增） | **3/3**：方法↔能力映射、不可信输入透传、`state` 的 null 语义 |
| `apps/desktop/src/main/ipc.test.ts`（扩展） | **8/8**（新增 4 项）：版本兼容、契约通道全部注册且不新增、提取通道转发、红线复核 |
| browser 包合计 | **131/131**（基线 110） |
| desktop 包合计 | **136/136**（基线 132） |

真实桌面冒烟新增一致性断言（渲染壳暴露面 = 契约方法集，无漂移）：

```text
[smoke-browser] ✓ 契约：渲染壳 browser 窄通道与插件契约方法集一致 — browserBack,browserExtractDetail,browserExtractList,browserForward,browserNavigate,browserOnEvent,browserReload,browserState,browserStop
```

**smoke-browser 29/29 全绿**（W6.5 时为 28/28，新增 1 项契约一致性断言）。

契约文档：[`docs/browser-plugin-ipc-contract.md`](../../../browser-plugin-ipc-contract.md)。

---

## 4. 未做与后续

| 项 | 原因 | 计划 |
| --- | --- | --- |
| 提取结果交给 Agent | 需要 Q3 的 capability 路由 | Q3 |
| 人工「截图点选」交互（orca 的 AI Grab 体验） | 需在页面注入 overlay 脚本，与本仓红线冲突 | v1.2 另立评审（可考虑截图 + `DOM.getNodeForLocation` 的无脚本替代） |
| 区域截图的独立预算策略 | 当前超 2MB 即省略 | v1.2 议 |
| 多浏览器 profile 分区 | 超出本次范围 | v2 议 |
| 对外 CDP WebSocket 代理（orca `CdpWsProxy`） | 等于放开整条 CDP 面，超出产品面 | 不做 |

## 5. 复现命令

```bash
# 单元测试
cd innate-dogic/plugins/browser && npx vitest run src/main/extraction.test.ts src/main/index.test.ts
cd innate-dogic/apps/desktop && npx vitest run src/renderer/src/surfaces/providers/browser.test.tsx

# 端到端（需先构建 desktop）
pnpm --filter @dogic/desktop build
npx tsx tools/smoke-browser.ts

# 全量门禁
pnpm build && pnpm verify
```
