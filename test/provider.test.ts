import { describe, it, expect, vi } from 'vitest';
import { OpenAICompatibleProvider, wireMessages } from '../src/provider.js';
import type { ModelEvent, ModelRequest } from '../src/types.js';

const request: ModelRequest = { model: 'test', system: 'test', messages: [{ role: 'user', content: '你好' }], tools: [], maxTokens: 100 };
const frame = (delta: object, finish_reason: string | null = null) => `data:${JSON.stringify({ choices: [{ delta, finish_reason }] })}\r\n\r\n`;
function response(text: string, size = 7) {
  const bytes = new TextEncoder().encode(text); let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) { if (offset >= bytes.length) { controller.close(); return; } controller.enqueue(bytes.slice(offset, offset += size)); } }));
}
function provider(fetcher: typeof fetch, retries = 0) { return new OpenAICompatibleProvider({ apiKey: 'secret', baseUrl: 'http://localhost/v1', fetch: fetcher, retries }); }
async function collect(instance: OpenAICompatibleProvider) { const events: ModelEvent[] = []; for await (const event of instance.stream(request)) events.push(event); return events; }

describe('OpenAI streaming adapter', () => {
  it('reads reported and cached tokens from a usage-only final SSE chunk', async () => {
    const body = frame({ content: 'done' }, 'stop') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 80 } } })}\n\n`;
    const events = await collect(provider(vi.fn<typeof fetch>().mockResolvedValue(response(body))));
    expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 120, outputTokens: 12, cachedInputTokens: 80, source: 'reported' } });
  });
  it('decodes split UTF-8 and interleaved tool argument fragments', async () => {
    const body = frame({ content: '你好🦦' }) + frame({ tool_calls: [
      { index: 1, id: 'b', function: { name: 'read_file', arguments: '{"path":' } },
      { index: 0, id: 'a', function: { name: 'list_files', arguments: '{' } },
    ] }) + frame({ tool_calls: [{ index: 0, function: { arguments: '}' } }, { index: 1, function: { arguments: '"中文.ts"}' } }] }, 'tool_calls') + 'data: [DONE]\r\n\r\n';
    const mock = vi.fn<typeof fetch>().mockResolvedValue(response(body, 1));
    const events = await collect(provider(mock));
    expect(events).toEqual([{ type: 'text', delta: '你好🦦' }, { type: 'tool_call', call: { id: 'a', name: 'list_files', args: {} } }, { type: 'tool_call', call: { id: 'b', name: 'read_file', args: { path: '中文.ts' } } }, { type: 'finish', reason: 'tool_calls' }]);
    expect(mock.mock.calls[0]![0]).toBe('http://localhost/v1/chat/completions');
  });
  it.each([
    ['invalid JSON', 'data: nope\n\n'],
    ['missing finish', frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{}' } }] }) + 'data: [DONE]\n\n'],
    ['invalid args', frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{' } }] }, 'tool_calls')],
    ['mismatched finish', frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{}' } }] }, 'stop')],
  ])('does not expose executable calls for %s', async (_name, body) => {
    const events: ModelEvent[] = [];
    await expect((async () => { for await (const event of provider(vi.fn<typeof fetch>().mockResolvedValue(response(body))).stream(request)) events.push(event); })()).rejects.toThrow();
    expect(events.filter(event => event.type === 'tool_call')).toEqual([]);
  });
  it('never executes even parseable tool calls when output is truncated', async () => {
    const body = frame({ tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{}' } }] }, 'length');
    expect(await collect(provider(vi.fn<typeof fetch>().mockResolvedValue(response(body))))).toEqual([{ type: 'finish', reason: 'length' }]);
  });
  it('retries transient HTTP responses before any increment', async () => {
    const mock = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response(frame({ content: 'ok' }, 'stop')));
    expect(await collect(provider(mock, 2))).toContainEqual({ type: 'text', delta: 'ok' });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it('does not retry a stream that already delivered text', async () => {
    let first = true;
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (first) { first = false; controller.enqueue(new TextEncoder().encode(frame({ content: 'partial' }))); } else controller.error(new Error('disconnected')); } });
    const mock = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(collect(provider(mock, 2))).rejects.toThrow('异常结束');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('serializes tool results with the OpenAI tool role', () => {
    expect(wireMessages('s', [{ role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list_files', args: {} }] }, { role: 'tool', toolCallId: 'a', content: '{}' }])).toMatchObject([{ role: 'system' }, { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] }, { role: 'tool', tool_call_id: 'a' }]);
  });
});
