---
schemaVersion: 1.0.0
id: task-local-w6-1-extraction
title: W6 浏览器元素提取（提取元素）
createdAt: 2026-11-02T04:05:00.000Z
updatedAt: 2026-11-02T12:00:00.000Z
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

受控浏览器取不到页面元素；issue #11 要求补「提取元素」，并归档
deepwiki/stablyai/orca 的 browser 内容做模块分析。

### 目标

纯 CDP 只读域实现元素提取（清单 + 详情 + 脱敏 + 选择器 + 截图），
不放宽「无页面脚本执行通道」红线；完成 orca 研究归档与 arch-diagram 分析。

### 范围

- orca deepwiki 全量导出 → `docs/orca/`；arch-diagram 分析
- 提取策略纯模块 + CDP 提取器 + 服务接线 + 窄通道 + 面板
- 端到端验收与红线断言

### 非目标

- 不注入页面脚本（orca AI Grab 路线）
- 不做对外 CDP 代理 / cookie 导入 / 多 profile 分区
- 不改导航、权限、下载、布局策略

### 依赖

W5 全绿（已 done）。

### 假设

- Electron 43 的 `webContents.debugger` 可对 `WebContentsView` 附加 CDP

### 未决问题

- 提取结果交给 Agent 的路由留给 Q3；区域截图预算策略留 v1.2 议

## 全局上下文

### 摘要

Sprint W6（docs/sprints/w6/README.md）子任务；需求细节见其来源原文快照与
plan 对应卡。

### 来源

- docs/sprints/w6/README.md
- docs/susu/plan/phases/W6-browser-extraction.md
- docs/orca/browser-module-analysis.md

### 约束

- passed 必须有可核查证据；token/认证 URL 不进日志快照证据
- 严格 TS；测试基线只增不减
- 红线：browser 视图抽象不得出现页面脚本执行通道

### 全局更新

- 需要：否
- 计划：无

## 设计影响

### 是否受影响

否（纯增量）

### 现状行为

browser Surface 只能导航与呈现，页面元素对壳层不可见。

### 目标行为

面板可拉出页面元素清单并逐个查看详情；提取全程不执行页面脚本。

### 决策

1. 走纯 CDP，不抄 orca 的注入脚本路线（本仓红线）。
2. CDP 方法白名单不含 `Runtime.*`。
3. 不透明 ref 绑定会话，只认本会话最近一次清单。
4. 属性白名单 + 凭据脱敏 + URL 净化 + 长度预算（沿用 orca 思路，更严）。

### 风险

行为回退风险由门禁 + smoke 兜底；提取为增量能力，移除窄通道即回 W5。

### 全局影响

无

## 功能与验证点

### F1 · orca 研究归档与 arch-diagram 分析

目标：orca browser 模块可离线查阅，路线取舍有据
模块：M5
Spec：S1

- F1-V1 [done] deepwiki 全量导出为 markdown 并带索引
  - 方法：解析 deepwiki 的 RSC flight 流取全部页面文本行，导出 58 页 + README 索引
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F1-V2 [done] arch-diagram 分析给出路线取舍
  - 方法：对照 orca 源码（src/main/browser）与本仓 browser 模块，产出 arch-diagram 文档
  - 证据：docs/orca/browser-module-analysis.md

### F2 · 提取策略纯模块

目标：白名单/脱敏/预算/CDP 方法白名单在实现前固定
模块：M1
Spec：S1

- F2-V1 [done] 属性白名单、凭据脱敏、URL 净化、预算全部有单测
  - 方法：vitest 单测
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F2-V2 [done] CDP 方法白名单不含 Runtime.*（红线）
  - 方法：单测断言白名单成员域与 Runtime.* 排除
  - 证据：docs/susu/plan/evidence/W6/extraction.md

### F3 · CDP 提取与服务接线

目标：能取到清单与详情；renderer 不能越权引用元素
模块：M1、M2、M3
Spec：S1

- F3-V1 [done] 服务层单测：清单/详情/非法 ref/跨会话/导航作废/端口异常
  - 方法：vitest 单测（41 项）
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F3-V2 [done] 真实桌面端到端：清单含角色+名称、详情含标签与选择器、凭据属性脱敏
  - 方法：tools/smoke-browser.ts 驱动真实 Electron 宿主 + 本地受控 HTTP 靶场
  - 证据：docs/susu/plan/evidence/W6/extraction.md

### F4 · 面板交互与红线断言

目标：用户能完成一次完整提取；红线可核查
模块：M4
Spec：S1

- F4-V1 [done] 面板单测覆盖清单/详情/失败/空清单/截图
  - 方法：vitest 面板测试（19 项）
  - 证据：docs/susu/plan/evidence/W6/extraction.md
- F4-V2 [done] 红线断言：渲染壳与 browser 窄通道无脚本执行入口
  - 方法：smoke-browser 真实宿主内读取 window.innate 通道集合并断言
  - 证据：docs/susu/plan/evidence/W6/extraction.md

## 涉及模块

- M1 [add] innate-dogic/plugins/browser/src/main/extraction.ts — 提取策略纯模块
- M2 [add] innate-dogic/plugins/browser/src/main/extraction-cdp.ts — CDP 提取器
- M3 [modify] innate-dogic/plugins/browser/src/main/index.ts — 服务层接线与引用表
- M4 [modify] innate-dogic/plugins/browser/src/renderer/BrowserPanel.tsx — 面板交互
- M5 [add] docs/orca — orca 研究归档与分析

## Spec 关联

- S1 [none] docs/susu/plan/phases/W6-browser-extraction.md — 验收定义来源

## 交付记录

- 2026-11-02 建档并实施完成（单 task 交付，W6.0–W6.5 合并为一张卡）。
  - orca 研究：58 页 markdown 落 `docs/orca/` + `browser-module-analysis.md`
    （arch-diagram：orca 五层骨架、两条提取路线时序、7 条安全设计、
    本仓现状图、差距表与路线对比）。
  - 提取能力：策略纯模块 + CDP 提取器 + 服务层引用表 + 2 个窄通道 + 面板。
  - 验收：smoke-browser 28/28（含 5 项新增断言）；browser 110/110、
    desktop 132/132；全仓 typecheck 与 check:typescript 绿。
  - 附带修复：① 页面聚焦自己的最近一个 Surface（浏览器页不再渲染终端）；
    ② smoke 断言不再硬编码检出目录名。
  - 证据见 docs/susu/plan/evidence/W6/extraction.md。

## 来源原文

### 本地任务

需求来自 issue #11 与 plan W6 卡；全文快照见 docs/sprints/w6/README.md
来源原文节，此处不重复。
