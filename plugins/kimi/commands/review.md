---
description: Ask Kimi Code to review the current git changes
argument-hint: "[--background] [--base <ref>] [--model <model> | --profile <profile>] [--preset correctness|security|performance|api|tests] [--label <label>] [--timeout <duration>] [focus]"
disable-model-invocation: true
disallowed-tools: "A* B* C* D* E* F* G* H* I* J* K* L* M* N* O* P* Q* R* S* Task* Todo* U* V* W* X* Y* Z*"
hooks:
  PreToolUse:
    - matcher: "*"
      hooks:
        - type: command
          command: node
          args: ["${CLAUDE_PLUGIN_ROOT}/scripts/tool-gate.mjs", "mcp__plugin_kimi_companion__review"]
---

The invocation text is appended below by Claude Code under `ARGUMENTS:`.
Call `mcp__plugin_kimi_companion__review` exactly once. Pass the complete
appended argument value through `rawArguments` without executing, interpolating,
or rewriting it. Do not use Bash or fix findings. Return the tool result verbatim.
