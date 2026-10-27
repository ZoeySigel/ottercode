import { promises as fs } from 'node:fs';
import path from 'node:path';

export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Check lexical containment and every existing ancestor (including final symlinks). */
export async function projectPath(root: string, input = '.'): Promise<string> {
  if (input.includes('\0')) throw new Error('路径包含 NUL 字符');
  const absolute = path.resolve(root, input);
  if (!within(root, absolute)) throw new Error('路径超出项目根目录');
  let existing = absolute;
  while (true) {
    try {
      const real = await fs.realpath(existing);
      if (!within(root, real)) throw new Error('符号链接指向项目外部');
      break;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      // A dangling link must not be treated as a missing, writable file.
      try { const stat = await fs.lstat(existing); if (stat.isSymbolicLink()) throw new Error('不允许访问悬空符号链接'); }
      catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT' && (linkError as NodeJS.ErrnoException).code !== 'ENOTDIR') throw linkError; }
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('无法解析项目路径');
      existing = parent;
    }
  }
  return absolute;
}
