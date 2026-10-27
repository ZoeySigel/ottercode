# 四项功能的实现与验证

## 1. 工具执行前 Hook

执行顺序为「并发 Hook → 按配置顺序合并 → 检查最终参数 Schema → 路径和目录指令检查 → 权限审批 → 执行」。Hook 不能更换工具名称与调用 ID。

在 `~/.ottercode/config.json` 添加以下配置，将脚本路径换成实际绝对路径：

```json
{
  "hooks": [
    {
      "name": "review",
      "command": ["node", "D:/coding/Otter Code/examples/hooks/review.mjs"],
      "timeoutMs": 3000,
      "tools": ["write_file", "edit_file", "run_command"]
    }
  ]
}
```

`tools` 省略时检查全部工具，包括委派调用。每个 Hook 运行独立进程，从 stdin 接收一份 JSON，包含 `call / sessionId / parentSessionId / root / approval`；stdout 必须只返回决策 JSON，诊断写入 stderr。不会把 OTTERCODE_API_KEY 环境变量传给 Hook。

```json
{
  "action": "allow",
  "argsPatch": { "timeout_ms": 30000 },
  "requireApproval": true,
  "reason": "命令需要用户审批"
}
```

- action 为 allow、deny 或 terminate，省略视为 allow。优先级是 **terminate > deny > allow**，后面的放行不能覆盖拒绝。
- 所有 Hook 并发执行，分别接收原参数的独立副本；按配置顺序浅合并 argsPatch，后面的同名字段覆盖前面。requireApproval 做逻辑 OR。
- allow 不能跳过原有命令审批。requireApproval 可使 auto 模式的命令或普通文件工具仍需确认，审批展示修改后的参数。
- 超时默认 3000 ms，用户配置最大 60000 ms。超时、异常、无效输出按 deny 处理；外部进程会清理进程树。程序内自定义异步 Hook 需遵守 AbortSignal，不能执行同步阻塞代码。
- terminate 会停止整个任务树，并为当前轮剩余调用补齐取消结果。决策与有效参数保存在 JSONL 审计记录中。

示例脚本演示 protected 目录拒绝、文件修改审批、命令参数修正，以及 `OTTERCODE_STOP=1` 时终止任务。Hook 是用户配置的本地程序，不构成操作系统沙箱。

实现见 `src/hooks.ts`、`src/agent.ts`，验证见 `test/hooks.test.ts`。

## 2. SSE 工作区与终端恢复

```powershell
# 终端一：模型配置留在服务进程
ottercode --serve --cwd "D:\your-project" --port 4317

# 终端二：通过 SSE 跟踪工作区
ottercode --connect http://127.0.0.1:4317
```

服务持有任务、会话写锁、工具状态和待审批列表。终端通过 SSE 接收文本增量、Hook 决策、工具状态、子任务状态、用量和快照。默认交互模式也使用这套传输，`-p` 仍保留直接执行的脚本接口。

服务只监听 127.0.0.1，所有 HTTP 接口要求 Bearer token，并拒绝带 Origin 的浏览器请求。默认生成凭证，保存至 `~/.ottercode/server.json`；也可在两端设置相同 OTTERCODE_SERVER_TOKEN，至少 16 个字符。连接端不需要模型密钥。

| 接口 | 用途 |
| --- | --- |
| GET /state | 工作区、任务、工具、审批、消息及费用快照 |
| GET /events | SSE，支持 Last-Event-ID |
| POST /tasks | input 字符串；可用 Idempotency-Key 防止重复提交 |
| POST /approvals/:id | approved 布尔值；已结束的审批返回 410 |
| POST /cancel | 取消当前任务或压缩操作 |
| POST /commands | command 字符串，例如 /usage 或 /sessions all |

事件 ID 由服务 epoch UUID 和递增序号组成。服务最多保留 1024 条、2 MiB 的事件。重连先补发游标之后的事件，再发送权威快照，随后继续订阅。游标过期或服务重启时直接用快照恢复。终端恢复文本、工具、待审批、会话和最终结果，不重新发起任务。

重连从 250 ms 指数增加至 10 s，并加入少量抖动；稳定连接超过 10 s 后重置退避。服务每 10 s 发心跳，客户端 30 s 无数据会重连。无效凭证不会反复重试，取消会停止重连。

关闭连接终端不会取消独立 --serve 服务中的任务；关闭服务会取消并保存中断结果，重启不重放工具。SSE 恢复指工作区到终端的连接，上游模型已输出内容后断流仍按错误收尾，避免重复请求和副作用。

实现见 `src/runtime.ts`、`src/transport.ts`、`src/remote-terminal.ts`。`test/transport.test.ts` 使用真实 HTTP socket 断开，验证消息补发、任务继续、审批恢复、游标失效及指数退避。

## 3. Token 窗口与摘要压缩

```json
{
  "contextWindow": 32768,
  "maxTokens": 4096,
  "compactThreshold": 0.7,
  "tokenizer": "o200k_base",
  "reportUsage": true
}
```

解析服务报告的 prompt_tokens、completion_tokens 和 cached_tokens。相同模型、系统提示、工具定义与消息前缀下，以真实输入 Token 加新增消息估算进行校准；模型、指令或历史变化后重新计数。未报告时使用 o200k_base 或 cl100k_base 分块估算，并缓存编码结果，避免长源码字符串的高开销。估算不声称等同于所有供应商的 tokenizer。

输入占用加输出预留达到阈值后自动摘要。按完整工具调用组切分，最近六组在必要时收缩至两组，旧历史过长则分段归纳。摘要保留进度、约束、决策、验证和待办，并加入实际文件差异、修改路径和当前目标。所有摘要完成、且确实缩小上下文后，才一次性替换并持久化；失败或中断不提交半份摘要。

摘要也计入共享调用预算和费用。JSONL 历史继续用于审计，恢复时不会重新加入模型上下文。不支持 stream_options.include_usage 的服务可配置 reportUsage 为 false，此时明确使用估算。

实现见 `src/context.ts`、`src/usage.ts`、`src/accounting.ts`，测试覆盖自动触发、压缩失败保留、用量校准和压缩后恢复。

## 4. Sub Agent 与费用归集

主 Agent 可调用 delegate_task：

```json
{
  "task": "阅读鉴权模块，列出测试可能失败的原因，返回简洁结论",
  "mode": "read_only"
}
```

子任务创建独立会话，只接收委派任务、项目指令和自身执行记录。默认 read_only 仅注册文件枚举、搜索和读取工具，显式 workspace_write 才可修改或执行命令。独立的是上下文，工作目录仍共享，并非文件系统副本。

工具只返回最多约 2000 Token 的最终答复、状态、修改路径、会话 ID 和用量；原始中间结果不进入主会话。Hook 和审批完整继承，父任务取消会传入子任务。文件写入和命令基线同步到祖先，使父会话 diff 包含子任务修改。

```json
{
  "subAgents": { "maxDepth": 1, "maxCalls": 8, "maxChildren": 4 },
  "pricing": {}
}
```

根任务默认共享 40 次调用，子任务额外受自身 8 次限制，摘要也消耗预算。默认最多 4 个子任务、一层委派。当前子任务串行执行，尚未实现多个子任务同时修改工作区。maxDepth 或 maxChildren 为 0 可关闭委派。

普通 /sessions 和 --continue 只选择顶层会话，/sessions all 可查看子会话。

每次逻辑请求生成唯一 usage 记录，包含来源会话、用途、Token、是否估算和费用。先写子会话，再用同一 ID 逐级计入祖先，相同记录不会重复累加。若在落盘和归集之间崩溃，恢复父会话时会读取后代记录补账，不重新执行任务。

pricing 按模型名配置 inputPerMillion、outputPerMillion 及可选 cachedInputPerMillion，单位为美元每百万 Token；星号键可作为默认价目。应填写供应商实际单价，本项目不附带价格表。

| /usage 字段 | 含义 |
| --- | --- |
| calls | 本会话及后代累计逻辑请求数，包含摘要 |
| inputTokens / outputTokens | 累计用量 |
| costUsd | 已配置单价部分的费用合计，可能只是总费用的一部分 |
| unpricedCalls | 未定价次数，这些单次记录的费用为 null |
| estimatedCalls | 未收到 usage 而使用估算的次数 |

服务用量优先。缺失用量、断流或失败请求仅估算逻辑请求，无法精确还原供应商内部重试和失败计费；没有价格不声称免费。旧会话可直接恢复，用量仅从升级后的新请求开始统计。

实现见 `src/tools/delegate.ts`、`src/agent.ts`、`src/accounting.ts`、`src/session.ts`。`test/subagent.test.ts` 验证上下文隔离、子任务变更、预算、取消、终止传播、费用归集和崩溃后去重补账。

## 简历表述

以下表述对应实现，不包含尚未测量的性能数字。

1. 设计工具执行前 Hook 流水线，并发执行策略检查、按配置顺序合并参数补丁，以拒绝优先、超时取消及二次校验对接权限审批，支持调用拦截和任务树终止。
2. 构建 SSE 工作区状态通道，实时推送消息、工具状态和审批请求，通过事件游标、指数退避重连、事件补发及快照同步恢复终端视图。
3. 基于模型报告用量和 tokenizer 估算管理上下文预算，触发分段摘要压缩，保留进度、文件差异、决策和待办，完整提交摘要以避免失败破坏原上下文。
4. 实现工具驱动的 Sub Agent 委派，用独立会话隔离中间上下文，仅回传摘要，通过唯一 usage 记录完成父子费用归集、共享预算与崩溃后去重补账。

验证入口为 npm run check 和 npm run test:terminal。真实模型效果、供应商账单一致性和性能提升比例需要在实际服务与任务集上测量后填写。
