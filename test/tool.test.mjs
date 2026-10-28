import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, createSummonTool } from '../src/index.js';
import { CACHE_VERSION } from '../src/cards.js';

const rows = [
  { serverName: 'beta', transport: 'stdio', command: 'node', args: [], env: {}, cwd: '', summary: 'B.', disableTools: [], toolCallTimeoutMs: 60000 },
  { serverName: 'alpha', transport: 'stdio', command: 'node', args: [], env: {}, cwd: '', summary: 'A.', disableTools: [], toolCallTimeoutMs: 60000 },
];
const cache = { version: CACHE_VERSION, servers: {} };

function fakeManager(overrides = {}) {
  return {
    names: ['alpha', 'beta'],
    has: (name) => ['alpha', 'beta'].includes(name),
    summon: async (name) => ({ ok: true, server: name, toolCount: 3, schemaBytes: 1200, tokens: 300, pid: 4242 }),
    release: async (name) => ({ ok: true, server: name }),
    summonAll: async () => [{ ok: true, server: 'alpha', toolCount: 3, schemaBytes: 1200, tokens: 300 }, { ok: true, already: true, server: 'beta', toolCount: 1, tokens: 9 }],
    releaseAll: async () => [{ ok: true, server: 'alpha' }, { ok: true, already: true, server: 'beta' }],
    status: () => [{ serverName: 'alpha', state: 'summoned', toolCount: 3, schemaBytes: 1200, tokens: 300, pid: 4242, lastError: undefined }],
    ...overrides,
  };
}

const tool = (manager = fakeManager()) => createSummonTool({ rows, cache, manager });

test('description carries sorted cards and the honest cost wording', () => {
  const description = tool().description;
  assert.ok(description.indexOf('alpha') < description.indexOf('beta'), 'cards sorted by serverName');
  assert.match(description, /alpha — A\. \(cost unmeasured until first summon\)/);
  assert.match(description, /mcp__<name>__<tool>/);
  assert.match(description, /NEXT turn/);
});

test('list re-renders the cards; status formats state, bytes and pid', async () => {
  assert.equal((await tool().execute({ action: 'list' })).text, tool().description);
  const status = (await tool().execute({ action: 'status' })).text;
  assert.match(status, /alpha: summoned \(3 tools, 1200 schema bytes ≈ 300 tokens\/turn, pid 4242\)/);
});

test('summon and release report cost and next-turn visibility', async () => {
  const summoned = (await tool().execute({ action: 'summon', server: 'alpha' })).text;
  assert.match(summoned, /summoned alpha: 3 tools registered as mcp__alpha__\* \(~300 tokens\/turn/);
  assert.match(summoned, /next turn/);
  const released = (await tool().execute({ action: 'release', server: 'alpha' })).text;
  assert.match(released, /released alpha: its tools unregister from your next turn/);
});

test('"*" acts on every configured server', async () => {
  const all = (await tool().execute({ action: 'summon', server: '*' })).text.split('\n');
  assert.equal(all.length, 2);
  assert.match(all[0], /summoned alpha/);
  assert.match(all[1], /beta is already summoned \(1 tools\)/);
  const released = (await tool().execute({ action: 'release', server: '*' })).text.split('\n');
  assert.match(released[0], /released alpha/);
  assert.match(released[1], /beta is already dormant/);
});

test('guidance for missing server, unknown server, and bad action', async () => {
  assert.match((await tool().execute({ action: 'summon' })).text, /needs a server name/);
  assert.match((await tool().execute({ action: 'release' })).text, /needs a server name/);
  const unknown = (await tool().execute({ action: 'summon', server: 'nope' })).text;
  assert.match(unknown, /unknown server "nope"/);
  assert.match(unknown, /alpha, beta/, 'lists configured servers');
  assert.match((await tool().execute({ action: 'zap' })).text, /unknown action "zap"/);
});

test('summon failure surfaces the child error verbatim', async () => {
  const manager = fakeManager({ summon: async (name) => ({ ok: false, server: name, error: 'spawn ENOENT' }) });
  assert.match((await tool(manager).execute({ action: 'summon', server: 'alpha' })).text, /failed: spawn ENOENT/);
});

test('output renders the canonical text and calls are state-mutating', async () => {
  const definition = tool();
  const value = await definition.execute({ action: 'status' });
  assert.deepEqual(definition.output.render({}, value), [{ type: 'text', text: value.text }]);
  assert.equal(definition.isConcurrencySafe({}), false);
});

test('apply rejects duplicate serverNames and registers exactly one tool', async () => {
  const registered = new Map();
  const cleanups = [];
  const ctx = {
    tools: { register: (definition) => { registered.set(definition.name, definition); return () => registered.delete(definition.name); } },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    effect: (fn) => cleanups.push(fn()),
    get: () => undefined,
  };
  await assert.rejects(
    apply(ctx, { servers: [rows[0], { ...rows[0] }], cacheFile: 'nonexistent-dir/cache.json' }),
    /duplicate serverName/,
  );
  await apply(ctx, { servers: rows, cacheFile: 'nonexistent-dir/cache.json' });
  assert.deepEqual([...registered.keys()], ['mcp_summon']);
  for (const cleanup of cleanups) await cleanup();
  assert.equal(registered.size, 0, 'cleanup unregisters mcp_summon');
});
