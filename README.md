<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="dsh-mcp-summon" src="assets/banner-light.png" width="1012">
</picture>

<br>

# dsh-mcp-summon

English | [中文](README.zh.md)

![language](https://img.shields.io/badge/language-javascript-f7dc6f) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen) ![dsh](https://img.shields.io/badge/dsh-0.2.x-orange) ![tests](https://img.shields.io/badge/tests-passing-brightgreen) ![runtime](https://img.shields.io/badge/runtime-zero%20processes%20at%20load-brightgreen)

Dormant-by-default MCP for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): MCP servers cost nothing until the model **summons** one — and what arrives is not a proxy, it is the server's **real native tools**.

## The problem

The official bridge (`@deepseek-ai/dsh-mcp-client`) connects every configured server at startup and registers **every** tool as a native tool, so every JSON schema enters **every model request forever** — whether the model ever calls them or not. A fat server pays that toll on every single turn:

| Server | Tools | Schema bytes | ≈ tokens / turn |
| --- | ---: | ---: | ---: |
| xerj (published schema, measured 2026-10-28) | 22 | 53,297 | **13,325** |
| chrome-devtools-mcp (measured by dsh-mcp-lazy) | 29 | 21,252 | 5,313 |
| this repo's test fixture | 5 | 902 | 226 |

## What you get

At load the plugin registers exactly **one** tool, `mcp_summon`, whose description carries a card per configured server — capability summary, tool count, and an honest cost line measured the same way as the table above:

```
Configured servers:
- xerj — Code and corpus search: definitions, hybrid search, field maps, hub corpora. (22 tools, ~13,325 tokens/turn when summoned)
- summon-fixture — Five demo tools: echo, add, now, image, fail. (5 tools, ~226 tokens/turn when summoned)
```

The model activates servers itself, mid-session:

```
mcp_summon({ action: "summon", server: "xerj" })
→ summoned xerj: 22 tools registered as mcp__xerj__* (~13,325 tokens/turn
  for the rest of this session, visible from your next turn).

mcp_summon({ action: "status" })
→ Server states:
  - xerj: summoned (22 tools, 53297 schema bytes ≈ 13325 tokens/turn, pid 41312)
  - summon-fixture: dormant

mcp_summon({ action: "release", server: "xerj" })
→ released xerj: its tools unregister from your next turn and its process
  stopped (a daemon it started keeps running — it is shared infrastructure).
```

After a summon the tools are **real native tools** — the same `ToolDefinition` adapter the official bridge uses (vendored, MIT notice reproduced): real schemas, native UI rendering, per-tool approval gates, image results admitted to durable storage intact. The harness re-assembles the tool set every turn, so they appear from the next turn and behave exactly like normally bridged MCP tools.

A crash or profile restart falls back to dormant-by-default — the safe direction. Session end releases everything.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-mcp-summon
```

Then list your servers in that profile's `cordis.patch.yml` (the bundle ships a commented example). Restart the profile. Servers stay dormant until summoned — nothing spawns at load.

## Config reference

One row, `config.servers: [...]`. Each row is the same shape as `@deepseek-ai/dsh-mcp-client`'s, stdio-only in v1:

| Field | Required | Default | Notes |
| --- | --- | --- | --- |
| `serverName` | ✓ | — | `[A-Za-z0-9_-]{1,32}`; the `mcp__<server>__*` namespace |
| `transport` | ✓ | — | `stdio` (v1) |
| `command` | ✓ | — | program to spawn |
| `args` | | `[]` | secrets here land in argv — visible to `ps` |
| `env` | | `{}` | the only place for secrets: the parent env is credential-scrubbed before spawn |
| `cwd` | | `""` | |
| `summary` | | `""` | the card's capability paragraph; falls back to cached tool names |
| `disableTools` | | `[]` | raw tool names to keep off the surface — e.g. servers whose tool descriptions instruct the agent to auto-send data |
| `toolCallTimeoutMs` | | `60000` | |
| `daemon` | | — | a long-lived local service this server proxies to; see below |

### `daemon:` — servers that proxy to a local service

Some stdio servers are just a proxy to a long-lived service you run separately — `xerj mcp` forwards every call to a xerj node on `http://localhost:9200`, and refuses to start one itself. A `daemon:` block makes summoning self-sufficient: before spawning the proxy, the plugin probes the health URL; if nothing answers it spawns the daemon **detached** (it outlives the plugin and the session), polls until healthy, then connects. `release` stops the proxy but **never kills the daemon** — it is shared infrastructure other tools and sessions may use.

```yaml
- serverName: xerj
  transport: stdio
  command: xerj
  args: ['mcp']
  env: { XERJ_URL: 'http://localhost:9200' }
  daemon:
    command: xerj
    args: ['--insecure', '--data-dir', 'C:/Users/adith/xerj-data']
    healthUrl: 'http://localhost:9200/'   # ANY HTTP response counts as up
    startTimeoutMs: 15000
```

If you already keep the node running yourself (terminal, Task Scheduler, service), the probe sees it and nothing is double-spawned — the block is a safety net, not a supervisor.

## How it works

| Mechanism | dsh seam |
| --- | --- |
| One tool at load, zero processes | `ctx.tools.register` in `apply`; the only startup I/O is one read of the measurement cache |
| Daemon-backed servers | probe `healthUrl` → spawn detached + unref'd → poll until healthy → connect the proxy; `release` leaves the daemon running |
| Summoned tools appear next turn | `register` fires `tools/change` — "a global change concerns every agent's next assembly" — and the tool set is re-assembled per turn |
| Real native behaviour | the official bridge's tool adapter, transport factory and naming rule vendored from `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3 (MIT) |
| Honest cost lines | JSON bytes of `{name, description, parameters}` ÷ 4 — exactly the fields the registry's `schemas()` whitelists onto the wire |
| Byte-stable cards | sorted by `serverName`, frozen for the session; a fresh measurement lands in the **next** session's cards from `$DSH_HOME/storages/dsh-mcp-summon/cache.json` — a server is never spawned just to card it |
| Release | the exact disposers `ctx.tools.register` returned, then `transport.close()` kills the child |
| Crash | `onclose` → unregister → dormant, reason kept for `status` |

Activating a server changes the tool block once, so that turn's prompt-cache prefix is invalidated once — that is the documented price of activation, and it is paid whether you summon or the official bridge registers at startup.

## Measurements

`node scripts/measure-tokens.mjs` prints per-server numbers for **your** configured servers (same methodology: rendered JSON bytes ÷ 4 — a deterministic proxy, not a BPE count):

```sh
node scripts/measure-tokens.mjs --fixture
node scripts/measure-tokens.mjs --config ~/.dsh/profiles/web/cordis.patch.yml
node scripts/measure-tokens.mjs --from-json https://xerj.org/docs/agents/schemas/mcp-tools.json --label xerj
```

Measured on this repo (2026-10-28): fixture 5 tools = 902 B ≈ 226 tokens/turn; xerj 22 tools = 53,297 B ≈ 13,325 tokens/turn. Trimming xerj to its 11 search/hub tools with `disableTools` measures 32,347 B ≈ **8,087 tokens/turn** — a 39% cut on the active cost, measured live against the real server. The permanent surface of `mcp_summon` itself — header plus two cards — is 1,591 B ≈ **398 tokens/turn**, and it grows only with the number of configured servers, never with their size.

## dsh-mcp-summon vs dsh-mcp-lazy

[dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy) is the other lazy-MCP plugin for dsh — a permanent **gateway**: one `mcp({search/describe/tool})` proxy tool, schemas fetched on demand, ~92.8% savings measured. Both keep idle servers at ~0. The difference is what happens **after activation**, and their README concedes it:

| Dimension | dsh-mcp-lazy (gateway) | dsh-mcp-summon (this) |
| --- | --- | --- |
| Idle cost per configured server | ~0 (disk-cached metadata) | 0 (dormant, never spawned) |
| Permanent model surface | 1 proxy tool, ~381 tok always | 1 summon tool, ~398 tok with 2 servers |
| After activation | schemas fetched per call through the proxy; calls go through `mcp({tool})` | real native tools: real schemas, native UI, per-tool approval gates, image results intact |
| Active-session cost | small proxy overhead per call | full schema tokens/turn for the rest of the session |
| Idle reclamation | yes (default 10 min) | no — release is explicit (v1) |
| Transports (v1) | stdio + streamable-http | stdio only |
| Wins when | many servers, each rarely used | one server used hard for a whole session |

If you keep 10 servers configured and touch one occasionally, take the gateway — it is strictly cheaper. If you summon xerj and live in it for two hours, native tools are worth their tokens: the model sees the real schema, calls `mcp__xerj__xerj_search` directly, and every result renders and gates like a first-class citizen.

## Known limitations

The v1 boundary, stated plainly:

- **stdio only.** No `streamable-http` rows yet.
- **Tools only.** No MCP resources, prompts, sampling or elicitation.
- **No OAuth.** Auth is whatever the row's `env` can carry.
- **No idle reclamation.** A summoned server stays until you release it or the session ends.
- **No reconnect with backoff.** A crashed server goes dormant with the reason in `status`; re-summon to retry.
- **Cards are frozen within a session.** A first summon's measurement shows up in the next session's cards (mid-session numbers are one `status` call away).
- **A secret passed through `args` lands in argv**, readable by `ps`; `env` is the safe path.
- **`mcp_summon`'s own description is a permanent cost** (~400 tokens with two servers) — the floor this plugin pays so the model can decide to activate anything at all.

## Development

```sh
pnpm install
pnpm test        # 31 tests: naming, cards+cache, dispatch, daemon hash, and a
                 # real stdio child (spawn → JSON-RPC → native registration →
                 # release → kill) plus daemon spawn/reuse/health-timeout paths
pnpm run measure # per-server bytes/tokens
pnpm run banners # re-render assets/banner-*.png from the SVGs
```

## Requirements

- dsh `0.2.0-rc.1` or newer (developed and tested on `0.2.1-rc.3`)
- Node.js 22 or newer

## Licence

MIT — see [LICENSE](LICENSE). [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) carries the notice for the vendored `@deepseek-ai/dsh-mcp-client` code.
