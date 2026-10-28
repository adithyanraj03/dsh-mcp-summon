<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/banner-dark.png">
  <img alt="dsh-mcp-summon" src="assets/banner-light.png" width="1012">
</picture>

<br>

# dsh-mcp-summon

[English](README.md) | 中文

![language](https://img.shields.io/badge/language-javascript-f7dc6f) ![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen) ![dsh](https://img.shields.io/badge/dsh-0.2.x-orange) ![tests](https://img.shields.io/badge/tests-passing-brightgreen) ![runtime](https://img.shields.io/badge/runtime-%E5%8A%A0%E8%BD%BD%E6%9C%9F%E9%9B%B6%E8%BF%9B%E7%A8%8B-brightgreen)

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的「默认休眠」MCP 插件：MCP 服务器在被模型**召唤**之前零成本——而召唤后到来的是该服务器的**真正原生工具**，不是代理。

## 问题

官方桥（`@deepseek-ai/dsh-mcp-client`）在启动时连接所有已配置的服务器，并把**每个**工具注册为原生工具，于是所有 JSON schema **永远进入每一次模型请求**——无论模型是否调用过它们。一个「胖」服务器每一轮都在交这笔税：

| 服务器 | 工具数 | schema 字节 | ≈ tokens / 轮 |
| --- | ---: | ---: | ---: |
| xerj（官方发布 schema，2026-10-28 实测） | 22 | 53,297 | **13,325** |
| chrome-devtools-mcp（dsh-mcp-lazy 实测） | 29 | 21,252 | 5,313 |
| 本仓库测试 fixture | 5 | 902 | 226 |

## 你得到什么

加载时插件只注册**一个**工具 `mcp_summon`，其描述为每个已配置服务器携带一张卡片——能力摘要、工具数量，以及按上表同一方法实测的诚实成本行：

```
Configured servers:
- xerj — Code and corpus search: definitions, hybrid search, field maps, hub corpora. (22 tools, ~13,325 tokens/turn when summoned)
- summon-fixture — Five demo tools: echo, add, now, image, fail. (5 tools, ~226 tokens/turn when summoned)
```

模型可以在会话中途自己激活服务器：

```
mcp_summon({ action: "summon", server: "xerj" })
→ summoned xerj: 22 tools registered as mcp__xerj__* (~13,325 tokens/turn
  for the rest of this session, visible from your next turn).

mcp_summon({ action: "status" })
→ Server states:
  - xerj: summoned (22 tools, 53297 schema bytes ≈ 13325 tokens/turn, pid 41312)
  - summon-fixture: dormant

mcp_summon({ action: "release", server: "xerj" })
→ released xerj: its tools unregister from your next turn and its process stopped.
```

召唤之后，这些工具就是**真正的原生工具**——使用与官方桥相同的 `ToolDefinition` 适配器（vendored，已按要求保留 MIT 声明）：真实 schema、原生 UI 渲染、逐工具审批门、图片结果完整进入持久存储。harness 每一轮重新组装工具集，因此它们从下一轮出现，行为与正常桥接的 MCP 工具完全一致。

崩溃或 profile 重启会退回「默认休眠」——安全的方向。会话结束时全部释放。

## 安装

```sh
dsh plugin --profile <your-profile> add dsh-mcp-summon
```

然后在该 profile 的 `cordis.patch.yml` 里列出你的服务器（bundle 自带注释示例）。重启 profile。服务器在召唤前保持休眠——加载期零进程。

## 配置参考

一行配置：`config.servers: [...]`。每行与 `@deepseek-ai/dsh-mcp-client` 同形，v1 仅支持 stdio：

| 字段 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `serverName` | ✓ | — | `[A-Za-z0-9_-]{1,32}`；即 `mcp__<server>__*` 命名空间 |
| `transport` | ✓ | — | `stdio`（v1） |
| `command` | ✓ | — | 要 spawn 的程序 |
| `args` | | `[]` | 密钥写在这里会进入 argv——`ps` 可见 |
| `env` | | `{}` | 密钥唯一安全的位置：spawn 前父环境会做凭据清洗 |
| `cwd` | | `""` | |
| `summary` | | `""` | 卡片的能力段落；缺省回退到缓存的工具名 |
| `disableTools` | | `[]` | 不上面的原始工具名——例如描述里指示 agent 自动外发数据的工具 |
| `toolCallTimeoutMs` | | `60000` | |
| `daemon` | | — | 该 server 转发到的常驻本地服务；见下 |

### `daemon:` —— 转发到本地服务的 server

有些 stdio server 只是一个常驻服务的代理——`xerj mcp` 把每次调用转发到 `http://localhost:9200` 上的 xerj 节点，而它自己不会启动节点。`daemon:` 让 summon 自给自足：在启动代理之前，插件先探测 health URL；若无响应，就以 **detached** 方式启动 daemon（它比插件和会话都活得久），轮询到健康后再连接。`release` 会停掉代理，但**绝不杀 daemon**——它是其他工具和会话共用的基础设施。

```yaml
- serverName: xerj
  transport: stdio
  command: xerj
  args: ['mcp']
  env: { XERJ_URL: 'http://localhost:9200' }
  daemon:
    command: xerj
    args: ['--insecure', '--data-dir', 'C:/Users/adith/xerj-data']
    healthUrl: 'http://localhost:9200/'   # 任何 HTTP 响应都算健康
    startTimeoutMs: 15000
```

如果你自己已经开着节点（终端、计划任务、服务），探测会看到它，不会重复启动——这个块是安全网，不是进程管理器。

## 工作原理

| 机制 | dsh 接缝 |
| --- | --- |
| 加载期一个工具、零进程 | `apply` 中 `ctx.tools.register`；唯一的启动 I/O 是读一次测量缓存 |
| 召唤的工具下一轮出现 | `register` 触发 `tools/change`——「全局变更影响每个 agent 的下一次组装」——工具集每轮重组 |
| 真正的原生行为 | 从 `@deepseek-ai/dsh-mcp-client` 0.2.1-rc.3 vendored 的工具适配器、传输工厂与命名规则（MIT） |
| 诚实的成本行 | `{name, description, parameters}` 的 JSON 字节 ÷ 4——正是 registry `schemas()` 白名单发到线上的字段 |
| 卡片字节稳定 | 按 `serverName` 排序、会话内冻结；新测量值经 `$DSH_HOME/storages/dsh-mcp-summon/cache.json` 进入**下一次**会话的卡片——绝不会仅为制作卡片而 spawn 服务器 |
| 释放 | 执行 `ctx.tools.register` 返回的精确 disposer，然后 `transport.close()` 杀掉子进程 |
| 崩溃 | `onclose` → 注销 → dormant，原因保留在 `status` 里 |

激活会一次性改变工具块，因此那一轮的 prompt-cache 前缀失效一次——这是激活的既定代价，无论召唤还是官方桥启动注册都要付。

## 测量

`node scripts/measure-tokens.mjs` 为**你的**已配置服务器打印每服务器数字（同一方法论：渲染 JSON 字节 ÷ 4——确定性代理，不是 BPE 计数）：

```sh
node scripts/measure-tokens.mjs --fixture
node scripts/measure-tokens.mjs --config ~/.dsh/profiles/web/cordis.patch.yml
node scripts/measure-tokens.mjs --from-json https://xerj.org/docs/agents/schemas/mcp-tools.json --label xerj
```

本仓库实测（2026-10-28）：fixture 5 工具 = 902 B ≈ 226 tokens/轮；xerj 22 工具 = 53,297 B ≈ 13,325 tokens/轮。`mcp_summon` 自身的常驻表面（头部 + 两张卡片）为 1,591 B ≈ **398 tokens/轮**，只随服务器数量增长，与服务器大小无关。

## dsh-mcp-summon 与 dsh-mcp-lazy 的对比

[dsh-mcp-lazy](https://github.com/wings1848/dsh-mcp-lazy) 是 dsh 的另一款惰性 MCP 插件——常驻**网关**：一个 `mcp({search/describe/tool})` 代理工具，schema 按需获取，实测节省约 92.8%。两者都让闲置服务器接近零成本，区别在**激活之后**，其 README 自己也承认：

| 维度 | dsh-mcp-lazy（网关） | dsh-mcp-summon（本插件） |
| --- | --- | --- |
| 每个已配置服务器的闲置成本 | ~0（磁盘缓存元数据） | 0（休眠，从不 spawn） |
| 常驻模型表面 | 1 个代理工具，恒定 ~381 tok | 1 个召唤工具，2 服务器时 ~398 tok |
| 激活之后 | schema 经代理按次获取；调用走 `mcp({tool})` | 真原生工具：真实 schema、原生 UI、逐工具审批门、图片结果完整 |
| 活跃会话成本 | 每次调用少量代理开销 | 本会话剩余时间全额 schema tokens/轮 |
| 闲置回收 | 有（默认 10 分钟） | 无——释放是显式的（v1） |
| 传输（v1） | stdio + streamable-http | 仅 stdio |
| 何时占优 | 服务器多、每个偶尔用 | 一个服务器整会话高强度用 |

如果你配了 10 台服务器只是偶尔碰一台，选网关——严格更便宜。如果你召唤 xerj 并在里面工作两小时，原生工具值这些 tokens：模型看到真实 schema，直接调 `mcp__xerj__xerj_search`，每个结果都按一等公民渲染和审批。

## 已知限制

v1 边界，直说：

- **仅 stdio。** 暂不支持 `streamable-http`。
- **仅工具。** 无 MCP resources、prompts、sampling、elicitation。
- **无 OAuth。** 认证只能靠行内 `env`。
- **无闲置回收。** 召唤后保持到显式释放或会话结束。
- **无退避重连。** 崩溃的服务器退回 dormant，原因在 `status`；重新召唤即重试。
- **卡片会话内冻结。** 首次召唤的测量值出现在下一次会话的卡片里（会话内数字一次 `status` 即得）。
- **写在 `args` 里的密钥进入 argv**，`ps` 可读；`env` 才是安全路径。
- **`mcp_summon` 自身描述是常驻成本**（两服务器时约 400 tokens）——这是让模型能够决定激活任何东西的地板价。

## 开发

```sh
pnpm install
pnpm test        # 27 个测试：命名、卡片+缓存、分派，以及真实 stdio 子进程
                 # （spawn → JSON-RPC → 原生注册 → 释放 → 杀进程）
pnpm run measure # 每服务器字节/tokens
pnpm run banners # 从 SVG 重新渲染 assets/banner-*.png
```

## 环境要求

- dsh `0.2.0-rc.1` 或更新（开发与测试基于 `0.2.1-rc.3`）
- Node.js 22 或更新

## 许可

MIT — 见 [LICENSE](LICENSE)。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 载有 vendored `@deepseek-ai/dsh-mcp-client` 代码的声明。
