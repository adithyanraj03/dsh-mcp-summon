import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CACHE_VERSION,
  cacheEntry,
  cardLine,
  configHash,
  measureTools,
  readCache,
  renderCards,
  sortServers,
  validEntry,
  writeCache,
} from '../src/cards.js';

const row = (over = {}) => ({
  serverName: 'demo',
  transport: 'stdio',
  command: 'node',
  args: ['server.mjs'],
  env: {},
  cwd: '',
  summary: '',
  disableTools: [],
  toolCallTimeoutMs: 60000,
  ...over,
});

test('configHash ignores card-only fields and tracks measured ones', () => {
  const base = configHash(row());
  assert.equal(configHash(row({ summary: 'a pitch', toolCallTimeoutMs: 1000 })), base, 'summary/timeout do not affect cost');
  assert.notEqual(configHash(row({ command: 'bun' })), base);
  assert.notEqual(configHash(row({ args: ['other.mjs'] })), base);
  assert.notEqual(configHash(row({ disableTools: ['now'] })), base, 'hiding tools changes the measured set');
  assert.notEqual(configHash(row({ env: { TOKEN: 'x' } })), base, 'a rotated credential re-measures');
});

test('measureTools counts exactly the wire-whitelisted fields', () => {
  const tools = [
    { name: 'a', description: 'x', inputSchema: { type: 'object' } },
    { name: 'b', description: undefined, inputSchema: { type: 'object', properties: {} } },
  ];
  const measured = measureTools(tools);
  const expected = tools.reduce(
    (sum, t) => sum + Buffer.byteLength(JSON.stringify({ name: t.name, description: t.description ?? '', parameters: t.inputSchema })),
    0,
  );
  assert.equal(measured.schemaBytes, expected);
  assert.equal(measured.tokens, Math.ceil(expected / 4));
  assert.equal(measured.toolCount, 2);
  assert.deepEqual(measured.toolNames, ['a', 'b']);
});

test('cache round-trips atomically; corrupt or foreign-version files read as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'summon-cache-'));
  const file = join(dir, 'cache.json');
  assert.deepEqual(readCache(file), { version: CACHE_VERSION, servers: {} }, 'missing file');
  const cache = readCache(file);
  cache.servers.demo = cacheEntry(row(), measureTools([{ name: 'a', description: 'x', inputSchema: {} }]));
  writeCache(file, cache);
  const reread = readCache(file);
  assert.equal(reread.servers.demo.toolCount, 1);
  assert.ok(reread.servers.demo.cachedAt > 0);
  writeFileSync(file, '{not json');
  assert.deepEqual(readCache(file).servers, {}, 'corrupt file reads as empty');
  writeFileSync(file, JSON.stringify({ version: 999, servers: { x: {} } }));
  assert.deepEqual(readCache(file).servers, {}, 'foreign version reads as empty');
});

test('validEntry expires when the config fingerprint changes', () => {
  const entry = cacheEntry(row(), measureTools([{ name: 'a', description: '', inputSchema: {} }]));
  assert.ok(validEntry(row(), entry));
  assert.equal(validEntry(row({ command: 'bun' }), entry), undefined);
  assert.equal(validEntry(row(), undefined), undefined);
});

test('cards are byte-stable, sorted, and honest about unmeasured servers', () => {
  const rows = [row({ serverName: 'zeta', summary: 'Z.' }), row({ serverName: 'alpha', summary: 'A.' })];
  const cache = { version: CACHE_VERSION, servers: {} };
  const first = renderCards(sortServers(rows), cache);
  assert.equal(renderCards(sortServers(rows), cache), first, 'byte-stable across renders');
  assert.ok(first.indexOf('alpha') < first.indexOf('zeta'), 'sorted by serverName');
  assert.match(first, /alpha — A\. \(cost unmeasured until first summon\)/);

  cache.servers.zeta = cacheEntry(rows[0], measureTools([
    { name: 't1', description: 'd', inputSchema: {} },
    { name: 't2', description: 'd', inputSchema: {} },
  ]));
  const second = renderCards(sortServers(rows), cache);
  assert.match(second, /zeta — Z\. \(2 tools, ~\d+ tokens\/turn when summoned\)/);
  assert.match(second, /alpha — A\. \(cost unmeasured until first summon\)/);
});

test('card falls back to cached tool names when no summary is configured', () => {
  const r = row({ summary: '' });
  const entry = cacheEntry(r, measureTools(Array.from({ length: 10 }, (_, i) => ({ name: `tool_${i}`, description: '', inputSchema: {} }))));
  const line = cardLine(r, entry);
  assert.ok(line.includes('tool_0, tool_1'), line);
  assert.ok(line.endsWith('… (2 tools, ~1 tokens/turn when summoned)') || line.includes('…'), 'truncated name list');
});

test('empty config renders the guidance line', () => {
  assert.match(renderCards([], { version: CACHE_VERSION, servers: {} }), /none — ask the user/);
});
