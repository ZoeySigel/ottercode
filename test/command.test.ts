import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it, expect, vi } from 'vitest';
import { fixture, nodeCommand } from './helpers.js';
import { commandTool } from '../src/tools/command.js';
import { sessionDiff } from '../src/session.js';

describe('command execution', () => {
  it('includes command edits, creations and deletions in session diff without Git', async () => {
    const { context, root, store, session } = await fixture();
    await fs.writeFile(path.join(root, 'before.txt'), 'old\n'); await fs.writeFile(path.join(root, 'deleted.txt'), 'remove me\n');
    const result = await commandTool().execute({ command: nodeCommand("const fs=require('fs'); fs.writeFileSync('before.txt','updated'); fs.writeFileSync('new.txt','created'); fs.unlinkSync('deleted.txt')") }, context);
    expect(result.status).toBe('success');
    const diff = await sessionDiff(session, store);
    expect(diff).toContain('+updated'); expect(diff).toContain('+created'); expect(diff).toContain('-remove me');
    expect((await store.load(session.id)).baselineFiles).toContain('deleted.txt');
  });
  it('does not execute denied commands and presents the real shell and cwd', async () => {
    const { context, root } = await fixture();
    const authorize = vi.fn(async () => false);
    const result = await commandTool().execute({ command: nodeCommand("require('fs').writeFileSync('should-not-exist', 'x')") }, { ...context, approval: 'ask', authorize });
    expect(result.status).toBe('denied');
    expect(authorize.mock.calls[0]).toMatchObject([{ cwd: root, shell: context.shell }, expect.anything()]);
    await expect(fs.access(path.join(root, 'should-not-exist'))).rejects.toThrow();
  });
  it('streams output, retains exit status, and saves a bounded tail and complete log', async () => {
    const { context } = await fixture(); const output: string[] = [];
    const result = await commandTool().execute({ command: nodeCommand("for(let i=0;i<400;i++) console.log('中文行 ' + i); console.error('failure-tail'); process.exitCode=7") }, { ...context, emit: text => output.push(text) });
    expect(result.status).toBe('failure'); expect(result.exitCode).toBe(7); expect(result.truncated).toBe(true);
    expect(result.content).toContain('failure-tail'); expect(output.join('')).toContain('中文行 0');
    expect(await fs.readFile(result.outputPath!, 'utf8')).toContain('中文行 0');
    expect(result.durationMs).toBeGreaterThan(0);
  });
  it('terminates timed out commands', async () => {
    const { context } = await fixture();
    const result = await commandTool().execute({ command: nodeCommand('setInterval(() => {}, 1000)'), timeout_ms: 500 }, context);
    expect(result.status).toBe('failure'); expect(result.timedOut).toBe(true); expect(result.durationMs).toBeLessThan(10000);
  });
  it('cancels the shell and its child process tree', async () => {
    const { context, root } = await fixture(); const controller = new AbortController();
    const code = "const c=require('child_process').spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'ignore'}); require('fs').writeFileSync('child.pid',String(c.pid)); setInterval(()=>{},1000)";
    const running = commandTool().execute({ command: nodeCommand(code) }, { ...context, signal: controller.signal });
    let pid = 0;
    for (let i = 0; i < 150 && !pid; i++) { await delay(30); try { pid = Number(await fs.readFile(path.join(root, 'child.pid'), 'utf8')); } catch {} }
    controller.abort();
    const result = await running; expect(pid).toBeGreaterThan(0); expect(result.status).toBe('cancelled');
    if (process.platform === 'win32') expect(() => process.kill(pid, 0)).toThrow();
  });
});
