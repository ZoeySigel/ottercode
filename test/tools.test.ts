import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { fixture } from './helpers.js';
import { ToolRegistry } from '../src/tools/index.js';
import { projectPath } from '../src/tools/path.js';
import { listProjectFiles } from '../src/tools/files.js';
import { sessionDiff } from '../src/session.js';
import type { ToolContext } from '../src/types.js';

const registry = new ToolRegistry();
async function execute(name: string, args: object, context: ToolContext) {
  const entry = registry.get(name)!;
  if (!entry.validate(args)) throw new Error(JSON.stringify(entry.validate.errors));
  return entry.tool.execute(args as Record<string, unknown>, context);
}
describe('project tools', () => {
  it('falls back to Node search when rg is absent', async () => {
    const { root, context, directory } = await fixture(); await fs.writeFile(path.join(root, 'fallback.txt'), 'first\nportable needle\n');
    vi.stubEnv('PATH', directory);
    try { expect((await execute('search_text', { query: 'portable needle' }, context)).content).toContain('fallback.txt:2:'); }
    finally { vi.unstubAllEnvs(); }
  });
  it('honors root and nested .gitignore, dependencies and negations', async () => {
    const { root } = await fixture();
    await fs.mkdir(path.join(root, 'src')); await fs.mkdir(path.join(root, 'node_modules')); await fs.mkdir(path.join(root, '.git'));
    await Promise.all([
      fs.writeFile(path.join(root, '.gitignore'), '*.log\n!keep.log\n'),
      fs.writeFile(path.join(root, 'src', '.gitignore'), 'hidden.ts\n!nested.log\n'),
      ...['skip.log', 'keep.log', 'src/hidden.ts', 'src/nested.log', 'src/中文.ts', 'node_modules/dependency.js', '.git/HEAD'].map(file => fs.writeFile(path.join(root, file), 'hello')),
    ]);
    const files = (await listProjectFiles(root)).files;
    expect(files).toContain('keep.log'); expect(files).toContain('src/中文.ts');
    expect(files).toContain('src/nested.log');
    expect(files).not.toContain('skip.log'); expect(files).not.toContain('src/hidden.ts');
    expect(files.some(file => file.startsWith('node_modules/') || file.startsWith('.git/'))).toBe(false);
    expect((await listProjectFiles(root, 'src')).files).toContain('src/中文.ts');
  });
  it('preserves CRLF and literal replacement dollars, and tracks a non-Git diff', async () => {
    const { root, context, session } = await fixture();
    await fs.writeFile(path.join(root, '中文.ts'), 'const a = 1;\r\nconst b = 2;\r\n');
    await execute('edit_file', { path: '中文.ts', old_string: 'a = 1', new_string: 'a = "$&"' }, context);
    expect(await fs.readFile(path.join(root, '中文.ts'), 'utf8')).toBe('const a = "$&";\r\nconst b = 2;\r\n');
    expect((await execute('read_file', { path: '中文.ts', start_line: 2, end_line: 2 }, context)).content).toContain('2: const b = 2;');
    expect(await sessionDiff(session)).toContain('+const a = "$&";');
    await execute('edit_file', { path: '中文.ts', old_string: 'a = "$&"', new_string: 'a = 3' }, context);
    expect(session.changes['中文.ts']?.before).toContain('a = 1');
  });
  it('rejects zero, duplicate, overlapping and empty edit matches', async () => {
    const { root, context } = await fixture(); await fs.writeFile(path.join(root, 'a'), 'aaa');
    await expect(execute('edit_file', { path: 'a', old_string: 'x', new_string: 'b' }, context)).rejects.toThrow('未匹配');
    await expect(execute('edit_file', { path: 'a', old_string: 'aa', new_string: 'b' }, context)).rejects.toThrow('多处');
    await expect(execute('edit_file', { path: 'a', old_string: '', new_string: 'b' }, context)).rejects.toThrow();
    expect(await fs.readFile(path.join(root, 'a'), 'utf8')).toBe('aaa');
  });
  it('rejects path traversal and external directory links for reads and new writes', async () => {
    const { root, directory, context } = await fixture();
    const outside = path.join(directory, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret'), 'secret');
    await fs.symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(projectPath(root, '../outside/secret')).rejects.toThrow('根目录');
    await expect(execute('read_file', { path: 'link/secret' }, context)).rejects.toThrow('外部');
    await expect(execute('write_file', { path: 'link/new.txt', content: 'bad' }, context)).rejects.toThrow('外部');
    await expect(fs.access(path.join(outside, 'new.txt'))).rejects.toThrow();
    expect((await listProjectFiles(root)).files).not.toContain('link/secret');
  });
  it('limits large reads without breaking Chinese UTF-8', async () => {
    const { root, context } = await fixture(); await fs.writeFile(path.join(root, 'large'), '中'.repeat(30000));
    const result = await execute('read_file', { path: 'large' }, context);
    expect(result.truncated).toBe(true); expect(result.content).not.toContain('�');
    expect(Buffer.byteLength(result.content)).toBeLessThan(33000);
  });
  it('searches literal text and returns file names and line numbers', async () => {
    const { root, context } = await fixture(); await fs.writeFile(path.join(root, '中文.ts'), 'line\nconst value = "a.*b";\nother');
    const result = await execute('search_text', { query: 'a.*b' }, context);
    expect(result.content).toContain('中文.ts:2:');
    const noMatch = await execute('search_text', { query: 'missing literal' }, context); expect(noMatch.content).toContain('没有找到');
  });
  it('tracks newly created files with names also present on Object.prototype', async () => {
    const { context, session } = await fixture();
    await execute('write_file', { path: 'constructor', content: 'hello' }, context);
    await execute('write_file', { path: '__proto__', content: 'otter' }, context);
    expect(Object.hasOwn(session.changes, 'constructor')).toBe(true);
    expect(Object.hasOwn(session.changes, '__proto__')).toBe(true);
    expect(await sessionDiff(session)).toContain('otter');
  });
});
