---
meta:
  title: Troubleshoot Kimi Code Companion failures
  navLabel: Troubleshooting
  category: Guides
  contentType: Troubleshooting
---

# Troubleshoot Kimi Code Companion failures

Start with local diagnostics; they redact sensitive values and do not start inference.

```text
/kimi:setup --json
/kimi:config --json
/kimi:models --json
/kimi:status --active
```

## Kimi CLI is missing or unsupported

Install Kimi Code 0.29.0 or newer, authenticate with `kimi login`, and rerun setup. Constrained workflows require the `--agent-file`, `--skills-dir`, and `--add-dir` capabilities. The plugin deliberately rejects batch wrappers. Windows is untested, so use WSL.

## An executable trust check fails

Use an administrator- or current-user-owned executable and non-writable parent directories. Ensure implicit `PATH` entries are absolute and do not resolve into the repository. Set `KIMI_BIN` only to a deliberate absolute path. Do not relax state or executable permissions to make a check pass.

## A job cannot be selected or recovered

Use `/kimi:status --active` to find its identifier, then pass that identifier to `/kimi:result` or `/kimi:cancel`. Cancellation may omit an ID only with exactly one active job. If recovery reports unsafe state, retain the named private evidence and correct the symlink, ownership, or permission problem; do not delete active guard, worker, slot, or job files manually.

For command behavior, see the [command reference](./command-reference.md); for trust and containment, see the [security model](./security-model.md).
