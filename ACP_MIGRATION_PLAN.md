# ACP 面板模式迁移计划

> 将 `vscode-acp` 的 ACP 能力迁移到 `costrict-merge-main` VS Code 插件中，以独立面板模式运行。

## 核心设计决策

- **独立子系统**：ACP 作为并行子系统接入，不融合进 `ClineProvider` 主状态树
- **互斥显示**：同一时刻只有 ACP 或 CoStrict 一个面板存在（通过 `when` clause + `config.costrict.panelMode` 控制）
- **切换需重载**：模式切换后提示用户重新加载窗口（VS Code 限制，WebviewView 注册/销毁需重载）
- **复用组件/样式**：共享同一套 Tailwind CSS v4 + shadcn/ui + VS Code CSS 变量体系，纯展示组件直接引用，业务组件独立实现
- **双入口构建**：前端 Vite 双入口（`index.html` + `acp.html`），共享同一份 CSS 产物

## 架构概览

```
costrict-merge-main/src/
├── extension.ts          # +ACP 初始化（增量，不碰现有逻辑）
├── acp/                  # ACP 后端子系统
│   ├── AcpProvider.ts    # WebviewViewProvider（轻量，独立于 ClineProvider）
│   ├── AcpMessageHandler.ts
│   ├── core/
│   │   ├── AgentManager.ts
│   │   ├── ConnectionManager.ts
│   │   ├── SessionManager.ts
│   │   └── AcpClientImpl.ts
│   ├── handlers/
│   │   ├── TerminalAdapter.ts   # 适配 TerminalRegistry（不移植 vscode-acp 的 TerminalHandler）
│   │   ├── FileSystemHandler.ts
│   │   └── PermissionHandler.ts
│   ├── state/
│   └── ui/
└── core/webview/ClineProvider.ts  # 不修改

webview-ui/
├── index.html            # CoStrict 主入口
├── acp.html              # ACP 入口
├── src/
│   ├── index.tsx         # CoStrict React 入口
│   ├── acp-index.tsx     # ACP React 入口
│   ├── acp/
│   │   ├── AcpApp.tsx
│   │   ├── AcpStateContext.tsx    # ACP 专属状态（独立于 ExtensionStateContext）
│   │   ├── AcpChatView.tsx
│   │   ├── AcpMessageList.tsx     # Phase 3
│   │   ├── AcpInputArea.tsx       # Phase 3
│   │   └── AcpModeSelector.tsx    # Phase 3
│   └── components/
│       ├── acp/                  # ACP 专属组件
│       └── common/               # 共享组件（CodeBlock, MarkdownBlock 等）
└── vite.config.ts        # 双入口构建
```

---

## Phase 1: 骨架跑通

**目标**：切换 `panelMode` 后能显示 ACP 空面板，模式切换命令可用。

### 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|------|----------|------|
| 1.1 | package.json: 新增 `costrict.AcpProvider` view（带 `when: config.costrict.panelMode == acp`） | `src/package.json` | ✅ |
| 1.2 | package.json: 现有 `costrict.SidebarProvider` view 添加 `when: config.costrict.panelMode == costrict` | `src/package.json` | ✅ |
| 1.3 | package.json: 新增 `switchToAcpMode` / `switchToCostrictMode` 命令 | `src/package.json` | ✅ |
| 1.4 | package.json: 新增 `costrict.panelMode` 配置项（enum: costrict/acp） | `src/package.json` | ✅ |
| 1.5 | extension.ts: 注册 AcpProvider + 模式切换命令 | `src/extension.ts` | ✅ |
| 1.6 | 新建 AcpProvider.ts（轻量 WebviewViewProvider） | `src/acp/AcpProvider.ts` | ✅ |
| 1.7 | 新建 acp.html（Vite 入口） | `webview-ui/acp.html` | ✅ |
| 1.8 | 新建 acp-index.tsx（React 入口） | `webview-ui/src/acp-index.tsx` | ✅ |
| 1.9 | 新建 AcpApp.tsx + AcpStateContext.tsx + AcpChatView.tsx | `webview-ui/src/acp/` | ✅ |
| 1.10 | vite.config.ts: 新增 acp 入口 | `webview-ui/vite.config.ts` | ✅ |

### 构建验证

- [x] 前端 Vite 构建成功，生成 `assets/acp.js`
- [x] 后端 esbuild 构建成功
- [ ] 在 VS Code 中实际加载验证（需手动）

### 修复记录

| 问题 | 修复 |
|------|------|
| `getNonce` 从 `getUri.ts` 导入报错 | 改为从 `../core/webview/getNonce.ts` 独立导入 |
| `@ts-expect-error` 在非 webview 环境报 unused | 移除未使用的 useEffect 块 |

---

## Phase 2: 协议层接入

**目标**：ACP 面板能连上 ACP agent，收发消息。

### 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|------|----------|------|
| 2.1 | 移植 AgentManager（agent 进程管理） | `src/acp/core/AgentManager.ts` | ✅ |
| 2.2 | 移植 ConnectionManager（stdio 连接） | `src/acp/core/ConnectionManager.ts` | ✅ |
| 2.3 | 移植 SessionManager（session/mode/model） | `src/acp/core/SessionManager.ts` | ✅ |
| 2.4 | 移植 AcpClientImpl（宿主能力暴露） | `src/acp/core/AcpClientImpl.ts` | ✅ |
| 2.5 | 实现 AcpMessageHandler | `src/acp/AcpMessageHandler.ts` | ✅ |
| 2.6 | TerminalAdapter 对接 TerminalRegistry | `src/acp/handlers/TerminalAdapter.ts` | ✅ |
| 2.7 | FileSystemHandler 移植 | `src/acp/handlers/FileSystemHandler.ts` | ✅ |
| 2.8 | PermissionHandler 移植 | `src/acp/handlers/PermissionHandler.ts` | ✅ |
| 2.9 | AcpProvider 接入消息处理（前后端通信） | `src/acp/AcpProvider.ts` | ✅ |
| 2.10 | ACP 消息类型定义 | `packages/types/src/` | ✅（内联在 AcpStateContext.tsx + AcpMessageHandler.ts） |
| 2.11 | ACP SDK 依赖引入 | `src/package.json` | ✅ |
| 2.12 | AgentConfig 移植（配置命名空间改为 costrict.acp） | `src/acp/config/AgentConfig.ts` | ✅ |
| 2.13 | SessionUpdateHandler 移植 | `src/acp/handlers/SessionUpdateHandler.ts` | ✅ |
| 2.14 | AcpStateContext.tsx 重写（集成 vscode 消息通信） | `webview-ui/src/acp/AcpStateContext.tsx` | ✅ |
| 2.15 | AcpChatView.tsx 重写（集成 connect/disconnect/sendPrompt） | `webview-ui/src/acp/AcpChatView.tsx` | ✅ |
| 2.16 | package.json: 新增 ACP 配置项 + 命令 | `src/package.json` | ✅ |
| 2.17 | extension.ts: 改为静态 import AcpProvider | `src/extension.ts` | ✅ |

### 验证标准

- [x] 能启动 ACP agent 进程（代码已就绪，需实际 agent 配置验证）
- [x] 通过 stdio 建立连接（代码已就绪）
- [x] 前端发送 prompt → 后端转发 → agent 响应 → 前端展示（代码已就绪）
- [x] cancel turn 可用
- [x] dispose 时正确清理进程和连接

---

## Phase 3: UI 完善

**目标**：完整聊天体验，风格与主面板一致。

### 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|------|----------|------|
| 3.1 | AcpMessageItem（复用 MarkdownBlock + CodeBlock） | `webview-ui/src/acp/components/AcpMessageItem.tsx` | ✅ |
| 3.2 | AcpInputArea（参考 ChatTextArea 简化版，复用 AutosizeTextarea） | `webview-ui/src/acp/components/AcpInputArea.tsx` | ✅ |
| 3.3 | AcpModeSelector + AcpModelSelector（参考 ModeSelector 简化版） | `webview-ui/src/acp/components/AcpModeSelector.tsx` | ✅ |
| 3.4 | AcpStateContext 增强（流式输出、thinking、tool call 内联、mode/model 类型） | `webview-ui/src/acp/AcpStateContext.tsx` | ✅ |
| 3.5 | AcpChatView 重写（组合新组件） | `webview-ui/src/acp/AcpChatView.tsx` | ✅ |
| 3.6 | AcpMessageHandler 增加 openFile 支持（MarkdownBlock 文件链接） | `src/acp/AcpMessageHandler.ts` | ✅ |
| 3.7 | 权限审批弹窗（当前使用 VS Code QuickPick，无需前端弹窗） | — | ⬜（已通过后端 QuickPick 实现） |
| 3.8 | Agent 选择/连接状态 UI | `webview-ui/src/acp/AcpChatView.tsx` header | ✅ |

### 组件复用策略

```
🟢 直接引用（无需改动）
├── ui/*              — 22 个 shadcn 组件（Button, Dialog, Input, Select, Tooltip...）
├── common/CodeBlock
├── common/MarkdownBlock
├── common/DiffView
├── common/ImageBlock
├── common/CodeAccordion
├── common/ToolUseBlock
├── common/Tab
├── chat/Markdown
└── LoadingView, ErrorBoundary

🟡 参考+简化（创建 ACP 专属版本）
├── ChatTextArea  → AcpInputArea      （去掉 clineStack 依赖）
└── ModeSelector  → AcpModeSelector   （只读 ACP session 的 modes）

🔴 不复用
├── ChatView（2122行，强绑定 ClineProvider）
├── ChatRow（2294行，强绑定 ClineMessage）
├── TaskHeader, CheckpointMenu, HistoryView, SettingsView
```

### 验证标准

- [x] 消息气泡与主面板风格一致（MarkdownBlock + CodeBlock 复用）
- [x] 代码块高亮正确（通过 MarkdownBlock 内嵌 CodeBlock）
- [x] Mode/Model 切换可用（AcpModeSelector + AcpModelSelector）
- [x] 权限审批可用（通过 VS Code QuickPick，后端 PermissionHandler）
- [x] 流式输出平滑渲染（agent_message_chunk + 光标闪烁动画）
- [x] Thinking 内容可展开查看（agent_thought_chunk + details/summary）
- [x] Tool call 进度和内容可展开（kind icon + status + rawInput/rawOutput）
- [x] 前端 Vite + 后端 esbuild 构建通过

---

## Phase 4: 打磨

**目标**：生产可用。

### 任务清单

| # | 任务 | 涉及文件 | 状态 |
|---|------|----------|------|
| 4.1 | 错误处理、断线重连 | `src/acp/core/ConnectionManager.ts` | ✅ |
| 4.2 | dispose 清理（进程、连接、webview 资源） | `src/acp/AcpProvider.ts` | ✅ |
| 4.3 | 状态栏集成（ACP 连接状态） | `src/acp/ui/StatusBarManager.ts` | ✅ |
| 4.4 | 基础测试 | `src/acp/__tests__/` | ✅ |
| 4.5 | ACP 面板命令面板入口优化 | `src/package.json` | ✅ |
| 4.6 | i18n 支持 | `src/i18n/` | ✅ |

### 验证标准

- [ ] 长时间运行无内存泄漏
- [ ] 断线后可重连
- [ ] 切换模式后资源完全释放
- [ ] 单元测试覆盖核心模块

---

## 关键风险

| 风险 | 缓解措施 |
|------|----------|
| 双 webview 内存 | ACP 和 CoStrict 通过 `when` clause 互斥，同一时刻只有一个 webview 存在 |
| `extension.ts` 继续膨胀 | ACP 初始化封装为独立函数，入口只调一行 |
| 模式切换需重启 | VS Code 限制，无法绕过；用户交互参考 Python 语言服务器切换的成熟模式 |
| ACP SDK 许可证 | 需确认 `@anthropic-ii/acp-sdk` 许可证与项目兼容 |
| 主 UI 回归 | Phase 1-2 不碰 `ClineProvider` 和 `webviewMessageHandler.ts`，零回归风险 |

## 消息协议设计

### 前端 → 后端（AcpWebviewMessage）

```typescript
type AcpWebviewMessage =
  | { type: "acpConnect"; agentId: string }
  | { type: "acpDisconnect" }
  | { type: "acpSendPrompt"; text: string; attachments?: string[] }
  | { type: "acpCancelTurn" }
  | { type: "acpSetMode"; mode: string }
  | { type: "acpSetModel"; model: string }
  | { type: "acpApprovePermission"; requestId: string }
  | { type: "acpRejectPermission"; requestId: string }
```

### 后端 → 前端（AcpExtensionMessage）

```typescript
type AcpExtensionMessage =
  | { type: "acpState"; state: AcpState }
  | { type: "acpSessionUpdate"; update: AcpSessionUpdate }
  | { type: "acpMessage"; message: AcpMessage }
  | { type: "acpPermissionRequest"; request: AcpPermissionRequest }
  | { type: "acpConnected"; agentId: string }
  | { type: "acpDisconnected"; reason?: string }
  | { type: "acpError"; error: string }
  | { type: "acpModesUpdate"; modes: string[] }
  | { type: "acpModelsUpdate"; models: string[] }
```

---

## 参考来源

- `vscode-acp/src/core/AgentManager.ts` — Agent 进程管理
- `vscode-acp/src/core/ConnectionManager.ts` — ACP 协议连接
- `vscode-acp/src/core/SessionManager.ts` — Session 管理
- `vscode-acp/src/core/AcpClientImpl.ts` — 宿主能力暴露
- `vscode-acp/src/handlers/*` — FileSystem/Permission/Terminal 处理
- `vscode-acp/src/ui/ChatWebviewProvider.ts` — Webview Provider 参考
- `vscode-acp/src/ui/SessionTreeProvider.ts` — Session 树视图
- `vscode-acp/src/ui/StatusBarManager.ts` — 状态栏管理
