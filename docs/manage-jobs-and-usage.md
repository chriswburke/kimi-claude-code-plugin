---
meta:
  title: Manage Kimi background jobs and usage
  navLabel: Jobs and Usage
  category: Guides
  contentType: How-to
contentPlan: ./content-plan.md#manage-jobs-and-usage
---

# Manage Kimi background jobs and usage

Kimi background jobs are scoped to the current Git repository. Its local usage ledger is private and excludes prompts, responses, diagnostics, repository paths, credentials, process identifiers, and worker tokens.

## Start and inspect a job

```text
/kimi:ask --background --label parser --timeout 20m Fix the parser
/kimi:status --active
/kimi:status --all
/kimi:result job_id --wait --timeout 30s
```

`status` shows ten recent jobs by default. `--all` removes that default limit; `--limit` sets an explicit cap. A result wait timeout leaves the job running because it is distinct from the execution timeout set when the job started.

## Cancel a job

```text
/kimi:cancel job_id
```

You may omit the identifier only when exactly one job is active. Cancellation waits for the managed provider-process group cleanup before it reports success. Do not delete job or guard files by hand.

## Inspect local usage

```text
/kimi:usage
/kimi:usage --window 30d --scope all --group-by model --json
```

The report is local operational activity, not token accounting or membership quota. Kimi Code does not expose supported noninteractive quota data, so the companion does not read credential files, call undocumented endpoints, scrape the terminal, open a browser, or launch a dummy prompt.

## Clean retained state

```text
/kimi:cleanup --older-than 30d
/kimi:cleanup --older-than 30d --confirm
```

Cleanup is a dry run by default. Confirmation can remove eligible terminal job artifacts and aged usage records, never active jobs. `--scope all` covers Kimi workspaces only. Kimi’s native session store is outside plugin cleanup.

## Recover interrupted work

Run `/kimi:usage`, `/kimi:status`, `/kimi:setup`, or confirmed cleanup after an abrupt owner exit. The companion validates private recovery data, records an interrupted run when appropriate, and removes only authenticated artifacts. If it reports an unsafe state error, preserve the state root and correct the named ownership, symlink, or permission problem before retrying.

After the two-repository migration, `CLAUDE_PLUGIN_DATA` can designate a new Kimi-specific state root. The companion does not combine it with old combined-installation data. Keep the older private directory until you have completed any required inspection.
