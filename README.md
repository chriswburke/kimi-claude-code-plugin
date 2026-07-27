<!-- Content plan: docs/content-plan.md#repository-landing -->

# Kimi Code Companion for Claude Code

Use Kimi Code from Claude Code for autonomous delegation, tool-constrained repository analysis, managed background jobs, and private local usage reporting.

## Install Kimi

This is the Kimi half of the two-repository migration. Clone this repository, then run these commands in Claude Code from its root:

```text
/plugin marketplace add .
/plugin install kimi@model-companions-kimi
/reload-plugins
```

Kimi requires Git, Node.js 18.18 or newer, Claude Code 2.1.169 or newer, and Kimi Code 0.29.0 or newer. Authenticate the Kimi CLI with `kimi login`, then verify the installation without model inference:

```text
/kimi:setup
/kimi:models
```

Start with a request that cannot modify the checkout:

```text
/kimi:explore --profile stable Where is authentication enforced?
```

`/kimi:ask` can modify files. Run it only in a checkout you trust.

## Migrate from the combined marketplace

The former `model-companions` marketplace has split into exactly two repositories: this Kimi repository and the separate GLM repository. Install Kimi from this repository as `kimi@model-companions-kimi`; do not expect updates through `kimi@model-companions`.

The split also changes the Claude Code data-directory identity. Claude Code may set `CLAUDE_PLUGIN_DATA` to a new Kimi-specific directory after reinstalling. The companion treats the supplied directory as a separate private state root; it does not merge, copy, or delete data from the former combined installation. Keep the old directory until you have confirmed any retained jobs or usage records you need. Never move private state while a Kimi job is active.

Before installing the new identity, finish or cancel every legacy Kimi job and inspect the local usage you need to retain. Exit Claude Code, then preserve the former data directory while removing the legacy installation:

```bash
claude plugin list --json
claude plugin uninstall kimi@model-companions \
  --scope user --keep-data
```

If the list reports a project or local installation, repeat the uninstall with `--scope project` or `--scope local`. Remove every reported legacy scope before continuing.

Install `kimi@model-companions-kimi`, reload plugins, and run `/kimi:setup`. Do not enable the old and new identities together because both expose the `/kimi:*` command and MCP namespaces.

## Find the right guide

| Task | Guide |
| --- | --- |
| Install and run a first request | [Get started](./docs/get-started.md) |
| Look up command syntax and boundaries | [Command reference](./docs/command-reference.md) |
| Manage jobs and local usage | [Manage jobs and usage](./docs/manage-jobs-and-usage.md) |
| Review trust assumptions | [Security model](./docs/security-model.md) |
| Diagnose a failure | [Troubleshooting](./docs/troubleshooting.md) |
| Validate and release Kimi | [Release packages](./docs/release-packages.md) |

The Kimi package source is nested at [`plugins/kimi`](./plugins/kimi); its [self-contained reference](./plugins/kimi/README.md) describes all runtime limits, retention, and security behavior.

## Develop

Run the repository checks after a change:

```bash
npm test
npm run validate
```

Read [Contributing](./CONTRIBUTING.md) before submitting a change. Report sensitive vulnerabilities through the [security policy](./SECURITY.md).
