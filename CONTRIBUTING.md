# Contributing

Contribute changes that keep the Kimi Code Companion installable, testable, and releasable as one provider-specific plugin.

## Prepare the workspace

Use Git, Node.js 18.18 or newer, and npm. Install Claude Code 2.1.169 or newer when validating plugin metadata.

```bash
npm test
npm run validate
```

Keep Kimi source, commands, tests, and documentation under `plugins/kimi`. The marketplace source must remain `./plugins/kimi`, and the install identity must remain `kimi@model-companions-kimi`.

## Prepare a release change

`plugins/kimi/.claude-plugin/plugin.json` is the plugin version authority. Follow the [release guide](./docs/release-packages.md) for the local validation and packaging flow. Contributions must not publish packages, create releases, or invent repository URLs or support contacts.

## Keep the plugin single-provider

This repository packages Kimi only. Do not add another provider or introduce shared provider tooling. Claude Code supplies the private state directory through `CLAUDE_PLUGIN_DATA`; do not write code or documentation that merges, copies, or removes an operator’s private state automatically.

## Report security concerns

Follow the [security policy](./SECURITY.md). Never put credentials, private prompts, model output, or unredacted usage records in an issue or pull request.
