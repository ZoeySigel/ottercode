import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Agent } from '../src/agent.js';
import { usageRecord, TokenCounter } from '../src/usage.js';
import { fixture, ScriptedProvider, call, stop } from './helpers.js';
import type { AgentEvent, ModelEvent } from '../src/types.js';

const billed = (events: ModelEvent[], inputTokens: number, outputTokens: number): ModelEvent[] => [...events, { type: 'usage', usage: { inputTokens, outputTokens, source: 'reported' } }];
async function collect(agent: Agent, session: Awaited<ReturnType<typeof fixture>>['session'], signal?: AbortSignal) { const result: AgentEvent[] = []; for await (const event of agent.run('分析项目', session, signal)) result.push(event); return result; }

describe('delegated tasks and cost accounting', () => {
  it('enforces a child-specific call cap while leaving unused root budget available', async () => {
    const f = await fixture(); f.config.subAgents = { maxDepth: 1, maxCalls: 1, maxChildren: 2 };
    const provider = new ScriptedProvider([call('d', 'delegate_task', { task: 'inspect' }), call('r', 'list_files', {}), stop('子任务预算用尽，主任务已收尾')]);
    const result = await collect(new Agent(f.config, provider, f.store, async () => false), f.session);
    expect(result.at(-1)).toMatchObject({ reason: 'completed', calls: 3 });
    expect(f.session.children![0]!.reason).toBe('budget'); expect(provider.requests).toHaveLength(3);
  });
  it('propagates writable child changes to the parent diff and cascades a child stop hook', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([call('d', 'delegate_task', { task: 'write', mode: 'workspace_write' }), call('w', 'write_file', { path: 'child.txt', content: 'written by child' }), stop('已写入 child.txt'), stop('完成')]);
    await collect(new Agent(f.config, provider, f.store, async () => false), f.session);
    expect(f.session.changes['child.txt']).toEqual({ before: null });
    expect(await fs.readFile(path.join(f.root, 'child.txt'), 'utf8')).toBe('written by child');
    const next = await f.store.create(f.config.model);
    const terminating = new ScriptedProvider([call('d2', 'delegate_task', { task: 'inspect' }), call('r', 'read_file', { path: 'child.txt' })]);
    const agent = new Agent(f.config, terminating, f.store, async () => true, undefined, { hooks: [{ name: 'stop-child', run: async input => input.parentSessionId ? { action: 'terminate', reason: 'stop tree' } : { action: 'allow' } }] });
    const result = await collect(agent, next); expect(result.at(-1)).toMatchObject({ reason: 'terminated', calls: 2 });
    expect(next.children![0]!.reason).toBe('terminated');
  });
  it('isolates child context, returns a concise result and rolls every child charge into the parent once', async () => {
    const f = await fixture(); f.config.pricing = { 'test-model': { inputPerMillion: 1, outputPerMillion: 2 } };
    await fs.writeFile(path.join(f.root, 'notes'), 'CHILD_ONLY_INTERMEDIATE');
    const provider = new ScriptedProvider([
      billed(call('delegate', 'delegate_task', { task: '阅读 notes 并总结' }), 100, 10),
      billed(call('read', 'read_file', { path: 'notes' }), 200, 20), billed(stop('简洁的子任务结论'), 300, 30), billed(stop('主任务完成'), 400, 40),
    ]);
    const events = await collect(new Agent(f.config, provider, f.store, async () => false), f.session);
    expect(events.at(-1)).toMatchObject({ reason: 'completed', calls: 4 });
    expect(f.session.usage).toMatchObject({ calls: 4, inputTokens: 1000, outputTokens: 100, costUsd: 0.0012, unpricedCalls: 0, estimatedCalls: 0 });
    const childId = f.session.children![0]!.id;
    const child = await f.store.load(childId); expect(child.parentSessionId).toBe(f.session.id);
    expect(child.react).toMatchObject({ phase: 'finish', step: 2, reason: 'completed' });
    expect(child.react!.runId).not.toBe(f.session.react!.runId);
    expect(child.messages.some(message => message.content.includes('CHILD_ONLY_INTERMEDIATE'))).toBe(true);
    expect(JSON.stringify(provider.requests[3]?.messages)).not.toContain('CHILD_ONLY_INTERMEDIATE');
    expect(JSON.stringify(provider.requests[3]?.messages)).toContain('简洁的子任务结论');
    expect(child.usage).toMatchObject({ calls: 2, inputTokens: 500, outputTokens: 50 });
    expect(await f.store.list()).toHaveLength(1); expect(await f.store.list(true)).toHaveLength(2);
    await f.store.release(childId);
    expect((await f.store.load(f.session.id)).usage?.costUsd).toBe(0.0012);
    expect((await f.store.load(f.session.id)).usage?.calls).toBe(4);
  });
  it('defaults to read-only children and enforces depth through their actual tool registry', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([call('d', 'delegate_task', { task: 'inspect' }), request => {
      expect(request.tools.map(tool => tool.name)).toEqual(['list_files', 'search_text', 'read_file']);
      return call('w', 'write_file', { path: 'forbidden', content: 'x' });
    }, stop('只读任务无法修改'), stop()]);
    await collect(new Agent(f.config, provider, f.store, async () => true), f.session);
    await expect(fs.access(path.join(f.root, 'forbidden'))).rejects.toThrow();
  });
  it('inherits hooks and approvals for writable children and shares the root call budget', async () => {
    const f = await fixture(); f.config.maxCalls = 3; let childSession = ''; let approvedSession = '';
    const provider = new ScriptedProvider([call('d', 'delegate_task', { task: 'validate', mode: 'workspace_write' }), call('c', 'run_command', { command: 'echo not executed' }), stop('命令未批准')]);
    const result = await collect(new Agent(f.config, provider, f.store, async request => { approvedSession = request.sessionId!; return false; }, undefined, {
      hooks: [{ name: 'child-policy', run: async input => { if (input.parentSessionId) childSession = input.sessionId; return { action: 'allow' }; } }],
    }), f.session);
    expect(childSession).toBe(f.session.children![0]!.id); expect(approvedSession).toBe(childSession);
    expect(result.at(-1)).toMatchObject({ reason: 'budget', calls: 3 }); expect(provider.requests).toHaveLength(3);
    expect(f.session.messages.at(-1)?.role).toBe('tool');
  });
  it('propagates parent cancellation to children and leaves complete tool pairs', async () => {
    const f = await fixture(); const controller = new AbortController();
    const provider = new ScriptedProvider([call('d', 'delegate_task', { task: 'validate', mode: 'workspace_write' }), call('c', 'run_command', { command: 'echo no' })]);
    const result = await collect(new Agent(f.config, provider, f.store, async () => { controller.abort(); return false; }), f.session, controller.signal);
    expect(result.at(-1)).toMatchObject({ reason: 'cancelled' });
    const child = await f.store.load(f.session.children![0]!.id);
    expect(child.messages.at(-1)?.role).toBe('tool'); expect(f.session.messages.at(-1)?.role).toBe('tool');
  });
  it('reconciles child costs after a crash between child commit and parent rollup', async () => {
    const f = await fixture(); const child = await f.store.create('test-model', f.session.id);
    await f.store.commit(f.session, { type: 'child', child: { id: child.id, task: 'work', mode: 'read_only' } });
    const record = usageRecord(child.id, child.model, 'task', { inputTokens: 100, outputTokens: 20, source: 'reported' }, { inputPerMillion: 2, outputPerMillion: 4 });
    await f.store.commit(child, { type: 'usage', record }); await f.store.release(child.id);
    const loaded = await f.store.load(f.session.id); expect(loaded.usage).toMatchObject({ calls: 1, costUsd: 0.00028 });
    expect((await f.store.load(f.session.id)).usage?.calls).toBe(1);
  });
  it('marks missing usage and pricing without claiming a zero-cost call', async () => {
    const f = await fixture(); await collect(new Agent(f.config, new ScriptedProvider([stop()]), f.store, async () => false), f.session);
    expect(f.session.usage).toMatchObject({ calls: 1, unpricedCalls: 1, estimatedCalls: 1 }); expect(f.session.usageRecords![0]!.costUsd).toBeNull();
  });
  it('uses reported prompt tokens for an unchanged request prefix and invalidates on compaction', () => {
    const counter = new TokenCounter(); const request = { model: 'm', system: 's', messages: [{ role: 'user' as const, content: 'hello' }], tools: [], maxTokens: 100 };
    const snapshot = counter.snapshot(request, 2000);
    expect(counter.prompt(request, snapshot)).toBe(2000);
    const extended = { ...request, messages: [...request.messages, { role: 'assistant' as const, content: 'response' }] };
    expect(counter.prompt(extended, snapshot)).toBeGreaterThan(2000);
    expect(counter.prompt({ ...request, messages: [{ role: 'user', content: 'summary' }] }, snapshot)).toBeLessThan(2000);
  });
});
