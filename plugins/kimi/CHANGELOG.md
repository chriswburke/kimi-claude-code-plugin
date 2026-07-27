# Changelog

## 1.0.0

- Moved Kimi to its own repository and marketplace identity,
  `kimi@model-companions-kimi`, with source nested at `plugins/kimi`.
- Documented that the new identity can change `CLAUDE_PLUGIN_DATA`; the plugin
  does not automatically merge, copy, or delete previous private state.
- Fixed test isolation so an inherited `CLAUDE_PLUGIN_DATA` no longer redirects
  the suite onto live plugin state. `MODEL_COMPANION_STATE_DIR` now takes
  precedence as the explicit override.
- Fixed foreground and session cleanup so a cleanup failure annotates the
  original error instead of replacing it.
- Scaled the untracked-file review budget with
  `KIMI_COMPANION_MAX_REVIEW_CONTEXT_BYTES` instead of a fixed bound.
- Added explicit `fast`, `stable`, `deep`, and `large-context` model profiles.
- Added model/config inspection, explore/plan workflows, review presets, richer
  job controls, grouped local usage reports, and guarded local cleanup.
- Added versioned JSON envelopes and structured MCP output for automation.
- Added bounded concurrency, execution time, and output with distinct terminal
  outcomes for timeouts and output limits.
- Added an explicitly opted-in experimental ACP session bridge using documented
  Kimi session operations, permission denial, and bounded output.
- Added owner-safe foreground, ACP, and provider-probe recovery with durable
  usage/byte accounting, retryable cleanup, and mutation-free cleanup previews.
- Added durable pre-job background recovery, including exact-owner atomic
  temporary cleanup and fail-closed preservation of unknown recovery evidence.
- Closed the fast-provider output-limit race by reconciling capture state after
  output streams close.
- Preserved bounded, redacted structured error metadata across the authenticated
  foreground guard, including an optional validated direct-CLI exit code.
- Minimized helper and isolated-provider environments and documented the trusted
  boundary around user-configured Kimi hooks and MCP startup.
- Replaced generic concurrency, job, usage, foreground-manifest, and
  background-provision locks with crash-safe owner directories, process-birth
  validation, deterministic retirement, and orphan scans. Normal release now
  leaves no lock residue, and usage identifiers no longer use `.reserve` files.

## 0.4.0

- Added private local usage accounting with no provider prompt or quota scraping.
- Hardened review isolation, Git preprocessing, managed process-group
  cancellation, local state permissions, prompt cleanup, and installed-copy behavior.
