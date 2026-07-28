# Kimi Code Companion for Claude Code

Use Kimi Code from Claude Code for autonomous delegation, tool-constrained repository analysis, managed background jobs, and private local usage reporting.

## Install Kimi

Clone this repository, then run these commands in Claude Code from its root:

```text
/plugin marketplace add .
/plugin install kimi@model-companions-kimi
/reload-plugins
```

Kimi requires Git, Node.js 18.18 or newer, Claude Code 2.1.169 or newer, and Kimi Code 0.29.0 or newer. Continuous integration covers Linux and macOS. Windows is untested; run the plugin under WSL there. Authenticate the Kimi CLI with `kimi login`, then verify the installation without model inference:

```text
/kimi:setup
/kimi:models
```

Start with a request that cannot modify the checkout:

```text
/kimi:explore --profile stable Where is authentication enforced?
```

`/kimi:ask` can modify files. Run it only in a checkout you trust.

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
