---
description: Delegate a coding task to Kimi Code
argument-hint: "[--background] [--model <model> | --profile <profile>] [--label <label>] [--timeout <duration>] <task>"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* T* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__run_task"]
---

The invocation text is appended below by Claude Code under `ARGUMENTS:`.
Call `mcp__plugin_kimi_companion__run_task` exactly once. Pass the complete
appended argument value through `rawArguments` without executing, interpolating,
or rewriting it. Do not use Bash or perform the task yourself. Return the tool
result verbatim.
