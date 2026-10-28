# dsh-mcp-summon

Dormant-by-default MCP for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

The official MCP bridge registers **every** tool of every configured server at
startup, so all their JSON schemas enter every model request forever. This
plugin keeps servers dormant and model-activatable: exactly one tool —
`mcp_summon` — is registered at load, its description carries an honest card
per server (capability summary, tool count, measured ~tokens/turn cost), and
`summon(server)` turns that server's tools into **real native tools**
(`mcp__<server>__<tool>`) for the rest of the session — real schemas, native UI
rendering, per-tool approval gates, image results intact. `release(server)`
unregisters and kills it.

> Scaffold in progress (0.1.0). Full README, Chinese README, measured token
> numbers, banner art and the docs site land with the first release — see the
> milestone plan in the repo history.

## Install (once 0.1.0 is published)

```sh
dsh plugin --profile <your-profile> add dsh-mcp-summon
```

## Licence

MIT — see [LICENSE](LICENSE).
