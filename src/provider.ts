import { setTimeout as delay } from 'node:timers/promises';
import type { Message, ModelEvent, ModelProvider, ModelRequest, ToolCall } from './types.js';

export class ProviderError extends Error {
  constructor(message: string, public retryable = false) { super(message); this.name = 'ProviderError'; }
}

export function wireMessages(system: string, messages: Message[]): object[] {
  return [{ role: 'system', content: system }, ...messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
    if (message.role === 'assistant' && message.toolCalls?.length) return {
      role: 'assistant', content: message.content || null,
      tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })),
    };
    return { role: message.role, content: message.content };
  })];
}

/** SSE event framing handles CRLF, arbitrary byte boundaries and multiline data. */
export async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  try {
    while (true) {
      const next = await reader.read();
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      if (buffer.length > 8 * 1024 * 1024) throw new ProviderError('SSE 单行超过 8 MiB');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (!line) { if (data.length) { yield data.join('\n'); data = []; } }
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        if (data.reduce((sum, item) => sum + item.length, 0) > 8 * 1024 * 1024) throw new ProviderError('SSE 事件超过 8 MiB');
      }
      if (next.done) break;
    }
    if (buffer.startsWith('data:')) data.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
    if (data.length) yield data.join('\n');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

type Chunk = {
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null;
  error?: { message?: string };
  choices?: { delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
};

export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private options: { apiKey: string; baseUrl: string; requestTimeoutMs?: number; fetch?: typeof fetch; retries?: number; reportUsage?: boolean }) {}

  async *stream(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    for (let attempt = 0; ; attempt++) {
      try { yield* this.attempt(request, signal); return; }
      catch (error) {
        if (signal?.aborted) throw error;
        if (!(error instanceof ProviderError) || !error.retryable || attempt >= (this.options.retries ?? 2)) throw error;
        await delay(200 * 2 ** attempt, undefined, { signal });
      }
    }
  }

  private async *attempt(request: ModelRequest, signal?: AbortSignal): AsyncGenerator<ModelEvent> {
    const timeout = AbortSignal.timeout(this.options.requestTimeoutMs ?? 120000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(`${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal: combined,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.options.apiKey}` },
        body: JSON.stringify({ model: request.model, messages: wireMessages(request.system, request.messages), stream: true, ...(this.options.reportUsage !== false ? { stream_options: { include_usage: true } } : {}),
          max_tokens: request.maxTokens,
          ...(request.tools.length ? { tools: request.tools.map(tool => ({ type: 'function', function: tool })) } : {}),
        }),
      });
    } catch (error) {
      if (combined.aborted) throw error;
      throw new ProviderError('连接模型服务失败，请检查 base URL 与网络', true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(`模型服务返回 HTTP ${response.status}`, response.status === 429 || response.status >= 500);
    }
    if (!response.body) throw new ProviderError('模型服务未返回响应流');
    const buffers = new Map<number, { id: string; name: string; arguments: string }>();
    let finish: 'stop' | 'tool_calls' | 'length' | undefined;
    let receivedDelta = false;
    try {
      for await (const data of parseSSE(response.body)) {
        if (data.trim() === '[DONE]') break;
        let chunk: Chunk;
        try { chunk = JSON.parse(data) as Chunk; } catch { throw new ProviderError('模型服务返回无效 SSE JSON'); }
        if (!chunk || typeof chunk !== 'object') throw new ProviderError('模型服务返回无效 SSE 对象');
        if (chunk.error) throw new ProviderError('模型服务在流中返回错误');
        if (chunk.usage) {
          const { prompt_tokens: inputTokens, completion_tokens: outputTokens, prompt_tokens_details } = chunk.usage;
          const cachedInputTokens = prompt_tokens_details?.cached_tokens ?? 0;
          if (![inputTokens, outputTokens, cachedInputTokens].every(value => Number.isSafeInteger(value) && value! >= 0) || cachedInputTokens > inputTokens!) throw new ProviderError('模型用量格式无效');
          yield { type: 'usage', usage: { inputTokens: inputTokens!, outputTokens: outputTokens!, cachedInputTokens, source: 'reported' } };
        }
        if (!Array.isArray(chunk.choices)) throw new ProviderError('SSE 缺少 choices');
        const choice = chunk.choices[0];
        if (!choice) continue; // optional usage-only chunk
        if (finish && (choice.delta?.content || choice.delta?.tool_calls?.length)) throw new ProviderError('终止标记之后仍有响应增量');
        const delta = choice.delta;
        if (delta?.content) {
          if (typeof delta.content !== 'string') throw new ProviderError('文本增量格式错误');
          receivedDelta = true;
          yield { type: 'text', delta: delta.content };
        }
        for (const part of delta?.tool_calls ?? []) {
          receivedDelta = true;
          if (!Number.isInteger(part.index) || part.index! < 0) throw new ProviderError('工具调用缺少有效 index');
          const item = buffers.get(part.index!) ?? { id: '', name: '', arguments: '' };
          if (part.id) item.id = part.id;
          if (part.function?.name) item.name += part.function.name;
          if (part.function?.arguments) item.arguments += part.function.arguments;
          if (item.arguments.length > 8 * 1024 * 1024) throw new ProviderError('工具参数超过 8 MiB');
          buffers.set(part.index!, item);
        }
        if (choice.finish_reason) {
          if (!['stop', 'tool_calls', 'length'].includes(choice.finish_reason)) throw new ProviderError(`模型终止原因：${choice.finish_reason}`);
          finish = choice.finish_reason as typeof finish;
        }
      }
    } catch (error) {
      if (error instanceof ProviderError || combined.aborted) throw error;
      throw new ProviderError('模型响应连接异常结束', !receivedDelta);
    }
    if (combined.aborted) combined.throwIfAborted();
    if (!finish) throw new ProviderError('模型流提前结束，缺少 finish_reason');
    // A truncated response is never allowed to execute tools, even if some args parse.
    if (finish === 'length') { yield { type: 'finish', reason: finish }; return; }
    if ((finish === 'tool_calls') !== (buffers.size > 0)) throw new ProviderError('工具调用与 finish_reason 不一致');
    const calls: ToolCall[] = [];
    const ids = new Set<string>();
    for (const [, item] of [...buffers].sort(([a], [b]) => a - b)) {
      if (!item.id || !item.name || ids.has(item.id)) throw new ProviderError('工具调用 ID 或名称无效');
      let args: unknown;
      try { args = JSON.parse(item.arguments); } catch { throw new ProviderError(`工具 ${item.name} 参数不是完整 JSON`); }
      ids.add(item.id);
      calls.push({ id: item.id, name: item.name, args });
    }
    // Validate every call before exposing any executable call.
    for (const call of calls) yield { type: 'tool_call', call };
    yield { type: 'finish', reason: finish };
  }
}
