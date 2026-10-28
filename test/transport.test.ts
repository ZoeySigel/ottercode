import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { TaskRuntime, type WorkspaceSnapshot } from '../src/runtime.js';
import { listenWorkspace, WorkspaceClient, type TransportItem } from '../src/transport.js';
import { fixture, ScriptedProvider, call, stop } from './helpers.js';
import type { ModelProvider } from '../src/types.js';

describe('workspace SSE transport', () => {
  it('replays messages produced while disconnected without rerunning the model', async () => {
    const f = await fixture(); let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let calls = 0;
    const provider: ModelProvider = { async *stream() { calls++; yield { type: 'text', delta: 'A' }; await barrier; yield { type: 'text', delta: 'B' }; yield { type: 'finish', reason: 'stop' }; } };
    const runtime = new TaskRuntime(f.config, provider, f.store, f.session); const server = await listenWorkspace(runtime);
    const client = new WorkspaceClient(server.url, server.token, { retryBaseMs: 20, random: () => 0 }); const controller = new AbortController(); let started = false; let text = ''; let disconnected = false;
    try {
      for await (const item of client.watch(controller.signal)) {
        if (item.kind === 'snapshot' && !started) { started = true; runtime.start('task'); }
        if (item.kind === 'event' && item.event.type === 'text') {
          text += item.event.delta;
          if (!disconnected) { disconnected = true; server.disconnect(); release(); }
        }
        if (item.kind === 'snapshot' && item.snapshot.task?.status === 'finished') { expect(item.snapshot.task.text).toBe('AB'); controller.abort(); break; }
      }
      expect(text).toBe('AB'); expect(calls).toBe(1);
    } finally { release(); controller.abort(); await runtime.close(); await server.close(); }
  });
  it('reconnects after a real socket drop, replays missing events and resynchronizes pending approvals', async () => {
    const f = await fixture(); const provider = new ScriptedProvider([call('cmd', 'run_command', { command: 'echo never' }), stop('命令未执行')]);
    const runtime = new TaskRuntime(f.config, provider, f.store, f.session); const server = await listenWorkspace(runtime, { heartbeatMs: 20 });
    const client = new WorkspaceClient(server.url, server.token, { retryBaseMs: 10, retryMaxMs: 40, random: () => 0 });
    const controller = new AbortController(); let disconnected = false; let reconnects = 0; let restored = false; const ids: string[] = [];
    try {
      for await (const item of client.watch(controller.signal)) {
        if (item.kind === 'reconnecting') { reconnects++; continue; }
        if (item.kind === 'event') ids.push(item.id);
        if (item.kind === 'snapshot' && !disconnected && !item.snapshot.task) {
          const key = 'same-request'; const started = await client.request<{ taskId: string }>('/tasks', { input: 'validate' }, key);
          expect(await client.request('/tasks', { input: 'validate' }, key)).toEqual(started);
        } else if (item.kind === 'event' && item.event.type === 'approval_pending' && !disconnected) {
          disconnected = true; server.disconnect();
        } else if (item.kind === 'snapshot' && disconnected && item.snapshot.approvals.length) {
          expect(item.snapshot.task?.react).toMatchObject({ phase: 'action', toolCallId: 'cmd' });
          restored = true; const approval = item.snapshot.approvals[0]!;
          expect(await client.request('/approvals/' + approval.id, { approved: false })).toEqual({ accepted: true });
          await expect(client.request('/approvals/' + approval.id, { approved: true })).rejects.toThrow('已结束');
        } else if (item.kind === 'snapshot' && item.snapshot.task?.status === 'finished') {
          expect(item.snapshot.task.text).toContain('未执行'); expect(item.snapshot.approvals).toEqual([]); controller.abort(); break;
        }
      }
      expect(restored).toBe(true); expect(reconnects).toBeGreaterThan(0); expect(new Set(ids).size).toBe(ids.length); expect(provider.requests).toHaveLength(2);
    } finally { controller.abort(); await runtime.close(); await server.close(); }
  });
  it('keeps a task alive without any event subscribers and restores its completed state', async () => {
    const f = await fixture(); const provider: ModelProvider = { async *stream() { yield { type: 'text', delta: '开始' }; await delay(50); yield { type: 'text', delta: '完成' }; yield { type: 'finish', reason: 'stop' }; } };
    const runtime = new TaskRuntime(f.config, provider, f.store, f.session); const server = await listenWorkspace(runtime);
    try {
      runtime.start('work'); await runtime.wait();
      const client = new WorkspaceClient(server.url, server.token); const state = await client.request<WorkspaceSnapshot>('/state');
      expect(state.task).toMatchObject({ status: 'finished', reason: 'completed', text: '开始完成' }); expect(state.messages.at(-1)?.content).toBe('开始完成');
      const controller = new AbortController();
      for await (const item of client.watch(controller.signal)) { expect(item.kind).toBe('snapshot'); controller.abort(); break; }
    } finally { await runtime.close(); await server.close(); }
  });
  it('uses exponential backoff across repeated connection failures and stops immediately on cancellation', async () => {
    const client = new WorkspaceClient('http://127.0.0.1:1', 'unused-token-value', { retryBaseMs: 5, retryMaxMs: 20, random: () => 0 });
    const controller = new AbortController(); const waits: number[] = [];
    for await (const item of client.watch(controller.signal)) if (item.kind === 'reconnecting') { waits.push(item.delayMs); if (waits.length === 4) controller.abort(); }
    expect(waits).toEqual([5, 10, 20, 20]);
  });
  it('requires authorization, rejects cross-origin clients and does not retry invalid credentials', async () => {
    const f = await fixture(); const runtime = new TaskRuntime(f.config, new ScriptedProvider([]), f.store, f.session); const server = await listenWorkspace(runtime);
    try {
      expect((await fetch(server.url + '/state')).status).toBe(401);
      expect((await fetch(server.url + '/state', { headers: { Authorization: 'Bearer ' + server.token, Origin: 'https://example.com' } })).status).toBe(401);
      const client = new WorkspaceClient(server.url, 'invalid-token'); const controller = new AbortController(); const items: TransportItem[] = [];
      await expect((async () => { for await (const item of client.watch(controller.signal)) items.push(item); })()).rejects.toThrow('token');
      expect(items).toEqual([]);
    } finally { await runtime.close(); await server.close(); }
  });
  it('resets from an authoritative snapshot when replay history is evicted', async () => {
    const f = await fixture(); const runtime = new TaskRuntime(f.config, new ScriptedProvider([]), f.store, f.session); const server = await listenWorkspace(runtime);
    const client = new WorkspaceClient(server.url, server.token, { retryBaseMs: 5, random: () => 0 }); const controller = new AbortController(); let started = false;
    try {
      for await (const item of client.watch(controller.signal)) {
        if (item.kind === 'snapshot' && !started) {
          started = true; server.disconnect(); for (let i = 0; i < 1100; i++) runtime.publish({ type: 'text', delta: String(i) });
        } else if (item.kind === 'snapshot' && started) { expect(item.replayed).toBe(false); expect(item.snapshot.revision).toBe(1100); controller.abort(); break; }
      }
    } finally { controller.abort(); await runtime.close(); await server.close(); }
  });
});
