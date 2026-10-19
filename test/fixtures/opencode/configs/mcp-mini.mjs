// Minimal stdio MCP server: one tool `ping`; records its environment to argv[2].
import { writeFileSync } from 'node:fs';
const envFile = process.argv[2];
if (envFile) writeFileSync(envFile, JSON.stringify({ argv: process.argv, env: process.env, cwd: process.cwd() }, null, 2));
let buf = '';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    const { id, method, params } = m;
    if (method === 'initialize') send({ jsonrpc: '2.0', id, result: { protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mini', version: '0.0.1' } } });
    else if (method === 'tools/list') send({ jsonrpc: '2.0', id, result: { tools: [{ name: 'ping', description: 'Returns pong plus a marker. Call it when asked.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
    else if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `pong-from-mcp token=${process.env.ORCH_TOKEN ?? 'unset'}` }] } });
    else if (method === 'ping') send({ jsonrpc: '2.0', id, result: {} });
    else if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
