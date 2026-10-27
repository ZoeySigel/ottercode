import { Ajv, type ValidateFunction } from 'ajv';
import type { Tool } from '../types.js';
import { fileTools } from './files.js';
import { commandTool } from './command.js';

export const builtinTools = () => [...fileTools(), commandTool()];
export class ToolRegistry {
  private entries = new Map<string, { tool: Tool; validate: ValidateFunction }>();
  constructor(tools: Tool[] = builtinTools()) {
    const ajv = new Ajv({ allErrors: true, strict: true });
    for (const tool of tools) {
      if (this.entries.has(tool.name)) throw new Error(`工具名重复：${tool.name}`);
      this.entries.set(tool.name, { tool, validate: ajv.compile(tool.parameters) });
    }
  }
  definitions() { return [...this.entries.values()].map(({ tool: { name, description, parameters } }) => ({ name, description, parameters })); }
  get(name: string) { return this.entries.get(name); }
}
