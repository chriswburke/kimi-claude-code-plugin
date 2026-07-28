---
meta:
  title: Run Kimi Code Companion commands
  navLabel: Kimi Commands
  category: Reference
  contentType: Reference
---

# Run Kimi Code Companion commands

Use this reference to select a Kimi slash command and understand its execution boundary.

## Common controls

Run commands accept `--background`, `--model model_name` or `--profile profile_name`, `--label label`, and `--timeout duration` where their syntax shows them. `--model` and `--profile` are mutually exclusive. Put options before free-form text; use `--` when text starts with a flag.

Kimi accepts positive durations with `ms`, `s`, `m`, `h`, or `d`, including `250ms`. A unitless Kimi duration means seconds.

| Profile | Model |
| --- | --- |
| `fast` | `kimi-for-coding-highspeed` |
| `stable` | `kimi-for-coding` |
| `deep` | `k3-256k` |
| `large-context` | `k3` |

## Commands

```text
/kimi:ask [run flags] task
/kimi:explore [run flags] question
/kimi:plan [run flags] objective
/kimi:review [run flags] [--base ref] [--preset preset] [focus]
/kimi:models [--json]
/kimi:config [--json]
/kimi:setup [--json]
/kimi:status job_id [--json]
/kimi:status [--active | --all] [--limit count] [--json]
/kimi:result [job_id] [--wait] [--timeout duration] [--json]
/kimi:cancel [job_id] [--json]
/kimi:usage [--local] [--window today|24h|7d|30d|all]
            [--scope repo|all] [--group-by day|model|kind|outcome] [--json]
/kimi:cleanup --older-than duration [--scope repo|all]
              [--dry-run | --confirm] [--json]
/kimi:session --experimental list [--json]
/kimi:session --experimental start [--model model_name | --profile profile_name]
              [--json] prompt
/kimi:session --experimental continue session_id [--json] prompt
/kimi:session --experimental fork session_id [--json]
```

| Command | Boundary |
| --- | --- |
| `/kimi:ask` | Autonomous coding in the trusted checkout; may modify files |
| `/kimi:explore`, `/kimi:plan` | Request-local agent with only `Read`, `Grep`, and `Glob` |
| `/kimi:review` | Precomputed Git context with empty tool and skill allowlists |
| `/kimi:models`, `/kimi:config`, `/kimi:setup` | Local diagnostics without model inference; sensitive configuration is redacted |
| `/kimi:status`, `/kimi:result`, `/kimi:cancel` | Repository-scoped managed-job operations |
| `/kimi:usage`, `/kimi:cleanup` | Private local ledger and retained-artifact operations |
| `/kimi:session` | Experimental Agent Client Protocol (ACP) bridge; every action requires `--experimental` |

`/kimi:result --wait` bounds observation, not the provider execution deadline. `/kimi:cleanup` previews by default, and `--confirm` removes eligible terminal artifacts or aged usage records. The native Kimi session store is outside plugin cleanup.

All JSON-capable commands return the version-2 envelope. A retrieved terminal job is a successful result operation even when its provider outcome was failed, cancelled, timed out, or output-limited. See [structured output](./structured-output-v2.md) and the [package reference](../plugins/kimi/README.md) for complete limits.
