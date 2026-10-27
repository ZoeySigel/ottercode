import { createHash, randomUUID } from 'node:crypto';
import { getEncoding } from 'js-tiktoken';
import type { ContextUsage, ModelPricing, ModelRequest, TokenUsage, UsageRecord, UsageTotals } from './types.js';

const encodings = new Map<string, ReturnType<typeof getEncoding>>();
const chunkCounts = new Map<string, Map<string, number>>();
export class TokenCounter {
  private cache = new Map<string, number>();
  constructor(private encoding: 'o200k_base' | 'cl100k_base' = 'o200k_base') {}
  private encoder() {
    if (!encodings.has(this.encoding)) encodings.set(this.encoding, getEncoding(this.encoding));
    return encodings.get(this.encoding)!;
  }
  count(value: unknown): number {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const cached = this.cache.get(text); if (cached !== undefined) return cached;
    // Bound BPE work per chunk: long unbroken source strings otherwise have quadratic merge cost.
    // Chunk boundaries slightly overestimate tokens; reported prompt_tokens remains authoritative.
    let count = 0;
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 256);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
      const chunk = text.slice(offset, end);
      if (!chunkCounts.has(this.encoding)) chunkCounts.set(this.encoding, new Map());
      const chunks = chunkCounts.get(this.encoding)!;
      let size = chunks.get(chunk);
      if (size === undefined) { size = this.encoder().encode(chunk).length; if (chunks.size >= 2048) chunks.delete(chunks.keys().next().value!); chunks.set(chunk, size); }
      count += size; offset = end;
    }
    if (text.length <= 131072) { if (this.cache.size >= 32) this.cache.delete(this.cache.keys().next().value!); this.cache.set(text, count); }
    return count;
  }
  truncate(text: string, tokens: number): string {
    if (this.count(text) <= tokens) return text;
    let low = 0; let high = text.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (this.count(text.slice(0, mid)) <= tokens) low = mid; else high = mid - 1; }
    return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
  }
  estimate(request: ModelRequest): number { return this.count({ system: request.system, messages: request.messages, tools: request.tools }) + request.messages.length * 8 + 16; }
  snapshot(request: ModelRequest, promptTokens: number): ContextUsage {
    return { model: request.model, systemHash: hash([request.system, request.tools]), messagesHash: hash(request.messages), messageCount: request.messages.length, promptTokens };
  }
  prompt(request: ModelRequest, previous?: ContextUsage): number {
    if (previous && previous.model === request.model && previous.systemHash === hash([request.system, request.tools]) && previous.messageCount <= request.messages.length && previous.messagesHash === hash(request.messages.slice(0, previous.messageCount))) {
      const extra = request.messages.slice(previous.messageCount);
      return previous.promptTokens + (extra.length ? this.count(extra) + extra.length * 8 : 0);
    }
    return this.estimate(request);
  }
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const emptyUsage = (): UsageTotals => ({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, unpricedCalls: 0, estimatedCalls: 0 });
const round = (value: number) => Math.round(value * 1e12) / 1e12;
export function usageRecord(sourceSessionId: string, model: string, purpose: UsageRecord['purpose'], tokens: TokenUsage, pricing?: ModelPricing): UsageRecord {
  const cached = Math.min(tokens.cachedInputTokens ?? 0, tokens.inputTokens);
  const costUsd = pricing ? round(((tokens.inputTokens - cached) * pricing.inputPerMillion + cached * (pricing.cachedInputPerMillion ?? pricing.inputPerMillion) + tokens.outputTokens * pricing.outputPerMillion) / 1e6) : null;
  return { id: randomUUID(), sourceSessionId, model, purpose, tokens, costUsd };
}
export function addUsage(totals: UsageTotals, record: UsageRecord): UsageTotals {
  return { calls: totals.calls + 1, inputTokens: totals.inputTokens + record.tokens.inputTokens, outputTokens: totals.outputTokens + record.tokens.outputTokens, costUsd: round(totals.costUsd + (record.costUsd ?? 0)), unpricedCalls: totals.unpricedCalls + Number(record.costUsd === null), estimatedCalls: totals.estimatedCalls + Number(record.tokens.source === 'estimated') };
}

export class CallBudget {
  private ownUsed = 0;
  private ownReason?: string;
  private ownChildren = 0;
  readonly limit: number;
  constructor(limit: number, private parent?: CallBudget) { this.limit = parent ? Math.min(parent.limit, parent.used + limit) : limit; }
  get used(): number { return this.parent?.used ?? this.ownUsed; }
  get children(): number { return this.parent?.children ?? this.ownChildren; }
  set children(value: number) { if (this.parent) this.parent.children = value; else this.ownChildren = value; }
  get terminatedReason(): string | undefined { return this.parent?.terminatedReason ?? this.ownReason; }
  set terminatedReason(value: string | undefined) { if (this.parent) this.parent.terminatedReason = value; else this.ownReason = value; }
  take(): void { if (this.used >= this.limit) throw new BudgetExceeded(); if (this.parent) this.parent.take(); else this.ownUsed++; }
}
export class BudgetExceeded extends Error { constructor() { super('已达到共享模型调用预算'); } }
