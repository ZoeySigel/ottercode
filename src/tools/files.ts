import { promises as fs } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ignore, { type Ignore } from 'ignore';
import type { Tool, ToolContext, ToolResult } from '../types.js';
import { atomicWrite, limitOutput } from '../utils.js';
import { projectPath, within } from './path.js';

const excluded = new Set(['.git', 'node_modules', 'vendor', '.venv', '.ottercode']);
type Filter = { directory: string; matcher: Ignore };
export async function listProjectFiles(root: string, input = '.', limit = 1000, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const start = await projectPath(root, input);
  if (!(await fs.stat(start)).isDirectory()) throw new Error('list_files 的 path 必须是目录');
  const files: string[] = [];
  let truncated = false;
  async function addFilter(directory: string, filters: Filter[]): Promise<Filter[]> {
    const gitignore = await projectPath(root, path.join(directory, '.gitignore'));
    try { return [...filters, { directory, matcher: ignore().add(await fs.readFile(gitignore, 'utf8')) }]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return filters; throw error; }
  }
  const ancestors: string[] = [];
  let dir = path.dirname(start);
  while (dir !== path.dirname(root) && dir !== start && within(root, dir)) {
    ancestors.unshift(dir);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  let initial: Filter[] = [];
  for (const ancestor of ancestors) initial = await addFilter(ancestor, initial);
  async function visit(directory: string, inherited: Filter[]): Promise<void> {
    signal?.throwIfAborted();
    const filters = await addFilter(directory, inherited);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      const isDir = entry.isDirectory();
      let ignored = false;
      for (const filter of filters) {
        const result = filter.matcher.test(path.relative(filter.directory, target).replaceAll('\\', '/') + (isDir ? '/' : ''));
        if (result.ignored) ignored = true;
        else if (result.unignored) ignored = false;
      }
      if (ignored) continue;
      if (isDir) await visit(target, filters);
      else if (entry.isFile()) {
        if (files.length >= limit) { truncated = true; return; }
        files.push(path.relative(root, target).replaceAll('\\', '/'));
      }
      if (truncated) return;
    }
  }
  await visit(start, initial);
  return { files, truncated };
}

export async function textFile(file: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('路径不是普通文件');
  if (stat.size > 8 * 1024 * 1024) throw new Error('文件超过 8 MiB，请使用命令工具处理');
  const bytes = await fs.readFile(file);
  let content: string;
  try { content = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new Error('文件不是有效 UTF-8 文本'); }
  if (content.includes('\0')) throw new Error('不支持二进制文件');
  return content;
}

async function searchWithRg(root: string, target: string, query: string, limit: number, signal: AbortSignal): Promise<string[] | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn('rg', ['--json', '--fixed-strings', '--line-number', '--hidden', '--no-require-git', ...[...excluded].flatMap(name => ['--glob', `!${name}`]), '--', query, target], { cwd: root, windowsHide: true, signal });
    let buffer = '';
    const matches: string[] = [];
    let intentionalStop = false;
    let failure: Error | undefined;
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2 * 1024 * 1024) { intentionalStop = true; child.kill(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        try {
          const entry = JSON.parse(line) as { type: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
          if (entry.type === 'match' && entry.data?.path?.text) {
            const relative = path.relative(root, path.resolve(root, entry.data.path.text)).replaceAll('\\', '/');
            matches.push(`${relative}:${entry.data.line_number}: ${(entry.data.lines?.text ?? '').trimEnd().slice(0, 2000)}`);
            if (matches.length >= limit) { intentionalStop = true; child.kill(); break; }
          }
        } catch { failure = new Error('rg 返回无效 JSON'); child.kill(); }
      }
    });
    child.on('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') resolve(undefined);
      else reject(error);
    });
    child.on('close', code => {
      if (signal.aborted) { reject(signal.reason); return; }
      if (failure) { reject(failure); return; }
      // Fall back to the portable walker on unsupported rg options or file errors.
      resolve(code === 0 || code === 1 || intentionalStop ? matches : undefined);
    });
  });
}

const parameters = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, required });
const pathField = { type: 'string', minLength: 1, description: '项目内相对路径' };
const success = (content: string): ToolResult => ({ status: 'success', content });

export function fileTools(): Tool[] {
  return [
    {
      name: 'list_files', description: '列出目录下的项目文件，遵循 .gitignore 并跳过依赖目录和符号链接。',
      parameters: parameters({ path: pathField, limit: { type: 'integer', minimum: 1, maximum: 10000 } }),
      async execute(args, context) {
        const result = await listProjectFiles(context.root, args.path as string | undefined, args.limit as number | undefined, context.signal);
        const bounded = limitOutput(result.files.join('\n'));
        return { ...success(bounded.text), truncated: result.truncated || bounded.truncated };
      },
    },
    {
      name: 'search_text', description: '以字面文本搜索项目，返回文件、行号和匹配行。优先使用 rg，遵循 .gitignore。',
      parameters: parameters({ query: { type: 'string', minLength: 1, pattern: '^[^\\r\\n]+$' }, path: pathField, limit: { type: 'integer', minimum: 1, maximum: 200 } }, ['query']),
      async execute(args, context) {
        const input = (args.path as string | undefined) ?? '.';
        const target = await projectPath(context.root, input);
        const query = args.query as string;
        const limit = (args.limit as number | undefined) ?? 100;
        let results = await searchWithRg(context.root, target, query, limit, context.signal);
        let truncated = false;
        if (!results) {
          const stat = await fs.stat(target);
          const listing = stat.isDirectory() ? await listProjectFiles(context.root, input, 10000, context.signal) : { files: [path.relative(context.root, target)], truncated: false };
          truncated = listing.truncated;
          results = [];
          for (const relative of listing.files) {
            context.signal.throwIfAborted();
            let content: string;
            try { content = await textFile(await projectPath(context.root, relative)); } catch { continue; }
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (lines[i]!.includes(query)) results.push(`${relative}:${i + 1}: ${lines[i]!.slice(0, 2000)}`);
              if (results.length >= limit) { truncated = true; break; }
            }
            if (results.length >= limit) break;
          }
        }
        const bounded = limitOutput(results.join('\n') || '没有找到匹配内容。');
        return { ...success(bounded.text), truncated: truncated || results.length >= limit || bounded.truncated };
      },
    },
    {
      name: 'read_file', description: '按行范围读取文本文件，返回行号。默认从第 1 行读取 200 行；可继续分段读取。',
      parameters: parameters({ path: pathField, start_line: { type: 'integer', minimum: 1 }, end_line: { type: 'integer', minimum: 1 } }, ['path']),
      async execute(args, context) {
        const file = await projectPath(context.root, args.path as string);
        const content = await textFile(file);
        const lines = content.split(/\r?\n/);
        const start = (args.start_line as number | undefined) ?? 1;
        const end = (args.end_line as number | undefined) ?? start + 199;
        if (end < start) throw new Error('end_line 不能小于 start_line');
        const selected = lines.slice(start - 1, Math.min(end, start + 199)).map((line, i) => `${start + i}: ${line}`).join('\n');
        // Keep the beginning of the requested range, so the next start line is predictable.
        const bytes = Buffer.from(selected);
        let length = Math.min(bytes.length, 32768);
        while (length < bytes.length && length > 0 && (bytes[length]! & 0xc0) === 0x80) length--;
        return { ...success(`文件 ${args.path}，共 ${lines.length} 行；请求 ${start}-${Math.min(end, start + 199, lines.length)}\n${bytes.subarray(0, length).toString('utf8')}`), truncated: end < lines.length || end >= start + 200 || bytes.length > length };
      },
    },
    {
      name: 'write_file', description: '创建或覆盖项目内 UTF-8 文本文件。覆盖前先阅读现有内容。',
      parameters: parameters({ path: pathField, content: { type: 'string', maxLength: 8 * 1024 * 1024 } }, ['path', 'content']),
      async execute(args, context) {
        const file = await projectPath(context.root, args.path as string);
        if (Buffer.byteLength(args.content as string) > 8 * 1024 * 1024) throw new Error('写入内容超过 8 MiB');
        let before: string | null = null;
        try { before = await textFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        await context.recordChange(path.relative(context.root, file).replaceAll('\\', '/'), before);
        context.signal.throwIfAborted();
        await fs.mkdir(path.dirname(file), { recursive: true });
        await projectPath(context.root, file);
        await atomicWrite(file, args.content as string);
        return success(`已写入 ${args.path}（${Buffer.byteLength(args.content as string)} bytes）`);
      },
    },
    {
      name: 'edit_file', description: '唯一精确文本替换。old_string 必须非空且在文件中只出现一次；保留其余内容和换行。',
      parameters: parameters({ path: pathField, old_string: { type: 'string', minLength: 1 }, new_string: { type: 'string' } }, ['path', 'old_string', 'new_string']),
      async execute(args, context: ToolContext) {
        const file = await projectPath(context.root, args.path as string);
        const before = await textFile(file);
        const old = args.old_string as string;
        const first = before.indexOf(old);
        if (first < 0) throw new Error('old_string 未匹配，请重新读取文件（注意 CRLF 换行）');
        if (before.indexOf(old, first + 1) >= 0) throw new Error('old_string 匹配多处，请提供更多上下文');
        const after = before.slice(0, first) + (args.new_string as string) + before.slice(first + old.length);
        if (Buffer.byteLength(after) > 8 * 1024 * 1024) throw new Error('编辑后的文件超过 8 MiB');
        await context.recordChange(path.relative(context.root, file).replaceAll('\\', '/'), before);
        context.signal.throwIfAborted();
        await projectPath(context.root, file);
        await atomicWrite(file, after);
        return success(`已编辑 ${args.path}`);
      },
    },
  ];
}
