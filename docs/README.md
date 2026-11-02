# Innate 平台总体计划(文档归档入口)

> 本目录自 `innate-labs/docs/` 迁入(2026-10-27),是 Innate 体系全部设计文档的归档处。
> **当前唯一执行源是 [`susu/plan/`](./susu/plan/README.md)（labs→innate-desktop 迁移与产品化计划,W0 起）**;P 系列平台计划已后置为 backlog(见 §4/§5);本文只做总纲摘要与文档地图。

---

## 1. 一句话定位

**`innate-dogic` = 共享底座 + 轻应用平台:用户说目的,平台匹配轻应用,结果以卡片留在画布上。**

三个角色分工不可互换:

| 对象 | 角色 | 是否在产品仓 |
| --- | --- | --- |
| DSH(`@deepseek-ai/dsh`) | Agent runtime、会话与工具执行、Harness UI | 否;本机全局解析,系统 Node 启动 |
| magpie | Provider/模型管理、Agent 接线、路由与用量 | 只保留 `bin/magpie.exe`,不持有源码 |
| `innate-dogic` | 桌面壳、进程与 Surface 生命周期、插件组合、轻应用生态 | 是;唯一产品工程 |

## 2. 已验证基线(M0–M2,2026-10-26,源仓 innate-labs)

以下能力在源仓真实验证完成,是所有后续里程碑「行为不回退」的验收前提(W0 将其迁入本仓):

- DSH 对话内嵌(系统 Node 启动 `dsh web`,Harness UI 嵌入桌面)、magpie 控制台
- simple/dev 双模式门控、simple overlay 裁剪 7/7 断言
- 原生工作区插件(文件/Markdown/图片/只读 Git)、Surface 安全快照
- 便携包真实 Electron 冒烟;全量门禁 83 项测试(基线只增不减,以 W0 实测为准)

## 3. 平台化重启方向(2026-10-27 提出;P 系列现为 backlog)

> 本节与 §4 的 P 系列自 2026-10-28 起**后置**:迁移主线(W0–W5/Q1–Q3/R1)完成后另做依赖评审再重启。详见 [susu/plan/03-migration-plan.md](./susu/plan/03-migration-plan.md) §5 后置清单。

### 底座五类共享服务

1. **Agent 会话运行时** —— `harness-runtime` → `AgentRuntime` 适配缝;dsh 是第一个适配器,不重写执行内核
2. **模型网关** —— magpie 承担 Provider 池/接线/用量,平台不自研
3. **Surface/工作区宿主** —— Surface/Document/Panel 三类内容;画布成为一等 Surface
4. **OS 能力** —— 能力注册表 + 显式权限审批(v0 三个权限位)
5. **分发组合** —— manifest 驱动的轻应用加载器 + 目录客户端;本地侧载先行,内容寻址 zip 市场随后

### 轻应用(一个用户目的一个包)

清单契约 `PluginManifest v1`(原型已跑通):`purpose` 目的索引 + 关键词匹配(v1 语义匹配)、`tools`(v0 模板 → v1 MCP 服务)、`widget` sandbox iframe 结果卡片、`permissions` 执行前必过审批中介、`integrity` 内容寻址校验。**同一目的、不同实现并列展示,用户选实现而不是学工具**;飞书式重平台是反面参照。

### 两个开发框架(后置)

- **`innate-fe`**(前端,已存在于 `framework/innate-fe`):React 组件基座 `@innate/ui`,本仓经私有源消费
- **`innate-backend`**(后端,原计划 TS 框架;`framework/innate-backend` 现为独立 Go 仓,不属本计划)

## 4. 里程碑状态

**当前主线(唯一执行源:[susu/plan/](./susu/plan/README.md))**:W0 基线迁入 → W1a/W1b/W1c 桌面壳 → (W2 网关收口 ∥ W3 工作区) → W4 terminal → W5 browser → R1 Harness 收敛 → Q1 快照 → Q2 看板 → Q3 单任务执行。状态板与机读投影见 plan README §4 与 [plan/canvas/](./susu/plan/canvas/docs/sprints/README.md)。

已后置的 P 系列(2026-10-28 起不再排期,保留 backlog):

| Sprint | 名称 | 状态 |
| --- | --- | --- |
| P0–P7 | 平台基线/框架/轻应用契约/目的网关/画布/dsh 适配器/分发 | **后置 backlog**(迁移主线完成后评审) |
| M4/M5 | 方向 B:DSH 侧插件 / 双向设置 | 后置 backlog |
| S5/S6 | mini-gateway 决策门 / 代码健康 | 不变,穿插 |

DoD:全量门禁绿 + 任务卡「如何验证」逐条通过 + 证据入 `docs/susu/plan/evidence/<阶段>/` + 文档同步。

## 5. 旧主线处置

- 迁移主线取代 P 系列执行顺序;S0 并入 W0,S1(M3)由 R1+Q3 吸收,M6 由 W4/W5/Q2 提前,M7 后置
- 方向 B(M4/M5)保留 backlog,任务卡沿用旧树(`original/plans/innate-dogic-dsh/`)
- `original/` 全树保留为 **M0–M2 基线证据与平台化方向依据**,不再新增执行任务

## 6. 硬约束(继承,不重开讨论)

1. 产品代码/后端/网站/工具全部 strict TypeScript;`references/` 只读不入库;`prototypes/` 不进门禁
2. DSH 用真实系统 Node 启动(清 `ELECTRON_RUN_AS_NODE`);全新 `DSH_HOME` 先裸 boot 再 magpie 接线
3. 本地服务一律只绑 `127.0.0.1`;认证 URL/token/key 不进日志、快照、夹具
4. 文件与 Git 默认只读、参数数组禁 shell 拼接;renderer 无任意 Node/shell
5. Electron:`contextIsolation: true`、`nodeIntegration: false`、WebContentsView `sandbox: true`
6. 轻应用 fail closed:清单非法或权限拒绝只禁用自身,不破坏底座
7. 测试基线只增不减;真实二进制测试只读、隔离 `DSH_HOME`/userData

## 7. 文档地图

| 问题 | 去哪里 |
| --- | --- |
| Issue/PR、需求文件或本地任务的分析、验证证据与 Canvas | [task-workflow](../.agents/skills/task-workflow/SKILL.md)；事实源为 `docs/sprints/task-*-*.md` |
| **仓库现状的 build-path 记录**（任务驱动基线、monorepo 骨架与 UI 基座接入） | [build-path/0-setup/](./build-path/0-setup/README.md)、[build-path/1-monorepo-init/](./build-path/1-monorepo-init/README.md) |
| orca ↔ innate-fe 的对齐结论与差异处置 | [build-path/1-monorepo-init/style-guide-alignment.md](./build-path/1-monorepo-init/style-guide-alignment.md) |
| **当前迁移执行计划(唯一执行源)** | [susu/plan/](./susu/plan/README.md)；看板投影 [susu/plan/canvas/](./susu/plan/canvas/docs/sprints/README.md) |
| **orca browser 模块研究（deepwiki 全量导出 + arch-diagram 分析）** | [orca/](./orca/README.md)；分析与路线取舍 [orca/browser-module-analysis.md](./orca/browser-module-analysis.md) |
| **browser 插件 IPC 契约（通道/签名/能力/版本，宿主中立接入）** | [browser-plugin-ipc-contract.md](./browser-plugin-ipc-contract.md)；契约定义 [plugins/browser/src/shared/ipc.ts](../innate-dogic/plugins/browser/src/shared/ipc.ts) |
| 已合并归档的旧迁移计划(plan1)与评审 | [susu/archive/plan1/](./susu/archive/plan1/README.md)(含 reviews/) |
| 并发会话画布预览产物(非事实源) | [susu/archive/project-canvas-preview/](./susu/archive/project-canvas-preview/) |
| 平台化方向总纲(P 系列 backlog) | [original/innate-dogic/CONTEXT.md](./original/innate-dogic/CONTEXT.md) |
| 新架构总览(分层/契约) | [original/innate-dogic/architecture/overview.md](./original/innate-dogic/architecture/overview.md) |
| 目标模块图与迁移映射 | [original/innate-dogic/architecture/module-map.md](./original/innate-dogic/architecture/module-map.md) |
| 视觉与交互规范 | `.agents/skills/susu-overview/STYLEGUIDE.md`(已按本仓基座重写) + `styleguide/` 深文(`color` / `components` / `toolbar` / `native-chat` / `ux-rules` / `ux-review-rubric`);`original/innate-dogic/architecture/style-guide.md` 为过时草案不执行 |
| P 系列里程碑与决策总纲(backlog) | [original/innate-dogic/plans/README.md](./original/innate-dogic/plans/README.md) |
| 构建矩阵、命令、门禁、分发 | [original/innate-dogic/build-path/README.md](./original/innate-dogic/build-path/README.md) |
| 旧全局 Context(M0–M2 基线) | [CONTEXT.md](./CONTEXT.md) |
| 旧双向宿主计划(dogic × DSH) | [original/plans/innate-dogic-dsh/README.md](./original/plans/innate-dogic-dsh/README.md) |
| 对齐审计与模块图(旧) | [original/architecture/plan-alignment-review.md](./original/architecture/plan-alignment-review.md) |
| Structured I/O 与批注契约(未实现) | [original/architecture/structured-io.md](./original/architecture/structured-io.md) |
| 技术栈说明 | [original/dsh-tech-stack.md](./original/dsh-tech-stack.md) |
| Kimi Work / ZCode 研究笔记 | [original/research/kimi-work-zcode-platform-notes.md](./original/research/kimi-work-zcode-platform-notes.md) |

## 8. 阅读顺序

新会话先读本文件 → [`susu/plan/README.md`](./susu/plan/README.md)（唯一执行源）→ 对应阶段任务卡;执行任务只看 plan,做完按 DoD 回写证据与状态板。UI 任务另读 `.agents/skills/susu-overview`;任务工作流读 `.agents/skills/task-workflow`;dsh/magpie 排障手册暂在 innate-labs 仓 `.agents/skills/innate-dsh-playbook`（W0 时迁回,见 plan W0.8）。
