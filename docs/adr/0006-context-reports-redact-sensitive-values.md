# Context reports redact sensitive values

`axray` context reports must redact sensitive values by default, especially MCP args, environment values, HTTP header values, bearer token references, and URL query strings. The report should preserve structure, names, source paths, and enough command shape to explain context provenance, but it should not dump secrets into JSON, terminal output, logs, or future HTML renderers; implementation may use a community redaction package after review, but the default behavior remains redaction.
