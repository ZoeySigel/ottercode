import { randomUUID } from 'node:crypto';
import { WorkspaceClient } from './transport.js';
import type { WorkspaceSnapshot } from './runtime.js';
import { errorMessage } from './utils.js';

export async function runRemoteTerminal(client: WorkspaceClient): Promise<void> {
  const { TerminalController, startTerminal } = await import('./terminal.js');
  const terminal = new TerminalController();
  terminal.print('ottercode 🦦 · SSE', false, 'cyan'); terminal.setBusy(true); terminal.setLabel('正在同步工作区…');
  const controller = new AbortController();
  let state: WorkspaceSnapshot | undefined;
  let endedTask: string | undefined;
  let approval: { id: string; controller: AbortController } | undefined;
  let submitting = false;
  let connected = false;
  let fatal: unknown;
  const pending = (items: WorkspaceSnapshot['approvals']) => {
    const first = items[0];
    if (approval?.id === first?.id) return;
    approval?.controller.abort(); approval = undefined;
    if (!first) return;
    const local = new AbortController(); approval = { id: first.id, controller: local };
    void (async () => {
      const approved = await terminal.confirm(first.request, local.signal);
      if (local.signal.aborted) return;
      try { await client.request('/approvals/' + first.id, { approved }); }
      catch (error) { terminal.print(errorMessage(error), false, 'red'); }
      finally {
        if (approval?.id === first.id) approval = undefined;
        if (!controller.signal.aborted) {
          try { const latest = await client.request<WorkspaceSnapshot>('/state'); state = latest; pending(latest.approvals); } catch { /* SSE reconnect will restore pending approvals */ }
        }
      }
    })();
  };
  terminal.onCancel = () => { if (!connected) controller.abort(); else void client.request('/cancel', {}).catch(error => terminal.print(errorMessage(error), false, 'red')); };
  terminal.onExit = () => controller.abort();
  const shutdown = () => controller.abort(); process.on('SIGTERM', shutdown);
  terminal.onSubmit = text => {
    if (text === '/exit') { controller.abort(); return; }
    if (!connected || submitting || state?.busy) return;
    submitting = true; terminal.setBusy(true);
    const previous = state;
    if (state) state = { ...state, busy: true };
    void (async () => {
      try {
        if (text.startsWith('/')) {
          const result = await client.request<{ text: string; markdown?: boolean }>('/commands', { command: text }); terminal.print(result.text, result.markdown);
        } else await client.request('/tasks', { input: text }, randomUUID());
      } catch (error) {
        terminal.print(errorMessage(error), false, 'red');
        try { state = await client.request<WorkspaceSnapshot>('/state'); } catch { state = previous; }
      }
      finally { submitting = false; if (state) terminal.setBusy(!connected || state.busy); }
    })();
  };
  const instance = startTerminal(terminal);
  try {
    for await (const item of client.watch(controller.signal)) {
      if (item.kind === 'reconnecting') {
        connected = false;
        approval?.controller.abort(); approval = undefined;
        terminal.setBusy(true); terminal.setLabel(`SSE 已断开，${item.delayMs} ms 后第 ${item.attempt} 次重连；工作区任务继续运行`);
      } else if (item.kind === 'snapshot') {
        connected = true;
        const snapshot = item.snapshot;
        const missing = snapshot.task?.status === 'finished' && snapshot.task.id !== endedTask;
        terminal.synchronize(snapshot, missing);
        if (missing) endedTask = snapshot.task!.id;
        if (!state || state.sessionId !== snapshot.sessionId) terminal.print(`项目：${snapshot.root}\n会话：${snapshot.sessionId} · ${snapshot.messages.length} 条上下文消息`, false, 'gray');
        state = snapshot; pending(snapshot.approvals);
      } else {
        const event = item.event;
        if (event.type === 'approval_pending') pending([{ id: event.id, request: event.request }]);
        else if (event.type === 'approval_resolved') { if (approval?.id === event.id) { approval.controller.abort(); approval = undefined; } }
        else if (event.type !== 'workspace_changed') {
          if (state && event.type === 'task_start') state = { ...state, busy: true };
          else if (state && event.type === 'task_end') state = { ...state, busy: false };
          terminal.event(event);
          if (event.type === 'task_end') { endedTask = item.taskId; terminal.setBusy(false); }
        }
      }
    }
  } catch (error) { fatal = error; }
  finally { approval?.controller.abort(); controller.abort(); instance.unmount(); process.off('SIGTERM', shutdown); }
  if (fatal) throw fatal;
}
