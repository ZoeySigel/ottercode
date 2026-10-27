import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import stripAnsi from 'strip-ansi';

export const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
export const safeText = (text: string): string => stripAnsi(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  let mode = 0o600;
  try { mode = (await fs.stat(file)).mode; } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const handle = await fs.open(temp, 'wx', mode);
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, { force: true }).catch(() => {}); }
}

export function limitOutput(text: string, maxLines = 200, maxBytes = 32768): { text: string; truncated: boolean } {
  const lines = text.split('\n');
  let tail = lines.slice(-maxLines).join('\n');
  let truncated = lines.length > maxLines;
  if (Buffer.byteLength(tail) > maxBytes) {
    const bytes = Buffer.from(tail);
    let start = bytes.length - maxBytes;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    tail = bytes.subarray(start).toString('utf8');
    truncated = true;
  }
  return { text: tail, truncated };
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  push(value: T): void { this.values.push(value); this.wake?.(); this.wake = undefined; }
  end(): void { this.ended = true; this.wake?.(); this.wake = undefined; }
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.ended) return;
      await new Promise<void>(resolve => { this.wake = resolve; });
    }
  }
}
