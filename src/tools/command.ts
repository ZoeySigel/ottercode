import { promises as fs, createWriteStream } from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { finished } from 'node:stream/promises';
import type { Tool, ToolResult } from '../types.js';
import { limitOutput, safeText } from '../utils.js';
import { projectPath } from './path.js';

export async function resolveShell(preferred?: string): Promise<string> {
  if (preferred) return preferred;
  if (process.platform !== 'win32') return '/bin/sh';
  const directories = (process.env.PATH ?? '').split(path.delimiter);
  for (const name of ['pwsh.exe', 'powershell.exe']) {
    for (const directory of directories) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), name);
      try { await fs.access(candidate); return candidate; } catch { /* try next PATH entry */ }
    }
  }
  return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export async function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); resolve(); });
      killer.on('close', () => resolve());
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    // Always follow up on the group: the shell can exit while a descendant ignores SIGTERM.
    await new Promise(resolve => setTimeout(resolve, 250));
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* process group already gone */ }
  }
}

export function commandTool(): Tool {
  return {
    name: 'run_command', description: '使用配置的 shell 执行非交互终端命令。默认必须用户确认。返回退出码、耗时及完整日志路径。命令不受文件工具的项目路径限制。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      command: { type: 'string', minLength: 1, maxLength: 131072 },
      cwd: { type: 'string', minLength: 1, description: '项目内工作目录，默认项目根目录' },
      timeout_ms: { type: 'integer', minimum: 1, maximum: 3600000 },
    }, required: ['command'] },
    async execute(args, context): Promise<ToolResult> {
      const cwd = await projectPath(context.root, (args.cwd as string | undefined) ?? '.');
      if (!(await fs.stat(cwd)).isDirectory()) throw new Error('命令工作目录不是文件夹');
      context.signal.throwIfAborted();
      const command = args.command as string;
      if (context.approval === 'ask' && !await context.authorize({ command, cwd, shell: context.shell }, context.signal)) {
        return { status: context.signal.aborted ? 'cancelled' : 'denied', content: context.signal.aborted ? '命令确认已取消。' : '命令未获批准，未执行。非交互模式需显式 --approval auto。' };
      }
      context.signal.throwIfAborted();
      await context.captureCommandBaseline();
      context.signal.throwIfAborted();
      await projectPath(context.root, cwd);
      await fs.mkdir(context.outputDir, { recursive: true });
      const outputPath = path.join(context.outputDir, `${randomUUID()}.log`);
      const log = createWriteStream(outputPath, { mode: 0o600 });
      let logError: Error | undefined;
      log.on('error', error => { logError = error; });
      const logDone = finished(log).catch(error => { logError = error as Error; });
      const isPowerShell = /(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/i.test(context.shell);
      const shellArgs = isPowerShell ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new(); $global:LASTEXITCODE = 0;\n${command}\n$ottercodeCommandSuccess = $?; if ($ottercodeCommandSuccess) { exit 0 }; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; exit 1`] : ['-c', command];
      const start = Date.now();
      const child = spawn(context.shell, shellArgs, { cwd, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      let totalBytes = 0;
      let totalLines = 0;
      let timedOut = false;
      let spawnError: Error | undefined;
      let killing: Promise<void> | undefined;
      const stop = (): void => { killing ??= killTree(child); };
      log.on('error', () => { child.stdout?.resume(); child.stderr?.resume(); stop(); });
      const timeout = setTimeout(() => { timedOut = true; stop(); }, (args.timeout_ms as number | undefined) ?? context.commandTimeoutMs);
      const onAbort = (): void => stop();
      context.signal.addEventListener('abort', onAbort, { once: true });
      if (context.signal.aborted) stop();
      for (const stream of [child.stdout!, child.stderr!]) {
        const decoder = new StringDecoder('utf8');
        const consume = (text: string): void => {
          if (!text) return;
          totalBytes += Buffer.byteLength(text);
          totalLines += text.split('\n').length - 1;
          tail = limitOutput(tail + text, 201, 65536).text;
          context.emit(safeText(text));
        };
        stream.on('data', (chunk: Buffer) => {
          consume(decoder.write(chunk));
          if (!log.destroyed && !log.write(chunk)) { stream.pause(); log.once('drain', () => stream.resume()); }
        });
        stream.on('end', () => consume(decoder.end()));
      }
      const exitCode = await new Promise<number | null>(resolve => {
        child.once('error', error => { spawnError = error; });
        child.once('close', code => resolve(code));
      });
      clearTimeout(timeout);
      context.signal.removeEventListener('abort', onAbort);
      if (killing) await killing;
      log.end();
      await logDone;
      const bounded = limitOutput(tail);
      const truncated = bounded.truncated || totalBytes > Buffer.byteLength(bounded.text) || totalLines >= 200;
      const status = context.signal.aborted ? 'cancelled' : timedOut || spawnError || logError || exitCode !== 0 ? 'failure' : 'success';
      const prefix = context.signal.aborted ? '命令已取消。\n' : timedOut ? '命令执行超时。\n' : spawnError ? `无法启动 shell：${spawnError.message}\n` : logError ? `日志写入失败：${logError.message}\n` : '';
      return { status, content: `${prefix}${truncated ? '[输出已截断，完整内容见 outputPath]\n' : ''}${safeText(bounded.text)}`, exitCode, durationMs: Date.now() - start, outputPath, truncated, timedOut };
    },
  };
}
