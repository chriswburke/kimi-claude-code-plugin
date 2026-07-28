---
meta:
  title: Parse Kimi structured output
  navLabel: Structured Output
  category: Reference
  contentType: Reference
---

# Parse Kimi structured output

Kimi commands with `--json` return the stable version-2 envelope. Provider-specific fields remain inside `data`.

```json
{
  "schemaVersion": 2,
  "provider": "kimi",
  "command": "status",
  "generatedAt": "2026-07-25T00:00:00.000Z",
  "data": {}
}
```

An operation failure replaces `data` with an error object:

```json
{
  "schemaVersion": 2,
  "provider": "kimi",
  "command": "result",
  "generatedAt": "2026-07-25T00:00:00.000Z",
  "error": { "code": "JOB_NOT_FOUND", "message": "...", "retryable": false }
}
```

Treat the command result separately from a retrieved job’s provider outcome. `/kimi:result` succeeds when it retrieves a terminal job, including a failed, cancelled, timed-out, or output-limited job; those outcomes appear in `data.job.status`. A missing job, an active job without `--wait`, or a result-wait timeout returns the error envelope and a nonzero exit.

MCP responses expose the same value as `structuredContent`. Depend on `schemaVersion`, `provider`, `command`, `generatedAt`, and the documented error shape; allow additive fields inside `data` and do not infer account quota from Kimi local usage data.
