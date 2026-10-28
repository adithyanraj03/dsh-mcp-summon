// Server cards and the on-disk measurement cache.
//
// A card is the one-paragraph pitch for one configured server that rides in
// `mcp_summon`'s description: name, capability summary, tool count, and an
// HONEST cost line — "activating adds ~N tokens/turn for the rest of this
// session". N is measured at the first summon (rendered JSON bytes of the
// registered tool definitions ÷ 4, the same methodology as the official
// bridge's request prefix) and cached to disk like a metadata cache, so a
// server is never spawned just to card it. Cards are byte-stable across turns:
// servers sort by name, and the description is frozen for the session —
// fresh numbers land in the next session's cards from the cache.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const CACHE_VERSION = 1;

/** Cache location: next to the other plugin storages under DSH home. */
export function defaultCacheFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'dsh-mcp-summon', 'cache.json');
}

/** Stable order for byte-stable cards: sort by serverName. */
export function sortServers(rows) {
  return [...rows].sort((a, b) => (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0));
}

/**
 * Fingerprint of everything that changes a server's measured cost: identity,
 * spawn shape, and the disabled-tool filter. Env values hash in (one-way), so
 * a rotated credential re-measures instead of reporting a stale cost.
 */
export function configHash(row) {
  const env = row.env ?? {};
  const daemon = row.daemon;
  const daemonEnv = daemon?.env ?? {};
  const identity = {
    serverName: row.serverName,
    transport: row.transport,
    command: row.command,
    args: row.args ?? [],
    env: Object.fromEntries(Object.keys(env).sort().map((key) => [key, env[key]])),
    cwd: row.cwd ?? '',
    disableTools: [...(row.disableTools ?? [])].sort(),
    // A daemon change can change what the proxy serves, so it re-measures.
    daemon: daemon
      ? {
          command: daemon.command,
          args: daemon.args ?? [],
          env: Object.fromEntries(Object.keys(daemonEnv).sort().map((key) => [key, daemonEnv[key]])),
          cwd: daemon.cwd ?? '',
          healthUrl: daemon.healthUrl,
        }
      : null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

/** Read the cache; a missing or corrupt file is simply an empty cache. */
export function readCache(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION && parsed.servers && typeof parsed.servers === 'object') {
      return parsed;
    }
  } catch {
    /* missing or corrupt: start fresh */
  }
  return { version: CACHE_VERSION, servers: {} };
}

/** Atomic replace: temp file in the same directory, then rename. */
export function writeCache(file, cache) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, file);
}

/**
 * Measure the request-prefix cost of a tool generation: exactly the fields
 * the registry's schemas() whitelists onto the wire — name, description,
 * parameters — rendered as JSON, four bytes per token.
 */
export function measureTools(tools) {
  let schemaBytes = 0;
  const toolNames = [];
  for (const tool of tools) {
    schemaBytes += Buffer.byteLength(JSON.stringify({
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema,
    }));
    toolNames.push(tool.name);
  }
  return { toolCount: tools.length, schemaBytes, tokens: Math.ceil(schemaBytes / 4), toolNames };
}

/** The cache row written after a successful summon. */
export function cacheEntry(row, measured) {
  return { configHash: configHash(row), ...measured, cachedAt: Date.now() };
}

/** A cache entry counts only while the config it was measured under holds. */
export function validEntry(row, entry) {
  return entry
    && entry.configHash === configHash(row)
    && Number.isFinite(entry.toolCount)
    && Number.isFinite(entry.schemaBytes)
    && Number.isFinite(entry.tokens)
      ? entry
      : undefined;
}

/** One card line: `- name — summary (N tools, ~T tokens/turn when summoned)`. */
export function cardLine(row, entry) {
  const summary = row.summary?.trim()
    || (entry?.toolNames?.length
      ? entry.toolNames.slice(0, 8).join(', ') + (entry.toolNames.length > 8 ? ', …' : '')
      : 'no summary configured');
  const cost = entry
    ? ` (${entry.toolCount} tools, ~${entry.tokens} tokens/turn when summoned)`
    : ' (cost unmeasured until first summon)';
  return `- ${row.serverName} — ${summary}${cost}`;
}

/** The cards block appended to mcp_summon's description. */
export function renderCards(rows, cache) {
  if (rows.length === 0) {
    return 'Configured servers: (none — ask the user to add rows under config.servers in cordis.patch.yml)';
  }
  const lines = sortServers(rows).map((row) => cardLine(row, validEntry(row, cache.servers?.[row.serverName])));
  return `Configured servers:\n${lines.join('\n')}`;
}
