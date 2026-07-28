import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import {
  createChangedRepository,
  fakeEnvironment,
  findFile,
  mcpExchange,
  parseJsonLines,
  poll,
  run,
  runtime,
  temporaryDirectory,
  usageRecordFiles
} from "./helpers.mjs";

function usageJson(cwd, env, ...arguments_) {
  const result = run(["usage", "--json", ...arguments_], { cwd, env });
  assert.equal(result.status, 0, result.stderr);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.schemaVersion, 2);
  assert.equal(envelope.provider, "kimi");
  assert.equal(envelope.command, "usage");
  assert.ok(Number.isFinite(Date.parse(envelope.generatedAt)));
  return envelope.data;
}


function runAsync(args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test("usage is local-only, non-billable, and available through direct CLI and MCP", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { KIMI_BIN: path.join(temporary, "missing-kimi") });

  const human = run(["usage"], { cwd: repository, env });
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /Local Kimi companion activity/);
  assert.match(human.stdout, /Window: rolling 7d/);
  assert.match(human.stdout, /Scope: current repository/);
  assert.match(human.stdout, /Provider token usage: unavailable/);
  assert.match(human.stdout, /membership quota: unavailable/i);
  assert.match(human.stdout, /Run \/usage inside the native Kimi Code TUI/);
  assert.match(human.stdout, /https:\/\/www\.kimi\.com\/code\/console/);
  assert.match(human.stdout, /A job whose usage record is missing stays readable through status and result without being counted/);

  const direct = usageJson(repository, env, "--local", "--window=all", "--scope=repo");
  assert.equal(direct.aggregates.runs, 0);
  assert.equal(direct.membershipQuota.available, false);
  assert.equal(direct.membershipQuota.nativeTuiCommand, "/usage");
  assert.equal(direct.tokenUsage.available, false);
  assert.match(direct.tokenUsage.reason, /byte counts are not token counts/);

  const result = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "usage", arguments: { rawArguments: "--json --window 24h --scope repo" } } }
    ],
    responseId: 2,
    env,
    cwd: repository
  });
  const response = parseJsonLines(result.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, false);
  const envelope = JSON.parse(response.result.content[0].text);
  assert.deepEqual(response.result.structuredContent, envelope);
  assert.equal(envelope.data.window.name, "24h");
});

test("usage parsing accepts documented forms and rejects unknown or malformed arguments", () => {
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { KIMI_BIN: path.join(temporary, "missing-kimi") });
  for (const window of ["today", "24h", "7d", "30d", "all"]) {
    assert.equal(run(["usage", `--window=${window}`, "--scope=all", "--local", "--json"], { env }).status, 0);
  }
  const invalid = [
    ["--window"],
    ["--window="],
    ["--window", "week"],
    ["--scope"],
    ["--scope="],
    ["--scope", "global"],
    ["--unknown"],
    ["unexpected"],
    ["--json=1"],
    ["--local=1"],
    ["--window", "7d", "--window", "24h"],
    ["--scope=repo", "--scope=all"],
    ["--json", "--json"]
  ];
  for (const args of invalid) {
    const result = run(["usage", ...args], { env });
    assert.notEqual(result.status, 0, `unexpectedly accepted: ${args.join(" ")}`);
  }
});

test("foreground task, review, and failure records are private and aggregate at query time", () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const secretTask = "PRIVATE_TASK_TEXT must never enter the usage ledger";
  const env = fakeEnvironment(temporary);

  const task = run(["run", "task", "--model", "kimi-test", secretTask], { cwd: repository, env });
  assert.equal(task.status, 0, task.stderr);
  const review = run(["run", "review", "focus", "correctness"], { cwd: repository, env });
  assert.equal(review.status, 0, review.stderr);
  const failed = run(["run", "task", "fail", "foreground"], {
    cwd: repository,
    env: fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "fail" })
  });
  assert.equal(failed.status, 3);

  const report = usageJson(repository, env, "--window", "all");
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.source, "local-companion-ledger");
  assert.equal(report.aggregates.runs, 3);
  assert.deepEqual(report.aggregates.execution, { foreground: 3, background: 0 });
  assert.deepEqual(report.aggregates.kinds, { task: 2, review: 1, explore: 0, plan: 0, session: 0 });
  assert.equal(report.aggregates.outcomes.finished, 2);
  assert.equal(report.aggregates.outcomes.failed, 1);
  assert.equal(report.aggregates.providerLaunched, 3);
  assert.ok(report.aggregates.bytes.prompt > 0);
  assert.ok(report.aggregates.bytes.output > 0);
  assert.ok(report.aggregates.bytes.error > 0);

  const files = usageRecordFiles(temporary);
  assert.equal(files.length, 3);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const record = JSON.parse(source);
    assert.deepEqual(Object.keys(record).sort(), [
      "bytes", "execution", "id", "jobId", "kind", "launched", "lifecycle", "outcome", "provider", "requestedModel", "schemaVersion"
    ]);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.jobId, null);
    assert.equal(record.execution, "foreground");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(source.includes(repository), false);
    assert.equal(source.includes(secretTask), false);
    assert.doesNotMatch(source, /workspaceRoot|promptPath|outputPath|errorPath|diagnostic|credential|workerPid|guardPid|"pid"|"token"/i);
  }
});

test("provider preflight failure records failed without claiming a launch or retaining diagnostics", () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const missing = path.join(temporary, "missing-kimi-provider");
  const secretTask = "PREFLIGHT_PRIVATE_TEXT";
  const env = fakeEnvironment(temporary, { KIMI_BIN: missing });
  const failed = run(["run", "task", secretTask], { cwd: repository, env });
  assert.notEqual(failed.status, 0);

  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.runs, 1);
  assert.equal(report.aggregates.outcomes.failed, 1);
  assert.equal(report.aggregates.providerLaunched, 0);
  const file = usageRecordFiles(temporary)[0];
  const source = fs.readFileSync(file, "utf8");
  const record = JSON.parse(source);
  assert.equal(record.launched, false);
  assert.equal(record.outcome, "failed");
  assert.ok(record.bytes.prompt > 0);
  assert.ok(record.bytes.error > 0);
  assert.equal(source.includes(secretTask), false);
  assert.equal(source.includes(missing), false);
  assert.doesNotMatch(source, /Could not start|ENOENT|diagnostic/i);
});

test("background finished, failed, and cancelled runs are tracked and results append metrics", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);

  const started = run(["run", "task", "--background", "background", "success"], { cwd: repository, env });
  const finishedId = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(finishedId);
  await poll(() => /\tfinished\t/.test(run(["status", finishedId], { cwd: repository, env }).stdout));
  const finishedResult = run(["result", finishedId], { cwd: repository, env });
  assert.equal(finishedResult.status, 0, finishedResult.stderr);
  assert.match(finishedResult.stdout, /"prompt":"background success"/);
  assert.match(finishedResult.stdout, /Local run metrics: background task .* finished/);

  const failEnv = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "fail" });
  const failedStarted = run(["run", "review", "--background", "failure", "focus"], { cwd: repository, env: failEnv });
  const failedId = failedStarted.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(failedId);
  await poll(() => /\tfailed\t/.test(run(["status", failedId], { cwd: repository, env: failEnv }).stdout));
  const failedResult = run(["result", failedId], { cwd: repository, env: failEnv });
  assert.equal(failedResult.status, 0);
  assert.match(failedResult.stdout, /Local run metrics: background review .* failed/);

  const recordFile = path.join(temporary, "cancelled-pids.json");
  const waitEnv = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const cancelStarted = run(["run", "task", "--background", "cancel", "me"], { cwd: repository, env: waitEnv });
  const cancelledId = cancelStarted.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(cancelledId);
  await poll(() => fs.existsSync(recordFile));
  const cancelled = run(["cancel", cancelledId], { cwd: repository, env: waitEnv, timeout: 15_000 });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  const cancelledResult = run(["result", cancelledId], { cwd: repository, env: waitEnv });
  assert.equal(cancelledResult.status, 0);
  assert.match(cancelledResult.stdout, /Local run metrics: background task .* cancelled/);

  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.runs, 3);
  assert.deepEqual(report.aggregates.execution, { foreground: 0, background: 3 });
  assert.equal(report.aggregates.outcomes.finished, 1);
  assert.equal(report.aggregates.outcomes.failed, 1);
  assert.equal(report.aggregates.outcomes.cancelled, 1);
  assert.equal(report.aggregates.providerLaunched, 3);
});

test("usage scope and windows aggregate records without exposing repository paths", () => {
  const firstRepository = createChangedRepository();
  const secondRepository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);

  assert.equal(run(["run", "task", "first"], { cwd: firstRepository, env }).status, 0);
  const firstFile = usageRecordFiles(temporary)[0];
  assert.ok(firstFile);
  const old = JSON.parse(fs.readFileSync(firstFile, "utf8"));
  old.lifecycle.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(firstFile, `${JSON.stringify(old, null, 2)}\n`, { mode: 0o600 });
  assert.equal(run(["run", "task", "second"], { cwd: secondRepository, env }).status, 0);

  assert.equal(usageJson(firstRepository, env, "--window=all").aggregates.runs, 1);
  assert.equal(usageJson(firstRepository, env, "--window=30d").aggregates.runs, 0);
  const all = usageJson(firstRepository, env, "--scope=all", "--window", "all");
  assert.equal(all.aggregates.runs, 2);
  assert.equal(usageJson(firstRepository, env, "--scope", "all", "--window=30d").aggregates.runs, 1);
  assert.ok(Date.parse(all.trackingSince) <= Date.parse(old.lifecycle.createdAt));
  const rendered = JSON.stringify(all);
  assert.equal(rendered.includes(firstRepository), false);
  assert.equal(rendered.includes(secondRepository), false);
  assert.doesNotMatch(rendered, /[a-f0-9]{16}\/usage/);
});

test("concurrent foreground runs retain one atomic usage record each", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { KIMI_COMPANION_MAX_CONCURRENCY: "8" });
  const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    runAsync(["run", "task", `concurrent-${index}`], { cwd: repository, env })
  ));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.runs, 6);
  assert.equal(report.aggregates.outcomes.finished, 6);
  assert.equal(new Set(usageRecordFiles(temporary).map((file) => path.basename(file))).size, 6);
});

test("usage reconciles a terminal job when a worker misses its final ledger write", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const started = run(["run", "task", "--background", "reconcile", "terminal"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const recordPath = usageRecordFiles(temporary).find((file) => JSON.parse(fs.readFileSync(file, "utf8")).jobId === id);
  assert.ok(recordPath);
  await poll(() => JSON.parse(fs.readFileSync(recordPath, "utf8")).outcome === "finished");
  const stale = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  stale.outcome = null;
  stale.lifecycle.finishedAt = null;
  stale.lifecycle.durationMs = null;
  stale.bytes.output = 0;
  fs.writeFileSync(recordPath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });

  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.runs, 1);
  assert.equal(report.aggregates.outcomes.finished, 1);
  const reconciled = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  const job = JSON.parse(fs.readFileSync(findFile(path.join(temporary, "state"), `${id}.json`), "utf8"));
  assert.equal(reconciled.outcome, "finished");
  assert.equal(reconciled.lifecycle.finishedAt, job.finishedAt);
  assert.ok(reconciled.bytes.output > 0);
});

test("cleanup-first finalizes a linked null usage record before deleting its terminal job", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const started = run(["run", "task", "--background", "cleanup", "first"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const metadataPath = findFile(path.join(temporary, "state"), `${id}.json`);
  const job = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const recordPath = usageRecordFiles(temporary).find((file) => JSON.parse(fs.readFileSync(file, "utf8")).jobId === id);
  assert.ok(recordPath);
  // A terminal job is persisted just before its worker finalizes usage. Wait
  // for that legitimate final write before simulating the missed-write state,
  // otherwise the worker can race the fixture and make cleanup see a normal
  // terminal record instead of the intended null outcome.
  await poll(() => JSON.parse(fs.readFileSync(recordPath, "utf8")).outcome === "finished");
  const stale = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  stale.outcome = null;
  stale.lifecycle.finishedAt = null;
  stale.lifecycle.durationMs = null;
  stale.bytes.output = 0;
  fs.writeFileSync(recordPath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
  const first = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env });
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  const firstSummary = JSON.parse(first.stdout).data;
  assert.equal(firstSummary.jobs.removed, 1);
  assert.equal(firstSummary.usageRecords.eligible, 0);
  assert.equal(firstSummary.usageRecords.removed, 0);
  assert.equal(fs.existsSync(metadataPath), false);
  assert.equal(fs.existsSync(path.dirname(job.outputPath)), false);
  assert.equal(fs.existsSync(recordPath), true);

  const finalized = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  assert.equal(finalized.outcome, "finished");
  assert.equal(finalized.lifecycle.finishedAt, job.finishedAt);
  assert.ok(finalized.bytes.output > 0);
  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.outcomes.active, 0);
  assert.equal(report.aggregates.outcomes.finished, 1);

  const second = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env });
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  const secondSummary = JSON.parse(second.stdout).data;
  assert.equal(secondSummary.jobs.removed, 0);
  assert.equal(secondSummary.usageRecords.eligible, 1);
  assert.equal(secondSummary.usageRecords.removed, 1);
  assert.equal(fs.existsSync(recordPath), false);
});

test("a job without a usage record stays readable and is honestly excluded from local tracking", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const started = run(["run", "task", "--background", "legacy", "compatible"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));

  const metadataPath = findFile(path.join(temporary, "state"), `${id}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  const recordPath = usageRecordFiles(temporary).find((file) => JSON.parse(fs.readFileSync(file, "utf8")).jobId === id);
  assert.ok(recordPath);
  delete metadata.usageRecordId;
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  fs.unlinkSync(recordPath);

  const result = run(["result", id], { cwd: repository, env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"prompt":"legacy compatible"/);
  assert.doesNotMatch(result.stdout, /Local run metrics:/);
  const report = usageJson(repository, env, "--window=all");
  assert.equal(report.aggregates.runs, 0);
  assert.equal(report.trackingSince, null);
  assert.equal(report.coverage.legacyBackgroundIncluded, false);
  assert.match(report.coverage.note, /stays readable through status and result without being counted/);
});
