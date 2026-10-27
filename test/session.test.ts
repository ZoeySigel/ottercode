import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { SessionStore } from '../src/session.js';

describe('session durability', () => {
  it('replays journal records newer than a snapshot and removes a broken tail', async () => {
    const f = await fixture();
    const snapshotPath = path.join(f.store.directory(f.session.id), 'snapshot.json');
    const old = await fs.readFile(snapshotPath, 'utf8');
    await f.store.commit(f.session, { type: 'message', message: { role: 'user', content: 'persisted' } });
    await fs.writeFile(snapshotPath, old);
    const journalPath = path.join(f.store.directory(f.session.id), 'journal.jsonl');
    await fs.appendFile(journalPath, '{"seq":2,"type":');
    const restored = await f.store.load(f.session.id);
    expect(restored.messages).toEqual([{ role: 'user', content: 'persisted' }]);
    await f.store.commit(restored, { type: 'message', message: { role: 'assistant', content: 'next' } });
    expect((await f.store.load(f.session.id)).messages).toHaveLength(2);
    expect((await fs.readFile(journalPath, 'utf8')).trim().split('\n').every(line => { JSON.parse(line); return true; })).toBe(true);
  });
  it('repairs incomplete tool groups and never replays side effects', async () => {
    const f = await fixture();
    await f.store.commit(f.session, { type: 'message', message: { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'write_file', args: { path: 'never', content: 'x' } }] } });
    await f.store.commit(f.session, { type: 'tool_start', call: { id: 'pending', name: 'write_file', args: {} } });
    const restored = await f.store.load(f.session.id);
    expect(restored.messages.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'pending' });
    expect(JSON.parse(restored.messages.at(-1)!.content).status).toBe('cancelled');
    await expect(fs.access(path.join(f.root, 'never'))).rejects.toThrow();
  });
  it('isolates projects and validates session identifiers', async () => {
    const f = await fixture(); const other = path.join(f.directory, 'other'); await fs.mkdir(other);
    const foreign = new SessionStore(f.home, other);
    expect(await foreign.list()).toEqual([]);
    await expect(foreign.load(f.session.id)).rejects.toThrow(); await foreign.close();
    expect(() => f.store.directory('../../outside')).toThrow('ID');
  });
  it('restores compacted context rather than resurrecting the full journal', async () => {
    const f = await fixture();
    await f.store.commit(f.session, { type: 'message', message: { role: 'user', content: 'old history' } });
    await f.store.commit(f.session, { type: 'replace_messages', messages: [{ role: 'user', content: 'summary' }] });
    await f.store.commit(f.session, { type: 'message', message: { role: 'assistant', content: 'recent' } });
    expect((await f.store.load(f.session.id)).messages.map(m => m.content)).toEqual(['summary', 'recent']);
  });
  it('prevents two stores from writing the same active session', async () => {
    const f = await fixture(); const second = new SessionStore(f.home, f.root);
    await expect(second.load(f.session.id)).rejects.toThrow('其他');
    await f.store.close(); expect((await second.load(f.session.id)).id).toBe(f.session.id); await second.close();
  });
});
