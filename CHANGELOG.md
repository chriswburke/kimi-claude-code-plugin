# Changelog

## 1.0.0 - 2026-07-27

- Split the former combined marketplace into exactly two provider repositories. This repository publishes Kimi from `plugins/kimi` as `kimi@model-companions-kimi`.
- Documented the new `CLAUDE_PLUGIN_DATA` identity: existing combined-installation state is not merged, copied, or deleted automatically.
- Reworked repository, package, operational, security, release, and contribution documentation for Kimi-only installation and maintenance.
- Fixed test isolation so an inherited `CLAUDE_PLUGIN_DATA` no longer redirects the suite onto live plugin state, and made `MODEL_COMPANION_STATE_DIR` take precedence as an explicit override.
- Fixed foreground and session cleanup so a cleanup failure annotates the original error instead of replacing it.
- Scaled the untracked-file review budget with `KIMI_COMPANION_MAX_REVIEW_CONTEXT_BYTES` instead of a fixed bound.
- Added Kimi profiles, redacted diagnostics, tool-constrained explore, plan, and review workflows, managed jobs, local usage reporting, cleanup, and experimental native sessions.
- Added command-scoped tool gates, bounded structured output, lifecycle recovery, archive checks, and cross-platform validation.

- Added Kimi profiles, redacted diagnostics, tool-constrained explore, plan, and review workflows, managed jobs, local usage reporting, cleanup, and experimental native sessions.
- Added command-scoped tool gates, bounded structured output, lifecycle recovery, archive checks, and cross-platform validation.
