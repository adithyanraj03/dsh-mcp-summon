# Changelog

All notable changes to dsh-mcp-summon are documented here.

## [0.1.0] - 2026-10-28

First release.

### Added

- `mcp_summon` — the single model-facing tool (`list` / `summon` / `release` /
  `status`) that keeps configured MCP servers dormant until the model activates
  one, mid-session.
- Real native activation: `summon` spawns the stdio server, fetches
  `tools/list`, and registers every tool via `ctx.tools.register` under
  `mcp__<server>__<tool>` — real schemas, native UI rendering, per-tool
  approval gates, image results intact — for the rest of the session.
  `release` runs the exact disposers and kills the child.
- Server cards with honest cost lines: JSON bytes of
  `{name, description, parameters}` ÷ 4, measured at first summon and cached
  at `$DSH_HOME/storages/dsh-mcp-summon/cache.json`; cards are byte-stable
  (sorted by `serverName`, frozen for the session) and a server is never
  spawned just to card it.
- Per-server `disableTools` to keep chosen raw tool names off the surface.
- Crash fallback: an unexpected child exit unregisters the server's tools and
  returns it to dormant, with the reason kept for `status`.
- `scripts/measure-tokens.mjs` — per-server schema bytes/tokens for your own
  configured servers (`--config`, `--fixture`, `--from-json`).
- Test suite (27 tests, `node --test`) including a dependency-free stdio MCP
  fixture server exercised as a real child process: spawn → JSON-RPC → native
  registration → release → kill, plus crash fallback and idempotence.
- Vendored tool adapter, transport factory and naming rule from
  `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3 (MIT; notice reproduced in
  `THIRD_PARTY_NOTICES.md`).

### Known limitations (v1)

- stdio transport only; tools only (no resources/prompts/sampling); no OAuth.
- No idle reclamation — release is explicit; no reconnect with backoff.
- Cards freeze within a session; fresh measurements land in the next session.
- Secrets passed via `args` land in argv (visible to `ps`); use `env`.

[0.1.0]: https://github.com/adithyanraj03/dsh-mcp-summon/releases/tag/v0.1.0
