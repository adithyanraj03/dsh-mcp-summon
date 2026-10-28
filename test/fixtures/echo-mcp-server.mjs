#!/usr/bin/env node
// echo-mcp-server.mjs — dependency-free stdio MCP fixture for dsh-mcp-summon tests.
//
// Hand-rolled newline-delimited JSON-RPC 2.0 implementing just enough of MCP:
// initialize, ping, tools/list, tools/call. Five tools — echo, add (with an
// outputSchema + structuredContent), now, image (a real 1x1 PNG block, to
// prove summoned tools keep image results), fail (an isError result).
//
// Spawned by the integration tests; also runnable by hand against any MCP client.

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the given message back as text.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Text to echo.' } },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'add',
    description: 'Add two numbers and return the sum as structured content.',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { sum: { type: 'number' } },
      required: ['sum'],
      additionalProperties: false,
    },
  },
  {
    name: 'now',
    description: 'Current UTC time as an ISO 8601 string.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'image',
    description: 'Return a 1x1 PNG image block after a short caption.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'fail',
    description: 'Always return an MCP error result.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let negotiatedVersion = '2025-06-18';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const replyError = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

function call(params) {
  const args = params?.arguments ?? {};
  switch (params?.name) {
    case 'echo':
      return { content: [{ type: 'text', text: `echo: ${args.message ?? ''}` }] };
    case 'add': {
      const sum = Number(args.a) + Number(args.b);
      return { content: [{ type: 'text', text: `sum: ${sum}` }], structuredContent: { sum } };
    }
    case 'now':
      return { content: [{ type: 'text', text: new Date().toISOString() }] };
    case 'image':
      return { content: [{ type: 'text', text: 'a 1x1 png follows' }, { type: 'image', data: PNG_1X1, mimeType: 'image/png' }] };
    case 'fail':
      return { isError: true, content: [{ type: 'text', text: 'boom' }] };
    default:
      return { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] };
  }
}

function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      negotiatedVersion = params?.protocolVersion ?? negotiatedVersion;
      return reply(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'summon-fixture', version: '1.0.0' },
      });
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications get no response
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call':
      return reply(id, call(params));
    default:
      if (id === undefined || id === null) return; // unknown notification
      return replyError(id, -32601, `unknown method: ${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* malformed line: ignore, stay alive */
    }
  }
});
process.stdin.on('end', () => process.exit(0));
