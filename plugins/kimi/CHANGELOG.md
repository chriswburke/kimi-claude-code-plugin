# Changelog

## 1.0.0

First release, published as `kimi@model-companions-kimi` with source nested at
`plugins/kimi`.

- Explicit `fast`, `stable`, `deep`, and `large-context` model profiles.
- Model and config inspection, explore and plan workflows, review presets, job
  controls, grouped local usage reports, and guarded local cleanup.
- Versioned JSON envelopes and structured MCP output for automation.
- Bounded concurrency, execution time, and output, with distinct terminal
  outcomes for timeouts and output limits.
- An explicitly opted-in experimental ACP session bridge using documented Kimi
  session operations, permission denial, and bounded output.
- Owner-safe foreground, ACP, and provider-probe recovery with durable
  usage/byte accounting, retryable cleanup, and mutation-free cleanup previews.
- Durable pre-job background recovery, including exact-owner atomic temporary
  cleanup and fail-closed preservation of unknown recovery evidence.
- Bounded, redacted structured error metadata across the authenticated
  foreground guard, including an optional validated direct-CLI exit code.
- Minimized helper and isolated-provider environments, with a documented trust
  boundary around user-configured Kimi hooks and MCP startup.
- Crash-safe owner directories for concurrency, job, usage,
  foreground-manifest, and background-provision locks, with process-birth
  validation, deterministic retirement, and orphan scans.
- Private local usage accounting with no provider prompt or quota scraping.
- Review isolation, Git preprocessing, managed process-group cancellation,
  local state permissions, prompt cleanup, and installed-copy hardening.
- Slash commands load their deferred companion tool schema through ToolSearch,
  and review, explore, and plan ask Kimi for Markdown with clickable path:line
  citations.
- Unauthenticated provider-guard liveness is trusted only within the heartbeat
  grace window, so a reused process identifier cannot pin a dead job active.
- The MCP server declares the protocol version it implements rather than
  echoing the version a client proposes.
- Continuous integration pins its Claude Code and Kimi Code installs, including
  the provider canary that runs with an API key.
