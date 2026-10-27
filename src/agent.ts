import type { AgentEvent, Authorize, Config, EndReason, Hook, ModelProvider, Session, ToolCall, ToolContext, ToolResult } from './types.js';
import { builtinTools, ToolRegistry } from './tools/index.js';
import { sessionDiff, SessionStore } from './session.js';
import { Instructions } from './instructions.js';
import { resolveShell } from './tools/command.js';
import { AsyncQueue, errorMessage } from './utils.js';
import { HookRunner, commandHook } from './hooks.js';
import { BudgetExceeded, CallBudget, TokenCounter } from './usage.js';
import { accountedStream } from './accounting.js';
import { compactionCut, summarizeHistory } from './context.js';
import { delegateTool } from './tools/delegate.js';
export { compactionCut } from './context.js';

export type AgentOptions = { hooks?: Hook[]; depth?: number; ancestors?: Session[]; budget?: CallBudget; readOnly?: boolean };

export function estimateTokens(value: unknown): number {
  return new TokenCounter().count(value);
}

export class Agent {
  readonly tools: ToolRegistry;
  private hooks: HookRunner;
  private counter: TokenCounter;
  constructor(readonly config: Config, readonly provider: ModelProvider, readonly store: SessionStore, readonly authorize: Authorize, tools?: ToolRegistry, private options: AgentOptions = {}) {
    this.counter = new TokenCounter(config.tokenizer);
    this.hooks = new HookRunner(options.hooks ?? config.hooks?.map(hook => commandHook(hook, config.root)));
    const builtins = builtinTools().filter(tool => !options.readOnly || ['list_files', 'search_text', 'read_file'].includes(tool.name));
    const delegate = !options.readOnly && (options.depth ?? 0) < (config.subAgents?.maxDepth ?? 1);
    this.tools = tools ?? new ToolRegistry([...builtins, ...(delegate ? [delegateTool()] : [])]);
  }

  async compact(session: Session, signal: AbortSignal, emit: (event: AgentEvent) => void = () => {}, budget = new CallBudget(this.config.maxCalls), system = ''): Promise<boolean> {
    if (!compactionCut(session.messages) || signal.aborted) return false;
    emit({ type: 'compaction', status: 'started' });
    try {
      const workspaceDiff = await sessionDiff(session, this.store);
      const changedFiles = [...new Set([...Object.keys(session.changes), ...[...workspaceDiff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(match => match[1]!)])];
      const messages = await summarizeHistory({ messages: session.messages, changedFiles, workspaceDiff, contextWindow: this.config.contextWindow, maxTokens: this.config.maxTokens, counter: this.counter, system, signal,
        stream: (prompt, content, maxTokens) => accountedStream(this.provider, { model: this.config.model, system: prompt, messages: [{ role: 'user', content }], tools: [], maxTokens }, session, this.store, this.config, budget, this.options.ancestors ?? [], 'compaction', emit, signal),
      });
      if (!messages) return false;
      await this.store.commit(session, { type: 'replace_messages', messages });
      emit({ type: 'compaction', status: 'completed' });
      return true;
    } catch (error) {
      emit({ type: 'compaction', status: 'failed' });
      if (error instanceof BudgetExceeded) throw error;
      return false;
    }
  }

  async *run(input: string, session: Session, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const queue = new AsyncQueue<AgentEvent>();
    const task = this.execute(input, session, combined, event => queue.push(event)).finally(() => queue.end());
    try { yield* queue; }
    finally { controller.abort(); await task; }
  }

  private async execute(input: string, session: Session, signal: AbortSignal, emit: (event: AgentEvent) => void): Promise<void> {
    let calls = 0;
    const budget = new CallBudget(this.config.maxCalls, this.options.budget);
    const initialCalls = budget.used;
    let end: EndReason = 'error';
    try {
      signal.throwIfAborted();
      const shell = await resolveShell(this.config.shell);
      const instructions = new Instructions(this.config.root);
      await instructions.initialize();
      if (session.model !== this.config.model) await this.store.commit(session, { type: 'model', model: this.config.model });
      await this.store.commit(session, { type: 'message', message: { role: 'user', content: input } });
      let compactionFailed = false;
      while (budget.used - initialCalls < this.config.maxCalls && budget.used < budget.limit) {
        signal.throwIfAborted();
        if (budget.terminatedReason) { end = 'terminated'; return; }
        const system = instructions.system(shell);
        const request = { model: this.config.model, system, messages: session.messages, tools: this.tools.definitions(), maxTokens: this.config.maxTokens };
        const size = this.counter.prompt(request, session.contextUsage) + this.config.maxTokens;
        if (!compactionFailed && size >= this.config.contextWindow * (this.config.compactThreshold ?? 0.7) && compactionCut(session.messages)) {
          compactionFailed = !await this.compact(session, signal, emit, budget, system);
          request.messages = session.messages;
          if (budget.used >= budget.limit || budget.used - initialCalls >= this.config.maxCalls) break;
        }
        if (this.counter.prompt(request, session.contextUsage) + this.config.maxTokens > this.config.contextWindow) throw new Error('上下文超出配置容量；请 /new 开始新会话、精简输入或调整 contextWindow');
        let text = '';
        const toolCalls: ToolCall[] = [];
        let finish: 'stop' | 'tool_calls' | 'length' | undefined;
        try {
          for await (const event of accountedStream(this.provider, request, session, this.store, this.config, budget, this.options.ancestors ?? [], 'task', emit, signal)) {
            if (event.type === 'text') { text += event.delta; emit({ type: 'text', delta: event.delta }); }
            else if (event.type === 'tool_call') toolCalls.push(event.call);
            else if (event.type === 'finish') finish = event.reason;
          }
          signal.throwIfAborted();
          if (!finish) throw new Error('模型没有完成本轮响应');
        } catch (error) {
          if (text) await this.store.commit(session, { type: 'message', message: { role: 'assistant', content: text } });
          throw error;
        }
        if (finish === 'length') {
          if (text) await this.store.commit(session, { type: 'message', message: { role: 'assistant', content: text } });
          end = 'truncated'; return;
        }
        if ((finish === 'tool_calls') !== (toolCalls.length > 0) || new Set(toolCalls.map(call => call.id)).size !== toolCalls.length) throw new Error('模型工具调用协议不一致');
        await this.store.commit(session, { type: 'message', message: { role: 'assistant', content: text, ...(toolCalls.length ? { toolCalls } : {}) } });
        if (!toolCalls.length) { end = 'completed'; return; }
        for (const original of toolCalls) {
          let call = original;
          emit({ type: 'tool_start', call });
          await this.store.commit(session, { type: 'tool_start', call });
          let result: ToolResult;
          if (signal.aborted || budget.terminatedReason) result = { status: 'cancelled', content: budget.terminatedReason ?? '任务已取消，工具未执行。' };
          else {
            try {
              const entry = this.tools.get(call.name);
              if (!entry) throw new Error(`未知工具：${call.name}`);
              const decision = await this.hooks.check({ call, sessionId: session.id, parentSessionId: session.parentSessionId, root: this.config.root, approval: this.config.approval }, signal);
              if (decision.outcomes.length) { emit({ type: 'hook_result', callId: call.id, decision }); await this.store.commit(session, { type: 'hook', callId: call.id, decision }); }
              if (decision.action === 'terminate') budget.terminatedReason = `Hook 终止任务：${decision.outcomes.map(outcome => outcome.result.reason).filter(Boolean).join('; ')}`;
              if (decision.action !== 'allow') {
                result = { status: 'denied', content: budget.terminatedReason ?? `Hook 拒绝：${decision.outcomes.map(outcome => outcome.result.reason).filter(Boolean).join('; ')}` };
                await this.store.commit(session, { type: 'tool_end', id: call.id, result });
                await this.store.commit(session, { type: 'message', message: { role: 'tool', toolCallId: call.id, content: JSON.stringify(result) } });
                emit({ type: 'tool_end', call, result }); continue;
              }
              call = { ...call, args: decision.args };
              if (!entry.validate(call.args)) throw new Error(`Hook 修改后的参数无效：${JSON.stringify(entry.validate.errors)}`);
              const args = call.args as Record<string, unknown>;
              const notices = await instructions.discover((args.path as string | undefined) ?? (args.cwd as string | undefined) ?? '.');
              if (notices.length && ['write_file', 'edit_file', 'run_command'].includes(call.name)) {
                result = { status: 'failure', content: `发现新的项目指令，本次尚未执行。请阅读后重新决定操作：\n${notices.join('\n')}` };
              } else {
                const context: ToolContext = {
                  root: this.config.root, outputDir: this.store.outputDirectory(session), signal, shell,
                  approval: decision.requireApproval ? 'ask' : this.config.approval, commandTimeoutMs: this.config.commandTimeoutMs,
                  authorize: async (request, abortSignal) => { const scoped = { ...request, sessionId: session.id }; emit({ type: 'approval_request', request: scoped }); return this.authorize(scoped, abortSignal); },
                  emit: output => emit({ type: 'tool_output', id: call.id, text: output }),
                  recordChange: async (relative, before) => { for (const target of [...(this.options.ancestors ?? []), session]) if (!Object.hasOwn(target.changes, relative)) await this.store.commit(target, { type: 'change', path: relative, before }); },
                  captureCommandBaseline: async () => { for (const target of [...(this.options.ancestors ?? []), session]) await this.store.captureCommandBaseline(target, signal); },
                  delegate: (task, mode) => this.delegate(task, mode, session, signal, budget, emit),
                };
                const approved = !decision.requireApproval || call.name === 'run_command' || await context.authorize({ command: JSON.stringify(call), cwd: this.config.root, shell, kind: 'tool', toolCall: call }, signal);
                signal.throwIfAborted();
                result = approved ? await entry.tool.execute(args, context) : { status: 'denied', content: 'Hook 要求的工具审批未获批准，未执行。' };
                if (JSON.stringify(original.args) !== JSON.stringify(call.args)) result = { ...result, content: `Hook 实际执行参数：${JSON.stringify(call.args)}\n${result.content}` };
                if (notices.length) result = { ...result, content: `${result.content}\n\n${notices.join('\n')}` };
              }
            } catch (error) { result = { status: signal.aborted ? 'cancelled' : 'failure', content: errorMessage(error) }; }
          }
          await this.store.commit(session, { type: 'tool_end', id: call.id, result });
          await this.store.commit(session, { type: 'message', message: { role: 'tool', toolCallId: call.id, content: JSON.stringify(result) } });
          emit({ type: 'tool_end', call, result });
        }
        if (budget.terminatedReason) { end = 'terminated'; return; }
      }
      end = 'budget';
    } catch (error) {
      if (signal.aborted) end = 'cancelled';
      else if (error instanceof BudgetExceeded) end = 'budget';
      else { end = 'error'; emit({ type: 'error', message: errorMessage(error).replaceAll(this.config.apiKey, '[REDACTED]') }); }
    } finally { calls = budget.used - initialCalls; emit({ type: 'task_end', reason: signal.aborted ? 'cancelled' : end, calls }); }
  }

  private async delegate(task: string, mode: 'read_only' | 'workspace_write', parent: Session, signal: AbortSignal, budget: CallBudget, emit: (event: AgentEvent) => void): Promise<ToolResult> {
    const limits = this.config.subAgents ?? { maxDepth: 1, maxCalls: 8, maxChildren: 4 };
    if ((this.options.depth ?? 0) >= limits.maxDepth || budget.children >= limits.maxChildren) return { status: 'denied', content: '子任务数量或深度达到上限' };
    if (budget.used >= budget.limit) throw new BudgetExceeded();
    budget.children++;
    const child = await this.store.create(this.config.model, parent.id);
    const info = { id: child.id, task, mode };
    await this.store.commit(parent, { type: 'child', child: info }); emit({ type: 'subagent_start', sessionId: child.id, task, mode });
    let reason: EndReason = 'error';
    try {
      const agent = new Agent({ ...this.config, maxCalls: Math.min(limits.maxCalls, this.config.maxCalls) }, this.provider, this.store, this.authorize, undefined,
        { ...this.options, depth: (this.options.depth ?? 0) + 1, ancestors: [...(this.options.ancestors ?? []), parent], budget, readOnly: mode === 'read_only' });
      for await (const event of agent.run(task, child, signal)) { if (event.type === 'task_end') reason = event.reason; emit({ type: 'subagent_event', sessionId: child.id, event }); }
      const answer = child.messages.findLast(message => message.role === 'assistant' && !message.toolCalls?.length)?.content ?? '子任务尚未生成最终答复，请查看独立会话。';
      return { status: reason === 'completed' ? 'success' : reason === 'cancelled' ? 'cancelled' : 'failure', content: JSON.stringify({ sessionId: child.id, reason, answer: this.counter.truncate(answer, 2000), changedFiles: Object.keys(child.changes), usage: child.usage }) };
    } finally { await this.store.commit(parent, { type: 'child', child: { ...info, reason } }); emit({ type: 'subagent_end', sessionId: child.id, reason }); await this.store.release(child.id); }
  }
}
