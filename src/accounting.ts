import type { AgentEvent, Config, ModelEvent, ModelProvider, ModelRequest, Session, TokenUsage } from './types.js';
import type { SessionStore } from './session.js';
import { CallBudget, TokenCounter, usageRecord } from './usage.js';

export async function* accountedStream(provider: ModelProvider, request: ModelRequest, session: Session, store: SessionStore, config: Config, budget: CallBudget, ancestors: Session[], purpose: 'task' | 'compaction', emit: (event: AgentEvent) => void, signal: AbortSignal): AsyncGenerator<ModelEvent> {
  signal.throwIfAborted(); budget.take();
  const counter = new TokenCounter(config.tokenizer);
  let reported: TokenUsage | undefined; let output = '';
  try {
    for await (const event of provider.stream(request, signal)) {
      if (event.type === 'usage') reported = event.usage;
      else if (event.type === 'text') output += event.delta;
      else if (event.type === 'tool_call') output += JSON.stringify(event.call);
      yield event;
    }
  } finally {
    const tokens: TokenUsage = reported ?? { inputTokens: counter.estimate(request), outputTokens: counter.count(output), source: 'estimated' };
    const record = usageRecord(session.id, request.model, purpose, tokens, config.pricing?.[request.model] ?? config.pricing?.['*']);
    for (const target of [session, ...ancestors.toReversed()]) {
      await store.commit(target, { type: 'usage', record });
      emit({ type: 'usage', sessionId: target.id, record, totals: target.usage! });
    }
    if (reported && purpose === 'task') await store.commit(session, { type: 'context_usage', usage: counter.snapshot(request, reported.inputTokens) });
  }
}
