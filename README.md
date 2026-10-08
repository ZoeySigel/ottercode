# OtterCode

<img src="assets/otter.svg" width="112" alt="OtterCode 水獭图标" />

个人学习用的终端 AI 编程助手，基于 [Charmbracelet Crush](https://github.com/charmbracelet/crush) 修改。

## 构建与运行

需要安装 `go.mod` 中指定版本的 Go。

```sh
git clone https://github.com/ZoeySigel/ottercode.git
cd ottercode
go build -o ottercode .
./ottercode
```

在 Windows 上运行：

```powershell
go build -o ottercode.exe .
.\ottercode.exe
```

配置文件使用 `ottercoderc` / `.ottercoderc`，或 `ottercode.json` / `.ottercode.json`。应用专用环境变量使用 `OTTERCODE_` 前缀。项目状态保存在 `.ottercode` 中，数据库和日志分别为 `ottercode.db` 和 `logs/ottercode.log`。程序不会读取或迁移现有的 Crush 配置和数据。运行 `ottercode dirs` 可以查看全局目录位置。

默认主题为 `otter-river`，同时保留其他内置主题和自定义主题功能。版本更新检查指向本个人仓库。目前没有提供包管理器发行版。

## 功能特性

- **多模型支持：** 从多种大语言模型中选择，也可以通过兼容 OpenAI 或 Anthropic 的 API 添加自己的模型。
- **灵活切换：** 在会话中切换模型，同时保留上下文。
- **多会话管理：** 为每个项目维护多个工作会话及其上下文。
- **LSP 增强：** 使用语言服务器协议（LSP）获取额外的代码上下文，辅助判断和操作。
- **可扩展：** 通过 MCP 添加功能，支持 `http`、`stdio` 和 `sse` 传输方式。
- **跨平台：** 支持 macOS、Linux、Windows（PowerShell 和 WSL）、Android、FreeBSD、OpenBSD 和 NetBSD 上的终端。
- **成熟生态：** 基于 Charm 生态构建；该生态已用于超过 25,000 个应用，覆盖开源项目和业务关键基础设施。

## 快速开始

在模型选择器中选择服务商和模型，然后配置 API 密钥或完成身份验证。现有服务商仍可使用，包括 Charm 提供的 [Hyper][hyper]。服务订阅和账号由各服务商提供；OtterCode 是个人学习用的派生项目。

## API 密钥

OtterCode 支持 Anthropic、OpenAI、Gemini、OpenRouter 等多种服务商。按 <kbd>ctrl+l</kbd> 打开模型选择器，选择服务商，然后粘贴 API 密钥。

也可以通过环境变量配置常用服务商：

| 环境变量                    | 服务商                                    |
| --------------------------- | ----------------------------------------- |
| `HYPER_API_KEY`             | [Charm Hyper][hyper]                      |
| `ANTHROPIC_API_KEY`         | Anthropic                                 |
| `OPENAI_API_KEY`            | OpenAI                                    |
| `VERCEL_API_KEY`            | Vercel AI Gateway                         |
| `GEMINI_API_KEY`            | Google Gemini                             |
| `ZAI_API_KEY`               | Z.ai                                      |
| `MINIMAX_API_KEY`           | MiniMax                                   |
| `SYNTHETIC_API_KEY`         | Synthetic                                 |
| `HF_TOKEN`                  | Hugging Face 推理服务                     |
| `CEREBRAS_API_KEY`          | Cerebras                                  |
| `OPENROUTER_API_KEY`        | OpenRouter                                |
| `IONET_API_KEY`             | io.net                                    |
| `ALIBABA_SINGAPORE_API_KEY` | 阿里云（新加坡）                          |
| `ALIBABA_US_API_KEY`        | 阿里云（美国）                            |
| `GROQ_API_KEY`              | Groq                                      |
| `AVIAN_API_KEY`             | Avian                                     |
| `OPENCODE_API_KEY`          | OpenCode Zen & Go                         |
| `VERTEXAI_PROJECT`          | Google Cloud VertexAI (Gemini)            |
| `VERTEXAI_LOCATION`         | Google Cloud VertexAI (Gemini)            |
| `AWS_ACCESS_KEY_ID`         | Amazon Bedrock (Claude)                   |
| `AWS_SECRET_ACCESS_KEY`     | Amazon Bedrock (Claude)                   |
| `AWS_REGION`                | Amazon Bedrock (Claude)                   |
| `AWS_PROFILE`               | Amazon Bedrock（自定义配置档）            |
| `AWS_BEARER_TOKEN_BEDROCK`  | Amazon Bedrock                            |
| `AZURE_OPENAI_API_ENDPOINT` | Azure OpenAI 模型                         |
| `AZURE_OPENAI_API_KEY`      | Azure OpenAI 模型（使用 Entra ID 时可选） |
| `AZURE_OPENAI_API_VERSION`  | Azure OpenAI 模型                         |
| `MOONSHOT_API_KEY`          | Moonshot                                  |

[hyper]: https://hyper.charm.land

OtterCode 还支持几乎所有其他服务商，包括[本地模型](#本地模型)。详情见下文的[自定义服务商](#自定义服务商)。

### 服务商与模型列表

希望 OtterCode 支持新的服务商，或者发现某个模型的信息需要更新？

OtterCode 的默认模型列表由 [Catwalk](https://github.com/charmbracelet/catwalk) 管理。这是一个由社区维护的开源模型目录，欢迎参与贡献。

<a href="https://github.com/charmbracelet/catwalk"><img width="174" height="174" alt="Catwalk 标识" src="https://github.com/user-attachments/assets/95b49515-fe82-4409-b10d-5beb0873787d" /></a>

## 配置

> [!TIP]
> OtterCode 内置了用于配置自身的技能。大多数情况下，你只需要告诉它想配置什么，它就能帮助完成。

OtterCode 无需额外配置即可运行。如果需要自定义行为，可以使用 `ottercoderc`。

`ottercoderc` 是带有 OtterCode 专用内置命令的 Bash 脚本，类似于专供 OtterCode 使用的 `.bashrc`。由于程序内置了原生 Bash 解释器，这种配置方式在所有平台上行为一致，包括 Windows。

例如：

```bash
# Add Ollama.
provider add ollama --type ollama --base-url "http://localhost:11434/v1"

# Register a model on Ollama.
model add ollama/llama3.3 --name "Llama 3.3" --context-window 128000

# Auto-approve some tools.
permissions allow view edit

# Include some other file on a specific machine.
if [[ $HOSTNAME == "babysquid" ]]; then
    source ~/my-stuff/babysquid.sh
fi

# Add an MCP server, with a GitHub API token stored in 1Password.
mcp add github \
  --type http \
  --url "https://api.github.com/mcp/" \
  --header Authorization "Bearer $(op read 'op://my-secret-key')"
```

配置既可以放在项目中，也可以设置为全局配置，优先级如下：

| 优先级 | 类 Unix 系统                      | Windows                                       |
| ------ | --------------------------------- | --------------------------------------------- |
| 1      | `./.ottercoderc`                  | `.\.ottercoderc`                              |
| 2      | `./ottercoderc`                   | `.\ottercoderc`                               |
| 3      | `~/.config/ottercode/ottercoderc` | `%USERPROFILE%\.config\ottercode\ottercoderc` |

OtterCode 遵循 [XDG 基础目录规范][xdg]，因此实际路径可能随 `XDG_CONFIG_HOME` 的值而变化。`~/.local/share/ottercode` 和 `%LOCALAPPDATA%\ottercode` 等数据目录只保存 JSON 状态；程序不会执行这些目录中的 `ottercoderc`。

[xdg]: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html

旧的 JSON 配置格式仍然受支持，但已被标记为弃用。详情见[配置文档](./docs/config/)。

> [!TIP]
> 可以通过以下环境变量覆盖用户配置目录和数据配置目录的位置：
>
> - `OTTERCODE_GLOBAL_CONFIG`
> - `OTTERCODE_GLOBAL_DATA`

此外，OtterCode 会在下面的位置保存应用状态等临时数据。这些内容属于程序状态，不应手动修改，也不应当作用户配置。

```bash
# Unix
$HOME/.local/share/ottercode/ottercode.json

# Windows
%LOCALAPPDATA%\ottercode\ottercode.json
```

#### 配置安全说明

`ottercoderc` 和 `ottercode.json` 都应视为可信代码：`ottercoderc` 在完整的 shell 环境中执行，`ottercode.json` 中的 `$(...)` 也会在加载时执行。不要在未检查配置的目录中启动 OtterCode，也不要随意在配置中 `source` 来自互联网的文件。

### 环境变量

顶层 `env` 字段会在程序启动、配置服务商之前设置环境变量。这适用于影响服务商身份验证的变量，例如 AWS SDK 凭据链使用的变量，无需额外编写包装 `ottercode` 命令的 shell 脚本，也无需在 shell 配置中导出它们：

```json
{
  "$schema": "https://raw.githubusercontent.com/ZoeySigel/ottercode/main/schema.json",
  "env": {
    "AWS_PROFILE": "my-sso-profile"
  }
}
```

这些值支持与其他配置字段相同的 `$VAR` 和 `$(command)` 展开方式，因此可以引用已有环境变量，也可以执行 shell 命令获取值。

### 主题

OtterCode 提供内置配色主题。

#### 切换主题

按 `ctrl+p` 打开命令面板，选择 **Themes（主题）**，然后浏览列表。移动选中项时，界面会实时预览对应主题。按 `enter` 确认，按 `esc` 取消并恢复原主题。

#### 编辑主题

打开 **Themes（主题）**，选中要自定义的主题，然后按 `ctrl+e`。输入时会实时预览修改效果。按 `enter` 或 `ctrl+s` 保存，按 `esc` 取消并恢复。用户主题全局保存在 OtterCode 配置目录下的 `themes/` 中。

也可以通过配置中的 `active_theme` 直接选择主题：

```json
{
  "$schema": "https://raw.githubusercontent.com/ZoeySigel/ottercode/main/schema.json",
  "options": {
    "tui": {
      "active_theme": "gruvbox-dark"
    }
  }
}
```

自定义主题配色以 JSON 文件形式保存在全局主题目录。例如，`~/.config/ottercode/themes/my-theme.json`：

```json
{
  "base": "gruvbox-dark",
  "primary": "#ff6b6b",
  "bg_base": "#1a1a2e"
}
```

将 `active_theme` 设置为 `my-theme`，或在 **Themes（主题）** 对话框中选择它即可启用。

#### 内置主题

| 主题                | 配置名称            |
| ------------------- | ------------------- |
| Otter River（默认） | `otter-river`       |
| Charmtone Pantera   | `charmtone-panther` |
| Gruvbox Dark        | `gruvbox-dark`      |

### LSP 服务

OtterCode 可以通过 LSP 获取额外的代码上下文，帮助做出判断。可以手动添加 LSP 服务：

```bash
# ottercoderc

lsp add go --command "gopls" --env "GOTOOLCHAIN go1.24.5"
lsp add typescript --command "typescript-language-server" --args --stdio
lsp add nix --command "nil"
```

### MCP 服务

OtterCode 支持模型上下文协议（Model Context Protocol，MCP）服务，并提供三种传输方式：用于命令行服务的 `stdio`、用于 HTTP 端点的 `http`，以及用于服务器发送事件（Server-Sent Events）的 `sse`。

```bash
# ottercoderc

# Add a local MCP server that runs a Node.js script.
mcp add filesystem --command node --args /path/to/mcp-server.js \
  --timeout 10 --disabled-tools some-tool-name --env NODE_ENV production

# Add a GitHub MCP server that uses an API token.
mcp add github --type http --url https://api.github.com/mcp/ \
  --timeout 10 --header Authorization "Bearer $GH_PAT" \
  --disabled-tools create_issue --disabled-tools create_pull_request

# Add a streaming MCP server that uses SSE.
mcp add streaming-service --type sse --url "https://example.com/mcp/sse" \
  --timeout 10 --header API-Key "$API_KEY"
```

#### MCP OAuth 身份验证

需要 OAuth 的 HTTP 和 SSE MCP 服务可以使用 OtterCode 内置的授权码流程，替代静态 `Authorization` 请求头。设置 `"oauth": true` 即可启用：

```json
{
  "mcp": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "oauth": true
    }
  }
}
```

##### 预注册客户端

部分服务，例如 GitHub 和 Slack，不支持动态客户端注册。对于这类服务，需要先在服务商处注册 OAuth 应用，再直接提供凭据。所有配置值都支持 shell 展开：

```json
{
  "mcp": {
    "github": {
      "type": "http",
      "url": "https://api.github.com/mcp/",
      "oauth": true,
      "oauth_client_id": "Iv1.abc123def456",
      "oauth_client_secret": "$GITHUB_MCP_SECRET",
      "oauth_callback_port": 40704
    }
  }
}
```

设置 `oauth_client_id` 后，OtterCode 会跳过动态客户端注册，并以指定客户端身份进行验证。未设置时，程序会自动尝试动态注册，适用于 Linear、Notion 以及其他支持 RFC 7591 的服务。

#### 无会话服务

部分 HTTP MCP 服务不维护会话：它们不会返回 `Mcp-Session-Id`，也会拒绝 OtterCode 为接收列表变更通知而打开的 `subscriptions/listen` 流，进而导致连接失败。OtterCode 会自动识别已知的无会话服务，包括 GitHub MCP 和 `api.githubcopilot.com/mcp`，这些服务无需额外配置。

对于其他无会话服务，可以显式设置 `"sessionless": true`，或在 `ottercoderc` 中设置 `--sessionless true`。对于自动识别的 URL，设置为 `false` 可以强制使用默认会话行为。无会话模式的代价是无法接收工具、提示词和资源列表变更的实时推送通知。

### 钩子

OtterCode 初步支持钩子功能。详情见[钩子指南](./docs/hooks/)。

### 多客户端共享工作区

当 OtterCode 连接共享后端运行时，例如两个 TUI 客户端连接同一个 `ottercode serve`，客户端会按解析后的 `--cwd` 分组为**工作区**。具有相同 `--cwd` 的客户端会加入同一个底层工作区，共享会话列表、消息历史、权限队列、LSP 和 MCP 状态。

加入工作区无需额外操作：第二个客户端只需指定同一个工作目录，即可连接现有工作区。不过，每次启动默认都会创建各自的新会话。若要继续另一个客户端已经打开的对话，可以在会话管理器（会话选择器）中选中该会话。列表中会显示两个状态：

- `IsBusy`：该会话中的智能体正在处理一轮任务时为真。
- `AttachedClients`：当前正在查看该会话的客户端数量。

`AttachedClients` 非零时，通常结合 `IsBusy` 可以判断该会话正在另一个客户端中进行。加入后会实时显示同一会话的内容。

第一个创建工作区的客户端会确定进程级参数。特别是 `--yolo` 和 `--debug` 遵循**先到先定**规则：后续客户端即使以不同的参数值连接相同的 `--cwd`，也不会改变正在运行的工作区。程序会在调试日志中记录参数不一致的情况，工作区则继续使用创建时的参数。

只要至少有一个客户端保持与工作区的 SSE 事件流连接，工作区就会继续存在。最后一个事件流断开后，工作区会被销毁。在 `POST /v1/workspaces` 调用后，程序会保留一个短暂的宽限期，避免刚创建工作区、尚未打开事件流的客户端在连接前被清理。

### 全局上下文文件

OtterCode 会自动加载两个文件，用于提供跨项目的指令。可以将它们视为系统提示词的个人补充：

- `~/.config/ottercode/OTTERCODE.md`：保存 OtterCode 专用规则，避免其他编程智能体误读。如果只使用 OtterCode，通常只需编辑这个文件。
- `~/.config/AGENTS.md`：保存其他编程工具也可能读取的通用指令。避免在这里引用 OtterCode 专用功能或工作流程。如果同时使用多个编程智能体，并希望共享指令，可以使用这个文件。

可以通过 `option global-context-path` 自定义路径。重复执行该命令可以添加多个路径：

```bash
# Load a single markdown file.
option global-context-path "~/path/to/custom/context/file.md"

# Recursively load all Markdown files in the folder.
option global-context-path "/full/path/to/folder/of/files/"
```

### 忽略文件

OtterCode 默认遵循 `.gitignore`，也可以通过 `.ottercodeignore` 指定额外需要忽略的文件和目录。这适用于希望保留在版本控制中，但不希望 OtterCode 在提供上下文时读取的文件。

`.ottercodeignore` 的语法与 `.gitignore` 相同，可以放在项目根目录或子目录中。

### 允许工具调用

默认情况下，OtterCode 在运行工具调用前会请求授权。可以将部分工具设为无需提示即可执行，使用时请谨慎。

```bash
permissions allow view ls grep edit mcp_context7_get-library-doc
```

### 禁用内置工具

也可以禁止某些工具，使它们完全不出现在智能体可用的工具列表中：

```bash
permissions deny bash sourcegraph
```

若要禁用 MCP 服务中的工具，请参阅 [MCP 配置部分](#mcp-服务)。

### 跳过权限提示

使用 `--yolo` 参数运行 OtterCode，可以完全跳过所有权限提示。请谨慎使用此功能。

### 禁用技能

可以完全禁止 OtterCode 使用指定技能。被禁用的技能不会出现在智能体的可用技能列表中，包括内置技能和从磁盘发现的技能。

```bash
option disable-skill ottercode-config
```

### 智能体技能

OtterCode 支持 [Agent Skills](https://agentskills.io) 开放标准，可以通过可复用的技能包扩展智能体能力。技能是包含 `SKILL.md` 指令文件的文件夹，OtterCode 可以发现这些技能，并按需启用。

程序会在以下全局路径中查找技能：

- `$OTTERCODE_SKILLS_DIR`
- `$XDG_CONFIG_HOME/agents/skills` 或 `~/.config/agents/skills/`
- `$XDG_CONFIG_HOME/ottercode/skills` 或 `~/.config/ottercode/skills/`
- `~/.agents/skills/`
- `~/.claude/skills/`
- 在 Windows 上，还会查找：
  - `%LOCALAPPDATA%\agents\skills\` 或 `%USERPROFILE%\AppData\Local\agents\skills\`
  - `%LOCALAPPDATA%\ottercode\skills\` 或 `%USERPROFILE%\AppData\Local\ottercode\skills\`
- `options.skills_paths` 中配置的其他路径。

此外，还会从项目中的以下相对路径加载技能：

- `.agents/skills`
- `.ottercode/skills`
- `.claude/skills`
- `.cursor/skills`

也可以在配置中显式指定技能目录：

```bash
option skill-path "$HOME/squid-skills" "./other-skills"
```

可以从 [anthropics/skills](https://github.com/anthropics/skills) 获取示例技能：

```bash
# Unix
mkdir -p ~/.config/ottercode/skills
cd ~/.config/ottercode/skills
git clone https://github.com/anthropics/skills.git _temp
mv _temp/skills/* . && rm -rf _temp
```

```powershell
# Windows (PowerShell)
mkdir -Force "$env:LOCALAPPDATA\ottercode\skills"
cd "$env:LOCALAPPDATA\ottercode\skills"
git clone https://github.com/anthropics/skills.git _temp
mv _temp/skills/* . ; rm -r -force _temp
```

#### 用户可调用的技能

技能可以作为命令出现在命令面板（<kbd>ctrl+p</kbd>）中。在技能的 YAML 前置元数据中添加 `user-invocable: true` 即可：

```yaml
---
name: my-hot-skill
description: A skill that can be invoked as a command.
user-invocable: true
---
```

用户可调用的技能会在命令面板中带有 `user:` 或 `project:` 前缀：

- 全局目录中的技能显示为 `user:skill-name`。
- 项目目录中的技能显示为 `project:skill-name`。

调用技能时，其指令会被加载到当前对话上下文中。

如果希望禁止模型自动触发某个技能，但仍允许用户手动调用，可以添加 `disable-model-invocation: true`：

```yaml
---
name: my-skill
description: Only invocable by users, not the model.
user-invocable: true
disable-model-invocation: true
---
```

设置了 `disable-model-invocation` 的技能不会出现在模型的可用技能列表中，但仍可由用户手动调用。

### 桌面通知

工具调用需要授权或智能体完成一轮任务时，OtterCode 会发送桌面通知。只有终端窗口未获得焦点，并且终端支持报告焦点状态时，才会发送通知。

```bash
# Choose auto, native, osc, bell, or disabled.
option notifications disabled
```

`auto` 模式在本地使用原生通知，通过 SSH 运行时则在终端支持的情况下使用 OSC 通知。

### 项目初始化

初始化项目时，OtterCode 会分析代码库并创建上下文文件，帮助它在后续会话中更有效地工作。默认文件名为 `AGENTS.md`，也可以通过 `initialize-as` 自定义名称和位置：

```bash
# ottercoderc
option initialize-as AGENTS.md
```

如果偏好其他命名方式，或者希望将文件放在特定目录中，例如 `OTTERCODE.md` 或 `docs/LLMs.md`，可以使用这个选项。OtterCode 会将初始化时发现的构建命令、代码模式和项目约定等上下文写入该文件。

### 署名设置

默认情况下，OtterCode 会为它创建的 Git 提交和拉取请求（PR）添加辅助创作署名。可以通过 `option` 命令调整此行为：

```bash
option attribution-trailer-style co-authored-by
option attribution-generated-with true
```

- `trailer_style`：控制提交说明末尾的署名格式，默认值为 `assisted-by`。
  - `assisted-by`：按照[相关约定](https://docs.kernel.org/process/coding-assistants.html#attribution)添加 `Assisted-by: OtterCode:[ModelID]`。
  - `co-authored-by`：添加 `Co-Authored-By: OtterCode <ottercode@charm.land>`。
  - `none`：不添加署名。
- `generated_with`：为真时（默认），在提交说明和 PR 描述中添加 `💘 Generated with OtterCode`。

### 自定义服务商

OtterCode 支持兼容 OpenAI 和 Anthropic API 的自定义服务商配置。

> [!NOTE]
> OpenAI 相关配置支持两种不同的类型，请按实际服务选择：
>
> - `openai`：用于通过代理或路由访问 OpenAI 的情况。
> - `openai-compat`：用于其他提供 OpenAI 兼容 API 的服务商。

#### OpenAI 兼容 API

下面是使用 OpenAI 兼容 API 的 DeepSeek 配置示例。使用前，请在环境中设置 `DEEPSEEK_API_KEY`。

```bash
provider add deepseek --type openai-compat \
  --base-url "https://api.deepseek.com/v1" \
  --api-key "$DEEPSEEK_API_KEY"

model add deepseek/deepseek-chat \
  --name "Deepseek V3" \
  --context-window 64000 \
  --default-max-tokens 5000 \
  --price-input 0.27 \
  --price-output 1.1 \
  --price-cache-create 1.1 \
  --price-cache-hit 0.07
```

#### Anthropic 兼容 API

自定义 Anthropic 兼容服务商的配置格式如下：

```bash
provider add custom-anthropic \
  --type anthropic \
  --base-url "https://api.anthropic.com/v1" \
  --api-key "$ANTHROPIC_API_KEY" \
  --extra-header anthropic-version 2023-06-01

model add custom-anthropic/claude-sonnet-4-20250514 \
  --name "Claude Sonnet 4" \
  --context-window 200000 \
  --default-max-tokens 50000 \
  --can-reason true \
  --supports-images true \
  --price-input 3 \
  --price-output 15 \
  --price-cache-create 3.75 \
  --price-cache-hit 0.3
```

### Amazon Bedrock

OtterCode 目前支持通过 Bedrock 运行 Anthropic 模型，但未启用缓存。

当 OtterCode 找到 AWS 凭据时，Bedrock 会出现在服务商列表中。可以通过以下两种方式完成身份验证：

**API 密钥。** 将 `AWS_BEARER_TOKEN_BEDROCK` 设置为 Bedrock API 密钥。这是最简单的方式，且不会在会话进行到一半时过期。

**AWS 凭据链（SSO、配置档、访问密钥）。** 使用 `aws configure` 或 `aws configure sso` 等标准方式配置 AWS。OtterCode 会使用 AWS SDK 凭据链解析出的凭据，包括 `AWS_PROFILE`、`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 或 SSO 会话。若要选择特定配置档，可在 shell 中设置 `AWS_PROFILE`，例如 `AWS_PROFILE=myprofile ottercode`，也可以在顶层 [`env`](#环境变量) 配置中设置。

如果通过 AWS SSO 验证身份，会话会定期过期。可以将 `aws_auth_refresh` 设置为刷新凭据的命令。当 Bedrock 返回凭据错误时，OtterCode 会运行该命令，然后直接重试请求，无需手动重启，也不会生成重复消息：

```json
{
  "$schema": "https://raw.githubusercontent.com/ZoeySigel/ottercode/main/schema.json",
  "env": {
    "AWS_PROFILE": "my-sso-profile"
  },
  "providers": {
    "bedrock": {
      "aws_auth_refresh": "aws sso login --profile my-sso-profile"
    },
    "bedrock-europe": {
      "aws_auth_refresh": "aws sso login --profile my-eu-sso-profile"
    }
  }
}
```

- `aws_auth_refresh`：AWS 凭据过期时运行的 shell 命令，例如 `aws sso login`。

### Vertex AI 平台

设置 `VERTEXAI_PROJECT` 和 `VERTEXAI_LOCATION` 后，Vertex AI 会出现在可用服务商列表中。还需要完成身份验证：

```bash
$ gcloud auth application-default login
```

如果需要在配置中添加特定模型，可以使用以下方式：

```bash
# ottercoderc — authentication still comes from gcloud and the VERTEXAI_* env vars.
provider add vertexai --type google-vertex

model add vertexai/claude-sonnet-4@20250514 \
  --name "VertexAI Sonnet 4" \
  --context-window 200000 \
  --default-max-tokens 50000 \
  --can-reason true \
  --supports-images true \
  --price-input 3 \
  --price-output 15 \
  --price-cache-create 3.75 \
  --price-cache-hit 0.3
```

### 本地模型

OtterCode 可以自动发现本地服务商提供的模型。添加自定义服务商时，将 `type` 设置为 `llamacpp`、`omlx`、`lmstudio`、`litellm` 或 `ollama`，并省略模型列表，程序就会自动填充可用模型。

```bash
# Piece of cake.
provider add ollama \
  --name Ollama \
  --type ollama \
  --base-url "http://localhost:11434/v1/"
```

对于 llama.cpp（`llama-server`），请使用服务器的基础 URL：

```bash
provider add llamacpp \
  --name "llama.cpp" \
  --type llamacpp \
  --base-url "http://localhost:2222"
```

#### 手动配置模型

仍然可以显式配置模型列表。用户定义的模型始终优先于自动发现的模型，手动设置的字段不会被自动发现结果覆盖。

对于任何 `openai-compat` 服务商，当模型列表为空时会运行自动发现。设置 `"discover_models": true` 后，则会将发现的模型与手动配置的模型合并。

```bash
# ottercoderc
provider add ollama \
  --name Ollama \
  --type ollama \
  --base-url "http://localhost:11434/v1/" \
  --discover-models true

model add ollama/qwen3:30b \
  --name "Qwen 3 30B" \
  --context-window 256000 \
  --default-max-tokens 20000
```

`--discover-models true` 会将自动发现的模型与上述模型合并；字段冲突时，优先使用手动配置的值。

## 日志

需要排查问题时，可以查看日志。OtterCode 会记录多种运行信息，日志默认位于项目目录下的 `./.ottercode/logs/ottercode.log`。

命令行提供了便于查看最近日志的辅助命令：

```bash
# Print the last 1000 lines
ottercode logs

# Print the last 500 lines
ottercode logs --tail 500

# Follow logs in real time
ottercode logs --follow
```

如果需要更详细的日志，可以使用 `--debug` 参数运行 `ottercode`，或者在 `ottercoderc` 中启用：

```bash
# ottercoderc
option debug true
option debug-lsp true
```

## 服务商自动更新

默认情况下，OtterCode 会从开源服务商与模型目录 [Catwalk](https://github.com/charmbracelet/catwalk) 获取最新列表。当新增服务商或模型，或者模型元数据发生变化时，程序会自动更新本地配置。

### 自定义服务商目录

可以覆盖 [Catwalk](https://github.com/charmbracelet/catwalk) 的默认 URL，用于测试或使用自己的派生目录服务。

设置 `CATWALK_URL` 环境变量即可，例如 `export CATWALK_URL=http://localhost:8000`。

### 禁用服务商自动更新

如果网络访问受到限制，或者需要在隔离网络环境中工作，可以禁用自动更新。

在 `ottercoderc` 中配置：

```bash
option provider-auto-update false
```

也可以设置 `OTTERCODE_DISABLE_PROVIDER_AUTO_UPDATE` 环境变量：

```bash
export OTTERCODE_DISABLE_PROVIDER_AUTO_UPDATE=1
```

### 手动更新服务商

使用 `ottercode update-providers` 命令可以手动更新服务商列表：

```bash
# Update providers remotely from Catwalk.
ottercode update-providers

# Update providers from a custom Catwalk base URL.
ottercode update-providers https://example.com/

# Update providers from a local file.
ottercode update-providers /path/to/local-providers.json

# Reset providers to the embedded version, embedded at ottercode at build time.
ottercode update-providers embedded

# For more info:
ottercode update-providers --help
```

## 使用统计

OtterCode 会记录与设备特定哈希关联的化名化使用统计，以帮助维护者确定开发和支持工作的优先级。统计只包含使用元数据，**不会收集提示词或模型回复**。

具体收集内容可在源码中查看：[事件模块](https://github.com/ZoeySigel/ottercode/tree/main/internal/event)和[智能体事件代码](https://github.com/ZoeySigel/ottercode/blob/main/internal/llm/agent/event.go)。

可以随时通过以下环境变量关闭统计收集：

```bash
export OTTERCODE_DISABLE_METRICS=1
```

OtterCode 也遵循 [`DO_NOT_TRACK`](https://donottrack.sh/) 约定，可以通过 `export DO_NOT_TRACK=1` 启用。

## 常见问题

### 为什么剪贴板复制和粘贴无法使用？

在类 Unix 环境中，可能需要安装额外工具。

| 环境                | 工具                    |
| ------------------- | ----------------------- |
| Windows             | 原生支持                |
| macOS               | 原生支持                |
| Linux/BSD + Wayland | `wl-copy` 和 `wl-paste` |
| Linux/BSD + X11     | `xclip` 或 `xsel`       |

## 参与贡献

请参阅[贡献指南](https://github.com/ZoeySigel/ottercode?tab=contributing-ov-file#contributing)。

## 项目来源与许可证

本项目基于 Charmbracelet 的 [Crush](https://github.com/charmbracelet/crush) 修改，保留原作者版权和 [FSL-1.1-MIT 许可证](LICENSE.md)。第三方服务和依赖保留原有名称与服务地址。
