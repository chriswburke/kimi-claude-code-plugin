---
meta:
  title: Install Kimi Code Companion in Claude Code
  navLabel: Getting Started
  category: Guides
  contentType: Tutorial
---

# Install Kimi Code Companion in Claude Code

This tutorial installs Kimi from this repository, verifies it without inference, and runs a first read-only request.

## Check prerequisites

Install Git, Node.js 18.18 or newer, Claude Code 2.1.169 or newer, and Kimi Code 0.29.0 or newer. Install and authenticate the Kimi command-line interface (CLI) using the [official Kimi Code documentation](https://www.kimi.com/code/docs/en/):

```bash
kimi login
```

## Add this marketplace

Register the marketplace and install Kimi from Claude Code:

```text
/plugin marketplace add chriswburke/kimi-claude-code-plugin
/plugin install kimi@model-companions-kimi
/reload-plugins
```

To develop against a local checkout instead, run `/plugin marketplace add .` from the repository root. The source entry is `./plugins/kimi`.

## Verify Kimi

```text
/kimi:setup
/kimi:models
/kimi:config
```

These commands inspect local configuration and do not start model inference. `/kimi:setup` checks the Kimi CLI version, required capabilities, and `kimi doctor`. Only a delegated request confirms authentication.

## Run a read-only request

```text
/kimi:explore --profile stable Where is authentication enforced?
/kimi:plan --profile deep Add resumable uploads without changing the public API
```

`explore` and `plan` permit only `Read`, `Grep`, and `Glob` through a request-local agent. `/kimi:ask` may modify files, so use it only in a trusted checkout.

Continue with the [command reference](./command-reference.md), [job and usage guide](./manage-jobs-and-usage.md), or [security model](./security-model.md).
