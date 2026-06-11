# Context reports are partial on source errors

`axray` should keep producing a context report when individual sources fail to parse or validate. A broken config file is part of the context story, so the failing source should appear with `status: "error"` and a structured issue instead of causing the whole command to fail; command-level failure should be reserved for unsupported products, inaccessible working directories, or internal program errors that prevent report serialization.
