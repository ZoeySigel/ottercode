import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { HookRunner, commandHook } from '../src/hooks.js';
import { Agent } from '../src/agent.js';
import { fixture, ScriptedProvider, call, stop } from './helpers.js';
import type { AgentEvent, HookInput, HookResult } from '../src/types.js';

const input: HookInput = { call: { id: 'call', name: 'write_file', args: { path: 'original', content: 'old' } }, sessionId: 'session', root: '.', approval: 'ask' };
describe('before-tool hooks', () => {
  it('executes the validated modified arguments and records the effective call', async () => {
    const f = await fixture(); const provider = new ScriptedProvider([call('w', 'write_file', { path: 'old', content: 'original' }), stop()]);
    const agent = new Agent(f.config, provider, f.store, async () => false, undefined, { hooks: [{ name: 'rewrite', run: async () => ({ argsPatch: { path: 'new', content: 'effective' } }) }] });
    for await (const _event of agent.run('write', f.session)) { /* consume */ }
    expect(await fs.readFile(path.join(f.root, 'new'), 'utf8')).toBe('effective'); await expect(fs.access(path.join(f.root, 'old'))).rejects.toThrow();
    expect(f.session.messages.find(message => message.role === 'tool')?.content).toContain('Hook 实际执行参数');
  });
  it('runs concurrently on independent originals and merges patches in config order', async () => {
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const runner = new HookRunner([
      { name: 'slow-first', async run(copy) { await barrier; expect(copy.call.args).toEqual(input.call.args); return { argsPatch: { path: 'first', content: 'first' } }; } },
      { name: 'fast-second', async run(copy) { expect(copy.call.args).toEqual(input.call.args); release(); return { argsPatch: { path: 'second' } }; } },
    ]);
    const result = await runner.check(input, new AbortController().signal);
    expect(result.args).toEqual({ path: 'second', content: 'first' }); expect(result.outcomes.map(outcome => outcome.name)).toEqual(['slow-first', 'fast-second']);
    expect(input.call.args).toEqual({ path: 'original', content: 'old' });
  });
  it('makes deny sticky and termination stronger than allow and denial', async () => {
    const hooks = (results: HookResult[]) => results.map((result, i) => ({ name: String(i), run: async () => result }));
    expect((await new HookRunner(hooks([{ action: 'deny' }, { action: 'allow', requireApproval: true }])).check(input, new AbortController().signal))).toMatchObject({ action: 'deny', requireApproval: true });
    expect((await new HookRunner(hooks([{ action: 'terminate' }, { action: 'deny' }, { action: 'allow' }])).check(input, new AbortController().signal)).action).toBe('terminate');
  });
  it('times out a hung hook, aborts it, and fails closed', async () => {
    let aborted = false;
    const runner = new HookRunner([{ name: 'hung', timeoutMs: 20, run: async (_input, signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } }]);
    const result = await runner.check(input, new AbortController().signal);
    expect(result.action).toBe('deny'); expect(result.outcomes[0]?.error).toContain('超时'); expect(aborted).toBe(true);
  });
  it('rejects invalid hook results and supports tool filters', async () => {
    const result = await new HookRunner([{ name: 'invalid', run: async () => ({ action: 'bypass' } as unknown as HookResult) }, { name: 'skipped', tools: ['read_file'], run: async () => { throw new Error('must not run'); } }]).check(input, new AbortController().signal);
    expect(result.action).toBe('deny'); expect(result.outcomes).toHaveLength(1);
  });
  it('executes configured subprocess hooks using JSON stdin/stdout', async () => {
    const f = await fixture(); const file = path.join(f.root, 'hook.cjs');
    await fs.writeFile(file, "let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{ const input=JSON.parse(text); console.log(JSON.stringify({argsPatch:{path:'hooked-'+input.call.args.path},requireApproval:true})); });");
    const result = await new HookRunner([commandHook({ name: 'process', command: [process.execPath, file], timeoutMs: 3000 }, f.root)]).check(input, new AbortController().signal);
    expect(result).toMatchObject({ action: 'allow', args: { path: 'hooked-original' }, requireApproval: true });
  });
  it('validates patched paths before approval or execution', async () => {
    const f = await fixture(); let approvals = 0;
    const provider = new ScriptedProvider([call('a', 'write_file', { path: 'safe', content: 'x' }), stop()]);
    const agent = new Agent(f.config, provider, f.store, async () => { approvals++; return true; }, undefined, { hooks: [{ name: 'escape', run: async () => ({ argsPatch: { path: '../escape' }, requireApproval: true }) }] });
    const events: AgentEvent[] = []; for await (const event of agent.run('write', f.session)) events.push(event);
    expect(events.find(event => event.type === 'tool_end')).toMatchObject({ result: { status: 'failure' } }); expect(approvals).toBe(0);
    await expect(fs.access(path.join(f.directory, 'escape'))).rejects.toThrow();
  });
  it('forces approval for writes even in auto mode and approves only patched arguments', async () => {
    const f = await fixture(); f.config.approval = 'auto'; let seen: unknown;
    const provider = new ScriptedProvider([call('a', 'write_file', { path: 'old', content: 'old' }), stop()]);
    const agent = new Agent(f.config, provider, f.store, async request => { seen = request.toolCall?.args; return false; }, undefined, { hooks: [{ name: 'modify', run: async () => ({ argsPatch: { path: 'new', content: 'patched' }, requireApproval: true }) }] });
    const events: AgentEvent[] = []; for await (const event of agent.run('write', f.session)) events.push(event);
    expect(seen).toEqual({ path: 'new', content: 'patched' }); expect(events.find(event => event.type === 'tool_end')).toMatchObject({ result: { status: 'denied' } });
    await expect(fs.access(path.join(f.root, 'new'))).rejects.toThrow();
  });
  it('terminates a task and pairs all skipped calls', async () => {
    const f = await fixture(); const first = call('a', 'write_file', { path: 'a', content: 'x' })[0]!; const second = call('b', 'write_file', { path: 'b', content: 'x' })[0]!;
    const provider = new ScriptedProvider([[first, second, { type: 'finish', reason: 'tool_calls' }]]);
    const agent = new Agent(f.config, provider, f.store, async () => true, undefined, { hooks: [{ name: 'stop', run: async () => ({ action: 'terminate', reason: 'policy stop' }) }] });
    const events: AgentEvent[] = []; for await (const event of agent.run('x', f.session)) events.push(event);
    expect(events.at(-1)).toMatchObject({ reason: 'terminated', calls: 1 }); expect(f.session.messages.filter(m => m.role === 'tool')).toHaveLength(2);
    expect(events.filter(event => event.type === 'tool_end').map(event => event.result.status)).toEqual(['denied', 'cancelled']);
    await expect(fs.access(path.join(f.root, 'a'))).rejects.toThrow();
  });
});
