import React, { useState, useSyncExternalStore } from 'react';
import { Box, Static, Text, render, useInput, usePaste, useWindowSize } from 'ink';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import type { AgentEvent, ApprovalRequest, UsageTotals } from './types.js';
import { safeText, limitOutput } from './utils.js';
import { editDraft, insertDraft, type Draft } from './terminal-input.js';
import type { WorkspaceSnapshot } from './runtime.js';

type Item = { id: number; text: string; markdown: boolean; color?: string };
type State = { items: Item[]; text: string; tool: string; output: string; busy: boolean; label: string; approval?: ApprovalRequest };
const reasonLabels = { completed: '完成', cancelled: '已取消', error: '发生错误', budget: '已达到模型调用预算', truncated: '模型输出被截断，未执行本轮工具', terminated: 'Hook 已终止任务' };

export class TerminalController {
  private state: State = { items: [], text: '', tool: '', output: '', busy: false, label: '' };
  private listeners = new Set<() => void>();
  private pending?: (answer: boolean) => void;
  private nextId = 0;
  private currentSessionId?: string;
  private workspaceLabel = '';
  onSubmit: (text: string) => void = () => {};
  onCancel: () => void = () => {};
  onExit: () => void = () => {};
  subscribe = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  snapshot = () => this.state;
  private update(patch: Partial<State>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  print(text: string, markdown = false, color?: string): void {
    this.update({ items: [...this.state.items, { id: this.nextId++, text: safeText(text), markdown, color }] });
  }
  setBusy(busy: boolean): void { this.update({ busy }); }
  setLabel(label: string): void { this.update({ label: safeText(label) }); }
  private setUsage(usage: UsageTotals): void {
    this.setLabel(`${this.workspaceLabel}\nToken ${usage.inputTokens}/${usage.outputTokens} · 已知费用 $${usage.costUsd.toFixed(6)}${usage.unpricedCalls ? ` · ${usage.unpricedCalls} 次未定价` : ''}${usage.estimatedCalls ? ` · ${usage.estimatedCalls} 次估算` : ''}`);
  }
  synchronize(snapshot: WorkspaceSnapshot, missingCompletion = false): void {
    const tool = snapshot.tools.findLast(item => !item.result);
    this.update({ busy: snapshot.busy, text: snapshot.task?.status === 'running' ? safeText(snapshot.task.text) : '', tool: tool?.call.name ?? '', output: tool?.output ?? '' });
    if (missingCompletion && snapshot.task?.status === 'finished') {
      if (snapshot.task.text) this.print(snapshot.task.text, true);
      this.print(`${snapshot.task.reason ? reasonLabels[snapshot.task.reason] : '任务已结束'} · 已从工作区恢复结果`, false, 'gray');
    }
    this.currentSessionId = snapshot.sessionId;
    this.workspaceLabel = `${snapshot.root} · ${snapshot.model} · ${snapshot.approval} · ${snapshot.sessionId}`;
    this.setUsage(snapshot.usage);
  }
  private flush(): void {
    if (this.state.text) this.print(this.state.text, true);
    this.update({ text: '' });
  }
  event(event: AgentEvent): void {
    switch (event.type) {
      case 'task_start': this.print(`❯ ${event.input}`, false, 'cyan'); this.update({ busy: true, text: '', tool: '', output: '' }); break;
      case 'usage': if (event.sessionId === this.currentSessionId) this.setUsage(event.totals); break;
      case 'hook_result': if (event.decision.outcomes.length) this.print(`Hook: ${event.decision.action}${event.decision.requireApproval ? ' · 需要审批' : ''}`, false, event.decision.action === 'allow' ? 'gray' : 'yellow'); break;
      case 'subagent_start': this.print(`子任务 ${event.sessionId} · ${event.mode}\n${event.task}`, false, 'cyan'); break;
      case 'subagent_end': this.print(`子任务 ${event.sessionId} · ${reasonLabels[event.reason]}`, false, 'gray'); break;
      case 'subagent_event':
        if (event.event.type === 'tool_start') this.print(`子任务 ${event.sessionId} · ${event.event.call.name}`, false, 'gray');
        else if (event.event.type === 'tool_end') this.print(`子任务 ${event.sessionId} · ${event.event.result.status}`, false, 'gray');
        else if (event.event.type === 'error') this.print(`子任务 ${event.sessionId} · ${event.event.message}`, false, 'red');
        else if (event.event.type === 'usage') this.event(event.event);
        break;
      case 'text': this.update({ text: this.state.text + safeText(event.delta) }); break;
      case 'tool_start': this.flush(); this.update({ tool: event.call.name, output: '' }); break;
      case 'tool_output': this.update({ output: limitOutput(this.state.output + safeText(event.text), 8, 2400).text }); break;
      case 'tool_end': {
        this.print(`[${event.result.status}] ${event.call.name}`, false, event.result.status === 'success' ? 'green' : 'yellow');
        const preview = limitOutput(event.result.content, 8, 2400);
        if (preview.text) this.print(`${preview.truncated ? '…\n' : ''}${preview.text}`);
        if (event.result.outputPath) this.print(`完整日志：${event.result.outputPath}`, false, 'gray');
        this.update({ tool: '', output: '' }); break;
      }
      case 'compaction': this.print(`上下文压缩：${event.status === 'started' ? '处理中' : event.status === 'completed' ? '完成' : '未替换，保留原历史'}`, false, 'gray'); break;
      case 'error': this.print(event.message, false, 'red'); break;
      case 'task_end': this.flush(); this.update({ tool: '', output: '' }); this.print(`${reasonLabels[event.reason]} · 模型调用 ${event.calls} 次`, false, 'gray'); break;
    }
  }
  confirm(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    this.print(`${request.kind === 'tool' ? '待确认的工具调用' : '待确认的命令'}${request.sessionId ? ` · ${request.sessionId}` : ''}\nShell: ${request.shell}\n目录: ${request.cwd}\n${request.command}`, false, 'yellow');
    return new Promise(resolve => {
      const finish = (answer: boolean) => {
        signal.removeEventListener('abort', abort);
        this.pending = undefined;
        this.update({ approval: undefined });
        resolve(answer);
      };
      const abort = () => finish(false);
      this.pending = finish;
      signal.addEventListener('abort', abort, { once: true });
      this.update({ approval: request });
      if (signal.aborted) abort();
    });
  }
  answer(value: boolean): void { this.pending?.(value); }
}

export function markdownText(content: string, width = 80): string {
  try {
    const marked = new Marked();
    // marked-terminal exports a Marked extension at runtime; DefinitelyTyped models it as a renderer.
    marked.use(markedTerminal({ width: Math.max(20, width - 4), reflowText: true }) as unknown as Parameters<Marked['use']>[0]);
    return (marked.parse(safeText(content), { async: false }) as string).trimEnd();
  } catch { return safeText(content); }
}

export function TerminalApp({ controller }: { controller: TerminalController }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [draft, setDraft] = useState<Draft>({ text: '', cursor: 0 });
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const { columns = 80, rows = 24 } = useWindowSize();
  usePaste(text => { if (!state.busy && !state.approval) setDraft(value => insertDraft(value, safeText(text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')))); });
  useInput((input, key) => {
    if (key.ctrl && input === 'c') { if (state.busy) controller.onCancel(); else controller.onExit(); return; }
    if (key.ctrl && input === 'd' && !state.busy) { controller.onExit(); return; }
    if (state.approval) {
      if (input.toLowerCase() === 'y') controller.answer(true);
      else if (input.toLowerCase() === 'n' || key.return || key.escape) controller.answer(false);
      return;
    }
    if (state.busy) return;
    if (key.upArrow && !draft.text.includes('\n') && history.length) {
      const index = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
      const text = history[index]!; setHistoryIndex(index); setDraft({ text, cursor: Array.from(text).length }); return;
    }
    if (key.downArrow && historyIndex >= 0) {
      const index = historyIndex + 1; const text = history[index] ?? '';
      setHistoryIndex(index >= history.length ? -1 : index); setDraft({ text, cursor: Array.from(text).length }); return;
    }
    if (key.return && !key.meta && !key.shift) {
      if (!draft.text.trim()) return;
      const text = draft.text.trim(); setDraft({ text: '', cursor: 0 }); setHistory(value => [...value, text]); setHistoryIndex(-1);
      controller.onSubmit(text); return;
    }
    setDraft(value => editDraft(value, safeText(input), key));
  });
  const characters = Array.from(draft.text);
  const before = characters.slice(0, draft.cursor).join('');
  const cursor = characters[draft.cursor] ?? ' ';
  const after = characters.slice(draft.cursor + 1).join('');
  return <>
    <Static items={state.items}>{item => <Box key={item.id} marginBottom={1}><Text color={item.color}>{item.markdown ? markdownText(item.text, columns) : item.text}</Text></Box>}</Static>
    <Box flexDirection="column">
      {state.text ? <Text>{limitOutput(state.text, Math.max(3, rows - 10), 12000).text}</Text> : null}
      {state.tool ? <Text color="cyan">执行中 · {state.tool}</Text> : null}
      {state.output ? <Text dimColor>{state.output}</Text> : null}
      {state.approval ? <Box borderStyle="round" borderColor="yellow" flexDirection="column" paddingX={1}>
        <Text color="yellow">{state.approval.kind === 'tool' ? '是否执行以上工具调用？' : '是否执行以上命令？'} [y/N]</Text>
        <Text dimColor>命令已完整输出到上方，可滚动查看 · Ctrl+C 取消任务</Text>
      </Box> : state.busy ? <Text dimColor>处理中 · Ctrl+C 取消</Text> : <Box><Text color="cyan">❯ </Text><Text>{before}<Text inverse>{cursor}</Text>{after}</Text></Box>}
      <Text dimColor>{state.label}</Text>
      {!state.busy && <Text dimColor>Enter 发送 · Alt+Enter 换行 · /help 帮助</Text>}
    </Box>
  </>;
}

export function startTerminal(controller: TerminalController) {
  return render(<TerminalApp controller={controller} />, { exitOnCtrlC: false, maxFps: 20 });
}
