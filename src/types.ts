export type ApprovalMode = 'ask' | 'auto';
export type ToolCall = { id: string; name: string; args: unknown };
export type Message = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
};
export type ToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ModelRequest = {
  model: string; system: string; messages: Message[]; tools: ToolDefinition[]; maxTokens: number;
};
export type ModelEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' };
export interface ModelProvider {
  stream(request: ModelRequest, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}
export type ToolResult = {
  status: 'success' | 'failure' | 'denied' | 'cancelled';
  content: string;
  exitCode?: number | null;
  durationMs?: number;
  outputPath?: string;
  truncated?: boolean;
  timedOut?: boolean;
};
export type ApprovalRequest = { command: string; cwd: string; shell: string; kind?: 'tool' | 'command'; toolCall?: ToolCall; sessionId?: string };
export type Authorize = (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
export type ToolContext = {
  root: string; outputDir: string; signal: AbortSignal; approval: ApprovalMode;
  commandTimeoutMs: number; shell: string;
  authorize: Authorize;
  emit: (text: string) => void;
  recordChange: (relativePath: string, before: string | null) => Promise<void>;
  captureCommandBaseline: () => Promise<void>;
  delegate?: (task: string, mode: 'read_only' | 'workspace_write') => Promise<ToolResult>;
};
export interface Tool extends ToolDefinition {
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
export type EndReason = 'completed' | 'cancelled' | 'error' | 'budget' | 'truncated' | 'terminated';
export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_output'; id: string; text: string }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult }
  | { type: 'approval_request'; request: ApprovalRequest }
  | { type: 'hook_result'; callId: string; decision: HookDecision }
  | { type: 'usage'; sessionId: string; record: UsageRecord; totals: UsageTotals }
  | { type: 'subagent_start'; sessionId: string; task: string; mode: 'read_only' | 'workspace_write' }
  | { type: 'subagent_event'; sessionId: string; event: AgentEvent }
  | { type: 'subagent_end'; sessionId: string; reason: EndReason }
  | { type: 'task_start'; input: string }
  | { type: 'compaction'; status: 'started' | 'completed' | 'failed' }
  | { type: 'error'; message: string }
  | { type: 'task_end'; reason: EndReason; calls: number };
export type Session = {
  version: 1; id: string; root: string; createdAt: string; updatedAt: string;
  model: string; seq: number; messages: Message[];
  changes: Record<string, { before: string | null }>;
  baselineFiles?: string[];
  parentSessionId?: string;
  children?: { id: string; task: string; mode: 'read_only' | 'workspace_write'; reason?: EndReason }[];
  usageRecords?: UsageRecord[];
  usage?: UsageTotals;
  contextUsage?: ContextUsage;
};
export type Config = {
  root: string; home: string; apiKey: string; baseUrl: string; model: string;
  approval: ApprovalMode; maxTokens: number; contextWindow: number; maxCalls: number;
  commandTimeoutMs: number; requestTimeoutMs: number; shell?: string;
  hooks?: HookConfig[];
  pricing?: Record<string, ModelPricing>;
  tokenizer?: 'o200k_base' | 'cl100k_base';
  compactThreshold?: number;
  reportUsage?: boolean;
  subAgents?: { maxDepth: number; maxCalls: number; maxChildren: number };
};

export type TokenUsage = { inputTokens: number; outputTokens: number; cachedInputTokens?: number; source: 'reported' | 'estimated' };
export type ModelPricing = { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion?: number };
export type UsageRecord = { id: string; sourceSessionId: string; model: string; purpose: 'task' | 'compaction'; tokens: TokenUsage; costUsd: number | null };
export type UsageTotals = { calls: number; inputTokens: number; outputTokens: number; costUsd: number; unpricedCalls: number; estimatedCalls: number };
export type ContextUsage = { model: string; systemHash: string; messagesHash: string; messageCount: number; promptTokens: number };
export type HookResult = { action?: 'allow' | 'deny' | 'terminate'; argsPatch?: Record<string, unknown>; requireApproval?: boolean; reason?: string };
export type HookInput = { call: ToolCall; sessionId: string; parentSessionId?: string; root: string; approval: ApprovalMode };
export type Hook = { name: string; timeoutMs?: number; tools?: string[]; run: (input: HookInput, signal: AbortSignal) => Promise<HookResult> };
export type HookConfig = { name: string; command: string[]; timeoutMs?: number; tools?: string[] };
export type HookDecision = { action: 'allow' | 'deny' | 'terminate'; args: unknown; requireApproval: boolean; outcomes: { name: string; result: HookResult; error?: string }[] };
