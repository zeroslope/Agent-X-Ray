# Codex rules are verified from local source before implementation

`axray` should verify Codex adapter rules against the local Codex source checkout at `/Users/zeroslope/repos/codex` before implementing or updating the adapter. The CLI should not check upstream Codex updates at runtime; rule drift should be handled through implementation-time source review, adapter notes, and fixtures so reports remain deterministic.
