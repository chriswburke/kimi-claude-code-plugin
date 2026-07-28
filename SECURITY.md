# Security policy

Use the newest Kimi plugin release before reporting a vulnerability. This project does not declare long-term support for older releases.

## Report a vulnerability privately

Use the hosting platform’s private vulnerability-reporting feature when available. Include the Kimi plugin version, impact, reproduction steps, and any proposed mitigation.

Do not include Kimi credentials, private model output, or exploit details in a public issue. If no private reporting feature appears, open a minimal issue asking a maintainer to establish a private channel. Omit sensitive details until that channel exists.

## Report a non-sensitive security bug

Use the security-hardening issue template for a gap that does not expose an active vulnerability. Redact provider keys, authorization headers, local paths, prompts, model output, and usage records before attaching logs.

The two-repository migration gives Kimi a new `CLAUDE_PLUGIN_DATA` identity. Treat any old and new state directories as private; do not attach their contents to a report or move them while work is active. Read the [Kimi security model](./docs/security-model.md) for documented trust boundaries and containment limits.
