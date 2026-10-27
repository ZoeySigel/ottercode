// Configure this script by absolute path in ~/.ottercode/config.json.
import path from 'node:path';
let text = '';
for await (const chunk of process.stdin) text += chunk;
const input = JSON.parse(text);
let result = { action: 'allow' };
if (process.env.OTTERCODE_STOP === '1') {
  result = { action: 'terminate', reason: '用户启用了 OTTERCODE_STOP' };
} else if (['write_file', 'edit_file'].includes(input.call.name)) {
  const relative = path.relative(input.root, path.resolve(input.root, input.call.args.path)).replaceAll('\\', '/');
  result = relative === 'protected' || relative.startsWith('protected/')
    ? { action: 'deny', reason: '示例策略：protected 目录只读' }
    : { action: 'allow', requireApproval: true, reason: '示例策略：文件修改需要审批' };
} else if (input.call.name === 'run_command') {
  result = { action: 'allow', argsPatch: { timeout_ms: Math.min(input.call.args.timeout_ms ?? 30000, 30000) }, requireApproval: true };
}
process.stdout.write(JSON.stringify(result) + '\n');
