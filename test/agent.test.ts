import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { Agent, compactionCut } from '../src/agent.js';
import { fixture, ScriptedProvider, call, stop } from './helpers.js';
import type { AgentEvent, Message, ModelEvent, ModelProvider } from '../src/types.js';

async function events(agent: Agent, input: string, session: Awaited<ReturnType<typeof fixture>>['session'], signal?: AbortSignal) {
  const result: AgentEvent[] = []; for await (const event of agent.run(input, session, signal)) result.push(event); return result;
}
describe('Agent loop', () => {
  it('automatically compacts at the context threshold and counts its model call', async () => {
    const f = await fixture();
    f.config.compactThreshold = 0.1;
    const history: Message[] = [{ role: 'user', content: 'original objective' }];
    for (let i = 0; i < 10; i++) history.push({ role: 'assistant', content: 'a'.repeat(3500), toolCalls: [{ id: `old_${i}`, name: 'list_files', args: {} }] }, { role: 'tool', toolCallId: `old_${i}`, content: 'b'.repeat(3500) });
    await f.store.commit(f.session, { type: 'replace_messages', messages: history });
    const provider = new ScriptedProvider([stop('original objective; files inspected; verification pending'), stop('已继续处理。')]);
    const result = await events(new Agent(f.config, provider, f.store, async () => false), '继续', f.session);
    expect(result).toContainEqual({ type: 'compaction', status: 'completed' });
    expect(result.at(-1)).toMatchObject({ reason: 'completed', calls: 2 });
    expect(provider.requests[1]?.messages[0]?.content).toContain('context_summary');
  });
  it('executes multiple tool rounds and returns actual tool results to the model', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([call('a', 'write_file', { path: 'hello.ts', content: 'export const n = 1;' }), call('b', 'read_file', { path: 'hello.ts' }), stop('已创建并读取文件，尚未运行测试。')]);
    const result = await events(new Agent(f.config, provider, f.store, async () => false), '创建文件', f.session);
    expect(await fs.readFile(path.join(f.root, 'hello.ts'), 'utf8')).toContain('n = 1');
    expect(provider.requests[2]?.messages.some(m => m.role === 'tool' && m.content.includes('n = 1'))).toBe(true);
    expect(result.at(-1)).toEqual({ type: 'task_end', reason: 'completed', calls: 3 });
  });
  it('returns unknown tools, invalid parameters, and denials as structured results', async () => {
    const f = await fixture();
    const provider = new ScriptedProvider([call('a', 'missing', {}), call('b', 'write_file', { path: 'bad' }), call('c', 'run_command', { command: 'echo hello' }), stop()]);
    const result = await events(new Agent(f.config, provider, f.store, async () => false), 'test', f.session);
    expect(result.filter(event => event.type === 'tool_end').map(event => event.result.status)).toEqual(['failure', 'failure', 'denied']);
    await expect(fs.access(path.join(f.root, 'bad'))).rejects.toThrow();
  });
  it('pairs every tool call on cancellation without executing remaining calls', async () => {
    const f = await fixture(); const controller = new AbortController();
    const provider = new ScriptedProvider([[{ type: 'tool_call', call: { id: 'a', name: 'run_command', args: { command: 'echo x' } } }, { type: 'tool_call', call: { id: 'b', name: 'write_file', args: { path: 'never', content: 'x' } } }, { type: 'finish', reason: 'tool_calls' }]]);
    const result = await events(new Agent(f.config, provider, f.store, async () => { controller.abort(); return false; }), 'cancel', f.session, controller.signal);
    expect(result.at(-1)).toMatchObject({ reason: 'cancelled' });
    expect(f.session.messages.filter(m => m.role === 'tool')).toHaveLength(2);
    await expect(fs.access(path.join(f.root, 'never'))).rejects.toThrow();
  });
  it('stops at the call budget with paired tool results', async () => {
    const f = await fixture(); f.config.maxCalls = 1;
    const provider = new ScriptedProvider([call('a', 'list_files', {})]);
    const result = await events(new Agent(f.config, provider, f.store, async () => false), 'loop', f.session);
    expect(result.at(-1)).toMatchObject({ reason: 'budget', calls: 1 }); expect(f.session.messages.at(-1)?.role).toBe('tool');
  });
  it('discards partial calls on provider failure and does not execute truncated output', async () => {
    const f = await fixture();
    const broken: ModelProvider = { async *stream() { yield { type: 'text', delta: 'partial' } as ModelEvent; yield { type: 'tool_call', call: { id: 'a', name: 'write_file', args: { path: 'never', content: 'x' } } } as ModelEvent; throw new Error('broken stream'); } };
    const result = await events(new Agent(f.config, broken, f.store, async () => false), 'x', f.session);
    expect(result.at(-1)).toMatchObject({ reason: 'error' }); expect(f.session.messages.at(-1)).toEqual({ role: 'assistant', content: 'partial' });
    const length = new ScriptedProvider([[...call('b', 'write_file', { path: 'never', content: 'x' }).slice(0, 1), { type: 'finish', reason: 'length' }]]);
    expect((await events(new Agent(f.config, length, f.store, async () => false), 'x', f.session)).at(-1)).toMatchObject({ reason: 'truncated' });
    await expect(fs.access(path.join(f.root, 'never'))).rejects.toThrow();
  });
  it('loads root instructions and defers edits when nested instructions are newly discovered', async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.root, 'src'));
    await fs.writeFile(path.join(f.root, 'AGENTS.md'), 'root-rule'); await fs.writeFile(path.join(f.root, 'src', 'AGENTS.md'), 'nested-rule');
    const provider = new ScriptedProvider([call('a', 'write_file', { path: 'src/a.ts', content: 'x' }), request => { expect(request.system).toContain('nested-rule'); return call('b', 'write_file', { path: 'src/a.ts', content: 'x' }); }, stop()]);
    const result = await events(new Agent(f.config, provider, f.store, async () => false), 'x', f.session);
    expect(provider.requests[0]?.system).toContain('root-rule');
    expect(result.filter(e => e.type === 'tool_end').map(e => e.result.status)).toEqual(['failure', 'success']);
  });
  it('compacts only whole tool groups, retains recent context, and preserves history on failure', async () => {
    const f = await fixture();
    const messages: Message[] = [{ role: 'user', content: 'task' }];
    for (let i = 0; i < 10; i++) messages.push({ role: 'assistant', content: 'details'.repeat(100), toolCalls: [{ id: String(i), name: 'list_files', args: {} }] }, { role: 'tool', toolCallId: String(i), content: 'result'.repeat(100) });
    await f.store.commit(f.session, { type: 'replace_messages', messages });
    const cut = compactionCut(messages); expect(messages[cut]?.role).not.toBe('tool');
    const provider = new ScriptedProvider([new Error('summary failed'), stop('用户目标 task；已检查文件；待运行验证。')]);
    const agent = new Agent(f.config, provider, f.store, async () => false);
    const original = structuredClone(f.session.messages);
    expect(await agent.compact(f.session, new AbortController().signal)).toBe(false); expect(f.session.messages).toEqual(original);
    expect(await agent.compact(f.session, new AbortController().signal)).toBe(true);
    expect(f.session.messages[0]?.content).toContain('context_summary'); expect(f.session.messages.slice(1)).toEqual(original.slice(cut));
  });
});
