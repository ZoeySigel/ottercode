import { randomUUID } from 'node:crypto';
import type { EndReason, ReActState, ToolCall, ToolResult } from './types.js';

/** One model decision followed by serial actions and real observations. */
export class ReActLoop {
  private readonly runId = randomUUID();
  private step = 0;
  private state?: ReActState;
  constructor(private publish: (state: ReActState) => Promise<void>) {}

  private async transition(phase: ReActState): Promise<void> {
    this.state = phase;
    await this.publish(phase);
  }

  async reason(): Promise<void> {
    if (this.state && this.state.phase !== 'observation') throw new Error('ReAct: 必须先观察工具结果才能继续决策');
    await this.transition({ runId: this.runId, step: ++this.step, phase: 'reason' });
  }

  async act(call: ToolCall): Promise<void> {
    if (!this.state || !['reason', 'observation'].includes(this.state.phase)) throw new Error('ReAct: 行动缺少决策或前一行动的观察');
    await this.transition({ runId: this.runId, step: this.step, phase: 'action', toolCallId: call.id, toolName: call.name });
  }

  async observe(call: ToolCall, result: ToolResult): Promise<void> {
    if (this.state?.phase !== 'action' || this.state.toolCallId !== call.id || this.state.toolName !== call.name) throw new Error('ReAct: 观察与当前行动不匹配');
    await this.transition({ runId: this.runId, step: this.step, phase: 'observation', toolCallId: call.id, toolName: call.name, status: result.status });
  }

  async finish(reason: EndReason): Promise<void> {
    if (this.state?.phase === 'finish') throw new Error('ReAct: 任务已结束');
    if (reason === 'completed' && this.state?.phase !== 'reason') throw new Error('ReAct: 完成必须来自模型的最终决策');
    await this.transition({ runId: this.runId, step: this.step, phase: 'finish', reason });
  }
}
