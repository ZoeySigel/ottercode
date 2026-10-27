import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config } from './types.js';
import { Ajv } from 'ajv';

export type ConfigOptions = Partial<Pick<Config, 'root' | 'baseUrl' | 'model' | 'approval' | 'maxTokens' | 'contextWindow' | 'maxCalls' | 'commandTimeoutMs' | 'requestTimeoutMs' | 'shell'>>;

export async function loadConfig(options: ConfigOptions = {}, env: NodeJS.ProcessEnv = process.env, home = path.join(os.homedir(), '.ottercode')): Promise<Config> {
  let file: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('配置必须为 JSON 对象');
    file = parsed as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const value = (key: keyof ConfigOptions, envKey: string, fallback?: unknown): unknown => options[key] ?? env[envKey] ?? file[key] ?? fallback;
  const number = (key: keyof ConfigOptions, envKey: string, fallback: number, min = 1): number => {
    const n = Number(value(key, envKey, fallback));
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${key} 必须是 >= ${min} 的整数`);
    return n;
  };
  const root = await fs.realpath(path.resolve(options.root ?? process.cwd()));
  if (!(await fs.stat(root)).isDirectory()) throw new Error('工作目录必须是文件夹');
  const model = value('model', 'OTTERCODE_MODEL');
  if (typeof model !== 'string' || !model.trim()) throw new Error('请通过 --model、OTTERCODE_MODEL 或 config.json 配置模型名');
  const apiKey = env.OTTERCODE_API_KEY ?? '';
  if (!apiKey.trim()) throw new Error('请设置 OTTERCODE_API_KEY 环境变量（本地兼容服务可设置占位值）');
  const baseUrl = String(value('baseUrl', 'OTTERCODE_BASE_URL', 'https://api.openai.com/v1')).replace(/\/+$/, '');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('baseUrl 必须为不含凭据、查询或片段的 HTTP(S) URL');
  const approval = value('approval', 'OTTERCODE_APPROVAL', 'ask');
  if (approval !== 'ask' && approval !== 'auto') throw new Error('approval 必须为 ask 或 auto');
  const maxTokens = number('maxTokens', 'OTTERCODE_MAX_TOKENS', 4096);
  const contextWindow = number('contextWindow', 'OTTERCODE_CONTEXT_WINDOW', 32768, 1024);
  if (maxTokens >= contextWindow) throw new Error('maxTokens 必须小于 contextWindow');
  const shell = value('shell', 'OTTERCODE_SHELL');
  if (shell !== undefined && (typeof shell !== 'string' || !shell.trim())) throw new Error('shell 必须为可执行文件路径或名称');
  const extensions = {
    hooks: file.hooks ?? [], pricing: file.pricing ?? {}, tokenizer: file.tokenizer ?? 'o200k_base',
    compactThreshold: file.compactThreshold ?? 0.7, reportUsage: file.reportUsage ?? true,
    subAgents: { maxDepth: 1, maxCalls: 8, maxChildren: 4, ...(file.subAgents as object | undefined) },
  };
  const valid = new Ajv({ allErrors: true }).compile({ type: 'object', properties: {
    hooks: { type: 'array', maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['name', 'command'], properties: { name: { type: 'string', minLength: 1 }, command: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } }, timeoutMs: { type: 'integer', minimum: 1, maximum: 60000 }, tools: { type: 'array', items: { type: 'string' } } } } },
    pricing: { type: 'object', additionalProperties: { type: 'object', additionalProperties: false, required: ['inputPerMillion', 'outputPerMillion'], properties: { inputPerMillion: { type: 'number', minimum: 0 }, outputPerMillion: { type: 'number', minimum: 0 }, cachedInputPerMillion: { type: 'number', minimum: 0 } } } },
    tokenizer: { enum: ['o200k_base', 'cl100k_base'] }, compactThreshold: { type: 'number', minimum: 0.1, maximum: 0.95 },
    reportUsage: { type: 'boolean' },
    subAgents: { type: 'object', additionalProperties: false, required: ['maxDepth', 'maxCalls', 'maxChildren'], properties: { maxDepth: { type: 'integer', minimum: 0, maximum: 3 }, maxCalls: { type: 'integer', minimum: 1, maximum: 100 }, maxChildren: { type: 'integer', minimum: 0, maximum: 32 } } },
  } });
  if (!valid(extensions)) throw new Error(`扩展配置无效：${JSON.stringify(valid.errors)}`);
  return {
    root, home, apiKey, baseUrl, model: model.trim(), approval, maxTokens, contextWindow,
    maxCalls: number('maxCalls', 'OTTERCODE_MAX_CALLS', 40),
    commandTimeoutMs: number('commandTimeoutMs', 'OTTERCODE_COMMAND_TIMEOUT_MS', 120000),
    requestTimeoutMs: number('requestTimeoutMs', 'OTTERCODE_REQUEST_TIMEOUT_MS', 120000),
    shell: shell as string | undefined,
    ...extensions as Pick<Config, 'hooks' | 'pricing' | 'tokenizer' | 'compactThreshold' | 'subAgents' | 'reportUsage'>,
  };
}
