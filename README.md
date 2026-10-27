# ottercode 🦦

一个在本地项目中工作的终端编程 Agent。输入任务后，它能搜索代码、读取和修改文件、请求执行命令，并根据实际结果继续工作。

支持工具调用前 Hook、工作区 SSE 状态流与断线重连、按 Token 窗口自动压缩，以及使用独立会话的子 Agent。配置、接口和简历亮点对应的实现见 [功能与实现说明](docs/advanced-features.md)。

ottercode 使用 TypeScript 和 Node.js 22+ 独立实现，借鉴 [pi-from-scratch](https://github.com/SaladDay/pi-from-scratch) 的 Agent 循环与事件流设计。核心逻辑、模型协议、工具、会话与终端界面分别组织，便于阅读和扩展。

## 快速开始

需要 Node.js **22 或更高版本**，以及支持流式 Chat Completions 和 function tools 的 OpenAI 兼容模型服务。Windows 推荐 PowerShell 7。

```powershell
npm ci
npm run build

$env:OTTERCODE_API_KEY = "你的 API key"
$env:OTTERCODE_MODEL = "你的模型名"
# 使用其他兼容服务时设置其 API 基地址，一般以 /v1 结尾
$env:OTTERCODE_BASE_URL = "https://api.openai.com/v1"

node dist/cli.js --cwd "D:\your-project"
```

macOS / Linux 的环境变量设置方式：

```sh
export OTTERCODE_API_KEY="your-api-key"
export OTTERCODE_MODEL="your-model"
export OTTERCODE_BASE_URL="https://api.openai.com/v1"
node dist/cli.js --cwd /path/to/project
```

源码运行可以使用 `npm run dev -- --cwd <项目目录>`。希望在其他目录直接使用 `ottercode` 命令时，在完成构建后运行 `npm link`。

进入交互界面后，可以输入：

```text
修复这个项目中失败的测试。先查找相关代码，修改后运行对应测试，并告诉我真实结果。
```

文件修改会自动执行。每条终端命令默认显示实际 shell、工作目录和完整命令，按 `y` 执行，按 `n`、Enter 或 Esc 拒绝。`/permissions auto` 可在当前进程中切换到自动执行；命令以当前用户权限运行，没有操作系统沙箱。

## 使用方式

```text
ottercode
ottercode --cwd <项目目录>
ottercode --continue
ottercode --resume <会话ID>
ottercode -p "解释这个项目"
ottercode -p "修复并运行测试" --approval auto
ottercode --help
ottercode --serve --cwd <项目目录>
ottercode --connect http://127.0.0.1:<服务端口>
```

`-p` 执行单个任务并退出，不需要交互终端。默认策略下，命令会返回 `denied` 而不执行；只有显式使用 `--approval auto` 或相应配置才会自动执行。

非交互模式将助手文本输出到 stdout，工具状态、结果和错误输出到 stderr。退出码为 `0`（模型正常结束任务）、`1`（错误）、`2`（调用预算耗尽或输出截断）、`130`（取消）。工具被拒绝或检查失败会回传模型；退出码 `0` 表示对话正常结束，不等同于所有检查通过。

终端操作：

| 操作 | 按键 |
| --- | --- |
| 发送 | Enter |
| 插入换行 | Alt+Enter；支持发送独立修饰键的终端也可用 Shift+Enter |
| 粘贴多行 | 直接粘贴，支持 bracketed paste |
| 调整光标 | 左右箭头、Home / End、Ctrl+A / Ctrl+E |
| 清除光标前输入 | Ctrl+U |
| 历史输入 | 单行输入时使用上下箭头 |
| 取消当前任务 | 运行期间 Ctrl+C |
| 退出 | 空闲时 Ctrl+C、Ctrl+D 或 `/exit` |

| 命令 | 作用 |
| --- | --- |
| `/help` | 查看会话命令 |
| `/new` | 新建当前项目会话 |
| `/sessions` | 列出当前项目的会话 ID、更新时间和模型 |
| `/resume <id>` | 恢复指定会话 |
| `/model [name]` | 查看或切换模型 |
| `/permissions [ask\|auto]` | 查看或切换命令确认策略 |
| `/diff` | 查看当前会话的文本文件变更，支持非 Git 项目 |
| `/compact` | 手动压缩旧上下文 |
| `/usage` | 查看当前会话及全部子任务的累计 Token 和费用 |
| `/exit` | 退出 |

## 配置

配置优先级为 **CLI 参数 > `OTTERCODE_*` 环境变量 > 用户配置 > 默认值**。模型名必须显式设置，API key 只从 `OTTERCODE_API_KEY` 读取，不会写入配置或会话。

用户配置路径为 `~/.ottercode/config.json`，可参考 [配置示例](ottercode.config.example.json)。`OTTERCODE_HOME` 可改变整个配置与会话存储目录。

| 配置字段 | 环境变量 | CLI 参数 | 默认值 |
| --- | --- | --- | --- |
| `model` | `OTTERCODE_MODEL` | `--model` | 必填 |
| `baseUrl` | `OTTERCODE_BASE_URL` | `--base-url` | `https://api.openai.com/v1` |
| `approval` | `OTTERCODE_APPROVAL` | `--approval` | `ask` |
| `maxTokens` | `OTTERCODE_MAX_TOKENS` | `--max-tokens` | `4096` |
| `contextWindow` | `OTTERCODE_CONTEXT_WINDOW` | `--context-window` | `32768` |
| `maxCalls` | `OTTERCODE_MAX_CALLS` | `--max-calls` | `40` |
| `commandTimeoutMs` | `OTTERCODE_COMMAND_TIMEOUT_MS` | `--command-timeout-ms` | `120000` |
| `requestTimeoutMs` | `OTTERCODE_REQUEST_TIMEOUT_MS` | `--request-timeout-ms` | `120000` |
| `shell` | `OTTERCODE_SHELL` | `--shell` | Windows 优先 pwsh，其次 powershell；其他系统 `/bin/sh` |

本地模型服务如果不校验 key，可以设置非空占位值。模型需要支持 `stream: true` 和工具调用，`baseUrl` 填 API 基地址，不要包含 `/chat/completions`。当前适配器使用 `max_tokens`；只接受 Responses、Anthropic Messages 或其他请求格式的服务暂不支持。不支持 `stream_options.include_usage` 的服务可设置 `reportUsage: false`，用量会标记为估算。

`/model` 和 `/permissions` 不会改写用户配置。权限切换只作用于当前会话；同一服务进程切回该会话时保留选择，新建会话使用启动时的默认策略。新进程按以上配置优先级确定模型和权限策略。

交互终端通过本机 SSE 接收消息、工具状态和审批。需要关闭终端后任务仍继续时，先运行 `ottercode --serve`，再在另一个终端用 `--connect` 连接。服务仅监听本机，连接凭证保存于用户目录 `server.json`；也可用 `OTTERCODE_SERVER_TOKEN` 显式配置。连接终端不需要模型密钥。

扩展配置包括 `hooks`、`pricing`、`tokenizer`、`compactThreshold` 和 `subAgents`，见 [功能说明](docs/advanced-features.md)。价格默认为未知；配置实际单价后按 Token 计算美元费用，未定价调用单独计数。

## 文件、会话和上下文

- 文件工具只访问项目内路径，检查 `..` 越界及指向项目外部的符号链接。搜索、枚举和命令 diff 基线遵循 `.gitignore`，跳过 `.git`、`node_modules`、`vendor`、`.venv`、`.ottercode` 和符号链接。
- 文本工具处理不超过 8 MiB 的有效 UTF-8 文件；精确编辑保留原有 CRLF/LF 和 BOM。大文件可以分段读取；超出文件上限的处理需要使用命令。
- 默认返回最多 200 行、32 KiB 的工具输出。命令完整 stdout/stderr 写入独立日志，结果包含绝对路径；界面只显示简短预览。
- `/diff` 保存文件工具的首次修改基线，并在首条获批命令执行前保存可见文本文件基线。因此也可查看命令产生的修改、新增和删除。二进制、被忽略和超过 8 MiB 的文件不在命令 diff 基线内；diff 不提供自动撤销。
- 根目录 `AGENTS.md` 自动加载。首次访问子目录会加载适用的嵌套指令；若首次修改操作发现新指令，会先回传指令，请模型重新决定，再执行后续调用。
- 会话按规范化项目路径隔离，每次启动默认新建会话。`--continue` 恢复最近会话，无历史时创建；恢复操作不重放历史工具。
- JSONL 日志先持久化，活动快照再原子替换。损坏尾行可恢复；未完成工具在恢复时补齐中断结果。会话写锁避免多个进程同时写入同一会话。
- 上下文优先使用模型报告的 prompt_tokens 校准，新增消息用配置的 tokenizer 估算，并预留输出空间。达到容量 70% 时摘要压缩，保留最近完整消息组、进度、实际文件差异、决策和待办，工具调用与结果不拆开；超长历史分段归纳，最后一次性替换活动上下文。失败和中断保留原历史。
- `delegate_task` 创建独立子会话，只把最终摘要回传主会话；默认只读，显式 workspace_write 才允许修改。子任务继承 Hook 和审批，根任务共享调用预算。费用按唯一记录 ID 归集到父会话，恢复时补齐未归集记录。

会话、日志和文本基线位于 `~/.ottercode/projects/<项目哈希>/<会话ID>/`，包含本地项目内容；删除某个会话目录即可移除对应历史，需先退出使用它的进程。

## 开发与验证

```sh
npm ci
npm run typecheck
npm run build
npm test
# 或一次完成
npm run check
```

测试使用本地模拟模型和临时项目，不需要真实 API key。端到端用例真实运行“搜索缺陷 → 读取 → 修改 → 执行 Node 测试 → 汇报”，分别验证自动批准与拒绝命令两条路径，并检查会话恢复。测试还覆盖 SSE 分片、畸形参数、超时、进程树取消、路径边界、日志恢复、上下文压缩和终端输入。

Windows、Linux、macOS 的 CI 配置位于 `.github/workflows/ci.yml`。终端交互测试使用原始输入流模拟粘贴、Alt+Enter、确认和 Ctrl+C。真实模型连通需要自行设置配置后运行任务。

可运行 `npm run test:terminal` 进行交互验收。它会启动本地模拟模型和临时中文项目，可以验证多行粘贴、确认/拒绝命令，以及输入 `cancel` 后按 Ctrl+C 中断；通过 `/exit` 退出后自动清理。该脚本不访问真实模型。当前验收结果见 [验证记录](docs/verification.md)。

架构和扩展接口见 [架构说明](docs/architecture.md) 与 [功能说明](docs/advanced-features.md)。当前版本支持主 Agent 委派子任务；Skills、MCP 和图形界面尚未加入。

## 致谢与许可

感谢 [SaladDay/pi-from-scratch](https://github.com/SaladDay/pi-from-scratch) 对最小编程 Agent 的清晰拆解。本项目借鉴其设计思想，源码独立实现，不包含其教学网站或图像资源。

MIT License，见 [LICENSE](LICENSE)。
