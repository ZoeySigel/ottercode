import { randomUUID } from 'node:crypto';
import { Agent } from './agent.js';
import { sessionDiff, SessionStore } from './session.js';
import type { AgentEvent, ApprovalRequest, Config, EndReason, ModelProvider, Session, ToolCall, ToolResult, UsageTotals } from './types.js';
import { emptyUsage } from './usage.js';
import { limitOutput } from './utils.js';

export type WorkspaceEvent = AgentEvent | { type: 'approval_pending'; id: string; request: ApprovalRequest } | { type: 'approval_resolved'; id: string; approved: boolean } | { type: 'workspace_changed' };
export type EventEnvelope = { kind: 'event'; id: string; sessionId: string; taskId?: string; event: WorkspaceEvent };
export type WorkspaceSnapshot = {
  epoch: string; revision: number; root: string; sessionId: string; model: string; approval: Config['approval']; busy: boolean;
  messages: Session['messages']; changedFiles: string[]; usage: UsageTotals; children: Session['children'];
  task?: { id: string; input: string; status: 'running' | 'finished'; reason?: EndReason; calls?: number; text: string };
  tools: { call: ToolCall; result?: ToolResult; output: string }[];
  approvals: { id: string; request: ApprovalRequest }[];
};

export class TaskRuntime {
  readonly epoch = randomUUID();
  revision = 0;
  readonly events: EventEnvelope[] = [];
  private eventBytes = 0;
  private listeners = new Set<(event: EventEnvelope) => void>();
  private pending = new Map<string, { request: ApprovalRequest; resolve: (approved: boolean) => void }>();
  private toolStates = new Map<string, { call: ToolCall; result?: ToolResult; output: string }>();
  private task?: WorkspaceSnapshot['task'];
  private controller?: AbortController;
  private running?: Promise<void>;
  private operation = false;
  private operationDone?: Promise<void>;
  private closed = false;
  private requestIds = new Map<string, string>();
  private approvals = new Map<string, Config['approval']>();
  private defaultApproval: Config['approval'];
  constructor(readonly config: Config, readonly provider: ModelProvider, readonly store: SessionStore, public session: Session) { this.defaultApproval = config.approval; }
  get busy() { return this.operation || this.task?.status === 'running'; }
  subscribe(listener: (event: EventEnvelope) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  publish(event: WorkspaceEvent): void {
    const item: EventEnvelope = { kind: 'event', id: `${this.epoch}:${++this.revision}`, sessionId: this.session.id, taskId: this.task?.id, event };
    this.events.push(item); this.eventBytes += Buffer.byteLength(JSON.stringify(item));
    while (this.events.length > 1024 || this.eventBytes > 2 * 1024 * 1024) this.eventBytes -= Buffer.byteLength(JSON.stringify(this.events.shift()!));
    for (const listener of this.listeners) listener(item);
  }
  snapshot(): WorkspaceSnapshot {
    return structuredClone({ epoch: this.epoch, revision: this.revision, root: this.config.root, sessionId: this.session.id, model: this.config.model, approval: this.config.approval,
      busy: this.busy, messages: this.session.messages, changedFiles: Object.keys(this.session.changes), usage: this.session.usage ?? emptyUsage(), children: this.session.children,
      task: this.task, tools: [...this.toolStates.values()], approvals: [...this.pending].map(([id, entry]) => ({ id, request: entry.request })),
    });
  }
  private authorize = (request: ApprovalRequest, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = (approved: boolean) => {
        signal.removeEventListener('abort', abort); this.pending.delete(id);
        this.publish({ type: 'approval_resolved', id, approved }); resolve(approved);
      };
      const abort = () => finish(false);
      this.pending.set(id, { request, resolve: finish });
      signal.addEventListener('abort', abort, { once: true });
      this.publish({ type: 'approval_pending', id, request });
      if (signal.aborted) abort();
    });
  };
  approve(id: string, approved: boolean): boolean { const entry = this.pending.get(id); if (!entry) return false; entry.resolve(approved); return true; }
  private consume(event: AgentEvent): void {
    if (event.type === 'text' && this.task) this.task.text += event.delta;
    else if (event.type === 'tool_start') { if (this.task) this.task.text = ''; this.toolStates.set(event.call.id, { call: event.call, output: '' }); }
    else if (event.type === 'tool_output') { const state = this.toolStates.get(event.id); if (state) state.output = limitOutput(state.output + event.text, 20, 8192).text; }
    else if (event.type === 'tool_end') { const state = this.toolStates.get(event.call.id); if (state) { state.call = event.call; state.result = event.result; } }
    else if (event.type === 'task_end' && this.task) { this.task.status = 'finished'; this.task.reason = event.reason; this.task.calls = event.calls; }
    this.publish(event);
  }
  start(input: string, requestId: string = randomUUID()): string {
    const existing = this.requestIds.get(requestId); if (existing) return existing;
    if (this.closed || this.busy) throw new Error('工作区正在执行任务或已关闭');
    if (!input.trim() || Buffer.byteLength(input) > 1024 * 1024) throw new Error('任务不能为空且不能超过 1 MiB');
    const id = randomUUID(); this.requestIds.set(requestId, id);
    if (this.requestIds.size > 128) this.requestIds.delete(this.requestIds.keys().next().value!);
    this.controller = new AbortController(); this.toolStates.clear();
    this.task = { id, input, status: 'running', text: '' }; this.publish({ type: 'task_start', input });
    const agent = new Agent(this.config, this.provider, this.store, this.authorize);
    this.running = (async () => {
      try { for await (const event of agent.run(input, this.session, this.controller!.signal)) this.consume(event); }
      finally { this.controller = undefined; this.publish({ type: 'workspace_changed' }); }
    })();
    // The runtime owns this promise even when no terminal is connected.
    void this.running.catch(() => {});
    return id;
  }
  cancel(): void { this.controller?.abort(); }
  async wait(): Promise<void> { await this.running; }
  async command(text: string): Promise<{ text: string; markdown?: boolean }> {
    if (this.closed || this.busy) throw new Error('当前工作区正在运行任务');
    this.operation = true; this.controller = new AbortController(); this.publish({ type: 'workspace_changed' });
    let finish!: () => void; this.operationDone = new Promise<void>(resolve => { finish = resolve; });
    try {
      const [name, ...parts] = text.trim().split(/\s+/); const argument = parts.join(' ');
      switch (name) {
        case '/help': return { text: '/new /sessions [all] /resume <id> /model [name] /permissions [ask|auto] /diff /compact /usage /exit' };
        case '/new': await this.switchSession(await this.store.create(this.config.model)); return { text: `新会话：${this.session.id}` };
        case '/sessions': return { text: (await this.store.list(argument === 'all')).map(s => `${s.id}  ${s.updatedAt}  ${s.model}${s.parentSessionId ? `  parent=${s.parentSessionId}` : ''}`).join('\n') };
        case '/resume': if (!argument) throw new Error('用法：/resume <id>'); await this.switchSession(await this.store.load(argument)); return { text: `已恢复：${this.session.id}` };
        case '/model': if (argument) { this.config.model = argument; await this.store.commit(this.session, { type: 'model', model: argument }); } return { text: `当前模型：${this.config.model}` };
        case '/permissions':
          if (argument && argument !== 'ask' && argument !== 'auto') throw new Error('用法：/permissions ask|auto');
          if (argument === 'ask' || argument === 'auto') this.config.approval = argument;
          return { text: `命令策略：${this.config.approval}${this.config.approval === 'auto' ? '（当前用户权限，无操作系统沙箱）' : ''}` };
        case '/diff': return { text: `\`\`\`diff\n${await sessionDiff(this.session, this.store)}\n\`\`\``, markdown: true };
        case '/usage': return { text: JSON.stringify(this.session.usage ?? emptyUsage(), null, 2) };
        case '/compact': return { text: await new Agent(this.config, this.provider, this.store, this.authorize).compact(this.session, this.controller.signal, event => this.publish(event)) ? '压缩完成' : '原上下文保留；没有可压缩历史或摘要失败' };
        default: throw new Error(`未知命令：${name}`);
      }
    } finally { this.operation = false; this.controller = undefined; this.publish({ type: 'workspace_changed' }); finish(); }
  }
  private async switchSession(next: Session) {
    this.approvals.set(this.session.id, this.config.approval);
    if (next.id !== this.session.id) await this.store.release(this.session.id);
    this.session = next; this.config.approval = this.approvals.get(next.id) ?? this.defaultApproval;
    this.task = undefined; this.toolStates.clear();
  }
  async close(): Promise<void> { this.closed = true; this.cancel(); await this.running; await this.operationDone; }
}
