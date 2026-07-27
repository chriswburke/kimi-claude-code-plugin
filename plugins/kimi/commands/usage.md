---
description: Show local Kimi companion activity and quota guidance
argument-hint: "[--local] [--json] [--window today|24h|7d|30d|all] [--scope repo|all] [--group-by day|model|kind|outcome]"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* T* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__usage"]
---

The optional usage filters are appended below under `ARGUMENTS:`. Call
`mcp__plugin_kimi_companion__usage` exactly once and pass that complete value
through `rawArguments` without executing, interpolating, or rewriting it.
Return the tool result verbatim. Do not make a model request or infer account
quota from local activity.
