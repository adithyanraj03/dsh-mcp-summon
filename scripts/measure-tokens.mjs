#!/usr/bin/env node
// measure-tokens.mjs — per-server schema bytes/tokens for YOUR configured servers.
//
// Same methodology as the plugin's cards and as dsh-mcp-lazy's published
// numbers: the fields the harness registry whitelists onto the wire (name,
// description, parameters) rendered as JSON, four bytes per token. This is a
// deterministic proxy, not a BPE count — it ranks servers honestly and matches
// how the cost actually enters each request prefix.
//
// Usage:
//   node scripts/measure-tokens.mjs --fixture
//       Measure the bundled test fixture server (spawns it).
//   node scripts/measure-tokens.mjs --config <cordis.patch.yml>
//       Spawn every dsh-mcp-summon server row in a patch file and measure.
//   node scripts/measure-tokens.mjs --from-json <file|url> [--label name]
//       Measure a published tool-schema JSON ({tools:[{name,description,
//       inputSchema}]} or a bare array) without spawning anything.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import yaml from 'js-yaml';
import { measureTools } from '../src/cards.js';
import { scrubbedChildEnv } from '../src/adapter.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const fmt = (n) => n.toLocaleString('en-US');

function table(rows) {
  const head = ['server', 'tools', 'schema bytes', '≈ tokens/turn'];
  const body = rows.map((r) => [r.label, String(r.toolCount), fmt(r.schemaBytes), fmt(r.tokens)]);
  const widths = head.map((_, i) => Math.max(...[head, ...body].map((row) => row[i].length)));
  const line = (cells) => cells.map((cell, i) => cell.padEnd(widths[i])).join('  ');
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...body.map(line)].join('\n');
}

/** Spawn one stdio server row, list its tools, measure, and shut it down. */
async function measureRow(row) {
  const transport = new StdioClientTransport({
    command: row.command,
    args: row.args ?? [],
    env: scrubbedChildEnv(row.env ?? {}),
    cwd: row.cwd || undefined,
  });
  const client = new Client({ name: 'dsh-mcp-summon-measure', version: '0.1.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(transport);
    const response = await client.listTools(void 0, { cacheMode: 'refresh' });
    const disabled = new Set(row.disableTools ?? []);
    const measured = measureTools(response.tools.filter((tool) => !disabled.has(tool.name)));
    return { label: row.serverName, ...measured };
  } finally {
    try {
      await client.close();
    } catch {
      /* child already gone */
    }
  }
}

/** Extract dsh-mcp-summon server rows from a cordis patch file (both patch shapes). */
function serverRowsFromPatch(text) {
  const doc = yaml.load(text);
  const entries = [];
  for (const item of Array.isArray(doc) ? doc : [doc]) {
    if (!item || typeof item !== 'object') continue;
    const rows = item.insert ?? [item];
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row?.name === 'dsh-mcp-summon' || row?.id === 'dsh-mcp-summon') {
        entries.push(...(row.config?.servers ?? []));
      }
    }
  }
  return entries;
}

async function toolsFromJson(source) {
  const text = /^https?:/i.test(source) ? await (await fetch(source)).text() : readFileSync(source, 'utf8');
  const parsed = JSON.parse(text);
  const tools = Array.isArray(parsed) ? parsed : parsed.tools;
  if (!Array.isArray(tools)) throw new Error('expected {tools:[...]} or a bare array of tool definitions');
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? tool.parameters ?? tool.schema ?? {},
  }));
}

async function main() {
  const results = [];
  const configPath = flag('config');
  const jsonSource = flag('from-json');

  if (flag('fixture') !== undefined || (!configPath && !jsonSource)) {
    const fixture = fileURLToPath(new URL('../test/fixtures/echo-mcp-server.mjs', import.meta.url));
    results.push(await measureRow({ serverName: 'summon-fixture (bundled)', transport: 'stdio', command: process.execPath, args: [fixture] }));
  }
  if (configPath) {
    for (const row of serverRowsFromPatch(readFileSync(configPath, 'utf8'))) {
      try {
        results.push(await measureRow(row));
      } catch (error) {
        results.push({ label: `${row.serverName} (FAILED)`, toolCount: 0, schemaBytes: 0, tokens: 0, note: String(error?.message ?? error) });
      }
    }
  }
  if (jsonSource) {
    const measured = measureTools(await toolsFromJson(jsonSource));
    results.push({ label: flag('label') ?? jsonSource.replace(/^https?:\/\//, ''), ...measured });
  }

  console.log(table(results));
  for (const r of results.filter((r) => r.note)) console.log(`\n${r.label}: ${r.note}`);
  console.log('\nMethodology: JSON bytes of {name, description, parameters} per tool ÷ 4 —');
  console.log('the fields the harness registry sends on every request while registered.');
  console.log('A deterministic proxy, not a BPE count. Summoned cost rides every turn until released.');
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
