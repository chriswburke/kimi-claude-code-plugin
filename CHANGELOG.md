# Changelog

## 1.0.0 - 2026-07-28

First release. Kimi installs as `kimi@model-companions-kimi` with source at `plugins/kimi`.

- Kimi model profiles, redacted local diagnostics, and tool-constrained explore, plan, and review workflows.
- Managed background jobs with status, result, and cancellation controls.
- Private local usage reporting and guarded cleanup of retained artifacts.
- Command-scoped tool gates, bounded version-2 structured output, lifecycle recovery, and cross-platform validation.
- Experimental native sessions behind an explicit `--experimental` flag.
- Commands load their deferred companion tool schema through ToolSearch, and review, explore, and plan return Markdown with clickable path:line citations.
- Pinned Claude Code and Kimi Code installs in continuous integration, including the provider canary that runs with an API key.
