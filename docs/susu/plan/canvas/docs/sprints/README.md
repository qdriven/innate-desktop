# plan 执行看板（project-canvas 机读投影）

> 本目录是 `docs/susu/plan/` 的机读投影，供 project-canvas 派生看板与审计。任务卡细节以 [../phases/](../../phases/) 为准；两处同步修改，plan 正文优先。
> 段映射：S0=W0、S1=W1a、S2=W1b、S3=W1c、S4=W2、S5=W3、S6=W4、S7=W5、S12=W6、S8=R1、S9=Q1、S10=Q2、S11=Q3。任务标题保留源编号（W/Q/R 别名）。
> 改任务卡后：canvas_audit → canvas_sync → canvas_board（root 传本 canvas/ 目录），不手改 out/。

| [S0](./S0-w0-baseline.md) | W0 基线迁入 | 源基线+工程门禁可运行，源头修复日志脱敏 | 2–3 人日 | 已完成（2026-10-28） |
| [S1](./S1-w1a-base.md) | W1a UI 基座+titlebar | 字体决策、Tailwind+token、只换顶栏留状态槽 | 1–2 人日 | 已完成（2026-10-28） |
| [S2](./S2-w1b-shell.md) | W1b 壳组合 | @innate/ui Sidebar/ContentArea、拆 App | 1–2 人日 | 已完成（2026-10-28） |
| [S3](./S3-w1c-tabs.md) | W1c 中栏多标签 | Surface 标签模型+接入统一槽+降级+回归 | 2–3 人日 | 待执行 |
| [S4](./S4-w2-gateway.md) | W2 网关收口 | sidecar/CLI/console/状态/网关真实链路 | 3–4 人日 | 待执行 |
| [S5](./S5-w3-workspace.md) | W3 工作区 | 右栏 Panel+中栏文档+WorkspaceContext | 3–5 人日 | 待执行 |
| [S6](./S6-w4-terminal.md) | W4 terminal | PTY spike/契约/服务/Surface/process:execute | 4–6 人日 | 待执行 |
| [S7](./S7-w5-browser.md) | W5 browser | 独立分区/导航/权限/下载/快照 | 3–5 人日 | 待执行 |
| [S12](./S12-w6-extraction.md) | W6 元素提取 | orca 研究归档+纯 CDP 提取+红线断言+IPC 契约 | 3–4 人日 | 已完成（2026-11-02） |
| [S8](./S8-r1-harness.md) | R1 Harness 收敛 | 单测护栏+共享实现收敛+DSH 真实集成链 | 2–3 人日 | 待执行 |
| [S9](./S9-q1-plan.md) | Q1 计划生成 | Schema 校验+audit+人工确认+原子落盘 | 3–5 人日 | 待执行 |
| [S10](./S10-q2-canvas.md) | Q2 项目看板 | 只读 store+四视图+草稿隔离+恢复 | 3–4 人日 | 待执行 |
| [S11](./S11-q3-task.md) | Q3 单任务执行 | 契约+路由+调度器+三类执行+证据回写 | 5–7 人日 | 待执行 |
