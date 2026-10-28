import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { fixture, nodeCommand } from './helpers.js';
import { WorkspaceClient } from '../src/transport.js';
import type { WorkspaceSnapshot } from '../src/runtime.js';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cli, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
type WireRequest = { messages: { role: string; content?: string; tool_call_id?: string }[] };

describe('CLI with a real local model server', () => {
  it('starts a persistent CLI workspace and serves authenticated SSE to a separate client', async () => {
    const f = await fixture();
    const model = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume request */ }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '独立服务验证完成' }, finish_reason: 'stop' }] })}\n\n`);
      response.end(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve));
    const address = model.address(); if (!address || typeof address === 'string') throw new Error('no model address');
    const service = spawn(process.execPath, ['--import', 'tsx', cli, '--serve', '--cwd', f.root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OTTERCODE_HOME: f.home, OTTERCODE_API_KEY: 'mock', OTTERCODE_MODEL: 'mock', OTTERCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OTTERCODE_SERVER_TOKEN: 'local-service-test-token-1234' } });
    service.stdout.resume(); let stderr = ''; service.stderr.setEncoding('utf8'); service.stderr.on('data', text => { stderr += text; });
    const exited = new Promise<void>(resolve => { service.once('close', () => resolve()); });
    const controller = new AbortController();
    try {
      let descriptor: { url: string; token: string } | undefined;
      for (let i = 0; i < 200 && !descriptor; i++) { try { descriptor = JSON.parse(await fs.readFile(path.join(f.home, 'server.json'), 'utf8')) as { url: string; token: string }; } catch { await delay(20); } }
      expect(descriptor, stderr).toBeDefined();
      const client = new WorkspaceClient(descriptor!.url, descriptor!.token); let started = false;
      for await (const item of client.watch(controller.signal)) {
        if (item.kind === 'snapshot' && !started) { started = true; await client.request('/tasks', { input: '验证独立服务' }); }
        else if (item.kind === 'snapshot' && item.snapshot.task?.status === 'finished') {
          expect(item.snapshot.task.text).toBe('独立服务验证完成'); expect(item.snapshot.usage).toMatchObject({ inputTokens: 100, outputTokens: 10, estimatedCalls: 0, unpricedCalls: 1 }); controller.abort(); break;
        }
      }
      const state = await client.request<WorkspaceSnapshot>('/state'); expect(state.busy).toBe(false);
      await client.request('/commands', { command: '/permissions auto' }); expect((await client.request<WorkspaceSnapshot>('/state')).approval).toBe('auto');
      expect(service.exitCode).toBeNull();
    } finally { controller.abort(); service.kill(); await exited; model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); }
  });
  it.each(['auto', 'ask'] as const)('finds and fixes a failing test, respecting %s command approval', async approval => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'math.cjs'), 'module.exports.add = (a, b) => a - b;\n');
    await fs.writeFile(path.join(f.root, 'check.cjs'), "const assert = require('node:assert/strict'); assert.equal(require('./math.cjs').add(2, 3), 5); console.log('test passed');\n");
    let round = 0; let checked = false;
    const requests: WireRequest[] = [];
    const server = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/v1/chat/completions');
        let raw = ''; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw) as WireRequest; requests.push(body);
        const plans = [
          { name: 'search_text', args: { query: 'add' } },
          { name: 'read_file', args: { path: 'math.cjs' } },
          { name: 'edit_file', args: { path: 'math.cjs', old_string: 'a - b', new_string: 'a + b' } },
          { name: 'run_command', args: { command: nodeCommand("require('./check.cjs')") } },
        ];
        const plan = plans[round++];
        response.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (plan) {
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${round}`, function: { name: plan.name, arguments: JSON.stringify(plan.args) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
        } else {
          const tool = JSON.parse(body.messages.findLast(message => message.role === 'tool')!.content!) as { status: string; content: string; exitCode?: number };
          checked = approval === 'auto' ? tool.status === 'success' && tool.exitCode === 0 && tool.content.includes('test passed') : tool.status === 'denied';
          response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: approval === 'auto' ? '已修复加法，测试真实通过。' : '已修复加法；验证命令未获批准，测试尚未执行。' }, finish_reason: 'stop' }] })}\n\n`);
        }
        response.end('data: [DONE]\n\n');
      } catch (error) { response.destroy(error as Error); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no server address');
    try {
      const env = { OTTERCODE_API_KEY: 'local-test', OTTERCODE_HOME: f.home, OTTERCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OTTERCODE_MODEL: 'local-mock' };
      const result = await run(['--cwd', f.root, '-p', '修复这个项目中失败的测试', '--approval', approval], env);
      expect(result.code, result.stderr).toBe(0); expect(checked).toBe(true); expect(requests).toHaveLength(5);
      expect(await fs.readFile(path.join(f.root, 'math.cjs'), 'utf8')).toContain('a + b');
      expect(result.stdout).toContain(approval === 'auto' ? '真实通过' : '尚未执行');
      const sessions = await f.store.list(); expect(sessions.length).toBe(2);
      const active = sessions.find(s => s.id !== f.session.id)!;
      const restored = await f.store.load(active.id);
      expect(restored.changes['math.cjs']?.before).toContain('a - b');
      expect(restored.messages.filter(m => m.role === 'tool')).toHaveLength(4);
      expect(restored.react).toMatchObject({ phase: 'finish', reason: 'completed', step: 5 });
      expect(result.stderr).toContain('[react:1] reason');
      expect(result.stderr).toContain('[react:5] finish (completed)');
      round = 100;
      const resumed = await run(['--cwd', f.root, '-p', '继续汇报', '--resume', active.id], env);
      // Explicitly release our inspection lock before allowing another CLI writer.
      expect(resumed.code).toBe(1); expect(resumed.stderr).toContain('其他');
      await f.store.close();
      const continued = await run(['--cwd', f.root, '-p', '继续汇报', '--continue'], env);
      expect(continued.code, continued.stderr).toBe(0);
      expect(requests.at(-1)!.messages.some(m => m.role === 'tool')).toBe(true);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('shows help without model configuration and rejects missing model configuration', async () => {
    const f = await fixture();
    expect((await run(['--help'], { OTTERCODE_HOME: f.home, OTTERCODE_API_KEY: '', OTTERCODE_MODEL: '' })).stdout).toContain('--approval');
    const result = await run(['--cwd', f.root, '-p', 'hello'], { OTTERCODE_HOME: f.home, OTTERCODE_API_KEY: 'x', OTTERCODE_MODEL: '' });
    expect(result.code).toBe(1); expect(result.stderr).toContain('模型名');
  });
});
