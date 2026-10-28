// Summon lifecycle: the per-server state machine.
//
// dormant → starting → summoned → (release) → dormant; a failed spawn or
// connect lands in failed and a re-summon retries. An unexpected child exit
// unregisters the server's tools and falls back to dormant — the safe
// direction (dormant-by-default), with the reason kept for `status`.
//
// Operations on one server are serialized through a promise chain, so a
// release queued during a starting summon waits for it instead of racing the
// register/dispose swap.

import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { publicToolName } from './naming.js';
import { createMcpToolDefinition, scrubbedChildEnv } from './adapter.js';
import { measureTools } from './cards.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** Teardown waits at most this long for the transport to confirm closure. */
export const CLOSE_TIMEOUT_MS = 5000;
/** Per-probe budget for a daemon health GET. */
export const HEALTH_PROBE_TIMEOUT_MS = 2000;
/** Poll interval while waiting for a daemon to come up. */
export const HEALTH_POLL_INTERVAL_MS = 400;

/** GET the health URL; ANY HTTP response (even 404) means something listens. */
async function probeHealth(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  // Deliberately NOT unref'd: during daemon polling this timer is what keeps
  // the event loop alive while the detached child runs elsewhere.
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Race a close against a timer; a wedged transport must not block teardown. */
async function closeQuietly(client) {
  let timer;
  try {
    await Promise.race([
      client.close(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        timer.unref();
      }),
    ]);
  } catch {
    /* already closed or never attached */
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param opts.ctx - Cordis plugin context (tools registry, logger).
 * @param opts.rows - resolved server rows.
 * @param opts.onMeasured - called after a successful summon with (row, measured)
 *   so the caller can persist the card measurement.
 */
export function createSummonManager({ ctx, rows, onMeasured }) {
  const servers = new Map();
  for (const row of rows) {
    servers.set(row.serverName, {
      row,
      state: 'dormant',
      client: undefined,
      disposers: new Map(),
      pid: undefined,
      daemonPid: undefined,
      toolCount: 0,
      schemaBytes: 0,
      tokens: 0,
      lastError: undefined,
      op: Promise.resolve(),
    });
  }

  const label = (serverName) => `dsh-mcp-summon(${serverName})`;

  /**
   * Make the row's daemon healthy before its proxy is spawned: probe first
   * (an operator-started service is reused, never double-spawned), else spawn
   * detached + unref'd so it outlives the plugin, then poll the health URL.
   * Release never kills it — shared infrastructure, by design.
   */
  async function ensureDaemon(server) {
    const spec = server.row.daemon;
    if (spec === undefined) return;
    if (await probeHealth(spec.healthUrl)) {
      server.daemonPid = undefined; // already running, started elsewhere
      return;
    }
    let spawnError;
    const child = spawn(spec.command, spec.args ?? [], {
      detached: true,
      stdio: 'ignore',
      cwd: spec.cwd || undefined,
      env: scrubbedChildEnv(spec.env ?? {}),
    });
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    const deadline = Date.now() + (spec.startTimeoutMs ?? 15000);
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`daemon spawn failed (${spec.command}): ${spawnError.message}`);
      if (await probeHealth(spec.healthUrl)) {
        server.daemonPid = child.pid;
        ctx.logger.info(`${label(server.row.serverName)}: daemon started (pid ${child.pid}, health ${spec.healthUrl})`);
        return;
      }
      await sleep(HEALTH_POLL_INTERVAL_MS);
    }
    throw new Error(`daemon did not become healthy at ${spec.healthUrl} within ${spec.startTimeoutMs ?? 15000}ms${spawnError ? ` (${spawnError.message})` : ''}`);
  }

  /** Serialize one operation per server; the chain never rejects. */
  function enqueue(server, run) {
    const done = server.op.then(run);
    server.op = done.catch(() => {});
    return done;
  }

  /** Unregister every tool, close the transport, return the server to dormant. */
  async function teardown(server, reason) {
    const client = server.client;
    server.client = undefined;
    server.pid = undefined;
    for (const dispose of server.disposers.values()) dispose();
    server.disposers = new Map();
    if (client !== undefined) await closeQuietly(client);
    server.state = 'dormant';
    server.lastError = reason;
  }

  async function doSummon(server) {
    if (server.state === 'summoned') {
      return { ok: true, already: true, server: server.row.serverName, toolCount: server.toolCount, tokens: server.tokens };
    }
    server.state = 'starting';
    server.lastError = undefined;
    let client;
    try {
      await ensureDaemon(server);
      const transport = new StdioClientTransport({
        command: server.row.command,
        args: server.row.args,
        env: scrubbedChildEnv(server.row.env),
        cwd: server.row.cwd || undefined,
      });
      client = new Client(
        { name: 'dsh-mcp-summon', version: pkg.version },
        { capabilities: {}, versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(transport);
      const active = client;
      active.onclose = () => {
        if (server.client !== active) return; // intentional teardown already cleared it
        ctx.logger.warn(`${label(server.row.serverName)}: connection closed unexpectedly — tools unregistered, server dormant again`);
        void enqueue(server, () => teardown(server, 'connection closed — the server process exited'));
      };
      const response = client.getServerCapabilities()?.tools === undefined
        ? { tools: [] }
        : await client.listTools(void 0, { cacheMode: 'refresh' });
      const disabled = new Set(server.row.disableTools);
      const visible = response.tools.filter((tool) => !disabled.has(tool.name));
      const disposers = new Map();
      try {
        for (const tool of visible) {
          const publicName = publicToolName(server.row.serverName, tool.name);
          if (disposers.has(publicName)) {
            throw new Error(`server listed tool "${tool.name}" more than once — invalid tool list`);
          }
          const definition = createMcpToolDefinition(ctx, {
            name: publicName,
            rawName: tool.name,
            description: tool.description ?? '',
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            taskRequired: tool.execution?.taskSupport === 'required',
            call: (args, execution) => client.callTool(
              { name: tool.name, arguments: args },
              { signal: execution.signal, timeout: server.row.toolCallTimeoutMs, toolDefinition: tool },
            ),
          });
          disposers.set(publicName, ctx.tools.register(definition));
        }
      } catch (error) {
        for (const dispose of disposers.values()) dispose(); // roll back the partial generation
        throw error;
      }
      server.client = client;
      server.disposers = disposers;
      server.pid = transport.pid;
      const measured = measureTools(visible);
      server.toolCount = measured.toolCount;
      server.schemaBytes = measured.schemaBytes;
      server.tokens = measured.tokens;
      server.state = 'summoned';
      try {
        onMeasured?.(server.row, measured);
      } catch (error) {
        ctx.logger.warn(`${label(server.row.serverName)}: measurement cache update failed: ${error?.message ?? error}`);
      }
      return {
        ok: true,
        server: server.row.serverName,
        toolCount: measured.toolCount,
        schemaBytes: measured.schemaBytes,
        tokens: measured.tokens,
        pid: server.pid,
      };
    } catch (error) {
      if (client !== undefined) await closeQuietly(client);
      server.state = 'failed';
      server.lastError = String(error?.message ?? error);
      return { ok: false, server: server.row.serverName, error: server.lastError };
    }
  }

  async function doRelease(server) {
    if (server.state === 'dormant') return { ok: true, already: true, server: server.row.serverName };
    await teardown(server, server.state === 'failed' ? server.lastError : undefined);
    return { ok: true, server: server.row.serverName };
  }

  return {
    names: [...servers.keys()],
    has: (serverName) => servers.has(serverName),
    summon(serverName) {
      const server = servers.get(serverName);
      if (!server) return Promise.resolve({ ok: false, server: serverName, error: `unknown server "${serverName}"` });
      return enqueue(server, () => doSummon(server));
    },
    release(serverName) {
      const server = servers.get(serverName);
      if (!server) return Promise.resolve({ ok: false, server: serverName, error: `unknown server "${serverName}"` });
      return enqueue(server, () => doRelease(server));
    },
    async summonAll() {
      const results = [];
      for (const server of servers.values()) results.push(await enqueue(server, () => doSummon(server)));
      return results;
    },
    async releaseAll() {
      const results = [];
      for (const server of servers.values()) results.push(await enqueue(server, () => doRelease(server)));
      return results;
    },
    status() {
      return [...servers.values()].map((server) => ({
        serverName: server.row.serverName,
        state: server.state,
        toolCount: server.toolCount,
        schemaBytes: server.schemaBytes,
        tokens: server.tokens,
        pid: server.pid,
        daemonPid: server.daemonPid,
        lastError: server.lastError,
      }));
    },
  };
}
