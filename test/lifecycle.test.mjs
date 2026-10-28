// Integration: the real fixture server as a real stdio child. Proves the
// whole claim — summon → native tools appear → they execute over JSON-RPC →
// release → they disappear and the child dies; plus crash fallback,
// disableTools, idempotence, and the measurement cache write.

import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSummonManager } from '../src/lifecycle.js';
import { cacheEntry, readCache, writeCache } from '../src/cards.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/echo-mcp-server.mjs', import.meta.url));

function makeHarness(overrides = {}) {
  const registered = new Map();
  const logs = [];
  const ctx = {
    tools: {
      register: (definition) => {
        if (registered.has(definition.name)) throw new Error(`duplicate registration ${definition.name}`);
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    },
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    get: () => undefined,
  };
  const cacheFile = join(mkdtempSync(join(tmpdir(), 'summon-live-')), 'cache.json');
  const cache = readCache(cacheFile);
  const measured = [];
  // Same wiring apply() uses: record, then persist the measurement.
  const manager = createSummonManager({
    ctx,
    rows: [row(overrides)],
    onMeasured: (r, m) => {
      measured.push([r.serverName, m]);
      cache.servers[r.serverName] = cacheEntry(r, m);
      writeCache(cacheFile, cache);
    },
  });
  return { ctx, registered, logs, manager, cacheFile, measured };
}

function row(over = {}) {
  return {
    serverName: 'summon-fixture',
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    cwd: '',
    summary: '',
    disableTools: [],
    toolCallTimeoutMs: 15000,
    ...over,
  };
}

const exec = () => ({ signal: new AbortController().signal });

async function until(condition, message, ms = 3000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('summon registers native tools, measures them, and writes the cache', async (t) => {
  const h = makeHarness();
  t.after(() => h.manager.releaseAll());
  const result = await h.manager.summon('summon-fixture');
  assert.equal(result.ok, true);
  assert.equal(result.toolCount, 5);
  assert.ok(result.schemaBytes > 100 && result.tokens === Math.ceil(result.schemaBytes / 4));
  assert.ok(Number.isInteger(result.pid) && result.pid > 0, 'reports the child pid');
  assert.deepEqual(
    [...h.registered.keys()].sort(),
    ['mcp__summon-fixture__add', 'mcp__summon-fixture__echo', 'mcp__summon-fixture__fail', 'mcp__summon-fixture__image', 'mcp__summon-fixture__now'],
  );
  assert.equal(h.manager.status()[0].state, 'summoned');
  assert.deepEqual(h.measured.map(([name]) => name), ['summon-fixture']);
  const entry = readCache(h.cacheFile).servers['summon-fixture'];
  assert.equal(entry.toolCount, 5);
  assert.ok(entry.tokens > 0);
});

test('summoned tools execute over real JSON-RPC — text, structured content, images, errors', async (t) => {
  const h = makeHarness();
  t.after(() => h.manager.releaseAll());
  await h.manager.summon('summon-fixture');

  const echo = await h.registered.get('mcp__summon-fixture__echo').execute({ message: 'hi' }, exec());
  assert.deepEqual(echo.content, [{ type: 'text', text: 'echo: hi' }]);

  const add = await h.registered.get('mcp__summon-fixture__add').execute({ a: 3, b: 4 }, exec());
  assert.equal(add.structuredContent.sum, 7);
  assert.equal(add.content[0].text, 'sum: 7');

  const image = await h.registered.get('mcp__summon-fixture__image').execute({}, exec());
  assert.equal(image.content[1].type, 'image', 'image block intact in the canonical value');
  assert.equal(image.content[1].mimeType, 'image/png');
  assert.ok(image.content[1].data.length > 50);

  await assert.rejects(h.registered.get('mcp__summon-fixture__fail').execute({}, exec()), /boom/);
});

test('release unregisters, kills the child, and is idempotent', async (t) => {
  const h = makeHarness();
  t.after(() => h.manager.releaseAll());
  const { pid } = await h.manager.summon('summon-fixture');
  const released = await h.manager.release('summon-fixture');
  assert.equal(released.ok, true);
  assert.equal(h.registered.size, 0, 'tools unregistered');
  assert.equal(h.manager.status()[0].state, 'dormant');
  await until(() => !pidAlive(pid), 'child process survived release');
  const again = await h.manager.release('summon-fixture');
  assert.equal(again.already, true, 'release is idempotent');
});

test('summoning an already-summoned server is a no-op', async (t) => {
  const h = makeHarness();
  t.after(() => h.manager.releaseAll());
  await h.manager.summon('summon-fixture');
  const second = await h.manager.summon('summon-fixture');
  assert.equal(second.already, true);
  assert.equal(second.toolCount, 5);
  assert.equal(h.registered.size, 5, 'no double registration');
});

test('disableTools keeps chosen tools off the surface and out of the measurement', async (t) => {
  const h = makeHarness({ disableTools: ['now', 'fail'] });
  t.after(() => h.manager.releaseAll());
  const result = await h.manager.summon('summon-fixture');
  assert.equal(result.toolCount, 3);
  assert.equal(h.registered.has('mcp__summon-fixture__now'), false);
  assert.equal(h.registered.has('mcp__summon-fixture__fail'), false);
  assert.deepEqual(h.measured[0][1].toolNames, ['echo', 'add', 'image']);
});

test('unexpected child exit falls back to dormant with the reason kept', async (t) => {
  const h = makeHarness();
  t.after(() => h.manager.releaseAll());
  const { pid } = await h.manager.summon('summon-fixture');
  process.kill(pid);
  await until(
    () => h.manager.status()[0].state === 'dormant' && h.registered.size === 0,
    'crash did not fall back to dormant with tools unregistered',
  );
  assert.match(h.manager.status()[0].lastError, /connection closed/);
});

test('a failed spawn lands in failed and release returns it to dormant', async (t) => {
  const h = makeHarness({ args: [join(tmpdir(), 'definitely-missing-mcp-server.mjs')] });
  t.after(() => h.manager.releaseAll());
  const result = await h.manager.summon('summon-fixture');
  assert.equal(result.ok, false);
  assert.ok(result.error.length > 0);
  assert.equal(h.manager.status()[0].state, 'failed');
  assert.equal(h.registered.size, 0);
  await h.manager.release('summon-fixture');
  assert.equal(h.manager.status()[0].state, 'dormant');
});

test('unknown server names are refused without touching state', async () => {
  const h = makeHarness();
  const result = await h.manager.summon('ghost');
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown server "ghost"/);
});
