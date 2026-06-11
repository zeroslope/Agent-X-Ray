# Agent X-Ray

Agent X-Ray explains the context an agent product would assemble for a session, with enough provenance to show why something is active or inactive.

## Language

**Agent Product**:
A concrete agent runtime whose loading rules can be inspected, such as Codex or Claude.
_Avoid_: Agent, platform, tool

**axray**:
The command-line product that inspects agent context from an agent product's runtime perspective.
_Avoid_: agent-x-ray CLI, agent-config

**Agent Context**:
The complete set of instructions, configuration, memory, skills, MCP servers, and extension-derived inputs that may shape an agent session.
_Avoid_: Config, prompt, environment

**Instruction Graph**:
The active instruction sources and the import relationships that cause one instruction source to pull in another.
_Avoid_: Prompt text, markdown tree

**Skill Inventory**:
The discovered skills available to an agent product, with source, scope, metadata, and structural health, but without expanding the full skill body or assets.
_Avoid_: Skill content, tool list

**MCP Configuration Inventory**:
The statically parsed MCP server definitions and related issues found for a context report, without starting servers, connecting transports, or listing runtime tools.
_Avoid_: MCP health check, tool discovery

**Effective Context**:
The subset of agent context that a selected agent product would actually use for a session in the current directory.
_Avoid_: Loaded files, scanned config

**Context Report**:
A structured explanation of effective context, inactive sources, source provenance, and detected issues for one agent product in one working directory. A context report describes the current state at generation time, not an archival interchange format for older reports.
_Avoid_: Terminal output, scan result

**Report Redaction**:
The removal or masking of sensitive values from a context report while preserving enough names, paths, and structure to explain the agent context.
_Avoid_: Secret dump, raw values

**Config Layer**:
One ordered source of product configuration that may participate in the selected agent product's configuration stack.
_Avoid_: Config file, setting group

**Memory Read Path**:
The part of memory behavior that determines whether memory can contribute text or tools to the current agent context.
_Avoid_: Memory pipeline, memory contents

**Memory Contents**:
The remembered material and supporting history that may influence future agent outputs when surfaced through a memory read path.
_Avoid_: Memory config, memory status

**Discovered Source**:
A context source found on disk or through configured locations before product-specific activation rules are applied.
_Avoid_: Loaded source, active source

**Source Status**:
The product-specific activation result for a discovered source: active, inactive, or error.
_Avoid_: Related, unknown, maybe

**Inactive Source**:
A discovered source that does not contribute to the effective context because product rules exclude, shadow, disable, or ignore it.
_Avoid_: Unused config, dead config

**Migration Source**:
A source owned by another agent product that the selected product may import or convert through an explicit migration path, but does not use directly as effective context. Migration sources are diagnostic detail, not part of the default context view.
_Avoid_: Compatible config, loaded external config, migration candidate
