## Scope

- [ ] This change targets Kimi Code Companion and its source under `plugins/kimi`.
- [ ] The marketplace source and install identity remain `plugins/kimi` and `kimi@model-companions-kimi`.

Describe the change and its provider scope:

## Verification

- [ ] I ran the relevant provider release gate or `npm run release:check`.
- [ ] I ran strict validation for manifest, marketplace, command, or workflow changes.
- [ ] I updated tests for changed behavior.

List the commands and results:

## Documentation and safety

- [ ] I updated documentation for user-visible behavior.
- [ ] Any `CLAUDE_PLUGIN_DATA` language preserves operator private state and does not promise automatic copying or deletion.
- [ ] I removed credentials, authorization headers, private prompts, model output, local paths, and usage records from this pull request.
- [ ] I followed [SECURITY.md](../SECURITY.md) for any vulnerability report.
