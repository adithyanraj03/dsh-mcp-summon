// dsh-mcp-summon — dormant-by-default MCP for dsh.
//
// The official bridge (@deepseek-ai/dsh-mcp-client) registers every tool of
// every configured server at startup, so all their JSON schemas enter every
// model request forever. This plugin registers exactly ONE model-facing tool,
// `mcp_summon`, whose description carries a card per configured server.
// `summon(server)` spawns the stdio child, fetches `tools/list`, and registers
// each tool natively under `mcp__<server>__<tool>` — the harness re-assembles
// the tool set per turn, so from the NEXT turn the model calls them directly,
// exactly like normal MCP: real schemas, native UI rendering, per-tool
// approval gates, image results intact. `release(server)` runs the disposers
// and kills the child. Session end / plugin dispose releases everything; a
// crash falls back to dormant-by-default.
//
// v1 scope: stdio transport only, tools only (no resources/prompts/sampling),
// no OAuth. See the README's Known limitations.

import z from '@deepseek-ai/schemastery';
import { createSummonManager } from './lifecycle.js';
import {
  cacheEntry,
  defaultCacheFile,
  readCache,
  renderCards,
  sortServers,
  writeCache,
} from './cards.js';

export const name = 'dsh-mcp-summon';
export const inject = ['tools'];

/** Valid `serverName`, kept below the public tool-name budget (official rule). */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Default timeout for individual MCP tool calls (ms). */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000;

/** One server row — the same shape as '@deepseek-ai/dsh-mcp-client', stdio only. */
const ServerRow = z.object({
  serverName: z.string().required().pattern(SERVER_NAME_PATTERN),
  transport: z.const('stdio'),
  command: z.string().required(),
  args: z.array(String).default([]),
  env: z.dict(String).default({}),
  cwd: z.string().default(''),
  /** One-paragraph capability summary for the card; falls back to cached tool names. */
  summary: z.string().default(''),
  /** Raw tool names to keep off the surface (e.g. auto-send field-report tools). */
  disableTools: z.array(String).default([]),
  toolCallTimeoutMs: z.number().default(DEFAULT_TOOL_CALL_TIMEOUT_MS),
});

export const Config = z.object({
  servers: z.array(ServerRow).default([]),
  /** Override the measurement cache location (tests); empty = DSH home storages. */
  cacheFile: z.string().default(''),
});

/** Static half of mcp_summon's description — fixed text, never varies. */
const HEADER = [
  '# Activate dormant MCP servers on demand',
  '',
  'The servers below are configured but NOT connected; their tools are NOT in your tool list yet. Actions:',
  '- { action: "list" } — show these server cards again.',
  '- { action: "summon", server: "<name>" } — start the server and register its tools as native mcp__<name>__<tool> tools. They appear from your NEXT turn and stay for the rest of this session; their full schemas then cost ~N tokens every turn (N is on the card). Summon only what you will actually use, and release it when done.',
  '- { action: "release", server: "<name>" } — unregister its tools and stop its process.',
  '- { action: "status" } — per-server state: dormant / starting / summoned / failed, tool count, schema bytes, pid.',
  'Pass server: "*" with summon or release to act on every configured server.',
].join('\n');

function describe(rows, cache) {
  return `${HEADER}\n\n${renderCards(rows, cache)}`;
}

function statusText(manager) {
  const lines = manager.status().map((s) => {
    const detail = s.state === 'summoned' || s.toolCount > 0
      ? ` (${s.toolCount} tools, ${s.schemaBytes} schema bytes ≈ ${s.tokens} tokens/turn${s.pid ? `, pid ${s.pid}` : ''})`
      : '';
    const error = s.lastError ? ` — last error: ${s.lastError}` : '';
    return `- ${s.serverName}: ${s.state}${detail}${error}`;
  });
  return lines.length > 0 ? `Server states:\n${lines.join('\n')}` : 'No servers configured.';
}

function summonResultText(result) {
  if (result.ok === false) return `summoning ${result.server} failed: ${result.error}`;
  if (result.already) return `${result.server} is already summoned (${result.toolCount} tools).`;
  return `summoned ${result.server}: ${result.toolCount} tools registered as mcp__${result.server}__* (~${result.tokens} tokens/turn for the rest of this session, visible from your next turn).`;
}

function releaseResultText(result) {
  if (result.ok === false) return `releasing ${result.server} failed: ${result.error}`;
  if (result.already) return `${result.server} is already dormant.`;
  return `released ${result.server}: its tools unregister from your next turn and its process stopped.`;
}

/** The one model-facing tool. `rows` must already be sorted (byte-stable cards). */
export function createSummonTool({ rows, cache, manager }) {
  return {
    name: 'mcp_summon',
    description: describe(rows, cache),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'summon', 'release', 'status'],
          description: 'list = show server cards; summon = activate a server as native tools; release = deactivate one; status = per-server state.',
        },
        server: {
          type: 'string',
          description: 'serverName from the cards; required for summon/release, ignored by list/status; "*" acts on all configured servers.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    // Summon/release mutate shared per-server state.
    isConcurrencySafe: () => false,
    async execute(args) {
      const { action, server } = args ?? {};
      switch (action) {
        case 'list':
          return { text: describe(rows, cache) };
        case 'status':
          return { text: statusText(manager) };
        case 'summon': {
          if (!server) return { text: 'summon needs a server name, or "*" for all. Cards: list.' };
          if (server === '*') {
            const results = await manager.summonAll();
            return { text: results.map(summonResultText).join('\n') || 'No servers configured.' };
          }
          if (!manager.has(server)) return { text: `unknown server "${server}" — configured: ${manager.names.join(', ') || '(none)'}` };
          return { text: summonResultText(await manager.summon(server)) };
        }
        case 'release': {
          if (!server) return { text: 'release needs a server name, or "*" for all.' };
          if (server === '*') {
            const results = await manager.releaseAll();
            return { text: results.map(releaseResultText).join('\n') || 'No servers configured.' };
          }
          if (!manager.has(server)) return { text: `unknown server "${server}" — configured: ${manager.names.join(', ') || '(none)'}` };
          return { text: releaseResultText(await manager.release(server)) };
        }
        default:
          return { text: `unknown action "${action}" — use list, summon, release or status.` };
      }
    },
  };
}

/**
 * Register mcp_summon and own the summon manager. Zero processes at load: the
 * only startup I/O is one synchronous read of the measurement cache.
 *
 * @param ctx - plugin context carrying the tool registry and logger.
 * @param config - resolved config: dormant server rows.
 */
export async function apply(ctx, config = {}) {
  const rows = sortServers(config.servers ?? []);
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.serverName)) {
      throw new Error(`dsh-mcp-summon: duplicate serverName "${row.serverName}" in config.servers — pick unique names`);
    }
    seen.add(row.serverName);
  }

  const cacheFile = config.cacheFile || defaultCacheFile();
  const cache = readCache(cacheFile);

  const manager = createSummonManager({
    ctx,
    rows,
    onMeasured: (row, measured) => {
      cache.servers[row.serverName] = cacheEntry(row, measured);
      try {
        writeCache(cacheFile, cache);
      } catch (error) {
        ctx.logger.warn(`dsh-mcp-summon: measurement cache write failed (${error?.message ?? error}) — cards will re-measure next session`);
      }
    },
  });

  const tool = createSummonTool({ rows, cache, manager });
  ctx.effect(() => {
    const dispose = ctx.tools.register(tool);
    return async () => {
      dispose();
      await manager.releaseAll(); // session end / plugin dispose: release everything
    };
  }, 'dsh-mcp-summon: mcp_summon');

  ctx.logger.info(`dsh-mcp-summon: ${rows.length} server(s) configured, dormant by default`);
}
