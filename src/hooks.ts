import { spawn } from 'node:child_process';
import { Ajv } from 'ajv';
import type { Hook, HookConfig, HookDecision, HookInput, HookResult } from './types.js';
import { killTree } from './tools/command.js';
import { errorMessage } from './utils.js';

const validate = new Ajv().compile({ type: 'object', additionalProperties: false, properties: {
  action: { enum: ['allow', 'deny', 'terminate'] }, argsPatch: { type: 'object' }, requireApproval: { type: 'boolean' }, reason: { type: 'string', maxLength: 4096 },
} });

export class HookRunner {
  constructor(private hooks: Hook[] = []) {}
  async check(input: HookInput, signal: AbortSignal): Promise<HookDecision> {
    signal.throwIfAborted();
    const selected = this.hooks.filter(hook => !hook.tools || hook.tools.includes(input.call.name));
    const outcomes = await Promise.all(selected.map(async hook => {
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort!: () => void;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new Error('Hook 超时')); }, hook.timeoutMs ?? 3000);
          abort = () => reject(new Error('Hook 已取消'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
        // All hooks see an independent copy of the same original arguments.
        const result = await Promise.race([Promise.resolve().then(() => hook.run(structuredClone(input), combined)), timeout]);
        if (!validate(result)) throw new Error('Hook 返回格式无效');
        return { name: hook.name, result: structuredClone(result) };
      } catch (error) {
        return { name: hook.name, result: { action: 'deny', reason: errorMessage(error) } as HookResult, error: errorMessage(error) };
      } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }));
    signal.throwIfAborted();
    let args = structuredClone(input.call.args);
    let action: HookDecision['action'] = 'allow';
    let requireApproval = false;
    for (const { result } of outcomes) {
      if (result.argsPatch) {
        if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
        // Define own keys safely, including __proto__, with deterministic shallow replacement.
        args = Object.fromEntries([...Object.entries(args as object), ...Object.entries(result.argsPatch)]);
      }
      if (result.action === 'terminate') action = 'terminate';
      else if (result.action === 'deny' && action !== 'terminate') action = 'deny';
      requireApproval ||= result.requireApproval === true;
    }
    return { action, args, requireApproval, outcomes };
  }
}

export function commandHook(config: HookConfig, root: string): Hook {
  return { ...config, run: (input, signal) => new Promise<HookResult>((resolve, reject) => {
    const env = { ...process.env }; delete env.OTTERCODE_API_KEY;
    const child = spawn(config.command[0]!, config.command.slice(1), { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed: Promise<void> | undefined;
    const stop = () => { killed ??= killTree(child); };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(input)}\n`);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; if (Buffer.byteLength(stdout) > 65536) { stop(); reject(new Error('Hook stdout 超过 64 KiB')); } });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4096); });
    child.on('error', reject);
    child.on('close', code => {
      signal.removeEventListener('abort', stop);
      void (async () => {
        if (killed) await killed;
        if (signal.aborted) throw new Error('Hook 已取消');
        if (code !== 0) throw new Error(`Hook 退出码 ${code}: ${stderr}`);
        resolve(JSON.parse(stdout) as HookResult);
      })().catch(reject);
    });
  }) };
}
