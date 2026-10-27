import React from 'react';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { render, renderToString } from 'ink';
import { describe, it, expect, vi } from 'vitest';
import { editDraft, insertDraft } from '../src/terminal-input.js';
import { TerminalApp, TerminalController, markdownText } from '../src/terminal.js';
import { safeText } from '../src/utils.js';

describe('terminal interaction', () => {
  it('edits Unicode input, inserts Alt+Enter and keeps pasted multiline text intact', () => {
    let draft = insertDraft({ text: '', cursor: 0 }, '中文🦦');
    draft = editDraft(draft, '', { return: true, meta: true });
    draft = insertDraft(draft, '第二行\r\n第三行');
    expect(draft.text).toBe('中文🦦\n第二行\n第三行');
    draft = editDraft({ text: '中🦦文', cursor: 2 }, '', { backspace: true });
    expect(draft).toEqual({ text: '中文', cursor: 1 });
  });
  it('renders Chinese, code highlighting and full command approval information', () => {
    const controller = new TerminalController(); controller.setLabel('中文项目');
    const abort = new AbortController(); void controller.confirm({ command: 'echo 中文', cwd: 'D:\\项目', shell: 'pwsh.exe' }, abort.signal);
    const output = renderToString(<TerminalApp controller={controller} />);
    expect(safeText(output)).toContain('echo 中文'); expect(output).toContain('pwsh.exe'); expect(output).toContain('[y/N]');
    expect(safeText(markdownText('**你好**\n```ts\nconst n = 1;\n```'))).toContain('const n = 1;');
    abort.abort();
  });
  it('resolves an aborted approval without executing it', async () => {
    const controller = new TerminalController(); const abort = new AbortController();
    const pending = controller.confirm({ command: 'echo x', cwd: '.', shell: 'sh' }, abort.signal);
    abort.abort(); expect(await pending).toBe(false); expect(controller.snapshot().approval).toBeUndefined();
  });
  it('handles raw terminal paste, Alt+Enter, approval and Ctrl+C on Windows-compatible streams', async () => {
    const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: (mode: boolean) => void; ref: () => void; unref: () => void };
    input.isTTY = true; input.setRawMode = () => {}; input.ref = () => {}; input.unref = () => {};
    const output = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean };
    output.columns = 100; output.rows = 30; output.isTTY = true;
    const chunks: string[] = []; output.on('data', data => chunks.push(String(data)));
    const controller = new TerminalController(); const submitted: string[] = []; const cancelled = vi.fn();
    controller.onSubmit = text => submitted.push(text); controller.onCancel = cancelled;
    const instance = render(<TerminalApp controller={controller} />, { stdin: input as unknown as NodeJS.ReadStream, stdout: output as unknown as NodeJS.WriteStream, stderr: output as unknown as NodeJS.WriteStream, exitOnCtrlC: false, patchConsole: false });
    try {
      await delay(100); input.write('中文'); await delay(50); input.write('\x1b\r'); await delay(50);
      input.write('\x1b[200~second\r\nthird\rfourth\x1b[201~'); await delay(50); input.write('\r'); await delay(100);
      expect(submitted).toEqual(['中文\nsecond\nthird\nfourth']);
      controller.setBusy(true); const signal = new AbortController(); const approval = controller.confirm({ command: 'echo approved', cwd: '.', shell: 'pwsh.exe' }, signal.signal);
      await delay(50); input.write('y'); expect(await approval).toBe(true);
      input.write('\x03'); await delay(100); expect(cancelled).toHaveBeenCalledOnce();
      expect(safeText(chunks.join(''))).toContain('echo approved');
    } finally { instance.unmount(); input.destroy(); output.destroy(); }
  });
});
