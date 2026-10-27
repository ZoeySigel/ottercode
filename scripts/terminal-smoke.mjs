// Interactive acceptance harness. Uses only a local mock server, never a real model.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('此验收脚本需要交互终端');
const workspace = fileURLToPath(new URL('../', import.meta.url));
const parent = path.join(workspace, '.test-tmp');
await fs.mkdir(parent, { recursive: true });
const directory = await fs.mkdtemp(path.join(parent, 'terminal-smoke-'));
const root = path.join(directory, '中文项目');
await fs.mkdir(root);
await fs.writeFile(path.join(root, 'example.txt'), 'terminal smoke fixture\n');
const observations = [];
const server = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  const last = body.messages.at(-1);
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const emit = (delta, reason = null) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: reason }] })}\n\n`);
  if (last.role === 'user' && /cancel/i.test(last.content)) {
    observations.push({ cancelledTask: true });
    emit({ content: '等待中，可以按 Ctrl+C 取消。\n' });
    const interval = setInterval(() => emit({ content: '·' }), 500);
    response.on('close', () => clearInterval(interval));
  } else if (last.role === 'user') {
    observations.push({ prompt: last.content });
    emit({ content: '已收到多行任务，将请求运行一条本地验证命令。\n' });
    emit({ tool_calls: [{ index: 0, id: `smoke_${observations.length}`, function: { name: 'run_command', arguments: JSON.stringify({ command: process.platform === 'win32' ? "Write-Output '中文验证通过'" : "printf '中文验证通过\\n'" }) } }] }, 'tool_calls');
    response.end('data: [DONE]\n\n');
  } else {
    observations.push({ result: JSON.parse(last.content).status });
    emit({ content: '**终端验证完成**\n```ts\nconst otter = "🦦";\n```\n命令结果已记录，可输入 cancel 验证中断，再输入 /exit。' }, 'stop');
    response.end('data: [DONE]\n\n');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
console.log('终端验收：输入中文、多行或粘贴内容，确认命令；再输入 cancel 并按 Ctrl+C；最后 /exit。');
try {
  const child = spawn(process.execPath, [path.join(workspace, 'dist', 'cli.js'), '--cwd', root], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, OTTERCODE_HOME: path.join(directory, 'home'), OTTERCODE_MODEL: 'terminal-mock', OTTERCODE_API_KEY: 'mock-only', OTTERCODE_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OTTERCODE_APPROVAL: 'ask' },
  });
  await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  console.log('终端验收记录：', JSON.stringify(observations));
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  if (path.dirname(path.resolve(directory)) !== path.resolve(parent) || !path.basename(directory).startsWith('terminal-smoke-')) throw new Error('Unsafe smoke cleanup path');
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
