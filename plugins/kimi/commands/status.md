---
description: Show Kimi companion jobs for this repository
argument-hint: "[job-id] [--active | --all] [--limit <n>] [--json]"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__status"]
---

The optional job ID and filters are appended below under `ARGUMENTS:`. Call
`mcp__plugin_kimi_companion__status` exactly once and pass that complete value
through `rawArguments` without executing, interpolating, or rewriting it.
Return the tool result verbatim.
