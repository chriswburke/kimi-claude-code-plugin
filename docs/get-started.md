---
meta:
  title: Install Kimi Code Companion in Claude Code
  navLabel: Getting Started
  category: Guides
  contentType: Tutorial
contentPlan: ./content-plan.md#get-started
---

# Install Kimi Code Companion in Claude Code

This tutorial installs Kimi from this repository, verifies it without inference, and runs a first read-only request.

## Check prerequisites

Install Git, Node.js 18.18 or newer, Claude Code 2.1.169 or newer, and Kimi Code 0.29.0 or newer. Install and authenticate the Kimi CLI using the [official Kimi Code documentation](https://www.kimi.com/code/docs/en/):

```bash
kimi login
```

## Add this marketplace

From this repository root in Claude Code, register this marketplace and install Kimi:

```text
/plugin marketplace add .
/plugin install kimi@model-companions-kimi
/reload-plugins
```

The source entry is `./plugins/kimi`.

## Verify Kimi

```text
/kimi:setup
/kimi:models
/kimi:config
```

These commands inspect local configuration and do not start model inference. `/kimi:setup` checks the Kimi CLI version, required capabilities, and `kimi doctor`; authentication is confirmed only by a delegated request.

## Run a read-only request

```text
/kimi:explore --profile stable Where is authentication enforced?
/kimi:plan --profile deep Add resumable uploads without changing the public API
```

`explore` and `plan` permit only `Read`, `Grep`, and `Glob` through a request-local agent. `/kimi:ask` may modify files, so use it only in a trusted checkout.

## Cut over from the combined marketplace

The old combined installation used a different plugin identity. Before installing the replacement, finish or cancel all jobs shown by `/kimi:status --active` and inspect `/kimi:usage --local --json`. Exit Claude Code, then remove the legacy plugin without deleting its private data:

```bash
claude plugin list --json
claude plugin uninstall kimi@model-companions \
  --scope user --keep-data
```

If the list reports the legacy identity at project or local scope, repeat the uninstall with `--scope project` or `--scope local`. Remove every reported legacy scope before continuing.

Register this repository, install `kimi@model-companions-kimi`, reload plugins, and run `/kimi:setup`. Do not keep both identities enabled because each registers the same `/kimi:*` commands and MCP tools.

Claude Code can provide a different `CLAUDE_PLUGIN_DATA` path for the new identity. The companion deliberately treats that path as a new private state root and never merges, copies, or removes old state. Keep the old state directory until you have inspected any jobs or usage records you need.

Continue with the [command reference](./command-reference.md), [job and usage guide](./manage-jobs-and-usage.md), or [security model](./security-model.md).
