import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { SessionStore } from '../src/session.js';
import { resolveShell } from '../src/tools/command.js';
import type { Config, ModelEvent, ModelProvider, ModelRequest, ToolContext } from '../src/types.js';

const temporary: string[] = [];
const stores: SessionStore[] = [];
const tempRoot = path.resolve('.test-tmp');
export async function fixture() {
  await fs.mkdir(tempRoot, { recursive: true });
  const directory = await fs.mkdtemp(path.join(tempRoot, 'ottercode-test-'));
  temporary.push(directory);
  const root = path.join(directory, '项目'); const home = path.join(directory, 'home');
  await fs.mkdir(root);
  const canonical = await fs.realpath(root);
  const store = new SessionStore(home, canonical); stores.push(store);
  const config: Config = { root: canonical, home, apiKey: 'test-only-key', baseUrl: 'http://127.0.0.1:1/v1', model: 'test-model', approval: 'ask', maxTokens: 1024, contextWindow: 32768, maxCalls: 40, commandTimeoutMs: 10000, requestTimeoutMs: 10000 };
  const session = await store.create(config.model);
  const context: ToolContext = { root: canonical, outputDir: store.outputDirectory(session), signal: new AbortController().signal, approval: 'auto', commandTimeoutMs: 10000, shell: await resolveShell(), authorize: async () => false, emit: () => {}, recordChange: async (relative, before) => { if (!Object.hasOwn(session.changes, relative)) await store.commit(session, { type: 'change', path: relative, before }); }, captureCommandBaseline: () => store.captureCommandBaseline(session, context.signal) };
  return { directory, root: canonical, home, store, config, session, context };
}
afterEach(async () => {
  for (const store of stores.splice(0)) await store.close();
  for (const directory of temporary.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith('ottercode-test-')) throw new Error('Refusing unsafe test cleanup');
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

export class ScriptedProvider implements ModelProvider {
  requests: ModelRequest[] = [];
  constructor(private scripts: (ModelEvent[] | Error | ((request: ModelRequest) => ModelEvent[]))[]) {}
  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(structuredClone(request));
    const script = this.scripts.shift();
    if (script instanceof Error) throw script;
    if (!script) throw new Error('Unexpected model request');
    yield* typeof script === 'function' ? script(request) : script;
  }
}
export const stop = (text = '完成'): ModelEvent[] => [{ type: 'text', delta: text }, { type: 'finish', reason: 'stop' }];
export const call = (id: string, name: string, args: unknown): ModelEvent[] => [{ type: 'tool_call', call: { id, name, args } }, { type: 'finish', reason: 'tool_calls' }];
export function nodeCommand(code: string): string {
  const quote = (text: string) => process.platform === 'win32' ? `'${text.replaceAll("'", "''")}'` : `'${text.replaceAll("'", "'\\''")}'`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(code)}`;
}
