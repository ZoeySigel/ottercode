#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, type ConfigOptions } from './config.js';
import { OpenAICompatibleProvider } from './provider.js';
import { SessionStore } from './session.js';
import { Agent } from './agent.js';
import type { AgentEvent, Config, EndReason, Session } from './types.js';
import { atomicWrite, errorMessage, safeText } from './utils.js';

const HELP = `ottercode — 本地终端编程 Agent

用法：ottercode [选项]
  --cwd <目录>               项目工作目录
  -p, --prompt <任务>         执行单个非交互任务
  --model <名称>             OpenAI 兼容模型名（必须配置）
  --base-url <URL>           模型 API 基地址
  --approval <ask|auto>      命令确认策略，默认 ask
  --resume <会话ID>          恢复当前项目的指定会话
  --continue                恢复当前项目最近会话
  --max-calls <次数>         单任务模型调用预算，默认 40
  --max-tokens <数量>        单次模型输出上限，默认 4096
  --context-window <数量>    模型上下文容量，默认 32768
  --command-timeout-ms <毫秒> 命令超时，默认 120000
  --request-timeout-ms <毫秒> 模型请求超时，默认 120000
  --shell <路径>             指定 shell 可执行文件
  --serve                    启动持久工作区服务（终端断开后任务继续）
  --port <端口>              工作区服务端口，默认自动分配
  --connect <URL>            通过 SSE 连接本机工作区，不需要模型密钥
  -h, --help                 显示帮助
  --version                  显示版本

密钥仅从 OTTERCODE_API_KEY 环境变量读取。
非交互模式默认拒绝命令；显式 --approval auto 可自动执行。
`;

export function argumentsFor(argv: string[]) {
  return parseArgs({ args: argv, strict: true, allowPositionals: false, options: {
    cwd: { type: 'string' }, prompt: { type: 'string', short: 'p' }, model: { type: 'string' }, 'base-url': { type: 'string' }, approval: { type: 'string' },
    resume: { type: 'string' }, continue: { type: 'boolean' }, 'max-calls': { type: 'string' }, 'max-tokens': { type: 'string' }, 'context-window': { type: 'string' },
    'command-timeout-ms': { type: 'string' }, 'request-timeout-ms': { type: 'string' }, shell: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
    serve: { type: 'boolean' }, port: { type: 'string' }, connect: { type: 'string' },
  } }).values;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = argumentsFor(argv);
  if (args.help) { process.stdout.write(HELP); return 0; }
  if (args.version) { const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }; process.stdout.write(`${pkg.version}\n`); return 0; }
  if (args.resume && args.continue) throw new Error('--resume 与 --continue 不能同时使用');
  if (args.prompt !== undefined && !args.prompt.trim()) throw new Error('任务不能为空');
  if (!args.serve && args.prompt === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('非终端环境请使用 -p "任务"');
  if (args.serve && args.prompt !== undefined) throw new Error('--serve 不支持 -p');
  if (args.port !== undefined && (!Number.isInteger(Number(args.port)) || Number(args.port) < 0 || Number(args.port) > 65535)) throw new Error('port 必须为 0-65535 的整数');
  const options: ConfigOptions = {
    root: args.cwd, model: args.model, baseUrl: args['base-url'], approval: args.approval as Config['approval'] | undefined, shell: args.shell,
    ...(args['max-calls'] !== undefined ? { maxCalls: Number(args['max-calls']) } : {}),
    ...(args['max-tokens'] !== undefined ? { maxTokens: Number(args['max-tokens']) } : {}),
    ...(args['context-window'] !== undefined ? { contextWindow: Number(args['context-window']) } : {}),
    ...(args['command-timeout-ms'] !== undefined ? { commandTimeoutMs: Number(args['command-timeout-ms']) } : {}),
    ...(args['request-timeout-ms'] !== undefined ? { requestTimeoutMs: Number(args['request-timeout-ms']) } : {}),
  };
  const home = process.env.OTTERCODE_HOME ? path.resolve(process.env.OTTERCODE_HOME) : path.join(os.homedir(), '.ottercode');
  if (args.connect) {
    if (args.serve || args.prompt !== undefined) throw new Error('--connect 仅用于连接交互终端');
    let token = process.env.OTTERCODE_SERVER_TOKEN;
    if (!token) {
      const descriptor = JSON.parse(await fs.readFile(path.join(home, 'server.json'), 'utf8')) as { url: string; token: string };
      if (descriptor.url.replace(/\/$/, '') !== args.connect.replace(/\/$/, '')) throw new Error('地址不匹配，请设置 OTTERCODE_SERVER_TOKEN');
      token = descriptor.token;
    }
    const { WorkspaceClient } = await import('./transport.js');
    const { runRemoteTerminal } = await import('./remote-terminal.js');
    await runRemoteTerminal(new WorkspaceClient(args.connect, token)); return 0;
  }
  const config = await loadConfig(options, process.env, home);
  const store = new SessionStore(config.home, config.root);
  try {
    let session: Session;
    const latest = args.continue ? (await store.list())[0]?.id : undefined;
    if (args.resume ?? latest) session = await store.load((args.resume ?? latest)!);
    else session = await store.create(config.model);
    const provider = new OpenAICompatibleProvider(config);
    if (args.prompt !== undefined) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.on('SIGINT', abort); process.on('SIGTERM', abort);
      let reason: EndReason = 'error';
      try {
        const agent = new Agent(config, provider, store, async () => false);
        for await (const event of agent.run(args.prompt, session, controller.signal)) {
          printEvent(event);
          if (event.type === 'task_end') reason = event.reason;
        }
        process.stdout.write('\n');
      } finally { process.off('SIGINT', abort); process.off('SIGTERM', abort); }
      return reason === 'completed' ? 0 : reason === 'cancelled' ? 130 : reason === 'error' ? 1 : 2;
    }
    const { TaskRuntime } = await import('./runtime.js');
    const { listenWorkspace, WorkspaceClient } = await import('./transport.js');
    const { runRemoteTerminal } = await import('./remote-terminal.js');
    const runtime = new TaskRuntime(config, provider, store, session);
    const server = await listenWorkspace(runtime, { port: args.port ? Number(args.port) : 0, token: process.env.OTTERCODE_SERVER_TOKEN });
    try {
      if (args.serve) {
        const descriptor = path.join(home, 'server.json');
        await atomicWrite(descriptor, JSON.stringify({ url: server.url, token: server.token, pid: process.pid }));
        process.stdout.write('ottercode workspace: ' + server.url + '\n');
        const shutdown = new Promise<void>(resolve => {
          const stop = () => { process.off('SIGINT', stop); process.off('SIGTERM', stop); resolve(); };
          process.on('SIGINT', stop); process.on('SIGTERM', stop);
        });
        try { await shutdown; } finally {
          try { const saved = JSON.parse(await fs.readFile(descriptor, 'utf8')) as { token: string }; if (saved.token === server.token) await fs.rm(descriptor); } catch {}
        }
      } else await runRemoteTerminal(new WorkspaceClient(server.url, server.token));
    } finally { await runtime.close(); await server.close(); }
    return 0;
  } finally { await store.close(); }
}

function printEvent(event: AgentEvent): void {
  if (event.type === 'text') process.stdout.write(safeText(event.delta));
  else if (event.type === 'react_step') process.stderr.write(`[react:${event.state.step}] ${event.state.phase}${event.state.phase === 'finish' ? ` (${event.state.reason})` : ''}\n`);
  else if (event.type === 'tool_start') process.stderr.write(`\n[tool] ${safeText(event.call.name)}\n`);
  else if (event.type === 'tool_end') process.stderr.write(`[${event.result.status}] ${safeText(event.result.content)}${event.result.outputPath ? `\n完整日志：${event.result.outputPath}` : ''}\n`);
  else if (event.type === 'error') process.stderr.write(`\n错误：${safeText(event.message)}\n`);
  else if (event.type === 'compaction') process.stderr.write(`[compaction] ${event.status}\n`);
  else if (event.type === 'task_end' && event.reason !== 'completed') process.stderr.write(`[task_end] ${event.reason}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { process.stderr.write(`ottercode: ${safeText(errorMessage(error))}\n`); process.exitCode = 1; });
}
