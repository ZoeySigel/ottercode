import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { parseSSE } from './provider.js';
import { TaskRuntime, type EventEnvelope, type WorkspaceSnapshot } from './runtime.js';
import { errorMessage } from './utils.js';

export type SyncEnvelope = { kind: 'snapshot'; id: string; snapshot: WorkspaceSnapshot; replayed: boolean };
export type TransportItem = EventEnvelope | SyncEnvelope | { kind: 'reconnecting'; attempt: number; delayMs: number };
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let data = ''; for await (const chunk of request) { data += chunk; if (Buffer.byteLength(data) > 1100000) throw new Error('请求过大'); }
  const parsed: unknown = JSON.parse(data || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求必须为 JSON 对象');
  return parsed as Record<string, unknown>;
}
const json = (response: ServerResponse, code: number, data: unknown) => { response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(data)); };

export async function listenWorkspace(runtime: TaskRuntime, options: { port?: number; token?: string; heartbeatMs?: number } = {}) {
  const token = options.token ?? randomBytes(32).toString('hex');
  if (token.length < 16) throw new Error('工作区连接 token 至少需要 16 个字符');
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    void (async () => {
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const expected = Buffer.from(token); const provided = Buffer.from(bearer);
      if (request.headers.origin || expected.length !== provided.length || !timingSafeEqual(expected, provided)) { json(response, 401, { error: '连接未授权' }); return; }
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/state') { json(response, 200, runtime.snapshot()); return; }
      if (request.method === 'GET' && url.pathname === '/events') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        response.flushHeaders(); streams.add(response);
        const send = (data: unknown, id?: string) => { if (response.destroyed) return; if (response.writableLength > 1024 * 1024) { response.destroy(); return; } response.write(`${id ? `id: ${id}\n` : ''}data: ${JSON.stringify(data)}\n\n`); };
        const cursor = String(request.headers['last-event-id'] ?? '');
        const position = runtime.events.findIndex(event => event.id === cursor);
        const sameEpoch = cursor.startsWith(`${runtime.epoch}:`);
        const sequence = Number(cursor.split(':').at(-1));
        const replayed = sameEpoch && Number.isInteger(sequence) && sequence <= runtime.revision && (position >= 0 || sequence === runtime.revision);
        if (replayed) for (const item of runtime.events) if (Number(item.id.split(':').at(-1)) > sequence) send(item, item.id);
        const snapshot = runtime.snapshot();
        const id = `${snapshot.epoch}:${snapshot.revision}`;
        send({ kind: 'snapshot', id, snapshot, replayed } satisfies SyncEnvelope, id);
        const unsubscribe = runtime.subscribe(item => {
          send(item, item.id);
          if (item.event.type === 'workspace_changed' || item.event.type === 'task_end' || item.event.type === 'task_start') {
            const state = runtime.snapshot();
            send({ kind: 'snapshot', id: item.id, snapshot: state, replayed: true } satisfies SyncEnvelope, item.id);
          }
        });
        const heartbeat = setInterval(() => send({ kind: 'heartbeat' }), options.heartbeatMs ?? 10000);
        response.on('close', () => { clearInterval(heartbeat); unsubscribe(); streams.delete(response); });
        return;
      }
      if (request.method !== 'POST') { json(response, 404, { error: '接口不存在' }); return; }
      const input = await body(request);
      if (url.pathname === '/tasks') {
        if (typeof input.input !== 'string') throw new Error('缺少 input');
        const key = request.headers['idempotency-key'];
        if (key !== undefined && (typeof key !== 'string' || key.length > 128)) throw new Error('幂等键无效');
        json(response, 202, { taskId: runtime.start(input.input, key as string | undefined) });
      } else if (url.pathname === '/cancel') { runtime.cancel(); json(response, 200, { cancelled: true }); }
      else if (url.pathname === '/commands') { if (typeof input.command !== 'string') throw new Error('缺少 command'); json(response, 200, await runtime.command(input.command)); }
      else if (url.pathname.startsWith('/approvals/')) {
        if (typeof input.approved !== 'boolean') throw new Error('approved 必须为布尔值');
        const found = runtime.approve(url.pathname.slice('/approvals/'.length), input.approved);
        json(response, found ? 200 : 410, found ? { accepted: true } : { error: '审批已结束或不存在' });
      } else json(response, 404, { error: '接口不存在' });
    })().catch(error => { if (!response.headersSent) json(response, 409, { error: errorMessage(error).replaceAll(runtime.config.apiKey, '[REDACTED]') }); else response.destroy(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('无法获取端口');
  return { url: `http://127.0.0.1:${address.port}`, token, disconnect: () => { for (const response of streams) response.destroy(); }, close: async () => { for (const response of streams) response.destroy(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

export class WorkspaceClient {
  private cursor?: string;
  constructor(readonly url: string, readonly token: string, private options: { retryBaseMs?: number; retryMaxMs?: number; idleTimeoutMs?: number; random?: () => number } = {}) {
    const parsed = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.protocol !== 'http:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error('仅支持本机 HTTP 工作区地址');
  }
  async request<T>(route: string, input?: unknown, key?: string): Promise<T> {
    const response = await fetch(`${this.url.replace(/\/$/, '')}${route}`, { method: input === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: input === undefined ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(route === '/commands' ? 600000 : 15000) });
    const data = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(data.error ?? `工作区 HTTP ${response.status}`);
    return data;
  }
  async *watch(signal: AbortSignal): AsyncGenerator<TransportItem> {
    let attempt = 0;
    while (!signal.aborted) {
      const connection = new AbortController(); let watchdog: ReturnType<typeof setTimeout> | undefined;
      const touch = () => { if (watchdog) clearTimeout(watchdog); watchdog = setTimeout(() => connection.abort(), this.options.idleTimeoutMs ?? 30000); };
      const connectedAt = Date.now();
      try {
        touch();
        const response = await fetch(`${this.url.replace(/\/$/, '')}/events`, { headers: { Authorization: `Bearer ${this.token}`, ...(this.cursor ? { 'Last-Event-ID': this.cursor } : {}) }, signal: AbortSignal.any([signal, connection.signal]) });
        if (response.status === 401 || response.status === 403) throw new AuthenticationError('工作区连接 token 无效');
        if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new Error(`SSE 连接失败：${response.status}`);
        for await (const data of parseSSE(response.body)) {
          touch();
          const item = JSON.parse(data) as EventEnvelope | SyncEnvelope | { kind: 'heartbeat' };
          if (item.kind === 'heartbeat') continue;
          if (item.kind !== 'snapshot' && item.kind !== 'event') throw new Error('未知工作区事件');
          if (item.kind === 'event' && this.cursor === item.id) continue;
          this.cursor = item.id; yield item;
        }
      } catch (error) { if (signal.aborted) return; if (error instanceof AuthenticationError) throw error; }
      finally { connection.abort(); if (watchdog) clearTimeout(watchdog); }
      if (signal.aborted) return;
      if (Date.now() - connectedAt > 10000) attempt = 0;
      const base = Math.min(this.options.retryMaxMs ?? 10000, (this.options.retryBaseMs ?? 250) * 2 ** Math.min(attempt++, 10));
      const delayMs = Math.min(this.options.retryMaxMs ?? 10000, Math.floor(base * (1 + (this.options.random ?? Math.random)() * 0.1)));
      yield { kind: 'reconnecting', attempt, delayMs };
      try { await delay(delayMs, undefined, { signal }); } catch { return; }
    }
  }
}
class AuthenticationError extends Error {}
