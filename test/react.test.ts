import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Agent } from '../src/agent.js';
import { ReActLoop } from '../src/react.js';
import { TaskRuntime } from '../src/runtime.js';
import type { AgentEvent, ReActState } from '../src/types.js';
import { call, fixture, ScriptedProvider, stop } from './helpers.js';

async function run(agent: Agent, f: Awaited<ReturnType<typeof fixture>>, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  for await (const event of agent.run('修复缺陷并验证', f.session, signal)) events.push(event);
  return events;
}
const phases = (events: AgentEvent[]) => events.filter(e => e.type === 'react_step').map(e => `${e.state.step}:${e.state.phase}`);

describe('explicit ReAct execution', () => {
  it('requires a decision and a matching observation before continuing', async () => {
    const states: ReActState[] = [];
    const loop = new ReActLoop(async state => { states.push(state); });
    const action = { id: 'read', name: 'read_file', args: { path: 'x' } };
    await expect(loop.act(action)).rejects.toThrow('行动');
    await loop.reason(); await loop.act(action);
    await expect(loop.finish('completed')).rejects.toThrow('最终决策');
    await expect(loop.reason()).rejects.toThrow('观察');
    await expect(loop.observe({ ...action, id: 'other' }, { status: 'success', content: 'x' })).rejects.toThrow('不匹配');
    await loop.observe(action, { status: 'failure', content: 'missing' });
    await loop.reason(); await loop.finish('completed');
    await expect(loop.reason()).rejects.toThrow();
    expect(states.map(s => s.phase)).toEqual(['reason', 'action', 'observation', 'reason', 'finish']);
    expect(new Set(states.map(s => s.runId)).size).toBe(1);
  });

  it('revises actions from real failure observations and journals every phase', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.root, 'actual.txt'), '真实文件内容');
    const provider = new ScriptedProvider([
      request => {
        expect(request.system).toContain('ReAct'); expect(request.system).toContain('不得编造');
        return call('missing', 'read_file', { path: 'missing.txt' });
      },
      request => {
        expect(JSON.parse(request.messages.at(-1)!.content).status).toBe('failure');
        return call('read', 'read_file', { path: 'actual.txt' });
      },
      request => {
        expect(request.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'read' });
        expect(request.messages.at(-1)!.content).toContain('真实文件内容');
        return stop('已读取真实文件，尚未运行验证。');
      },
    ]);
    const events = await run(new Agent(f.config, provider, f.store, async () => false), f);
    expect(phases(events)).toEqual(['1:reason', '1:action', '1:observation', '2:reason', '2:action', '2:observation', '3:reason', '3:finish']);
    const observations = events.flatMap(e => e.type === 'react_step' && e.state.phase === 'observation' ? [e.state] : []);
    expect(observations).toMatchObject([{ status: 'failure' }, { status: 'success' }]);
    const journal = (await fs.readFile(path.join(f.store.directory(f.session.id), 'journal.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { type: string; state?: ReActState });
    expect(journal.filter(e => e.type === 'react_step').map(e => e.state)).toEqual(events.filter(e => e.type === 'react_step').map(e => e.state));
    expect((await f.store.load(f.session.id)).react).toMatchObject({ phase: 'finish', reason: 'completed', step: 3 });
  });

  it('observes hook denials before asking the model to choose an alternative', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([call('deny', 'write_file', { path: 'never', content: 'x' }), request => {
      expect(JSON.parse(request.messages.at(-1)!.content).status).toBe('denied'); return stop('写入被拒绝。');
    }]);
    const events = await run(new Agent(f.config, provider, f.store, async () => false, undefined, { hooks: [{ name: 'deny', run: async () => ({ action: 'deny', reason: 'policy' }) }] }), f);
    expect(phases(events)).toEqual(['1:reason', '1:action', '1:observation', '2:reason', '2:finish']);
    await expect(fs.access(path.join(f.root, 'never'))).rejects.toThrow();
  });

  it.each(['budget', 'cancelled', 'truncated', 'error', 'terminated'] as const)('finishes the state machine on %s', async reason => {
    const f = await fixture(); const controller = new AbortController();
    if (reason === 'budget') f.config.maxCalls = 1;
    const provider = new ScriptedProvider([reason === 'error' ? new Error('broken stream') : reason === 'truncated' ? [{ type: 'finish', reason: 'length' }] : call('cmd', 'run_command', { command: 'echo never' })]);
    const agent = new Agent(f.config, provider, f.store, async () => { if (reason === 'cancelled') controller.abort(); return false; }, undefined,
      { hooks: reason === 'terminated' ? [{ name: 'stop', run: async () => ({ action: 'terminate' }) }] : [] });
    const events = await run(agent, f, controller.signal);
    expect(events.at(-1)).toMatchObject({ type: 'task_end', reason });
    expect(events.at(-2)).toMatchObject({ type: 'react_step', state: { phase: 'finish', reason } });
    expect(f.session.react).toMatchObject({ phase: 'finish', reason });
    expect(events.filter(e => e.type === 'react_step' && e.state.phase === 'action')).toHaveLength(['truncated', 'error'].includes(reason) ? 0 : 1);
  });

  it('pairs observations for a serial batch before the next model decision', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([[...call('a', 'list_files', {}).slice(0, 1), ...call('b', 'list_files', {})], stop()]);
    const events = await run(new Agent(f.config, provider, f.store, async () => false), f);
    expect(phases(events)).toEqual(['1:reason', '1:action', '1:observation', '1:action', '1:observation', '2:reason', '2:finish']);
    expect(provider.requests[1]!.messages.filter(m => m.role === 'tool')).toHaveLength(2);
  });

  it('recovers interrupted phases without replaying the action and starts a new run', async () => {
    const f = await fixture();
    await f.store.commit(f.session, { type: 'react_step', state: { runId: 'interrupted', step: 4, phase: 'action', toolCallId: 'pending', toolName: 'write_file' } });
    await f.store.commit(f.session, { type: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'write_file', args: { path: 'never', content: 'x' } }] } });
    const restored = await f.store.load(f.session.id);
    expect(restored.react).toEqual({ runId: 'interrupted', step: 4, phase: 'finish', reason: 'cancelled' });
    expect(JSON.parse(restored.messages.at(-1)!.content).status).toBe('cancelled');
    await expect(fs.access(path.join(f.root, 'never'))).rejects.toThrow();
    const agent = new Agent(f.config, new ScriptedProvider([stop()]), f.store, async () => false);
    const events = await run(agent, { ...f, session: restored });
    expect(phases(events)).toEqual(['1:reason', '1:finish']); expect(restored.react!.runId).not.toBe('interrupted');
  });

  it('synchronizes the current phase in SSE snapshots during approval', async () => {
    const f = await fixture();
    const runtime = new TaskRuntime(f.config, new ScriptedProvider([call('cmd', 'run_command', { command: 'echo never' }), stop('未执行')]), f.store, f.session);
    let current: ReturnType<TaskRuntime['snapshot']> | undefined;
    const off = runtime.subscribe(item => {
      if (item.event.type === 'approval_pending') {
        current = runtime.snapshot(); runtime.approve(item.event.id, false);
      }
    });
    try {
      runtime.start('validate'); await runtime.wait();
      expect(current?.task?.react).toMatchObject({ phase: 'action', step: 1, toolCallId: 'cmd' });
      expect(runtime.snapshot().task?.react).toMatchObject({ phase: 'finish', reason: 'completed', step: 2 });
      expect(runtime.events.filter(e => e.event.type === 'react_step')).toHaveLength(5);
    } finally { off(); await runtime.close(); }
  });
});
