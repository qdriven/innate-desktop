# orca DeepWiki 导出

本目录是 [deepwiki.com/stablyai/orca](https://deepwiki.com/stablyai/orca) 的完整离线导出：每个页面对应一个 markdown 文件，内容为该 wiki 页面的正文（已去掉页首的“相关源文件”清单），文件头记录了标题、原始 URL 与抓取日期。

- 来源：<https://deepwiki.com/stablyai/orca>
- 抓取日期：2026-11-02
- 导出方式：解析页面内嵌的 Next.js RSC flight 流，取每页的 `T` 文本行
- 页面数：58

> **分析与取舍**：orca browser 模块的 arch-diagram 分析、与本仓 browser 的差距、
> 以及「提取元素」的技术路线选择，见
> [browser-module-analysis.md](./browser-module-analysis.md)。

## 页面索引

| 页面 | 标题 | 原始 URL |
| --- | --- | --- |
| [1-orca-overview.md](1-orca-overview.md) | Orca Overview | <https://deepwiki.com/stablyai/orca/1-orca-overview> |
| [1.1-getting-started.md](1.1-getting-started.md) | Getting Started | <https://deepwiki.com/stablyai/orca/1.1-getting-started> |
| [1.2-architecture-overview.md](1.2-architecture-overview.md) | Architecture Overview | <https://deepwiki.com/stablyai/orca/1.2-architecture-overview> |
| [2-main-process.md](2-main-process.md) | Main Process | <https://deepwiki.com/stablyai/orca/2-main-process> |
| [2.1-ipc-api-reference.md](2.1-ipc-api-reference.md) | IPC API Reference | <https://deepwiki.com/stablyai/orca/2.1-ipc-api-reference> |
| [2.2-persistence-layer.md](2.2-persistence-layer.md) | Persistence Layer | <https://deepwiki.com/stablyai/orca/2.2-persistence-layer> |
| [2.3-git-and-github-integration.md](2.3-git-and-github-integration.md) | Git & GitHub Integration | <https://deepwiki.com/stablyai/orca/2.3-git-and-github-integration> |
| [2.4-auto-updater.md](2.4-auto-updater.md) | Auto-Updater | <https://deepwiki.com/stablyai/orca/2.4-auto-updater> |
| [2.5-ssh-and-remote-connections.md](2.5-ssh-and-remote-connections.md) | SSH & Remote Connections | <https://deepwiki.com/stablyai/orca/2.5-ssh-and-remote-connections> |
| [2.6-cli-and-runtime-rpc.md](2.6-cli-and-runtime-rpc.md) | CLI & Runtime RPC | <https://deepwiki.com/stablyai/orca/2.6-cli-and-runtime-rpc> |
| [2.7-automations-and-orchestration.md](2.7-automations-and-orchestration.md) | Automations & Orchestration | <https://deepwiki.com/stablyai/orca/2.7-automations-and-orchestration> |
| [2.8-daemon-relay-and-provider-abstractions.md](2.8-daemon-relay-and-provider-abstractions.md) | Daemon, Relay, and Provider Abstractions | <https://deepwiki.com/stablyai/orca/2.8-daemon-relay-and-provider-abstractions> |
| [2.9-plugin-system.md](2.9-plugin-system.md) | Plugin System | <https://deepwiki.com/stablyai/orca/2.9-plugin-system> |
| [3-renderer-process-and-state-management.md](3-renderer-process-and-state-management.md) | Renderer Process & State Management | <https://deepwiki.com/stablyai/orca/3-renderer-process-and-state-management> |
| [3.1-zustand-store-architecture.md](3.1-zustand-store-architecture.md) | Zustand Store Architecture | <https://deepwiki.com/stablyai/orca/3.1-zustand-store-architecture> |
| [3.2-worktree-lifecycle-in-the-renderer.md](3.2-worktree-lifecycle-in-the-renderer.md) | Worktree Lifecycle in the Renderer | <https://deepwiki.com/stablyai/orca/3.2-worktree-lifecycle-in-the-renderer> |
| [3.3-internationalization-and-localization.md](3.3-internationalization-and-localization.md) | Internationalization & Localization | <https://deepwiki.com/stablyai/orca/3.3-internationalization-and-localization> |
| [4-sidebar.md](4-sidebar.md) | Sidebar | <https://deepwiki.com/stablyai/orca/4-sidebar> |
| [4.1-worktree-list-and-cards.md](4.1-worktree-list-and-cards.md) | Worktree List & Cards | <https://deepwiki.com/stablyai/orca/4.1-worktree-list-and-cards> |
| [4.2-sidebar-controls-and-toolbar.md](4.2-sidebar-controls-and-toolbar.md) | Sidebar Controls & Toolbar | <https://deepwiki.com/stablyai/orca/4.2-sidebar-controls-and-toolbar> |
| [5-terminal-system.md](5-terminal-system.md) | Terminal System | <https://deepwiki.com/stablyai/orca/5-terminal-system> |
| [5.1-pty-layer-and-tab-management.md](5.1-pty-layer-and-tab-management.md) | PTY Layer & Tab Management | <https://deepwiki.com/stablyai/orca/5.1-pty-layer-and-tab-management> |
| [5.2-pane-manager-and-terminal-pane-lifecycle.md](5.2-pane-manager-and-terminal-pane-lifecycle.md) | Pane Manager & Terminal Pane Lifecycle | <https://deepwiki.com/stablyai/orca/5.2-pane-manager-and-terminal-pane-lifecycle> |
| [5.3-terminal-themes-and-appearance.md](5.3-terminal-themes-and-appearance.md) | Terminal Themes & Appearance | <https://deepwiki.com/stablyai/orca/5.3-terminal-themes-and-appearance> |
| [5.4-agent-completion-and-notifications.md](5.4-agent-completion-and-notifications.md) | Agent Completion & Notifications | <https://deepwiki.com/stablyai/orca/5.4-agent-completion-and-notifications> |
| [5.5-native-chat-interface.md](5.5-native-chat-interface.md) | Native Chat Interface | <https://deepwiki.com/stablyai/orca/5.5-native-chat-interface> |
| [5.6-keyboard-ime-and-terminal-links.md](5.6-keyboard-ime-and-terminal-links.md) | Keyboard, IME & Terminal Links | <https://deepwiki.com/stablyai/orca/5.6-keyboard-ime-and-terminal-links> |
| [6-editor-and-right-sidebar.md](6-editor-and-right-sidebar.md) | Editor & Right Sidebar | <https://deepwiki.com/stablyai/orca/6-editor-and-right-sidebar> |
| [6.1-monaco-editor-panel.md](6.1-monaco-editor-panel.md) | Monaco Editor Panel | <https://deepwiki.com/stablyai/orca/6.1-monaco-editor-panel> |
| [6.2-right-sidebar-panels.md](6.2-right-sidebar-panels.md) | Right Sidebar Panels | <https://deepwiki.com/stablyai/orca/6.2-right-sidebar-panels> |
| [6.3-github-pr-and-checks-integration.md](6.3-github-pr-and-checks-integration.md) | GitHub PR & Checks Integration | <https://deepwiki.com/stablyai/orca/6.3-github-pr-and-checks-integration> |
| [6.4-rich-markdown-and-image-editors.md](6.4-rich-markdown-and-image-editors.md) | Rich Markdown & Image Editors | <https://deepwiki.com/stablyai/orca/6.4-rich-markdown-and-image-editors> |
| [6.5-task-trackers--linear-jira-and-integrations.md](6.5-task-trackers--linear-jira-and-integrations.md) | Task Trackers: Linear, Jira & Integrations | <https://deepwiki.com/stablyai/orca/6.5-task-trackers:-linear-jira-and-integrations> |
| [7-settings.md](7-settings.md) | Settings | <https://deepwiki.com/stablyai/orca/7-settings> |
| [7.1-appearance-and-general-settings.md](7.1-appearance-and-general-settings.md) | Appearance & General Settings | <https://deepwiki.com/stablyai/orca/7.1-appearance-and-general-settings> |
| [7.2-terminal-and-repository-settings.md](7.2-terminal-and-repository-settings.md) | Terminal & Repository Settings | <https://deepwiki.com/stablyai/orca/7.2-terminal-and-repository-settings> |
| [7.3-agent-and-ai-settings.md](7.3-agent-and-ai-settings.md) | Agent & AI Settings | <https://deepwiki.com/stablyai/orca/7.3-agent-and-ai-settings> |
| [7.4-voice-dictation-and-speech-models.md](7.4-voice-dictation-and-speech-models.md) | Voice, Dictation, and Speech Models | <https://deepwiki.com/stablyai/orca/7.4-voice-dictation-and-speech-models> |
| [8-browser-pane-and-ai-agent-features.md](8-browser-pane-and-ai-agent-features.md) | Browser Pane & AI Agent Features | <https://deepwiki.com/stablyai/orca/8-browser-pane-and-ai-agent-features> |
| [8.1-integrated-browser-pane.md](8.1-integrated-browser-pane.md) | Integrated Browser Pane | <https://deepwiki.com/stablyai/orca/8.1-integrated-browser-pane> |
| [8.2-ai-agent-tracking-accounts-and-usage.md](8.2-ai-agent-tracking-accounts-and-usage.md) | AI Agent Tracking, Accounts & Usage | <https://deepwiki.com/stablyai/orca/8.2-ai-agent-tracking-accounts-and-usage> |
| [8.3-computer-use-and-desktop-automation.md](8.3-computer-use-and-desktop-automation.md) | Computer Use & Desktop Automation | <https://deepwiki.com/stablyai/orca/8.3-computer-use-and-desktop-automation> |
| [8.4-mobile-emulator-pane.md](8.4-mobile-emulator-pane.md) | Mobile Emulator Pane | <https://deepwiki.com/stablyai/orca/8.4-mobile-emulator-pane> |
| [8.5-ai-vault-and-session-scanner.md](8.5-ai-vault-and-session-scanner.md) | AI Vault & Session Scanner | <https://deepwiki.com/stablyai/orca/8.5-ai-vault-and-session-scanner> |
| [9-build-packaging-and-release.md](9-build-packaging-and-release.md) | Build, Packaging & Release | <https://deepwiki.com/stablyai/orca/9-build-packaging-and-release> |
| [9.1-cicd-and-testing.md](9.1-cicd-and-testing.md) | CI/CD & Testing | <https://deepwiki.com/stablyai/orca/9.1-cicd-and-testing> |
| [9.2-agent-skills-and-ai-coding-guidelines.md](9.2-agent-skills-and-ai-coding-guidelines.md) | Agent Skills & AI Coding Guidelines | <https://deepwiki.com/stablyai/orca/9.2-agent-skills-and-ai-coding-guidelines> |
| [9.3-diagnostics-telemetry-and-reliability-gates.md](9.3-diagnostics-telemetry-and-reliability-gates.md) | Diagnostics, Telemetry & Reliability Gates | <https://deepwiki.com/stablyai/orca/9.3-diagnostics-telemetry-and-reliability-gates> |
| [9.4-documentation-site-and-assets.md](9.4-documentation-site-and-assets.md) | Documentation Site & Assets | <https://deepwiki.com/stablyai/orca/9.4-documentation-site-and-assets> |
| [10-mobile-companion-app.md](10-mobile-companion-app.md) | Mobile Companion App | <https://deepwiki.com/stablyai/orca/10-mobile-companion-app> |
| [10.1-mobile-transport-and-pairing.md](10.1-mobile-transport-and-pairing.md) | Mobile Transport & Pairing | <https://deepwiki.com/stablyai/orca/10.1-mobile-transport-and-pairing> |
| [10.2-mobile-terminal-and-ui.md](10.2-mobile-terminal-and-ui.md) | Mobile Terminal & UI | <https://deepwiki.com/stablyai/orca/10.2-mobile-terminal-and-ui> |
| [10.3-mobile-source-control-and-tasks.md](10.3-mobile-source-control-and-tasks.md) | Mobile Source Control & Tasks | <https://deepwiki.com/stablyai/orca/10.3-mobile-source-control-and-tasks> |
| [11-cloud-relay-and-push-infrastructure.md](11-cloud-relay-and-push-infrastructure.md) | Cloud Relay & Push Infrastructure | <https://deepwiki.com/stablyai/orca/11-cloud-relay-and-push-infrastructure> |
| [11.1-relay-service-and-wire-contract.md](11.1-relay-service-and-wire-contract.md) | Relay Service & Wire Contract | <https://deepwiki.com/stablyai/orca/11.1-relay-service-and-wire-contract> |
| [11.2-push-gateway.md](11.2-push-gateway.md) | Push Gateway | <https://deepwiki.com/stablyai/orca/11.2-push-gateway> |
| [11.3-relay-ops-fence-broker-and-infrastructure.md](11.3-relay-ops-fence-broker-and-infrastructure.md) | Relay Ops, Fence Broker & Infrastructure | <https://deepwiki.com/stablyai/orca/11.3-relay-ops-fence-broker-and-infrastructure> |
| [12-glossary.md](12-glossary.md) | Glossary | <https://deepwiki.com/stablyai/orca/12-glossary> |
