import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createTwoFilesPatch } from 'diff';
import type { ContextUsage, HookDecision, Message, Session, ToolCall, ToolResult, UsageRecord } from './types.js';
import { atomicWrite } from './utils.js';
import { addUsage, emptyUsage } from './usage.js';

type SessionEvent =
  | { type: 'message'; message: Message }
  | { type: 'replace_messages'; messages: Message[] }
  | { type: 'change'; path: string; before: string | null }
  | { type: 'model'; model: string }
  | { type: 'baseline'; files: string[] }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; id: string; result: ToolResult };
// Metadata is journaled with the same crash recovery and idempotency as messages.
type MetadataEvent =
  | { type: 'usage'; record: UsageRecord }
  | { type: 'context_usage'; usage: ContextUsage }
  | { type: 'hook'; callId: string; decision: HookDecision }
  | { type: 'child'; child: NonNullable<Session['children']>[number] };
type JournalEntry = (SessionEvent | MetadataEvent) & { seq: number; timestamp: string };

export function projectKey(root: string): string {
  const normalized = path.normalize(root);
  return createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 24);
}

function apply(session: Session, entry: JournalEntry): void {
  switch (entry.type) {
    case 'message': session.messages.push(entry.message); break;
    case 'replace_messages': session.messages = entry.messages; break;
    case 'change': if (!Object.hasOwn(session.changes, entry.path)) Object.defineProperty(session.changes, entry.path, { value: { before: entry.before }, enumerable: true, writable: true, configurable: true }); break;
    case 'model': session.model = entry.model; break;
    case 'baseline': session.baselineFiles = entry.files; break;
    case 'usage':
      session.usageRecords ??= [];
      if (!session.usageRecords.some(record => record.id === entry.record.id)) { session.usageRecords.push(entry.record); session.usage = addUsage(session.usage ?? emptyUsage(), entry.record); }
      break;
    case 'context_usage': session.contextUsage = entry.usage; break;
    case 'child': {
      session.children ??= [];
      const index = session.children.findIndex(child => child.id === entry.child.id);
      if (index < 0) session.children.push(entry.child); else session.children[index] = entry.child;
      break;
    }
  }
  session.seq = entry.seq;
  session.updatedAt = entry.timestamp;
}

export function repairToolPairs(messages: Message[]): Message[] {
  const repaired: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'tool') continue; // orphan results are not sent to the API
    repaired.push(message);
    if (!message.toolCalls?.length) continue;
    const results = new Map<string, Message>();
    while (messages[i + 1]?.role === 'tool') {
      const next = messages[++i]!;
      if (next.toolCallId) results.set(next.toolCallId, next);
    }
    for (const call of message.toolCalls) repaired.push(results.get(call.id) ?? {
      role: 'tool', toolCallId: call.id,
      content: JSON.stringify({ status: 'cancelled', content: '上次执行已中断，结果未知；不会自动重放。请检查实际文件或进程状态。' } satisfies ToolResult),
    });
  }
  return repaired;
}

export class SessionStore {
  readonly projectDir: string;
  private locks = new Map<string, () => Promise<void>>();
  constructor(readonly home: string, readonly root: string) {
    this.projectDir = path.join(home, 'projects', projectKey(root));
  }
  directory(id: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('会话 ID 格式无效');
    return path.join(this.projectDir, id);
  }
  outputDirectory(session: Session): string { return path.join(this.directory(session.id), 'outputs'); }

  async captureCommandBaseline(session: Session, signal: AbortSignal): Promise<void> {
    if (session.baselineFiles) return;
    const { listProjectFiles, textFile } = await import('./tools/files.js');
    const { projectPath, within } = await import('./tools/path.js');
    const listing = await listProjectFiles(this.root, '.', 100000, signal);
    if (listing.truncated) throw new Error('项目超过 100000 个可见文件，无法完整建立命令变更基线');
    const files: string[] = [];
    for (const relative of listing.files) {
      signal.throwIfAborted();
      if (within(path.resolve(this.home), path.resolve(this.root, relative))) continue;
      let content: string;
      try { content = await textFile(await projectPath(this.root, relative)); }
      catch (error) {
        if (/二进制|UTF-8|8 MiB/.test((error as Error).message) || (error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      await atomicWrite(path.join(this.directory(session.id), 'baseline', relative), content);
      files.push(relative);
    }
    signal.throwIfAborted();
    await this.commit(session, { type: 'baseline', files });
  }

  private async acquire(id: string): Promise<void> {
    if (this.locks.has(id)) return;
    const file = path.join(this.directory(id), 'session.lock');
    await fs.mkdir(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await fs.open(file, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        await handle.close();
        this.locks.set(id, async () => { await fs.rm(file, { force: true }); });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const pid = Number(await fs.readFile(file, 'utf8'));
        let alive = true;
        try { process.kill(pid, 0); } catch (check) { alive = (check as NodeJS.ErrnoException).code !== 'ESRCH'; }
        if (alive || attempt) throw new Error('该会话正被其他 ottercode 进程使用');
        await fs.rm(file, { force: true });
      }
    }
  }
  async close(): Promise<void> {
    for (const id of [...this.locks.keys()]) await this.release(id);
  }
  async release(id: string): Promise<void> {
    const release = this.locks.get(id);
    if (release) { await release(); this.locks.delete(id); }
  }
  async create(model: string, parentSessionId?: string): Promise<Session> {
    const now = new Date().toISOString();
    const session: Session = { version: 1, id: randomUUID(), root: this.root, model, createdAt: now, updatedAt: now, seq: 0, messages: [], changes: {}, ...(parentSessionId ? { parentSessionId } : {}), usage: emptyUsage(), usageRecords: [] };
    await this.acquire(session.id);
    await atomicWrite(path.join(this.directory(session.id), 'snapshot.json'), JSON.stringify(session));
    return session;
  }
  async commit(session: Session, event: SessionEvent | MetadataEvent): Promise<void> {
    if (!this.locks.has(session.id)) throw new Error('会话尚未获取写锁');
    const entry: JournalEntry = { ...event, seq: session.seq + 1, timestamp: new Date().toISOString() };
    const journal = await fs.open(path.join(this.directory(session.id), 'journal.jsonl'), 'a', 0o600);
    try { await journal.writeFile(`${JSON.stringify(entry)}\n`, 'utf8'); await journal.sync(); } finally { await journal.close(); }
    apply(session, entry);
    await atomicWrite(path.join(this.directory(session.id), 'snapshot.json'), JSON.stringify(session));
  }
  async load(id: string, visited = new Set<string>()): Promise<Session> {
    if (visited.has(id) || visited.size > 128) throw new Error('子会话关系存在循环或数量异常');
    visited.add(id);
    await this.acquire(id);
    const session = JSON.parse(await fs.readFile(path.join(this.directory(id), 'snapshot.json'), 'utf8')) as Session;
    if (session.version !== 1 || session.root !== this.root || session.id !== id || !Array.isArray(session.messages)) throw new Error('会话不属于当前项目或格式无效');
    const journalPath = path.join(this.directory(id), 'journal.jsonl');
    let data = '';
    try { data = await fs.readFile(journalPath, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const lines = data.split('\n');
    const valid: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try { entry = JSON.parse(line) as JournalEntry; } catch {
        if (i >= lines.length - 2) break;
        throw new Error('会话日志中间存在损坏记录');
      }
      valid.push(line);
      if (entry.seq > session.seq) {
        if (entry.seq !== session.seq + 1) throw new Error('会话日志序号不连续');
        apply(session, entry);
      }
    }
    // Remove an incomplete crash tail before appending future journal entries.
    if (data && data !== `${valid.join('\n')}\n`) await atomicWrite(journalPath, valid.length ? `${valid.join('\n')}\n` : '');
    const repaired = repairToolPairs(session.messages);
    if (JSON.stringify(repaired) !== JSON.stringify(session.messages)) await this.commit(session, { type: 'replace_messages', messages: repaired });
    else await atomicWrite(path.join(this.directory(id), 'snapshot.json'), JSON.stringify(session));
    // Reconcile usage if a crash happened after the child charge but before its parent rollup.
    for (const childInfo of session.children ?? []) {
      const child = await this.load(childInfo.id, visited);
      try {
        if (child.parentSessionId !== id) throw new Error('子会话父级不匹配');
        for (const record of child.usageRecords ?? []) if (!session.usageRecords?.some(existing => existing.id === record.id)) await this.commit(session, { type: 'usage', record });
        if (!childInfo.reason) await this.commit(session, { type: 'child', child: { ...childInfo, reason: 'cancelled' } });
      } finally { await this.release(child.id); }
    }
    return session;
  }
  async list(includeChildren = false): Promise<Pick<Session, 'id' | 'updatedAt' | 'model' | 'parentSessionId'>[]> {
    let entries: string[];
    try { entries = await fs.readdir(this.projectDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const sessions: Pick<Session, 'id' | 'updatedAt' | 'model' | 'parentSessionId'>[] = [];
    for (const id of entries) {
      try {
        const s = JSON.parse(await fs.readFile(path.join(this.directory(id), 'snapshot.json'), 'utf8')) as Session;
        if (s.root === this.root && s.version === 1 && (includeChildren || !s.parentSessionId)) sessions.push({ id: s.id, updatedAt: s.updatedAt, model: s.model, ...(s.parentSessionId ? { parentSessionId: s.parentSessionId } : {}) });
      } catch { /* incomplete/foreign directory is not a resumable session */ }
    }
    return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export async function sessionDiff(session: Session, store?: SessionStore): Promise<string> {
  const patches: string[] = [];
  // Resolve again at display time: a path may have become a symlink since recording.
  const { projectPath, within } = await import('./tools/path.js');
  const paths = new Set(Object.keys(session.changes));
  const baselines = new Set(session.baselineFiles ?? []);
  if (store && session.baselineFiles) {
    const { listProjectFiles } = await import('./tools/files.js');
    for (const file of session.baselineFiles) paths.add(file);
    for (const file of (await listProjectFiles(session.root, '.', 100000)).files) if (!within(path.resolve(store.home), path.resolve(session.root, file))) paths.add(file);
  }
  for (const relative of paths) {
    let before = Object.hasOwn(session.changes, relative) ? session.changes[relative]!.before : null;
    if (!Object.hasOwn(session.changes, relative) && baselines.has(relative) && store) before = await fs.readFile(path.join(store.directory(session.id), 'baseline', relative), 'utf8');
    const file = await projectPath(session.root, relative);
    let current: string | null = null;
    try { const { textFile } = await import('./tools/files.js'); current = await textFile(file); }
    catch (error) { if (/二进制|UTF-8|8 MiB/.test((error as Error).message)) continue; if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (current !== before) patches.push(createTwoFilesPatch(before === null ? '/dev/null' : `a/${relative}`, current === null ? '/dev/null' : `b/${relative}`, before ?? '', current ?? ''));
  }
  return patches.join('\n') || '当前会话没有文件变更。';
}
