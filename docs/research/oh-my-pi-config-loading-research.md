# oh-my-pi Agent 配置加载调研报告

## 读者与用途

读者：`agent-config` 项目的后续实现者。

读完之后应能做的事：为 `agent-config scan/mcp/doctor` 设计更准确的 Agent adapter、路径发现规则、重复/覆盖诊断规则，并理解 oh-my-pi 为什么会把多个 Agent 的配置混在一起加载。

## 调研范围

本次调研基于本地仓库 `/Users/zeroslope/repos/oh-my-pi`，重点查看：

- 配置根目录解析
- capability/provider 加载架构
- MCP Server 发现与归一化
- 对其他 Agent 配置的兼容读取
- 配置优先级、去重、禁用与过滤逻辑
- 对 `agent-config` 后续工作的启发

## 一句话结论

oh-my-pi 不是只读取自己的 `.omp` 配置；它把 Claude、Codex、Gemini、Cursor、Windsurf、VS Code、OpenCode、Cline、GitHub Copilot、通用 AGENTS 标准、Claude 插件、OMP 插件、独立 `mcp.json` 等都注册成 capability provider，然后通过统一的 capability registry 加载、归一化、按优先级去重。这种设计提升了兼容性，但也正是配置来源复杂、重复和覆盖关系不透明的主要原因。

## 1. 总体架构：按 capability 加载，而不是按 Agent 手写流程

oh-my-pi 的核心思路是：调用方不直接关心 `.claude`、`.cursor`、`.gemini` 等路径，而是请求某类能力，例如：

- `mcps`
- `skills`
- `rules`
- `settings`
- `context-files`
- `slash-commands`
- `hooks`
- `tools`
- `extension-modules`

每个 Agent / 标准 / 插件系统作为 provider 注册到这些 capability 上。

关键机制：

1. `discovery/index.ts` 通过 import 自动注册所有 provider。
2. `capability/index.ts` 维护 capability 和 provider registry。
3. `loadCapability(capabilityId, { cwd })` 并行调用所有启用的 provider。
4. provider 返回统一结构，并附带 `_source` 元数据。
5. capability 使用 `key(item)` 去重；多数能力是“高优先级 first wins”。
6. `settings` 是例外：不按 key 去重，而是保留所有配置并后续 merge。

这个架构对我们的启发：

- 我们的 `agent-config` 也应该保留 adapter/provider 思路。
- 但我们应该区分“发现全部来源”和“模拟某个工具最终会生效的结果”。
- 诊断模式需要同时展示 `items` 和被 shadow 的 `all`，否则用户看不到重复配置为什么没生效。

## 2. oh-my-pi 支持的配置来源

### 2.1 通用路径表

`discovery/helpers.ts` 中有一张 `SOURCE_PATHS` 表，包含：

| source | user-level | project-level | 备注 |
|---|---|---|---|
| native | `~/.omp/agent` | `.omp` | OMP 自己的配置 |
| claude | `~/.claude` | `.claude` | Claude Code |
| codex | `~/.codex` | `.codex` | OpenAI Codex |
| gemini | `~/.gemini` | `.gemini` | Gemini CLI |
| opencode | `~/.config/opencode` | `.opencode` | OpenCode |
| cursor | `~/.cursor` | `.cursor` | Cursor |
| windsurf | `~/.codeium/windsurf` | `.windsurf` | Windsurf / Codeium |
| cline | `~/.cline` | 无目录，项目根 `.clinerules` | 只用于 rules |
| github | 无 | `.github` | GitHub Copilot |
| vscode | `~/.vscode` | `.vscode` | MCP 目前只项目级 |

另外，`config.ts` 有一套更窄的 generic config priority list：

1. `.omp`
2. `.claude`
3. `.codex`
4. `.gemini`

这套列表主要用于通用 config dir helper 和 task agent discovery。注意：源码注释里仍有 `.pi` 旧说法，但当前实现不包含 `.pi`。

## 3. MCP Server 加载细节

MCP 是最值得我们借鉴的部分，因为它清楚暴露了多 Agent 配置兼容带来的复杂性。

### 3.1 统一后的 MCP 数据模型

oh-my-pi 将各来源归一化为 `MCPServer`：

- `name`
- `enabled`
- `timeout`
- `command`
- `args`
- `env`
- `cwd`
- `url`
- `headers`
- `auth`
- `oauth`
- `transport`
- `_source`

校验规则：

- 必须有 `name`
- 必须有 `command` 或 `url`
- `stdio` 必须有 `command`
- `http` / `sse` 必须有 `url`

### 3.2 MCP provider 与路径清单

| Provider | 优先级 | 路径 | 格式 |
|---|---:|---|---|
| OMP native | 100 | `.omp/mcp.json`, `.omp/.mcp.json`, `~/.omp/agent/mcp.json`, `~/.omp/agent/.mcp.json` | `{ mcpServers: { ... } }` |
| OMP extension packages | 90 | extension package 内 `.mcp.json` / `mcp.json` | `{ mcpServers: { ... } }` |
| Claude Code | 80 | `~/.claude.json`, `~/.claude/mcp.json`, `.claude/.mcp.json`, `.claude/mcp.json` | `{ mcpServers: { ... } }` |
| Claude marketplace plugins | 70 | installed plugin root 内 `.mcp.json` | 支持 `{ mcpServers }` 或 flat server map |
| Codex | 70 | `~/.codex/config.toml`, `.codex/config.toml` | TOML `[mcp_servers.<name>]` |
| Gemini CLI | 60 | `~/.gemini/settings.json`, `.gemini/settings.json` | `{ mcpServers: { ... } }` |
| OpenCode | 55 | `~/.config/opencode/opencode.json`, project `opencode.json` | `{ mcp: { ... } }`，`type: local/remote` |
| Cursor | 50 | `~/.cursor/mcp.json`, `.cursor/mcp.json` | `{ mcpServers: { ... } }` |
| Windsurf | 50 | `~/.codeium/windsurf/mcp_config.json`, `.windsurf/mcp_config.json` | `{ mcpServers: { ... } }` |
| VS Code | 20 | `.vscode/mcp.json` | `{ mcp: { servers: { ... } } }` |
| standalone MCP | 5 | project `mcp.json`, project `.mcp.json` | `{ mcpServers: { ... } }` |

重要细节：

- Claude provider 对 user 路径是“找到第一个含 `mcpServers` 的文件就停止”，project 路径也一样。
- Claude plugin MCP 会给 server name 加命名空间：`pluginName:serverName`。
- Codex 会把 `tool_timeout_sec` 从秒转换成毫秒 `timeout`。
- Codex 支持 `env_vars`、`http_headers`、`env_http_headers`、`bearer_token_env_var` 这些非通用字段。
- VS Code 使用的是 `mcp.servers`，不是顶层 `mcpServers`。
- OpenCode 使用的是顶层 `mcp`，并将 `type: local` 映射为 `stdio`，`type: remote` 映射为 `http`。
- OMP native 与 standalone provider 都会读取 `mcp.json` / `.mcp.json`，但优先级不同，可能导致同名 server 被高优先级来源 shadow。

### 3.3 MCP 生效前的额外过滤

`mcp/config.ts` 并不是直接使用 `loadCapability("mcps")` 的结果。它还会：

1. 根据 `mcp.enableProjectConfig` 过滤 project-level 配置。
2. 读取 `~/.omp/agent/mcp.json` 里的 `disabledServers`。
3. 过滤 `enabled === false` 的 server。
4. 默认过滤 Exa MCP server，因为 oh-my-pi 有原生 Exa 集成。
5. 可选过滤 browser MCP server，因为 oh-my-pi 有原生 browser tool。
6. 转换为内部 legacy `MCPServerConfig`。

这意味着“被发现”和“最终连接”不是同一件事。

对我们的启发：

- `agent-config mcp` 应该至少有两个视图：
  - discovered：所有发现到的 server，包括重复和被禁用项。
  - effective：模拟某个工具最终会启用的 server。
- `doctor` 应该解释 server 不生效的原因：被 shadow、disabledServers、enabled=false、项目配置关闭、内建集成过滤等。

## 4. 其他 Agent 配置兼容读取

### 4.1 Claude

Claude 是 oh-my-pi 兼容最深入的来源之一。

读取内容：

- MCP：`.claude.json`、`.claude/mcp.json`、`.claude/.mcp.json`
- context：`CLAUDE.md`
- skills：`.claude/skills/*/SKILL.md`
- extension modules：`.claude/extensions`
- slash commands：`.claude/commands/**/*.md`
- hooks：`.claude/hooks/pre`、`.claude/hooks/post`
- custom tools：`.claude/tools`
- settings：`.claude/settings.json`
- system prompt：`.claude/SYSTEM.md`
- marketplace plugins：`~/.claude/plugins/installed_plugins.json` 所指向的插件 root

特别值得注意：Claude Code marketplace plugins 会被当成独立 provider，读取 plugin root 下的 skills、commands、hooks、tools、agents、`.mcp.json`。

### 4.2 Codex

读取内容：

- MCP：`config.toml` 的 `[mcp_servers.*]`
- context：user-level `~/.codex/AGENTS.md`
- skills：`skills/*/SKILL.md`
- extension modules：`extensions`
- slash commands：`commands/*.md`
- prompts：`prompts/*.md`
- hooks：`hooks/*.ts|*.js`
- custom tools：`tools/*.ts|*.js`
- settings：`config.toml`

Codex 是我们必须单独建 adapter 的原因：它的 MCP 格式是 TOML，而且字段和 JSON MCP 生态不完全一致。

### 4.3 Gemini

读取内容：

- MCP：`settings.json` 的 `mcpServers`
- context：`GEMINI.md`
- system prompt：`system.md`
- extensions：`extensions/*/gemini-extension.json`
- extension modules：`extensions`
- settings：`settings.json`

### 4.4 Cursor

读取内容：

- MCP：`mcp.json` 的 `mcpServers`
- rules：`rules/*.mdc` / `rules/*.md`
- settings：`settings.json`

### 4.5 Windsurf

读取内容：

- MCP：`mcp_config.json` 的 `mcpServers`
- user rules：`~/.codeium/windsurf/memories/global_rules.md`
- project rules：`.windsurf/rules/*.md`

### 4.6 VS Code

读取内容：

- MCP：project-only `.vscode/mcp.json`
- 格式：`{ "mcp": { "servers": { ... } } }`

当前 oh-my-pi 的 VS Code MCP provider 不读取全局 VS Code settings。

### 4.7 Cline

Cline provider 只读取 rules：

- 从 `cwd` 向上查找 `.clinerules`
- `.clinerules` 可以是单文件，也可以是目录

它不读取 Cline MCP 配置。

### 4.8 GitHub Copilot

读取内容：

- context：`.github/copilot-instructions.md`
- instructions：`.github/instructions/*.instructions.md`
- skills：`.github/skills/*/SKILL.md`

它不读取 Copilot MCP 配置。

### 4.9 OpenCode

读取内容：

- MCP：user `~/.config/opencode/opencode.json` 和 project `opencode.json` 的 `mcp`
- context：`~/.config/opencode/AGENTS.md`
- settings：`opencode.json`
- skills：`skills`
- commands：`commands`
- plugins：`plugins`

虽然 OpenCode 不在我们最初的列表里，但它是 oh-my-pi 兼容读取的一类重要来源，后续可以作为扩展 adapter。

### 4.10 通用 Agents 标准

oh-my-pi 还有一个 `agents` provider，读取：

- `~/.agent`
- `~/.agents`
- project/ancestor `.agent`
- project/ancestor `.agents`

支持 skills、rules、prompts、commands、`AGENTS.md`、`SYSTEM.md`。

此外还有 standalone `AGENTS.md` provider，会从当前目录向上读取项目内 `AGENTS.md`。

## 5. 优先级与去重规则

### 5.1 Provider 优先级

主要优先级如下：

| Provider | Priority |
|---|---:|
| OMP native | 100 |
| OMP extension packages | 90 |
| Claude Code | 80 |
| Claude marketplace plugins | 70 |
| Agents standard | 70 |
| Codex | 70 |
| Gemini | 60 |
| OpenCode | 55 |
| Cursor | 50 |
| Windsurf | 50 |
| Cline | 40 |
| GitHub Copilot | 30 |
| VS Code | 20 |
| standalone AGENTS.md | 10 |
| standalone MCP JSON | 5 |

### 5.2 去重方式

多数 capability 都是 first-wins：

- MCP：按 server name 去重
- skills：按 skill name 去重
- rules：按 rule name 去重
- slash commands：按 command name 去重
- extensions：按 extension name 去重
- context-files：按 scope/depth 去重

Settings 不去重，而是合并。

对我们的启发：

- `doctor` 应该检测“同名 MCP server 被更高优先级来源覆盖”。
- 输出不能只显示 winner；还要显示 shadowed source。
- 同名但参数不同是高价值告警。

## 6. Project / user / walk-up 行为并不统一

这是配置混乱的重要来源。

不同 provider 的 project 查找方式不一致：

- 多数 MCP provider 只看当前 `cwd` 下的 project config，不向上递归。
- native skills 会从 `cwd` 向上扫描 `.omp/skills`。
- Claude skills 会从 `cwd` 向上扫描 `.claude/skills`。
- task agent discovery 使用 `findAllNearestProjectConfigDirs("agents")`，每种 source 只取最近的 project agents 目录。
- standalone `AGENTS.md` 会向上扫描多个祖先目录。
- Cline 会向上查找最近的 `.clinerules`。
- GitHub / Cursor / Windsurf 的很多 provider 是 cwd-only。

对我们的启发：

- `agent-config` 不应假设所有 project 配置都 walk-up。
- 每个 adapter 要明确：`cwd-only`、`nearest-ancestor`、`all-ancestors`、`home-only`。
- CLI 输出最好标注 discovery strategy。

## 7. 错误处理与容错

oh-my-pi 的模式是：

- provider 内部尽量吞掉文件不存在。
- 解析失败通常产生 warning，不中断整体 discovery。
- capability registry 捕获 provider load 错误，并记录 provider-level warning。
- bad file 不应阻止其他文件加载。

这与我们当前 `agent-config` 的方向一致：解析错误应该进入 result/issue，而不是让 scan 停止。

## 8. 变量与 secret 处理

MCP 加载中有两类处理：

1. discovery-time `${VAR}` / `${VAR:-default}` 展开。
2. pre-connect 阶段对 env/header 的值做进一步解析：
   - 以 `!` 开头则执行 shell 命令取 stdout。
   - 否则如果值是环境变量名且存在，则取环境变量值。
   - 否则使用 literal string。

我们的工具初期应避免执行 `!command`，只做静态识别和风险提示。否则一个只读 inspect 工具可能产生副作用。

建议：

- 标注 `${VAR}` 引用。
- 标注 env value 是 literal 还是 env-var reference 的可能性。
- 对 `!command` 标注为动态 secret command，不执行。

## 9. 对 agent-config 后续工作的直接建议

### 9.1 Adapter 覆盖范围

我们初期可以按优先级实现：

1. `mcp` / standalone：`mcp.json`, `.mcp.json`
2. Claude：`.claude.json`, `.claude/mcp.json`, `.claude/.mcp.json`
3. Cursor：`.cursor/mcp.json`
4. VS Code：`.vscode/mcp.json` 的 `mcp.servers`
5. Codex：`.codex/config.toml` 的 `mcp_servers`
6. Gemini：`.gemini/settings.json` 的 `mcpServers`
7. Windsurf：`.windsurf/mcp_config.json`
8. OMP：`.omp/mcp.json`, `.omp/.mcp.json`, `~/.omp/agent/mcp.json`
9. OpenCode：`opencode.json` 的 `mcp`

### 9.2 数据模型需要保留的信息

`McpServer` 除了 command/url/env 之外，建议补充：

- `sourceAgent`
- `sourcePath`
- `scope`
- `discoveryStrategy`
- `priority`
- `shadowedBy?`
- `enabledRaw?`
- `disabledReason?`
- `transportInference`
- `rawShape`：`mcpServers` / `mcp_servers` / `mcp.servers` / `mcp` / `flat-plugin-map`

### 9.3 Doctor 规则

高价值诊断项：

- 同名 server 多处定义。
- 同名 server command/url/args/env 不一致。
- project/global 同时定义但优先级不透明。
- 远程 server 缺少 `type: http/sse`，可能被误判为 stdio。
- server 同时有 `command` 和 `url`。
- `stdio` 缺少 command。
- `http/sse` 缺少 url。
- env 中出现 `${VAR}` 但当前环境缺失。
- env/header 中出现 `!command`，提示“动态执行，不在 inspect 中运行”。
- Codex 的 `env_vars`、`env_http_headers`、`bearer_token_env_var` 应被转换/标注。
- 被 `disabledServers` 或 `enabled: false` 禁用。
- 被更高优先级来源 shadow。

### 9.4 输出建议

`agent-config mcp --format table` 可以展示：

- name
- transport
- command/url
- agent/source
- scope
- path
- status：active / shadowed / disabled / invalid

`agent-config mcp --format json` 应保留完整 raw + normalized + issues。

## 10. 与我们当前实现的差异

我们当前 `agent-config` 已经实现的方向是正确的：

- Bun + TypeScript
- project/global scan 分离
- macOS-only platform gate
- JSON/JSONC/TOML parsing
- MCP extraction
- `.mcp.json` / `mcp.json`
- parse errors 不阻断整体扫描

需要根据本次调研补强的地方：

1. 加入 OMP / OpenCode adapter。
2. 加入 VS Code `mcp.servers` 之外的路径/字段检查时，保持项目级优先。
3. Codex adapter 需要真正理解 TOML `[mcp_servers.*]`，而不是只做通用字段递归搜索。
4. MCP 提取结果需要表达 shadowed/priority，而不是只列出扁平 server 列表。
5. Doctor 应显式报告“其他 Agent 配置被兼容读取”的事实。
6. 不执行 secret command，只静态标注。

## 11. 风险与注意事项

- oh-my-pi 自己的 docs 和代码注释偶尔有旧信息，例如 `.pi` 的 stale comment；应以当前代码为准。
- capability provider priority 和某个 provider 内部的文件顺序是两层不同优先级。
- `settings` 的 merge 行为不同于 MCP/skills 的 first-wins，需要单独处理。
- “发现到配置”不等于“运行时连接/启用”。MCP 还会被 disabledServers、enabled=false、内建能力过滤、project config 设置过滤。
- project walk-up 规则不统一，不能用一套路径规则覆盖所有 Agent。

## 12. 总结

oh-my-pi 是一个很好的反例和参考：它通过 capability/provider 体系把多种 Agent 生态接入同一个运行时，但也使用户很难判断一个 MCP Server 或 skill 到底来自哪里、为什么生效、为什么被覆盖。

我们的 `agent-config` 应该站在“解释器”和“诊断器”的位置：不急于迁移或修改配置，而是把来源、格式、作用域、优先级、重复、shadow、禁用原因完整暴露出来。
