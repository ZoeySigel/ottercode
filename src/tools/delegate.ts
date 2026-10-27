import type { Tool } from '../types.js';
export function delegateTool(): Tool {
  return {
    name: 'delegate_task',
    description: '委派一个边界清晰的子任务。子 Agent 使用独立会话，仅返回最终摘要；默认 read_only，只能搜索和读取。workspace_write 允许修改并继承当前 Hook 与命令审批。调用与费用计入父会话共享预算。',
    parameters: { type: 'object', additionalProperties: false, required: ['task'], properties: { task: { type: 'string', minLength: 1, maxLength: 16000 }, mode: { enum: ['read_only', 'workspace_write'] } } },
    async execute(args, context) {
      if (!context.delegate) throw new Error('当前执行层级不允许继续委派');
      return context.delegate(args.task as string, (args.mode as 'read_only' | 'workspace_write' | undefined) ?? 'read_only');
    },
  };
}
