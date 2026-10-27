# ottercode 架构

## 一次任务如何运行

CLI 解析配置并获取项目会话写锁。TaskRuntime 持有 Agent、待审批与状态，交互终端通过带事件游标的 SSE 订阅；非交互模式直接消费同一套 AgentEvent。完整扩展接口与语义见 [四项功能说明](advanced-features.md)。

```text
CLI / Terminal
      │ HTTP 提交、审批、取消 / SSE 事件、重放、状态快照
      ▼
  TaskRuntime ── WorkspaceClient（指数退避重连）
      │
    Agent ──────────── SessionStore
      │                  │ journal + atomic snapshot
      ├── Instructions   └── text baseline + command logs
      │
      ├── ModelProvider.stream()
      │      └── Chat Completions / SSE
      │
      └── Hooks（并发、合并、拒绝优先、超时）
             │ JSON Schema / 目录指令 / 授权
          ToolRegistry
             ├── list_files / search_text / read_file
             ├── write_file / edit_file
             ├── run_command ── authorization ── process tree
             └── delegate_task ── 独立子会话 / 共享预算 / 费用归集
```

Agent 每次收集完整模型回复后，将 assistant 消息持久化，再串行调用工具。工具结果以独立 `tool` 消息保存并回填下一次模型请求。工具失败属于可观察结果，模型可以据此调整；模型协议错误、容量不足或存储错误会终止任务。

Agent 使用异步事件队列转发命令输出与状态。运行时持续消费它，终端 SSE 断线不会退出 Agent 迭代器。直接使用 Agent.run 的消费者提前退出仍会取消执行。每个工作区一次只运行一个根任务，子任务串行执行。

## 接口

公共类型集中于 `src/types.ts`。

| 接口 | 约定 |
| --- | --- |
| `ModelProvider.stream(request, signal)` | 提供文本、完整工具调用、usage 和 finish 事件；异常抛出错误 |
| `Agent.run(input, session, signal)` | 返回可取消的异步事件流 |
| `Tool` | 名称、说明、JSON Schema 和异步 execute；不持有 Agent 全局状态 |
| `ToolContext` | 显式注入项目目录、输出目录、shell、授权、取消、变更记录和命令基线 |
| `ToolResult` | `success / failure / denied / cancelled`，以及退出码、耗时、输出文件和截断状态 |
| `SessionStore.commit()` | 先 fsync 日志，再更新内存和原子快照 |
| `HookRunner.check()` | 并发检查原参数独立副本，配置顺序浅合并，终止优先于拒绝优先于放行 |
| `TaskRuntime / WorkspaceClient` | 任务独立于连接生命周期，事件游标补发和快照重同步 |

新增工具时实现 `Tool` 并传给 `ToolRegistry`，Schema 在注册时编译，调用前严格校验。新增模型协议时实现 `ModelProvider`，沿用现有 Agent 和工具，不修改终端。

## 不完整响应与中断

SSE 先按字节流解码，再按空行分隔事件；工具参数按 index 累积。在确认 finish_reason、所有参数 JSON 和调用 ID 有效后才暴露工具调用。输出截断、未知终止原因、无终止标记和断流均不会执行不完整调用。

临时连接错误、HTTP 429 和 5xx 最多重试两次；已经收到任何文本或工具参数增量的响应不重试。每次尝试受请求超时和用户取消共同控制。

用户中断后，当前命令及其子进程树被终止，剩余工具补齐 cancelled 结果。会话崩溃恢复只恢复记录，不恢复执行。没有结果的历史调用会标注中断且结果未知，让下一轮检查实际文件状态。

## 持久化

```text
~/.ottercode/
  config.json
  server.json
  projects/<项目路径哈希>/<会话UUID>/
    session.lock
    snapshot.json
    journal.jsonl
    baseline/<项目相对路径>
    outputs/<命令UUID>.log
```

快照还包含父子会话关系、唯一 usage 记录、累计用量、价格计算结果及上下文 Token 校准信息。JSONL 保存消息、工具、Hook、压缩、基线和费用事件。恢复时重放快照之后的日志，裁掉损坏尾行，修复工具配对，并对后代费用去重补账。

首次获批命令执行前，将 `.gitignore` 可见的 UTF-8 文本文件复制到会话基线目录，再提交基线清单。`/diff` 合并当前文件、基线文件和文件工具修改记录，优先采用文件工具保存的更早基线。命令基线最多枚举 100000 个文件，单文件不超过 8 MiB；达到枚举上限时命令尚未执行并返回明确错误。

基线只是 diff 来源，不是回滚事务。命令执行、文件写入和日志提交之间无法形成跨进程原子事务，因此崩溃后不会推测操作是否可以重试。

## 目录指令与上下文

根目录 AGENTS.md 加入系统上下文。每次工具调用前，按路径由根向下发现适用指令；修改操作若首次发现新指令，会先返回而不执行。下一次模型请求可看到指令。任意 shell 命令无法静态判断所有目标路径，模型需要遵守已经读取的目录指令。

上下文优先按服务报告的输入 Token 校准，再用 tokenizer 估算新增消息，包含系统提示、工具和输出预留。保留近期完整组，必要时由六组缩为两组；过长旧历史分段归纳，加入当前目标及实际文件差异。摘要完整、非空且能缩小上下文才提交。所有摘要与子任务调用均计入根任务共享预算；历史 JSONL 不重新加入模型上下文。

## 验证与边界

核心测试使用可注入 Provider；协议测试构造任意 UTF-8 分片；端到端测试启动真实 HTTP SSE 服务与 CLI 子进程。命令测试执行真实 shell，并验证进程树取消。终端测试独立覆盖输入编辑与 Ink 原始输入通道。

文件工具验证词法路径及现有祖先 realpath，枚举不跟随符号链接。命令拥有用户权限，Hook 与文件边界不是操作系统沙箱。子任务共享工作目录并串行执行；当前没有 MCP、Skills、自动 Git 提交、发布或自动撤销。
