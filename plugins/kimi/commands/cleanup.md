---
description: Preview or remove old local Kimi companion records
argument-hint: "--older-than <duration> [--scope repo|all] [--dry-run | --confirm] [--json]"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__cleanup"]
---

The cleanup options are appended below under `ARGUMENTS:`. Call
`mcp__plugin_kimi_companion__cleanup` exactly once and pass that complete value
through `rawArguments` without executing, interpolating, or rewriting it.
Return the tool result verbatim. Do not delete files yourself or make a model
request. Cleanup is a preview unless the user supplied `--confirm`.
