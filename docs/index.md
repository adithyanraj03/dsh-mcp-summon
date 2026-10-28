---
title: dsh-mcp-summon
---

![dsh-mcp-summon](assets/banner-dark.png)

**Dormant-by-default MCP for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).** The official bridge registers every tool of every configured MCP server at startup, so all their JSON schemas enter every model request forever. This plugin keeps servers dormant and model-activatable through exactly one tool — `mcp_summon` — and what a summon delivers is the server's **real native tools** for the rest of the session: real schemas, native UI rendering, per-tool approval gates, image results intact.

## The numbers (measured, JSON bytes ÷ 4)

| Server | Tools | ≈ tokens / turn |
| --- | ---: | ---: |
| xerj | 22 | **13,325** |
| chrome-devtools-mcp | 29 | 5,313 |
| test fixture | 5 | 226 |
| `mcp_summon` itself (2 servers) | 1 | 398 |

Idle servers cost **0** — no process, no schema, no spawn at load.

## How it works

1. At load the plugin registers `mcp_summon` only. Its description carries a byte-stable card per server: name, capability summary, tool count, and an honest "activating adds ~N tokens/turn" line from a disk-cached measurement — a server is never spawned just to card it.
2. `summon(server)` spawns the stdio child, fetches `tools/list`, and registers each tool via `ctx.tools.register` under `mcp__<server>__<tool>`, keeping every disposer. The harness re-assembles the tool set per turn, so from the **next** turn the model calls them directly.
3. `release(server)` runs the disposers and kills the child. Crash or session end falls back to dormant — the safe direction.

```
mcp_summon({ action: "summon", server: "xerj" })
→ summoned xerj: 22 tools registered as mcp__xerj__* (~13,325 tokens/turn
  for the rest of this session, visible from your next turn).
```

## Install

```sh
dsh plugin --profile <your-profile> add dsh-mcp-summon
```

List servers in the profile's `cordis.patch.yml` (same row shape as `@deepseek-ai/dsh-mcp-client`, stdio-only in v1). Restart. Nothing spawns until summoned.

## vs dsh-mcp-lazy

[dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy) is a permanent gateway: one proxy tool, schemas on demand, ~92.8% savings — strictly cheaper for many rarely-used servers. Summon wins when one server is used hard all session: after activation you get first-class native tools, not calls routed through a proxy.

## Known limitations (v1)

stdio only · tools only (no resources/prompts/sampling) · no OAuth · no idle reclamation (release is explicit) · no reconnect with backoff · cards freeze within a session · secrets in `args` land in argv.

---

[GitHub repository](https://github.com/adithyanraj03/dsh-mcp-summon) · [README](https://github.com/adithyanraj03/dsh-mcp-summon#readme) · [中文 README](https://github.com/adithyanraj03/dsh-mcp-summon/blob/main/README.zh.md) · [MIT licence](https://github.com/adithyanraj03/dsh-mcp-summon/blob/main/LICENSE)
