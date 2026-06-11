# Codex 配置与 Memory 加载调研报告

## 读者与用途

读者：`agent-config` 项目的后续实现者。

读完之后应能做的事：为 `agent-config scan/mcp/doctor` 增补更准确的 Codex adapter，理解 Codex 的配置层级、MCP 解析规则、Claude 配置迁移逻辑，以及 memory 配置与文件状态如何影响最终行为。

## 调研范围

本次调研基于本地仓库 `/Users/zeroslope/repos/codex`，重点查看：

- Codex home 和配置文件位置
- 多层配置加载与合并顺序
- project `.codex/config.toml` 的发现、信任与禁用规则
- MCP Server 配置结构、校验和迁移逻辑
- 与其他 Agent 配置的关系，尤其是 Claude 配置迁移
- memory 配置、memory 文件布局、生成与读取路径
- 对 `agent-config` 后续工作的建议

## 一句话结论

Codex 的主配置不是多 Agent 混读式架构，而是以 `CODEX_HOME/config.toml`、profile 覆盖层、项目 `.codex/config.toml`、系统/企业/MDM 管理层和运行时覆盖层组成的 TOML layer stack。Codex 不会在常规运行中直接把 Claude / Cursor / Windsurf 等配置当作自身配置加载；但它有一套明确的 Claude 外部配置迁移流程，会检测 `~/.claude` 和项目 `.claude`，并把 settings、MCP、hooks、skills、commands、subagents、CLAUDE.md、sessions 等迁移到 Codex 的配置与目录。Memory 是 Codex 自己的独立子系统，配置在 `[memories]`，状态在 SQLite，文件工作区在 `CODEX_HOME/memories`。

## 1. Codex home 与全局配置入口

Codex 的用户级配置根目录由 `CODEX_HOME` 决定：

- 如果设置了 `CODEX_HOME`，它必须存在且必须是目录；Codex 会 canonicalize 这个路径。
- 如果没有设置，默认是 `~/.codex`。
- 用户级主配置文件是 `$CODEX_HOME/config.toml`。
- profile-v2 配置文件是 `$CODEX_HOME/<profile>.config.toml`，通过 `--profile <name>` 选择。
- 用户级 AGENTS 指令文件在 `$CODEX_HOME/AGENTS.override.md` 或 `$CODEX_HOME/AGENTS.md`。
- 用户级 memory 工作区在 `$CODEX_HOME/memories`。
- 用户级 MCP OAuth 文件兜底存储在 `$CODEX_HOME/.credentials.json`。
- 用户级历史记录配置控制 `$CODEX_HOME/history.jsonl`。
- 默认日志目录是 `$CODEX_HOME/log`。

对 `agent-config` 的启发：

- Codex global scan 不应只硬编码 `~/.codex/config.toml`，还要在可能时识别 `CODEX_HOME`。
- 如果 `CODEX_HOME` 指向不存在路径，Codex 本身会报错；`agent-config doctor` 可以把它作为明确诊断项。
- `~/.codex/*.config.toml` 不是自动全部生效，只有被 `--profile` 或 loader override 选中的 profile 才会叠加。

## 2. 配置 layer stack：不是单文件配置

Codex 通过 `load_config_layers_state(...)` 读取配置层，并生成：

- effective merged TOML config
- 每个 key 的来源 origins
- 每层的 version fingerprint
- disabled layer 信息
- requirements 约束

配置覆盖关系是“高优先级覆盖低优先级”。从低到高可以理解为：

| 层 | 典型来源 | 说明 |
|---|---|---|
| System | `/etc/codex/config.toml` 或 Windows 系统路径 | 机器级基础配置 |
| EnterpriseManaged | 云端企业配置 bundle | 企业托管配置 |
| User | `$CODEX_HOME/config.toml` | 用户主配置 |
| User profile | `$CODEX_HOME/<name>.config.toml` | 通过 `--profile` 选择，覆盖主配置 |
| Project | `<repo>/.codex/config.toml` 及 cwd 到项目根路径上的 `.codex/config.toml` | 需要项目 trust；某些 key 被禁用 |
| SessionFlags | CLI `--config` / UI 运行时覆盖 | 最高优先级运行时配置 |
| Legacy managed | `managed_config.toml` / MDM | 兼容旧托管配置机制，位置特殊 |

同时还有 requirements 层，主要来源包括：

- `/etc/codex/requirements.toml`
- 企业云端 requirements
- macOS managed preferences 中的 requirements
- 旧 `managed_config.toml` 映射而来的 constraints

requirements 不是普通覆盖配置，而是约束最终配置，例如限制 sandbox、approval、MCP server、feature 等。

对 `agent-config` 的启发：

- 仅展示 `$CODEX_HOME/config.toml` 中的配置是不够的；要区分 `discovered`、`layered` 和 `effective`。
- `doctor` 应能提示“某个值存在于低优先级层，但被 profile / project / session 覆盖”。
- `requirements.toml` 可能让配置“看起来存在但最终不可用”，尤其是 MCP 和权限相关配置。

## 3. Project 配置发现与 trust 机制

Codex project 配置位于项目中的 `.codex/config.toml`。加载规则不是简单扫描当前目录：

1. 先根据 `project_root_markers` 找项目根。
2. 默认 marker 是 `.git`。
3. 从项目根到当前工作目录沿途查找 `.codex` 目录。
4. 每个存在的 `.codex` 都形成一个 project layer。
5. project layer 顺序从项目根到 cwd，越靠近 cwd 优先级越高。
6. 如果项目未被用户信任，project layer 会被记录但禁用，不参与 effective config。

项目 trust 信息保存在用户配置的 `[projects]` 表里，key 是 canonicalized project path，value 包含 `trust_level`。

Project-local 配置还有 denylist。以下 key 即使写在项目 `.codex/config.toml` 里也会被移除，并产生 startup warning：

- `openai_base_url`
- `chatgpt_base_url`
- `apps_mcp_product_sku`
- `model_provider`
- `model_providers`
- `notify`
- `profile`
- `profiles`
- `experimental_realtime_ws_base_url`
- `otel`

对 `agent-config` 的启发：

- `scan` 可以发现 `.codex/config.toml`，但 `doctor` 应标注它是否会被 Codex 禁用。
- `doctor` 应检查 project config 中不支持的 key，并提示这些 key 不会作为 project-local 配置生效。
- Project scan 不应只看当前目录，还应考虑项目根到 cwd 的 `.codex` 链。

## 4. Config TOML 结构重点

Codex 的 `ConfigToml` 是强 schema 的 TOML 配置。和 `agent-config` 当前最相关的字段包括：

| 字段 | 作用 |
|---|---|
| `model` / `review_model` | 模型选择 |
| `model_provider` / `model_providers` | 模型 provider 选择与自定义 provider |
| `approval_policy` / `approvals_reviewer` | 命令审批策略 |
| `sandbox_mode` / `sandbox_workspace_write` | 旧权限配置路径 |
| `default_permissions` / `[permissions]` | 新权限 profile 配置路径 |
| `notify` | 用户通知命令 |
| `instructions` / `developer_instructions` | 系统/开发者指令 |
| `model_instructions_file` | 指令文件，路径会相对配置文件所在目录解析 |
| `mcp_servers` | MCP server 定义 |
| `mcp_oauth_credentials_store` | MCP OAuth 凭证存储后端 |
| `project_doc_max_bytes` | AGENTS.md 注入最大字节数 |
| `project_doc_fallback_filenames` | AGENTS.md 缺失时的 fallback 文件名 |
| `profile` / `profiles` | 旧 profile 机制；当前加载中会报错或被限制 |
| `history` | history persistence 和大小限制 |
| `sqlite_home` | state DB 位置 |
| `log_dir` | log 目录 |
| `features` | feature flags |
| `memories` | memory 子系统配置 |
| `project_root_markers` | 项目根发现规则 |
| `projects` | 项目 trust 状态 |
| `hooks` / `plugins` / `marketplaces` / `skills` | 扩展能力配置 |

路径型字段会根据所在配置层的 base dir 解析成绝对路径。比如用户配置中的相对路径相对 `$CODEX_HOME`，项目配置中的相对路径相对对应 `.codex` 目录。

对 `agent-config` 的启发：

- Codex parser 需要 TOML。
- 如果后续做 effective view，需要保留每层 base dir，否则相对路径解释会错。
- 旧 `profile = "name"` 和 `[profiles.name]` 不是当前推荐路径；需要在 doctor 中提示迁移到 `$CODEX_HOME/<name>.config.toml` + `--profile`。

## 5. MCP Server 配置

### 5.1 Codex 原生 MCP 路径

Codex 原生 MCP 配置位于 TOML 的 `[mcp_servers.<name>]`：

```toml
[mcp_servers.filesystem]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]

[mcp_servers.docs]
url = "https://example.com/mcp"
bearer_token_env_var = "DOCS_TOKEN"
```

主要字段包括：

| 字段 | 说明 |
|---|---|
| `command` | stdio MCP 启动命令 |
| `args` | stdio 参数 |
| `env` | 静态环境变量 map |
| `env_vars` | 从本地或远端环境读取的环境变量名列表 |
| `cwd` | stdio 工作目录 |
| `url` | streamable HTTP MCP URL |
| `http_headers` | 静态 HTTP headers |
| `env_http_headers` | 从环境变量读取的 HTTP headers |
| `bearer_token_env_var` | bearer token 环境变量名 |
| `environment_id` | 默认 `local`；远端 stdio 需要绝对 `cwd` |
| `enabled` | false 时跳过初始化 |
| `required` | true 时 `codex exec` 初始化失败会报错退出 |
| `startup_timeout_sec` / `startup_timeout_ms` | 启动超时 |
| `tool_timeout_sec` | tool 调用超时 |
| `enabled_tools` / `disabled_tools` | tool allow/deny list |
| `default_tools_approval_mode` | 默认 tool 审批模式 |
| `tools.<name>.approval_mode` | 单 tool 审批覆盖 |
| `scopes` / `oauth` / `oauth_resource` | OAuth 配置 |

### 5.2 MCP transport 校验

Codex 的 MCP server 只能是两类之一：

- stdio：必须有 `command`。
- streamable HTTP：必须有 `url`。

校验规则包括：

- `command` 与 `url` 不能混用。
- stdio 不允许 `url`、`bearer_token_env_var`、`http_headers`、`env_http_headers`、`oauth`、`oauth_resource`。
- HTTP 不允许 `args`、`env`、`env_vars`、`cwd`、`bearer_token`。
- `bearer_token` 作为直接 secret 字段不支持，要求使用 `bearer_token_env_var`。
- `env_vars` 的 source 只支持 `local` 或 `remote`。
- 非 local 的 stdio server 必须配置绝对 `cwd`。

### 5.3 MCP requirements 与 plugin MCP

Codex 最终生成 MCP config 时会合并：

1. 用户/项目/运行时配置中的 `mcp_servers`
2. 活跃 plugin 提供的 MCP servers
3. requirements 对 MCP 的约束

合并时，显式配置的 MCP 优先于 plugin MCP。plugin MCP 只有在同名 server 不存在时才加入。requirements 可以过滤掉不允许的 MCP server，也可以导致 server 被 disabled 并带上 disabled reason。

对 `agent-config` 的启发：

- `agent-config mcp --agent codex` 需要识别 TOML 的 `mcp_servers`，不是 JSON 的 `mcpServers`。
- 输出需要区分 `stdio` 和 `streamable_http`，并保留 Codex 特有字段。
- `doctor` 应检查互斥字段、无效 transport、远端 stdio 相对 cwd、直接 bearer token、被 requirements 禁用等情况。
- 如果后续实现 effective MCP view，需要考虑 plugin MCP 和 requirements，而不是只读 `config.toml`。

## 6. Codex 与其他 Agent 配置：重点是 Claude 迁移，而不是常规兼容读取

Codex 仓库中存在一套外部 Agent 配置迁移服务，当前目标明确是 Claude：

- 外部 Agent 目录名：`.claude`
- 用户级来源：`~/.claude`
- 项目级来源：`<repo>/.claude`
- Claude 指令文件：`CLAUDE.md`
- Claude settings：`settings.json` 和 `settings.local.json`
- Claude MCP 文件：`.mcp.json`

迁移服务会检测并提示用户导入以下类型：

| 类型 | Claude 来源 | Codex 目标 |
|---|---|---|
| Config | `settings.json` / `settings.local.json` | `$CODEX_HOME/config.toml` 或 `<repo>/.codex/config.toml` |
| MCP | `.mcp.json`、Claude project config 中的 `mcpServers` | TOML `[mcp_servers]` |
| Hooks | `.claude/hooks` 与 settings 中 hooks | `hooks.json` |
| Skills | `.claude/skills` | `.agents/skills` |
| Commands | `.claude/commands` | `.agents/skills` 中的 command skill |
| Subagents | `.claude/agents` | `.codex/agents` 或 `$CODEX_HOME/agents` |
| AGENTS.md | `CLAUDE.md` | `AGENTS.md` |
| Sessions | `~/.claude/projects/*.jsonl` | Codex sessions 迁移 |
| Plugins | Claude plugin settings | Codex marketplaces/plugins |

`settings.local.json` 会覆盖 `settings.json`，但无效的 local settings 会被忽略。

### 6.1 Claude settings 到 Codex config 的映射

目前普通 config 迁移只覆盖少量字段：

- Claude `env` 迁移为 Codex `shell_environment_policy.set`，并设置 `inherit = "core"`。
- Claude `sandbox.enabled = true` 迁移为 `sandbox_mode = "workspace-write"`。

迁移采用“只填缺失值”的 merge 策略：如果目标 Codex config 已经有同名 key，不会覆盖。

### 6.2 Claude MCP 到 Codex MCP 的迁移

Claude MCP 来源包括：

- 项目根 `.mcp.json`
- 项目根 `.claude` project config
- 用户级 Claude project config 中匹配当前项目路径的 `projects.<path>.mcpServers`

合并规则：

- 当前 source root 内的 MCP 定义可覆盖前面读到的同名 server。
- 用户级 project-specific MCP 在某些路径下作为 fallback，保留已有 server。
- 目标 Codex config 已有同名 MCP server 时，迁移不会覆盖。

迁移只接受可安全转换的 MCP：

- 支持 stdio `command` / `args` / `env`。
- 支持 HTTP `url` / `headers`。
- 支持 `type = "stdio"`、`"http"`、`"streamable_http"`。
- `enabled = false`、`disabled = true`、不在 `enabledMcpjsonServers` allowlist 或在 `disabledMcpjsonServers` denylist 中的 server 会跳过。
- `command`、`args`、`url` 中包含 `${...}` 占位符时会跳过。
- env value 如果是 `${KEY}`，会转换为 `env_vars = ["KEY"]`。
- env value 如果包含复杂 `${...}`，会跳过整个 server。
- HTTP `Authorization = "Bearer ${TOKEN}"` 会转换为 `bearer_token_env_var = "TOKEN"`。
- 其他 header 如果 value 是 `${KEY}`，会进入 `env_http_headers`。
- header value 包含复杂 `${...}` 会跳过整个 server。

对 `agent-config` 的启发：

- Codex doctor 应能解释“为什么 Claude MCP 没被迁移”：disabled、transport 不支持、占位符无法安全转换、同名 Codex server 已存在等。
- 对比 Codex 和 Claude MCP 时，应把“可迁移”和“已生效”分开。
- 如果检测到 `.claude/.mcp.json` 或 `.mcp.json` 与 Codex `[mcp_servers]` 同名，需要展示是否会被 Codex 迁移跳过或被目标同名保留。

## 7. AGENTS.md 加载规则

Codex 使用 `AGENTS.md` 作为项目指令文档，也支持用户级 AGENTS：

- 用户级优先查 `$CODEX_HOME/AGENTS.override.md`，再查 `$CODEX_HOME/AGENTS.md`。
- 项目级候选文件优先 `AGENTS.override.md`，再 `AGENTS.md`，再用户配置的 `project_doc_fallback_filenames`。
- 项目级搜索从项目根到 cwd，按顺序拼接所有匹配文件。
- 默认项目根 marker 是 `.git`，可通过 `project_root_markers` 修改。
- `project_doc_max_bytes = 0` 会禁用项目文档注入。
- 文件超出 `project_doc_max_bytes` 会被截断。
- 用户级与项目级内容之间插入 `--- project-doc ---` 分隔符。
- `features.child_agents_md` 开启时，会额外追加内部的层级 AGENTS 指导。

对 `agent-config` 的启发：

- `scan` 除 `.codex/config.toml` 外，也可以为 Codex adapter 发现 `AGENTS.override.md`、`AGENTS.md` 和 fallback 文件。
- `doctor` 可以提示 fallback 文件与 `AGENTS.md` 的优先级关系，以及 `project_doc_max_bytes = 0` 导致项目指令不注入。

## 8. Memory 配置与行为

### 8.1 Memory 配置字段

Codex memory 配置在 `[memories]` 表中：

| 字段 | 默认值 | 说明 |
|---|---:|---|
| `disable_on_external_context` | `false` | 当 web search / tool search 等外部上下文出现时，将线程 memory mode 标记为 `polluted` |
| `no_memories_if_mcp_or_web_search` | alias | 旧字段名，等价于 `disable_on_external_context` |
| `generate_memories` | `true` | 新线程是否以可生成 memory 的状态创建；false 时线程 memory mode 为 `disabled` |
| `use_memories` | `true` | 是否把 memory read-path 指令注入 developer prompt |
| `dedicated_tools` | `false` | 是否暴露专用 memory tools |
| `max_raw_memories_for_consolidation` | `256` | Phase 2 最多选择多少 raw memories；clamp 到 1..4096 |
| `max_unused_days` | `30` | 太久未使用的 memory 不参与 Phase 2；clamp 到 0..365 |
| `max_rollout_age_days` | `10` | Phase 1 选择多老以内的 rollout；clamp 到 0..90 |
| `max_rollouts_per_startup` | `2` | 每次 startup 最多处理多少 rollout；clamp 到 1..128 |
| `min_rollout_idle_hours` | `6` | rollout 至少空闲多久才可生成 memory；clamp 到 1..48 |
| `min_rate_limit_remaining_percent` | `25` | 剩余 quota 低于阈值时跳过 startup memory；clamp 到 0..100 |
| `extract_model` | unset | Phase 1 抽取模型覆盖 |
| `consolidation_model` | unset | Phase 2 consolidation agent 模型覆盖 |

注意：memory pipeline 是否运行还受 `features.memory_tool` 影响。`use_memories = true` 本身不足以启用 memory read path；需要 feature enabled。

### 8.2 Memory 文件布局

Memory 文件根目录是 `$CODEX_HOME/memories`。主要文件包括：

| 文件 / 目录 | 作用 |
|---|---|
| `memory_summary.md` | read path 注入 developer prompt 的摘要文件 |
| `MEMORY.md` | consolidated memory 主文件 |
| `raw_memories.md` | Phase 1 输出的机械合并，Phase 2 输入 |
| `rollout_summaries/` | 每个被选中 rollout 的 summary 文件 |
| `phase2_workspace_diff.md` | Phase 2 consolidation agent 读取的 diff，上次成功后会被移除 |
| `.git` | Codex 管理的 memory baseline git repo |
| `extensions/` | memory extension 资源，例如 ad-hoc note instructions |
| `skills/` | consolidation agent 可维护的 memory-derived skills |

还有一个清理命令会清空 `$CODEX_HOME/memories` 和 `$CODEX_HOME/memories_extensions` 的内容，但会保留根目录，并拒绝清理 symlinked root。

### 8.3 Memory read path

Codex memory read path 通过 extension contributor 工作：

1. 线程启动时读取当前 config，生成 `MemoriesExtensionConfig`。
2. 当 `features.memory_tool` 开启且 `memories.use_memories = true` 时，memory extension 可贡献 developer prompt fragment。
3. 只有当 `$CODEX_HOME/memories/memory_summary.md` 存在且非空时，才会渲染 memory read-path developer instructions。
4. `memory_summary.md` 会按 token limit 截断后注入。
5. 如果 `memories.dedicated_tools = true`，还会暴露专用 memory tools。

对 `agent-config` 的启发：

- Memory 是否“可用”不是只看 `[memories]`，还要看 feature flag、`memory_summary.md` 是否存在、是否非空。
- `doctor` 可以输出 memory read path 状态：disabled by feature、disabled by config、summary missing、summary empty、dedicated tools enabled/disabled。

### 8.4 Memory write path / startup pipeline

Memory startup pipeline 在 root session 启动时异步触发，但只有满足以下条件才运行：

- session 不是 ephemeral
- `features.memory_tool` 开启
- 当前 session 不是 sub-agent session
- state DB 可用

启动后流程：

1. 创建 `$CODEX_HOME/memories`。
2. 写入 memory extension instructions。
3. 先 prune 过期 stage-1 outputs。
4. 检查 Codex backend rate limit；低于 `min_rate_limit_remaining_percent` 则跳过。
5. Phase 1：从 state DB claim 最近可用 rollout，运行模型抽取 raw memory 和 rollout summary。
6. Phase 2：claim 全局 consolidation lock，把 DB 中被选中的 memory 同步到 memory workspace，生成 git diff，必要时启动内部 consolidation agent。

Phase 1 只选择：

- 允许的 interactive session source
- `memory_mode = 'enabled'`
- 不是当前线程
- 未归档
- 在 `max_rollout_age_days` 窗口内
- 至少空闲 `min_rollout_idle_hours`
- 未处于 running lease / retry backoff / retry exhausted
- 未被已有 stage1 output 或 job watermark 视为 up to date

Phase 2 只选择：

- 当前 latest stage-1 outputs
- 未被 `memory_mode = 'polluted'` 排除
- 未超过 `max_unused_days`
- 按 usage 和最近更新时间排序后取 top N

Phase 2 consolidation agent 的运行环境被强限制：

- cwd 是 memory root
- ephemeral = true
- `generate_memories = false`
- `use_memories = false`
- MCP servers 清空
- approval policy 固定为 never
- 禁用 collab / memory tool / apps / plugins / skill MCP dependency install 等 feature
- sandbox 仅允许本地 memory root write，无网络

对 `agent-config` 的启发：

- Memory doctor 需要区分“配置允许生成 memory”和“实际有无候选 rollout / DB 是否可用 / rate limit 是否允许”。
- Memory 状态不是纯文件系统问题，SQLite state DB 中的 `threads.memory_mode`、jobs 和 stage1_outputs 才决定生成链路。
- 如果只做静态 scan，可以至少报告 `$CODEX_HOME/memories` 文件存在性和 `[memories]` 配置；不要声称 memory pipeline 一定会运行。

### 8.5 Memory mode 与 external context

Codex 用 `memory_mode` 管理线程是否可参与 memory：

- `enabled`：可参与 memory 生成和 Phase 2 选择。
- `disabled`：不会参与 memory 生成。
- `polluted`：因外部上下文污染，不参与 Phase 2 选择。

`generate_memories = false` 会让新线程初始为 disabled。

`disable_on_external_context = true` 时，如果模型输出涉及外部上下文来源，Codex 会把当前线程标记为 polluted。当前识别的外部上下文包括：

- tool search call
- tool search output
- web search call

如果某个已被 Phase 2 选中过的线程变成 polluted，Codex 会 enqueue 一次全局 Phase 2 consolidation，用于从 consolidated memory 中遗忘相关内容。

对 `agent-config` 的启发：

- `doctor` 可以解释为什么某个 memory 不再参与 consolidation：thread memory_mode 是 disabled / polluted。
- 对用户来说，`disable_on_external_context` 名字容易误读；实际效果不是关闭 memory 功能，而是外部上下文出现后污染当前线程，使其不再进入 memory consolidation。

## 9. Codex 对 `agent-config` 的 adapter 建议

### 9.1 Scan 候选路径

建议 Codex adapter 至少发现：

| scope | 路径 |
|---|---|
| global | `$CODEX_HOME/config.toml` |
| global | `$CODEX_HOME/*.config.toml`，作为 profile candidates |
| global | `$CODEX_HOME/AGENTS.override.md` |
| global | `$CODEX_HOME/AGENTS.md` |
| global | `$CODEX_HOME/memories/` |
| global | `$CODEX_HOME/memories/memory_summary.md` |
| global | `$CODEX_HOME/memories/MEMORY.md` |
| global | `$CODEX_HOME/memories/raw_memories.md` |
| system | `/etc/codex/config.toml` |
| system | `/etc/codex/requirements.toml` |
| system | `/etc/codex/managed_config.toml` |
| project | 从 project root 到 cwd 的 `.codex/config.toml` |
| project | 从 project root 到 cwd 的 `AGENTS.override.md` / `AGENTS.md` |
| external migration source | `~/.claude/settings.json` / `settings.local.json` |
| external migration source | `~/.claude/CLAUDE.md` |
| external migration source | `~/.claude/.mcp.json` |
| external migration source | `<repo>/.claude/settings.json` / `settings.local.json` |
| external migration source | `<repo>/.claude/*` migration sources |
| external migration source | `<repo>/.mcp.json` |

### 9.2 MCP extraction

Codex MCP extractor 需要支持：

- TOML `mcp_servers.<name>`。
- stdio transport：`command`、`args`、`env`、`env_vars`、`cwd`。
- HTTP transport：`url`、`bearer_token_env_var`、`http_headers`、`env_http_headers`。
- enabled / required / timeout / tool allowlist / tool approval / OAuth 字段。
- requirements 或 disabled reason 的后续 effective view。

### 9.3 Doctor 规则

建议增加 Codex-specific doctor：

- `CODEX_HOME` 设置但不存在或不是目录。
- `config.toml` TOML 解析失败。
- project `.codex/config.toml` 存在但项目未 trust，因此不会生效。
- project config 使用 denylist key，因此被移除。
- `$CODEX_HOME/<profile>.config.toml` 存在但没有被选中，因此不是 effective layer。
- 旧 `profile` / `[profiles]` 配置导致当前 Codex 报错或不推荐。
- `[mcp_servers]` 中 `command` 和 `url` 混用。
- stdio / HTTP transport 使用了不支持字段。
- HTTP 使用 `bearer_token` 而不是 `bearer_token_env_var`。
- 远端 stdio MCP 缺少绝对 `cwd`。
- 同名 MCP 在 Codex config、plugin MCP、Claude migration source 中重复。
- Claude MCP 可迁移但目标 Codex 已有同名 server，因此会被保留/跳过。
- Memory feature 未开启但 `[memories]` 配置存在。
- `use_memories = true` 但 `memory_summary.md` 缺失或为空。
- `generate_memories = true` 但 state DB 缺失，无法判断 pipeline 是否实际运行。
- `disable_on_external_context = true` 时存在 polluted memory mode，需要解释会排除 Phase 2。

## 10. 与 oh-my-pi 调研的关键差异

| 维度 | oh-my-pi | Codex |
|---|---|---|
| 架构 | capability/provider registry，同时读取多个 Agent 来源 | Codex 自身 TOML layer stack，外部 Agent 主要通过迁移流程进入 |
| 多 Agent 兼容 | 常规加载 Claude/Codex/Gemini/Cursor/Windsurf 等 provider | 当前重点迁移 Claude `.claude`，不是运行时持续混读 |
| MCP 来源 | 多 provider 并行发现、归一化、按优先级去重 | 原生 `[mcp_servers]` + plugin MCP + requirements；Claude MCP 可迁移 |
| project 配置 | provider 自己决定路径和优先级 | `.codex/config.toml`，受 trust 和 denylist 限制 |
| effective view | capability 去重后 items / all | ConfigLayerStack effective config + origins + disabled layers |
| memory | 调研范围内非核心 | 独立子系统，配置、DB、文件工作区、后台 agent 全套链路 |

对 `agent-config` 来说，Codex adapter 不应照搬 oh-my-pi 的“多 provider 混读”模型。更准确的模型是：

- `discovered`: 所有 Codex 原生配置、project 配置、memory 文件、Claude migration source。
- `effective`: Codex layer stack 语义下真正生效的配置。
- `migration-candidates`: Claude 来源中可迁移但尚未进入 Codex 的配置。
- `memory-state`: memory 配置 + 文件状态 + 后续可选 DB 状态。

## 11. 建议的后续实现优先级

1. 为 Codex adapter 增加 `$CODEX_HOME/config.toml`、`$CODEX_HOME/*.config.toml`、project `.codex/config.toml` 发现。
2. 将 Codex MCP extractor 从通用 `mcp_servers` 扩展到 Codex 特有字段。
3. 为 Codex memory 增加 scan 输出，至少列出 `[memories]` 配置和 `$CODEX_HOME/memories` 关键文件状态。
4. 增加 Codex doctor：project trust、project denylist、MCP transport 校验、memory summary 缺失。
5. 后续增加 Claude migration candidate 视图，用于解释 `.claude` / `.mcp.json` 与 Codex 配置的关系。
6. 如果需要真正的 effective view，考虑实现一个轻量版 Codex layer resolver，至少覆盖 system/user/profile/project/session 的 TOML merge 和 disabled layer 标注。
