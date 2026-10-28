// dsh-mcp-summon — host plugin entry.
//
// Dormant-by-default MCP: the plugin registers exactly one model-facing tool,
// `mcp_summon`, whose description carries a card per configured server (name,
// capability summary, tool count, honest per-turn token cost measured at the
// first summon and cached on disk). `summon` spawns the server, fetches its
// tools, and registers each one as a real native tool under
// `mcp__<server>__<tool>` for the rest of the session; `release` runs the
// disposers and kills the child; `status` reports per-server state.
//
// This stub keeps the bundle row loadable while the repo is scaffolded; the
// full lifecycle ships with the 0.1.0 core.

export const name = 'dsh-mcp-summon';
export const inject = ['tools'];

export async function apply(ctx) {
  ctx.logger.info('dsh-mcp-summon: scaffold loaded — mcp_summon arrives with the 0.1.0 core');
}
