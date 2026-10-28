# Third-party notices

dsh-mcp-summon is MIT-licensed (see [LICENSE](LICENSE)). It vendors source from,
and depends on, the following.

## Vendored source

### @deepseek-ai/dsh-mcp-client 0.2.1-rc.3

`src/naming.js` and `src/adapter.js` are vendored and trimmed (stdio-only,
tools-only) from `@deepseek-ai/dsh-mcp-client`
(https://github.com/deepseek-ai/deepseek-harness, `packages/mcp/mcp-client`),
Copyright (c) 2026 DeepSeek, MIT License. Function bodies are kept
near-verbatim so summoned tools behave exactly like natively bridged ones and
public tool names are byte-identical for the same `(serverName, rawName)`.

> MIT License
>
> Copyright (c) 2026 DeepSeek
>
> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Runtime dependencies

- `@modelcontextprotocol/client` 2.2.0 — the MCP TypeScript SDK client
  (https://github.com/modelcontextprotocol/typescript-sdk). Licensed under a
  MIT/Apache-2.0 transition dual-license per its LICENSE; used under the MIT
  terms.
- `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-subprocess`,
  `@deepseek-ai/dsh-attachment` (optional) — DeepSeek Harness packages,
  Copyright (c) 2026 DeepSeek, MIT License. Declared as peer dependencies;
  they resolve from the host installation.
- `@deepseek-ai/schemastery` — Copyright (c) 2021-present Shigma, MIT License.
- `@deepseek-ai/cordis` — the plugin framework, MIT License.
