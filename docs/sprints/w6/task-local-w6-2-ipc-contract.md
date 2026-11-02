---
schemaVersion: 1.0.0
id: task-local-w6-2-ipc-contract
title: W6.6 browser 插件 IPC 契约（版本化、宿主中立）
createdAt: 2026-11-02T12:40:00.000Z
updatedAt: 2026-11-02T13:10:00.000Z
status: done
branch: qdriven/issue-11
repository: qdriven/innate-desktop
sourceKind: local
sourcePath:
issueNumber: "11"
issueUrl: https://github.com/qdriven/innate-desktop/issues/11
issueState: open
issueTitle: 请合并当前项目的所有分支
issueUpdatedAt: 2026-11-02T00:00:00.000Z
prNumber:
prUrl:
prState:
prTitle:
prUpdatedAt:
---

## 任务上下文

### 问题

browser 插件的 IPC 通道原先散落在桌面宿主源码里（`apps/desktop/src/main/ipc.ts`
与 `preload/index.ts` 各写一遍字符串），插件本身没有对外的接口定义。插件一旦
被**别的插件**或**另一个 desktop 版本**消费，就没有可依据的接入点：宿主只能
抄通道名，抄错无从发现，插件升级也会静默漂移。

### 目标

把「插件暴露什么、参数与返回是什么、需要什么能力、版本如何协商」固定成
**一份归插件所有的显式契约**，并提供宿主中立的双侧接入面：
主进程 `registerBrowserIpc(host, handlers)`、渲染侧 `createBrowserApi(transport)`。

### 范围

- 契约模块 `plugins/browser/src/shared/ipc.ts`（通道/签名/能力/版本/红线）
- 处理器工厂 `plugins/browser/src/main/ipc.ts`（契约 → 服务层）
- 桌面接入 `apps/desktop/src/main/browser-ipc.ts`（声明版本 + 注册）
- 桌面 preload 改由契约构造 BrowserApi
- 契约文档 `docs/browser-plugin-ipc-contract.md`

### 非目标

- 不做动态插件加载器 / 通用 RPC 框架（超出当前产品面）
- 不改动 W5/W6 的安全策略与红线
- 不引入新的运行时依赖（契约模块零运行时 import）

### 依赖

W6.0–W6.5 已交付（窄通道与提取能力就位）。

### 假设

- 桌面与插件同仓同版本发布，契约 `minor` 提升时桌面同步提升声明版本

### 未决问题

- 契约 `minor` 提升后的兼容期策略（双版本并行注册）留 v1.1 议

## 全局上下文

### 摘要

Sprint W6（docs/sprints/w6/README.md）子任务；来源为 issue #11 的追加要求
「当前 plugin browser 这个 plugin 需要考虑 ipc 接口需要定义一下，可能会连接
不同的 plugin，或者 desktop version」。

### 来源

- docs/sprints/w6/README.md
- docs/susu/plan/phases/W6-browser-extraction.md（W6.6 卡）
- docs/browser-plugin-ipc-contract.md

### 约束

- passed 必须有可核查证据
- 严格 TS；测试基线只增不减
- 红线：契约内不得出现页面脚本执行通道

### 全局更新

- 需要：否
- 计划：收口时回写 plan README §4 与投影

## 设计影响

### 是否受影响

否（纯增量：把既有通道收编为契约，不改行为）

### 现状行为

桌面手写 `innate:browser*` 通道字符串；插件无对外接口定义；其他插件接入
无据可依。

### 目标行为

插件单点定义契约；桌面只声明版本并注册；渲染侧 API 由契约构造；
任何宿主（含别的插件、别的 desktop 版本）按同一份清单接入。

### 决策

1. **契约归插件，不归宿主**——通道名写在 `plugins/browser/src/shared/ipc.ts`，
   桌面不再出现通道字符串。
2. **契约模块零运行时依赖**——只用类型导入，编译产物可被 preload / 沙箱
   渲染进程直接引用。
3. **版本协商 fail closed**——major 不一致或宿主 minor 更低即拒绝注册，
   不做部分通道降级（降级会让宿主行为不一致）。
4. **红线入契约**——契约内无脚本执行通道，注册时断言，单测再断言。
5. **双侧接入面**——主进程 `registerBrowserIpc` + 渲染侧 `createBrowserApi`；
   进程内直调与跨进程 RPC 各有适配器。

### 风险

- 契约与实现漂移 → 由「渲染壳通道集合 = 契约方法集」的真实桌面断言兜底。
- 版本声明漏提升 → 注册即抛错（可见失败，不是静默降级）。

### 全局影响

无

## 功能与验证点

### F1 · 契约定义

目标：通道/签名/能力/版本单一事实源
模块：M1
Spec：S1

- F1-V1 [done] 契约清单固定且通道唯一
  - 方法：vitest 单测断言通道名、能力声明与反查表一致
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F1-V2 [done] 红线：契约无脚本执行通道
  - 方法：单测断言契约通道不匹配 /execute|eval|script|runtime|cdp/i
  - 证据：docs/susu/plan/evidence/W6/extraction.md

### F2 · 宿主中立接入面

目标：任一宿主都能按契约接入
模块：M1、M2
Spec：S1

- F2-V1 [done] 版本协商：兼容才注册，不兼容抛错
  - 方法：vitest 单测覆盖版本矩阵与 fail closed
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F2-V2 [done] 渲染侧 API 由契约构造；进程内直调与 RPC 分发可用
  - 方法：vitest 单测 + 桌面 preload 改用 createBrowserApi
  - 证据：docs/susu/plan/evidence/W6/extraction.md

### F3 · 桌面接线与漂移断言

目标：桌面只声明版本；契约漂移可被自动化发现
模块：M3
Spec：S1

- F3-V1 [done] 桌面注册契约全部通道且不额外新增
  - 方法：apps/desktop/src/main/ipc.test.ts 单测
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F3-V2 [done] 真实桌面：渲染壳 browser 窄通道集合 = 契约方法集
  - 方法：tools/smoke-browser.ts 读取 window.innate 键集并与契约比对
  - 证据：docs/susu/plan/evidence/W6/extraction.md

## 涉及模块

- M1 [add] innate-dogic/plugins/browser/src/shared/ipc.ts — IPC 契约
- M2 [add] innate-dogic/plugins/browser/src/main/ipc.ts — 处理器工厂
- M3 [modify] innate-dogic/apps/desktop/src/main/browser-ipc.ts — 宿主绑定
- M4 [modify] innate-dogic/apps/desktop/src/main/ipc.ts — 收编通道注册
- M5 [modify] innate-dogic/apps/desktop/src/preload/index.ts — 由契约构造 API
- M6 [add] docs/browser-plugin-ipc-contract.md — 契约文档

## Spec 关联

- S1 [none] docs/susu/plan/phases/W6-browser-extraction.md — 验收定义来源

## 交付记录

- 2026-11-02 建档并实施完成。
  - 契约：`plugins/browser/src/shared/ipc.ts`——8 个调用方法 + 1 个事件通道、
    能力声明、版本协商、红线断言、宿主注册面、渲染侧出口与两种跨宿主适配器。
  - 处理器工厂：`plugins/browser/src/main/ipc.ts`。
  - 桌面：`apps/desktop/src/main/browser-ipc.ts` 声明 `DESKTOP_BROWSER_IPC_VERSION`
    并注册；`main/ipc.ts` 收编 8 条通道；`preload/index.ts` 改为
    `createBrowserApi({ invoke, subscribe })`。
  - 验收：契约单测 18 项 + 处理器工厂 3 项 + 桌面接线 4 项；
    browser 131/131、desktop 136/136；smoke-browser 含新增契约一致性断言。
  - 证据见 docs/susu/plan/evidence/W6/extraction.md。

## 来源原文

### 本地任务

需求来自 issue #11 追加要求与 plan W6.6 卡；全文快照见
docs/sprints/w6/README.md 来源原文节。
