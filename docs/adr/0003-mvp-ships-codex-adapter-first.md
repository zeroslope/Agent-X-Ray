# MVP ships the Codex adapter first

The first `axray` MVP will default to `--product codex` and only implement the Codex adapter, while keeping a product adapter boundary for future agent products. Codex alone already requires accurate handling of config layers, instruction files, memory read path state, skills, MCP configuration, trust, and disabled sources; adding multi-product aggregation now would push the project toward a generic scanner before the Codex runtime view is correct.
