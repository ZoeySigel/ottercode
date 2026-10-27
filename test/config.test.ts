import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { fixture } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { argumentsFor } from '../src/cli.js';

describe('configuration', () => {
  it('prioritizes CLI over environment over user config, keeping secrets out of JSON', async () => {
    const f = await fixture(); await fs.writeFile(path.join(f.home, 'config.json'), JSON.stringify({ model: 'file', maxCalls: 9, approval: 'auto', apiKey: 'ignored' }));
    const env = { OTTERCODE_API_KEY: 'env-key', OTTERCODE_MODEL: 'env', OTTERCODE_MAX_CALLS: '8' };
    const config = await loadConfig({ root: f.root, model: 'cli' }, env, f.home);
    expect(config.model).toBe('cli'); expect(config.maxCalls).toBe(8); expect(config.approval).toBe('auto'); expect(config.apiKey).toBe('env-key');
    await expect(loadConfig({ root: f.root }, {}, f.home)).rejects.toThrow('API_KEY');
  });
  it('requires a model, validates budgets and URLs, and parses the promised CLI flags', async () => {
    const f = await fixture(); const env = { OTTERCODE_API_KEY: 'x' };
    await expect(loadConfig({ root: f.root }, env, f.home)).rejects.toThrow('模型名');
    await expect(loadConfig({ root: f.root, model: 'm', maxCalls: -1 }, env, f.home)).rejects.toThrow('maxCalls');
    await expect(loadConfig({ root: f.root, model: 'm', baseUrl: 'file:///secret' }, env, f.home)).rejects.toThrow('HTTP');
    expect(argumentsFor(['--cwd', 'project', '-p', 'task', '--continue', '--approval', 'auto'])).toMatchObject({ cwd: 'project', prompt: 'task', continue: true, approval: 'auto' });
  });
});
