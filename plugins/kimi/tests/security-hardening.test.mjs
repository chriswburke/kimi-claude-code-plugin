import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { atomicCreateJson } from "../scripts/companion.mjs";
import {
  createChangedRepository,
  fakeEnvironment,
  findFile,
  isAlive,
  mcpExchange,
  parseJsonLines,
  pluginRoot,
  poll,
  run,
  runtime,
  temporaryDirectory
} from "./helpers.mjs";

function jobId(result) {
  const id = result.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id, `${result.stdout}\n${result.stderr}`);
  return id;
}

function collectProcess(child) {
  return new Promise((resolve, reject) => {
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

test("atomic create publishes without clobbering and cleans failed temporaries", () => {
  const temporary = temporaryDirectory();
  const directory = path.join(temporary, "private-state");
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, "record.json");
  atomicCreateJson(file, { revision: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { revision: 1 });
  assert.throws(() => atomicCreateJson(file, { revision: 2 }), (error) => error?.code === "EEXIST");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { revision: 1 });
  assert.deepEqual(fs.readdirSync(directory), ["record.json"]);
});

test("probe teardown kills descendants after the probe leader exits", { skip: process.platform === "win32", timeout: 12_000 }, async () => {
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "probe-tree.json");
  const result = run(["setup"], {
    env: fakeEnvironment(temporary, { FAKE_PROBE_LEAVE_CHILD: "1", FAKE_RECORD_FILE: recordFile }),
    timeout: 10_000
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /timed out|termination/i);
  const pids = JSON.parse(fs.readFileSync(recordFile, "utf8"));
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid));
});

test("captured managed process groups use a persistent authenticated stdio sentinel", () => {
  const source = fs.readFileSync(runtime, "utf8");
  assert.match(source, /_stdio_guard/);
  assert.match(source, /persistent guard is the stable taskkill \/T anchor/);
  assert.match(source, /child\.__treeAnchor = true/);
  assert.match(source, /\["\/PID", String\(id\), "\/T", "\/F"\]/);
  assert.match(source, /TREE_TERMINATIONS = new WeakMap/);
});

test("ACP bounds a raw frame before JSON parsing", () => {
  const temporary = temporaryDirectory();
  const result = run(["session", "--experimental", "list", "--json"], {
    env: fakeEnvironment(temporary, {
      FAKE_ACP_RAW_FRAME_BYTES: "2048",
      KIMI_COMPANION_MAX_OUTPUT_BYTES: "1024"
    }),
    timeout: 8_000
  });
  assert.equal(result.status, 1, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.code, "OUTPUT_LIMIT");
  assert.match(document.error.message, /protocol frame/i);
});

test("ACP writes honor backpressure and turn a closed stdin into a bounded error", async () => {
  const temporary = temporaryDirectory();
  const prompt = "p".repeat(512 * 1024);
  const exchange = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "session", arguments: { rawArguments: `--experimental start --json ${prompt}` } } }
    ],
    responseId: 2,
    env: fakeEnvironment(temporary),
    timeout: 15_000
  });
  const response = parseJsonLines(exchange.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.data.output, "fake session response");

  const closed = run(["session", "--experimental", "start", "--json", "close safely"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_ACP_MODE: "close" }),
    timeout: 8_000
  });
  assert.notEqual(closed.status, 0);
  const closedDocument = JSON.parse(closed.stdout);
  assert.equal(closedDocument.error.code, "ACP_CLOSED");
});

test("pre-handoff cancellation leaves no job, prompt, control, or slot allocation", async () => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  const env = fakeEnvironment(temporary);
  const exchange = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "--background never launch" } } },
      { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } }
    ],
    responseId: 2,
    env,
    cwd: repository
  });
  const response = parseJsonLines(exchange.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, true);
  const state = path.join(temporary, "state");
  const files = fs.existsSync(state) ? collectFiles(state) : [];
  assert.equal(files.some((file) => /\/jobs\/kimi-.*(?:\.json|\.cancel|\.start|request\.prompt)$/.test(file)), false);
  assert.equal(files.some((file) => /\/slots\/slot-.*\.json$/.test(file)), false);
});

test("managed state rejects unsafe components, preserves its parent mode, and dry-run is non-mutating", { skip: process.platform === "win32" }, () => {
  const temporary = temporaryDirectory();
  const state = path.join(temporary, "configured-state");
  fs.mkdirSync(state, { mode: 0o755 });
  fs.chmodSync(state, 0o755);
  const env = fakeEnvironment(temporary, { MODEL_COMPANION_STATE_DIR: state });
  const usage = run(["usage", "--json", "--window=all"], { env });
  assert.equal(usage.status, 0, usage.stderr);
  assert.equal(fs.statSync(state).mode & 0o777, 0o755);

  const seed = run(["run", "task", "create managed state"], { env });
  assert.equal(seed.status, 0, seed.stderr);

  const managedRoot = path.join(state, "model-companions");
  fs.chmodSync(managedRoot, 0o777);
  const tightened = run(["run", "task", "tighten managed state"], { env });
  assert.equal(tightened.status, 0, tightened.stderr);
  assert.equal(fs.statSync(managedRoot).mode & 0o777, 0o700);

  fs.chmodSync(managedRoot, 0o777);
  const unsafeDryRun = run(["cleanup", "--older-than", "1d", "--dry-run", "--json"], { env });
  assert.equal(unsafeDryRun.status, 1);
  assert.equal(JSON.parse(unsafeDryRun.stdout).error.code, "STATE_PATH_UNSAFE");
  assert.equal(fs.statSync(managedRoot).mode & 0o777, 0o777);
  fs.chmodSync(managedRoot, 0o700);

  const untouched = path.join(temporary, "dry-state");
  const dryEnv = fakeEnvironment(temporary, { MODEL_COMPANION_STATE_DIR: untouched });
  const dry = run(["cleanup", "--older-than", "1d", "--dry-run", "--json"], { env: dryEnv });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(untouched), false);

  const unsafe = path.join(temporary, "unsafe-state");
  const outside = path.join(temporary, "outside");
  fs.mkdirSync(unsafe);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(unsafe, "model-companions"), "dir");
  const rejected = run(["usage", "--json", "--window=all"], {
    env: fakeEnvironment(temporary, { MODEL_COMPANION_STATE_DIR: unsafe })
  });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, "STATE_PATH_UNSAFE");
  assert.deepEqual(fs.readdirSync(outside), []);

  const ancestorTarget = path.join(temporary, "ancestor-target");
  const ancestorLink = path.join(temporary, "ancestor-link");
  fs.mkdirSync(ancestorTarget);
  fs.symlinkSync(ancestorTarget, ancestorLink, "dir");
  const ancestorRejected = run(["usage", "--json", "--window=all"], {
    env: fakeEnvironment(temporary, { MODEL_COMPANION_STATE_DIR: path.join(ancestorLink, "configured") })
  });
  assert.equal(ancestorRejected.status, 1);
  assert.equal(JSON.parse(ancestorRejected.stdout).error.code, "STATE_PATH_UNSAFE");
  assert.deepEqual(fs.readdirSync(ancestorTarget), []);
});

test("JSON result retrieval is successful data for failed jobs and cleanup failures are errors in both modes", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "fail" });
  const id = jobId(run(["run", "task", "--background", "fail"], { cwd: repository, env }));
  await poll(() => /\tfailed\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const result = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(result.status, 0, result.stderr);
  const resultDocument = JSON.parse(result.stdout);
  assert.equal(resultDocument.data.job.status, "failed");
  assert.equal(Object.hasOwn(resultDocument, "error"), false);

  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const startPath = path.join(path.dirname(metadata), `${id}.start`);
  fs.mkdirSync(startPath);
  fs.writeFileSync(path.join(startPath, "retained"), "x");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const human = run(["cleanup", "--older-than", "1ms", "--confirm"], { cwd: repository, env });
  assert.equal(human.status, 1);
  assert.match(human.stderr, /could not remove/i);
  const json = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env });
  assert.equal(json.status, 1);
  const cleanupDocument = JSON.parse(json.stdout);
  assert.equal(cleanupDocument.error.code, "CLEANUP_FAILED");
  assert.equal(Object.hasOwn(cleanupDocument, "data"), false);
});

test("cleanup rechecks live metadata and refuses unknown artifact entries", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const liveEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait" });
  const liveId = jobId(run(["run", "task", "--background", "remain live"], { cwd: repository, env: liveEnvironment }));
  const liveMetadata = await poll(() => {
    const file = findFile(path.join(temporary, "state"), `${liveId}.json`);
    if (!file) return undefined;
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    return job.status === "running" && job.workerPid && job.guardPid ? { file, job } : undefined;
  });
  const tamperedTerminal = {
    ...liveMetadata.job,
    status: "finished",
    finishedAt: new Date().toISOString(),
    exitCode: 0
  };
  fs.writeFileSync(liveMetadata.file, `${JSON.stringify(tamperedTerminal)}\n`, { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const liveCleanup = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env: liveEnvironment });
  assert.equal(liveCleanup.status, 0, liveCleanup.stderr);
  assert.equal(fs.existsSync(liveMetadata.file), true);
  fs.writeFileSync(liveMetadata.file, `${JSON.stringify(liveMetadata.job)}\n`, { mode: 0o600 });
  const cancelled = run(["cancel", liveId, "--json"], { cwd: repository, env: liveEnvironment, timeout: 20_000 });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  const retainedTemporary = temporaryDirectory();
  const retainedEnvironment = fakeEnvironment(retainedTemporary);
  const retainedId = jobId(run(["run", "task", "--background", "finish first"], { cwd: repository, env: retainedEnvironment }));
  await poll(() => /\tfinished\t/.test(run(["status", retainedId], { cwd: repository, env: retainedEnvironment }).stdout));
  const retainedMetadata = findFile(path.join(retainedTemporary, "state"), `${retainedId}.json`);
  const unknown = path.join(path.dirname(retainedMetadata), `${retainedId}.d`, "unknown-entry");
  fs.writeFileSync(unknown, "retain", { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const rejected = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env: retainedEnvironment });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, "CLEANUP_FAILED");
  assert.equal(fs.existsSync(retainedMetadata), true);
  assert.equal(fs.readFileSync(unknown, "utf8"), "retain");
});

test("two-process cleanup and result retrieval cannot create orphan usage or partial snapshots", { timeout: 20_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const id = jobId(run(["run", "task", "--background", "race snapshot"], { cwd: repository, env }));
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const job = JSON.parse(fs.readFileSync(metadata, "utf8"));
  const artifactDirectory = path.dirname(job.outputPath);
  const workspaceState = path.dirname(path.dirname(metadata));
  const usagePath = path.join(workspaceState, "usage", `${job.usageRecordId}.json`);
  const jobLock = metadata.replace(/\.json$/, ".lock");
  await poll(() => !fs.existsSync(jobLock));
  const jobLockToken = "0123456789abcdef0123456789abcdef";
  fs.mkdirSync(jobLock, { mode: 0o700 });
  fs.writeFileSync(path.join(jobLock, "owner.json"), `${JSON.stringify({
    schemaVersion: 1,
    pid: process.pid,
    token: jobLockToken,
    acquiredAt: new Date().toISOString(),
    birthIdentity: null
  })}\n`, { mode: 0o600 });
  await new Promise((resolve) => setTimeout(resolve, 15));

  let resultPromise;
  let cleanupPromise;
  try {
    resultPromise = collectProcess(spawn(process.execPath, [runtime, "result", id, "--json"], {
      cwd: repository,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }));
    cleanupPromise = collectProcess(spawn(process.execPath, [runtime, "cleanup", "--older-than", "1ms", "--confirm", "--json"], {
      cwd: repository,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    }));
    await new Promise((resolve) => setTimeout(resolve, 250));
  } finally {
    const retired = `${jobLock}.retired-${jobLockToken}`;
    try { fs.renameSync(jobLock, retired); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { fs.unlinkSync(path.join(retired, "owner.json")); } catch (error) { if (error?.code !== "ENOENT") throw error; }
    try { fs.rmdirSync(retired); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }

  const [result, cleanup] = await Promise.all([resultPromise, cleanupPromise]);
  assert.equal(cleanup.status, 0, `${cleanup.stdout}\n${cleanup.stderr}`);
  const cleanupDocument = JSON.parse(cleanup.stdout);
  let removedJobs = cleanupDocument.data.jobs.removed;
  let removedUsage = cleanupDocument.data.usageRecords.removed;
  if (removedJobs < 1 || removedUsage < 1) {
    const retry = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env });
    assert.equal(retry.status, 0, `${retry.stdout}\n${retry.stderr}`);
    const retried = JSON.parse(retry.stdout);
    removedJobs += retried.data.jobs.removed;
    removedUsage += retried.data.usageRecords.removed;
  }
  assert.equal(removedJobs, 1);
  assert.equal(removedUsage, 1);
  assert.ok(result.status === 0 || result.status === 1, `${result.stdout}\n${result.stderr}`);
  const resultDocument = JSON.parse(result.stdout);
  if (result.status === 0) {
    assert.equal(resultDocument.data.job.status, "finished");
    assert.match(resultDocument.data.output, /race snapshot/);
  } else {
    assert.equal(resultDocument.error.code, "JOB_NOT_FOUND");
  }
  assert.equal(fs.existsSync(metadata), false);
  assert.equal(fs.existsSync(artifactDirectory), false);
  assert.equal(fs.existsSync(usagePath), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(usagePath), false);
});

test("tampered stale guard PIDs are never signalled by recovery", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait" });
  const id = jobId(run(["run", "task", "--background", "guard identity"], { cwd: repository, env }));
  const observed = await poll(() => {
    const file = findFile(path.join(temporary, "state"), `${id}.json`);
    if (!file) return undefined;
    const job = JSON.parse(fs.readFileSync(file, "utf8"));
    const lease = path.join(path.dirname(file), `${id}.guard`);
    return job.status === "running" && job.workerPid && job.guardPid && fs.existsSync(lease) ? { file, job } : undefined;
  });
  const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore"
  });
  await new Promise((resolve, reject) => {
    sentinel.once("spawn", resolve);
    sentinel.once("error", reject);
  });
  sentinel.unref();
  try {
    process.kill(observed.job.workerPid, "SIGKILL");
    await poll(() => !isAlive(observed.job.workerPid) && !isAlive(observed.job.guardPid));
    const tampered = { ...observed.job, guardPid: sentinel.pid, heartbeatAt: new Date().toISOString() };
    fs.writeFileSync(observed.file, `${JSON.stringify(tampered)}\n`, { mode: 0o600 });
    const cancellation = run(["cancel", id, "--json"], { cwd: repository, env, timeout: 10_000 });
    assert.equal(cancellation.status, 1);
    assert.equal(JSON.parse(cancellation.stdout).error.code, "GUARD_IDENTITY_UNVERIFIED");
    assert.equal(isAlive(sentinel.pid), true);
  } finally {
    try { process.kill(-sentinel.pid, "SIGKILL"); } catch { /* Test sentinel already exited. */ }
    fs.writeFileSync(observed.file, `${JSON.stringify(observed.job)}\n`, { mode: 0o600 });
    run(["status", id, "--json"], { cwd: repository, env });
  }
});

test("foreground success is withheld until strict cleanup and failed accounting complete", { timeout: 15_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_HOLD_MS: "1200" });
  const child = spawn(process.execPath, [runtime, "run", "task", "strict cleanup"], {
    cwd: repository,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const prompt = await poll(() => {
    const state = path.join(temporary, "state");
    if (!fs.existsSync(state)) return undefined;
    return collectFiles(state).find((file) => file.endsWith("request.prompt") && file.includes("foreground-"));
  });
  const unknown = path.join(path.dirname(prompt), "unexpected-retained-entry");
  fs.writeFileSync(unknown, "retain", { mode: 0o600 });
  const status = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(status, 1, `${stdout}\n${stderr}`);
  assert.match(stderr, /foreground state cleanup failed/i);
  assert.equal(fs.existsSync(prompt), false);
  assert.equal(fs.readFileSync(unknown, "utf8"), "retain");
  const stateFiles = collectFiles(path.join(temporary, "state"));
  assert.equal(stateFiles.some((file) => /\/slots\/slot-.*\.json$/.test(file)), false);
  const usage = stateFiles.find((file) => /\/usage\/.*\.json$/.test(file));
  assert.equal(JSON.parse(fs.readFileSync(usage, "utf8")).outcome, "failed");
});

test("fast background writers cannot persist more than the configured combined cap", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, {
    FAKE_PROVIDER_STDOUT_BYTES: String(8 * 1024 * 1024),
    KIMI_COMPANION_MAX_OUTPUT_BYTES: "1024"
  });
  const id = jobId(run(["run", "task", "--background", "write fast"], { cwd: repository, env }));
  await poll(() => /\toutput_limit\t/.test(run(["status", id], { cwd: repository, env }).stdout), 15_000);
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const artifacts = path.join(path.dirname(metadata), `${id}.d`);
  const total = ["stdout.txt", "stderr.txt"].reduce((sum, name) => {
    const file = path.join(artifacts, name);
    return sum + (fs.existsSync(file) ? fs.statSync(file).size : 0);
  }, 0);
  assert.ok(total <= 1024, `persisted ${total} bytes above the 1024-byte cap`);
});

test("background read-only preflight failures remain bounded, private, readable, accounted, and cleanable", { timeout: 25_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const maximumBytes = 2048;
  const env = fakeEnvironment(temporary, {
    FAKE_VERSION_STDERR_BYTES: String(64 * 1024),
    FAKE_VERSION_STDERR_PREFIX: `${repository}\u001b[31m\u0000`,
    FAKE_VERSION_STDERR_CHARACTER: "v",
    FAKE_VERSION_EXIT: "2",
    KIMI_COMPANION_MAX_OUTPUT_BYTES: String(maximumBytes)
  });
  const started = run(["run", "explore", "--background", "inspect the repository"], { cwd: repository, env });
  assert.equal(started.status, 0, `${started.stdout}\n${started.stderr}`);
  const id = jobId(started);
  await poll(() => /\tfailed\t/.test(run(["status", id], { cwd: repository, env }).stdout), 15_000);

  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const job = JSON.parse(fs.readFileSync(metadata, "utf8"));
  assert.equal(job.status, "failed");
  assert.ok(job.error.length > 0 && job.error.length <= 4096);
  assert.equal(job.error.includes(repository), false);
  assert.doesNotMatch(job.error, /[\u0000\u001b]/);
  const artifactText = [job.outputPath, job.errorPath]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("");
  const artifactBytes = [job.outputPath, job.errorPath]
    .reduce((sum, file) => sum + (fs.existsSync(file) ? fs.statSync(file).size : 0), 0);
  assert.ok(artifactBytes <= maximumBytes, `retained ${artifactBytes} bytes above the ${maximumBytes}-byte cap`);
  assert.equal(artifactText.includes(repository), false);
  assert.doesNotMatch(artifactText, /[\u0000\u001b]/);

  const result = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.job.status, "failed");
  const usagePath = path.join(path.dirname(path.dirname(metadata)), "usage", `${job.usageRecordId}.json`);
  const usageRecord = JSON.parse(fs.readFileSync(usagePath, "utf8"));
  assert.equal(usageRecord.outcome, "failed");
  const usage = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(usage.status, 0, usage.stderr);
  assert.equal(JSON.parse(usage.stdout).data.aggregates.outcomes.failed, 1);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const cleanup = run(["cleanup", "--older-than", "1ms", "--confirm", "--json"], { cwd: repository, env });
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const removed = JSON.parse(cleanup.stdout).data;
  assert.equal(removed.jobs.removed, 1);
  assert.equal(removed.usageRecords.removed, 1);
  assert.equal(fs.existsSync(metadata), false);
  assert.equal(fs.existsSync(path.dirname(job.outputPath)), false);
  assert.equal(fs.existsSync(usagePath), false);
  assert.equal(run(["status", id], { cwd: repository, env }).status, 1);
});

test("a nonzero provider exit at the exact output cap cannot append past the combined cap", { timeout: 20_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const maximumBytes = 1024;
  const env = fakeEnvironment(temporary, {
    FAKE_PROVIDER_EXACT_STDOUT_BYTES: String(maximumBytes),
    FAKE_PROVIDER_EXACT_EXIT: "3",
    KIMI_COMPANION_MAX_OUTPUT_BYTES: String(maximumBytes)
  });
  const id = jobId(run(["run", "task", "--background", "fill the cap"], { cwd: repository, env }));
  await poll(() => /\tfailed\t/.test(run(["status", id], { cwd: repository, env }).stdout), 15_000);
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const job = JSON.parse(fs.readFileSync(metadata, "utf8"));
  assert.equal(job.status, "failed");
  assert.ok(job.error.length > 0 && job.error.length <= 4096);
  assert.equal(fs.statSync(job.outputPath).size, maximumBytes);
  assert.equal(fs.statSync(job.errorPath).size, 0);
  assert.equal(fs.statSync(job.outputPath).size + fs.statSync(job.errorPath).size, maximumBytes);

  const result = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).data.job.status, "failed");
  const exchange = await mcpExchange({
    messages: [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "result", arguments: { rawArguments: `${id} --json` } } }],
    responseId: 2,
    env,
    cwd: repository
  });
  const response = parseJsonLines(exchange.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, false);
  assert.equal(response.result.structuredContent.data.job.status, "failed");
  const usagePath = path.join(path.dirname(path.dirname(metadata)), "usage", `${job.usageRecordId}.json`);
  const usageRecord = JSON.parse(fs.readFileSync(usagePath, "utf8"));
  assert.equal(usageRecord.outcome, "failed");
  assert.equal(usageRecord.bytes.output, maximumBytes);
});

test("result retrieval safely previews artifacts larger than the MCP transport cap", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const retainedBytes = 140 * 1024 * 1024;
  const env = fakeEnvironment(temporary, { KIMI_COMPANION_MAX_OUTPUT_BYTES: String(200 * 1024 * 1024) });
  const id = jobId(run(["run", "task", "--background", "large retained result"], { cwd: repository, env }));
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const output = path.join(path.dirname(metadata), `${id}.d`, "stdout.txt");
  const pathologicalPrefix = Buffer.concat([
    Buffer.alloc(1024 * 1024 - 1, 0),
    Buffer.from("😀", "utf8")
  ]);
  fs.writeFileSync(output, pathologicalPrefix, { mode: 0o600 });
  fs.truncateSync(output, retainedBytes);

  const exchange = await mcpExchange({
    messages: [{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "result", arguments: { rawArguments: `${id} --json` } } }],
    responseId: 2,
    env,
    cwd: repository,
    timeout: 20_000
  });
  const response = parseJsonLines(exchange.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, false);
  const data = response.result.structuredContent.data;
  assert.equal(data.artifacts.truncated, true);
  assert.equal(data.artifacts.output.totalBytes, retainedBytes);
  assert.equal(data.artifacts.output.returnedBytes, 1024 * 1024 - 1);
  assert.equal(Buffer.byteLength(data.output), 1024 * 1024 - 1);
  assert.equal(data.output.endsWith("�"), false);
  assert.match(exchange.stdout, /\\u0000/);
  assert.ok(Buffer.byteLength(exchange.stdout) < 128 * 1024 * 1024);
});

test("background results retain their creation-time output limit after configuration changes", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const originalLimit = 8 * 1024;
  const creationEnvironment = fakeEnvironment(temporary, {
    FAKE_PROVIDER_EXACT_STDOUT_BYTES: String(4 * 1024),
    KIMI_COMPANION_MAX_OUTPUT_BYTES: String(originalLimit)
  });
  const id = jobId(run(["run", "task", "--background", "persist the output cap"], { cwd: repository, env: creationEnvironment }));
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env: creationEnvironment }).stdout));
  const metadataPath = findFile(path.join(temporary, "state"), `${id}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.equal(metadata.outputLimitBytes, originalLimit);

  const lowerLimitEnvironment = fakeEnvironment(temporary, { KIMI_COMPANION_MAX_OUTPUT_BYTES: "1024" });
  const result = run(["result", id, "--json"], { cwd: repository, env: lowerLimitEnvironment });
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(result.stdout).data;
  assert.equal(data.job.outputLimitBytes, originalLimit);
  assert.equal(data.artifacts.output.totalBytes, 4 * 1024);
  assert.equal(Buffer.byteLength(data.output, "utf8"), 4 * 1024);
});

test("day grouping uses the same local-calendar semantics as today", () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { TZ: "America/Los_Angeles" });
  const task = run(["run", "task", "seed"], { cwd: repository, env });
  assert.equal(task.status, 0, task.stderr);
  const usageFile = collectFiles(path.join(temporary, "state")).find((file) => /\/usage\/.*\.json$/.test(file));
  const record = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  record.lifecycle.createdAt = "2026-01-01T01:00:00.000Z";
  record.lifecycle.finishedAt = "2026-01-01T01:00:01.000Z";
  fs.writeFileSync(usageFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  const report = run(["usage", "--json", "--window=all", "--group-by=day"], { cwd: repository, env });
  assert.equal(report.status, 0, report.stderr);
  assert.equal(JSON.parse(report.stdout).data.grouping.groups[0].key, "2025-12-31");
});

test("setup requires --add-dir and ACP fork rejects an explicitly false capability", () => {
  const missingAddDir = run(["setup", "--json"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_KIMI_ADD_DIR: "0" })
  });
  assert.equal(missingAddDir.status, 1);
  assert.match(JSON.parse(missingAddDir.stdout).error.message, /--add-dir/);

  const falseFork = run(["session", "--experimental", "fork", "session-listed", "--json"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_ACP_FORK_CAPABILITY: "false" })
  });
  assert.equal(falseFork.status, 1);
  assert.equal(JSON.parse(falseFork.stdout).error.code, "ACP_FORK_UNSUPPORTED");
});

test("provider lookup is trusted, setup redacts doctor output, and public control text is normalized", { skip: process.platform === "win32" }, async () => {
  const trusted = run(["setup", "--json"], { env: fakeEnvironment(temporaryDirectory()) });
  assert.equal(trusted.status, 0, trusted.stderr);

  const repository = createChangedRepository();
  const workspaceBin = path.join(repository, "bin");
  fs.mkdirSync(workspaceBin);
  const malicious = path.join(workspaceBin, "kimi");
  fs.writeFileSync(malicious, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const ambientBin = temporaryDirectory();
  fs.symlinkSync(malicious, path.join(ambientBin, "kimi"));
  const pathEnvironment = fakeEnvironment(temporaryDirectory());
  delete pathEnvironment.KIMI_BIN;
  pathEnvironment.PATH = `${ambientBin}${path.delimiter}${pathEnvironment.PATH}`;
  const rejected = run(["setup", "--json"], { cwd: repository, env: pathEnvironment });
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).error.code, "UNTRUSTED_PROVIDER_EXECUTABLE");
  assert.match(JSON.parse(rejected.stdout).error.message, /inside the current workspace/i);

  const maliciousGit = path.join(workspaceBin, "git");
  fs.writeFileSync(maliciousGit, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.symlinkSync(maliciousGit, path.join(ambientBin, "git"));
  const gitEnvironment = fakeEnvironment(temporaryDirectory());
  gitEnvironment.PATH = `${ambientBin}${path.delimiter}${gitEnvironment.PATH}`;
  const rejectedGit = run(["run", "task", "do not trust workspace git"], { cwd: repository, env: gitEnvironment });
  assert.equal(rejectedGit.status, 1);
  assert.match(rejectedGit.stderr, /ambient Git executable.*current workspace/i);

  const relativeExplicit = fakeEnvironment(temporaryDirectory(), { KIMI_BIN: "./kimi" });
  const rejectedExplicit = run(["setup", "--json"], { cwd: repository, env: relativeExplicit });
  assert.equal(rejectedExplicit.status, 1);
  assert.equal(JSON.parse(rejectedExplicit.stdout).error.code, "UNTRUSTED_PROVIDER_EXECUTABLE");

  const optedIn = path.join(workspaceBin, "kimi-opted-in");
  const quotedNode = `'${process.execPath.replaceAll("'", `'"'"'`)}'`;
  fs.writeFileSync(optedIn, `#!/bin/sh\nexec ${quotedNode} "$@"\n`, { mode: 0o700 });
  const explicitWorkspaceEnvironment = fakeEnvironment(temporaryDirectory(), { KIMI_BIN: optedIn });
  const explicitWorkspace = run(["setup", "--json"], { cwd: repository, env: explicitWorkspaceEnvironment });
  assert.equal(explicitWorkspace.status, 0, `${explicitWorkspace.stdout}\n${explicitWorkspace.stderr}`);

  const source = fs.readFileSync(runtime, "utf8");
  assert.match(source, /explicit && !path\.win32\.isAbsolute\(command\)/);
  assert.match(source, /rejectAmbientWorkspaceExecutable\(resolved, cwd, label, path\.win32\)/);
  assert.match(source, /resolveWindowsProvider\("git", cwd, env, \{ explicit: false, label: "Git" \}\)/);
  assert.doesNotMatch(source, /pathText\.split\(";"\)\.filter\(Boolean\)/);

  const secret = "doctor-secret-must-not-escape";
  const doctor = run(["setup", "--json"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_DOCTOR_FAIL: "1", FAKE_DOCTOR_MESSAGE: secret })
  });
  assert.equal(doctor.status, 1);
  assert.equal(JSON.parse(doctor.stdout).error.code, "KIMI_DOCTOR_FAILED");
  assert.equal(`${doctor.stdout}${doctor.stderr}`.includes(secret), false);

  const controls = temporaryDirectory();
  const models = run(["models", "--json"], {
    env: fakeEnvironment(controls, {
      FAKE_PROVIDER_LIST_JSON: JSON.stringify({
        models: { safe: { model: "safe-model", display_name: "\u001b[31mOwned\u001b[0m\u0007", capabilities: [] } }
      })
    })
  });
  assert.equal(models.status, 0, models.stderr);
  assert.equal(JSON.parse(models.stdout).data.configured.models[0].displayName, "Owned");

  const sessions = run(["session", "--experimental", "list", "--json"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_ACP_SESSION_TITLE: "\u001b]0;owned\u0007Listed\u001b[31m session\u001b[0m" })
  });
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.equal(JSON.parse(sessions.stdout).data.sessions[0].title, "Listed session");

  const rendered = run(["run", "task", "render safely"], {
    env: fakeEnvironment(temporaryDirectory(), { FAKE_PROVIDER_RAW_OUTPUT: "\u001b]0;owned\u0007\u001b[31mSafe output\u001b[0m\u0007\n" })
  });
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /Safe output/);
  assert.doesNotMatch(rendered.stdout, /[\u001b\u0007]/);
  const diagnostic = run(["run", "task", "render diagnostics safely"], {
    env: fakeEnvironment(temporaryDirectory(), {
      FAKE_PROVIDER_MODE: "fail",
      FAKE_PROVIDER_DIAGNOSTIC: "\u001b[31mUnsafe diagnostic\u001b[0m\u0007"
    })
  });
  assert.equal(diagnostic.status, 3);
  assert.match(diagnostic.stderr, /Unsafe diagnostic/);
  assert.doesNotMatch(diagnostic.stderr, /[\u001b\u0007]/);

  const changed = createChangedRepository();
  const labelEnvironment = fakeEnvironment(temporaryDirectory());
  const id = jobId(run(["run", "task", "--background", "--label", "\u001b[31mparser-fix\u001b[0m", "label"], { cwd: changed, env: labelEnvironment }));
  const status = run(["status", id, "--json"], { cwd: changed, env: labelEnvironment });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).data.jobs[0].label, "parser-fix");
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: changed, env: labelEnvironment }).stdout));
});

test("foreground guard preserves only validated CompanionError metadata across MCP IPC", { skip: process.platform === "win32" }, async () => {
  const repository = createChangedRepository();
  const unsafeTemporary = temporaryDirectory();
  const unsafeExecutable = path.join(unsafeTemporary, "unsafe-kimi");
  fs.writeFileSync(unsafeExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o777 });
  fs.chmodSync(unsafeExecutable, 0o777);
  const unsafeExchange = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "reject the unsafe provider" } } }
    ],
    responseId: 2,
    env: fakeEnvironment(unsafeTemporary, { KIMI_BIN: unsafeExecutable }),
    cwd: repository
  });
  assert.equal(unsafeExchange.status, 0, unsafeExchange.stderr);
  const unsafeResponse = parseJsonLines(unsafeExchange.stdout).find((message) => message.id === 2).result;
  assert.equal(unsafeResponse.isError, true);
  assert.equal(unsafeResponse.structuredContent.error.code, "UNTRUSTED_PROVIDER_EXECUTABLE");
  assert.match(unsafeResponse.structuredContent.error.message, /untrusted provider executable/i);
  assert.ok(Buffer.byteLength(unsafeResponse.structuredContent.error.message) <= 4096);
  assert.equal(unsafeResponse.structuredContent.error.exitCode, 1);
  assert.equal(unsafeResponse.structuredContent.error.retryable, false);
  assert.match(unsafeResponse.structuredContent.error.hint, /Install Kimi Code in a root- or user-owned non-writable directory/);
  assert.ok(Buffer.byteLength(unsafeResponse.structuredContent.error.hint) <= 4096);
  assert.doesNotMatch(JSON.stringify(unsafeResponse), new RegExp(unsafeExecutable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const providerTemporary = temporaryDirectory();
  const providerExchange = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "ordinary provider failure" } } }
    ],
    responseId: 3,
    env: fakeEnvironment(providerTemporary, { FAKE_PROVIDER_MODE: "fail" }),
    cwd: repository
  });
  assert.equal(providerExchange.status, 0, providerExchange.stderr);
  const providerResponse = parseJsonLines(providerExchange.stdout).find((message) => message.id === 3).result;
  assert.equal(providerResponse.isError, true);
  assert.equal(providerResponse.structuredContent.error.code, "KIMI_COMPANION_ERROR");
  assert.equal(providerResponse.structuredContent.error.exitCode, 3);
  assert.equal(providerResponse.structuredContent.error.retryable, false);
  assert.equal(providerResponse.structuredContent.error.hint, null);
});

test("MCP ingress is bounded before parsing and the transport uses queued writes", () => {
  const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, "x");
  const result = spawnSync(process.execPath, [runtime, "mcp"], {
    cwd: pluginRoot,
    env: fakeEnvironment(temporaryDirectory()),
    input: oversized,
    encoding: "utf8",
    timeout: 10_000
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /frame exceeded/i);
  const source = fs.readFileSync(runtime, "utf8");
  assert.doesNotMatch(source, /readline\.createInterface/);
  assert.match(source, /let writeQueue = Promise\.resolve\(\)/);
  assert.match(source, /process\.stdout\.write\(payload, \(error\)/);
  assert.match(source, /queuedOutputBytes \+ payloadBytes > maximumQueuedOutputBytes/);
});

test("MCP requires exactly one string rawArguments field and malformed cancel calls cannot cancel the sole active job", { timeout: 25_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "active-provider.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const id = jobId(run(["run", "task", "--background", "stay active"], { cwd: repository, env }));
  await poll(() => fs.existsSync(recordFile));

  const malformedArguments = [
    {},
    { rawArguments: 7 },
    { rawArguments: "", extra: true }
  ];
  for (const [index, arguments_] of malformedArguments.entries()) {
    const requestId = index + 1;
    const exchange = await mcpExchange({
      messages: [{ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name: "cancel", arguments: arguments_ } }],
      responseId: requestId,
      env,
      cwd: repository
    });
    const response = parseJsonLines(exchange.stdout).find((message) => message.id === requestId);
    assert.equal(response.error.code, -32602);
    assert.equal(Object.hasOwn(response, "result"), false);
  }

  const status = run(["status", id, "--json"], { cwd: repository, env });
  assert.equal(status.status, 0, status.stderr);
  assert.ok(["queued", "running"].includes(JSON.parse(status.stdout).data.jobs[0].status));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  assert.equal(fs.existsSync(metadata.replace(/\.json$/, ".cancel")), false);
  const cancelled = run(["cancel", id, "--json"], { cwd: repository, env, timeout: 15_000 });
  assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
  assert.equal(JSON.parse(cancelled.stdout).data.job.status, "cancelled");

  const resultExchange = await mcpExchange({
    messages: [{ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "result", arguments: { rawArguments: `${id} --json` } } }],
    responseId: 10,
    env,
    cwd: repository
  });
  const resultResponse = parseJsonLines(resultExchange.stdout).find((message) => message.id === 10);
  assert.equal(resultResponse.result.isError, false);
  assert.equal(resultResponse.result.structuredContent.data.job.status, "cancelled");
});

test("MCP rejects scalar and batch frames, duplicate IDs, and excess concurrent requests", async () => {
  const malformed = await mcpExchange({
    messages: [null, [], 7, { jsonrpc: "2.0", id: 99, method: "initialize", params: {} }],
    responseId: 99,
    env: fakeEnvironment(temporaryDirectory())
  });
  const malformedResponses = parseJsonLines(malformed.stdout);
  assert.equal(malformedResponses.filter((message) => message.id === null && message.error?.code === -32600).length, 3);
  assert.ok(malformedResponses.some((message) => message.id === 99 && message.result));

  const duplicate = await mcpExchange({
    messages: [
      { jsonrpc: "2.0", id: "same", method: "tools/call", params: { name: "usage", arguments: { rawArguments: "--json --window=all" } } },
      { jsonrpc: "2.0", id: "same", method: "tools/call", params: { name: "usage", arguments: { rawArguments: "--json --window=all" } } },
      { jsonrpc: "2.0", id: 100, method: "initialize", params: {} }
    ],
    responseId: 100,
    env: fakeEnvironment(temporaryDirectory())
  });
  const duplicateResponses = parseJsonLines(duplicate.stdout).filter((message) => message.id === "same");
  assert.equal(duplicateResponses.filter((message) => message.error?.message === "Duplicate active request ID").length, 1);
  assert.equal(duplicateResponses.filter((message) => message.result).length, 1);

  const concurrentMessages = Array.from({ length: 33 }, (_, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: { name: "status", arguments: { rawArguments: "--json" } }
  }));
  const concurrent = await mcpExchange({
    messages: concurrentMessages,
    responseId: 33,
    env: fakeEnvironment(temporaryDirectory())
  });
  const limited = parseJsonLines(concurrent.stdout).find((message) => message.id === 33);
  assert.equal(limited.error.code, -32002);
  assert.match(limited.error.message, /too many active/i);
});

test("MCP stdout closure aborts work and exits without an uncaught stream error", { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, [runtime, "mcp"], {
    cwd: pluginRoot,
    env: fakeEnvironment(temporaryDirectory()),
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.destroy();
  child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  const status = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("MCP server did not close after stdout loss")), 8_000);
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  assert.notEqual(status, 0);
  assert.doesNotMatch(stderr, /Unhandled 'error' event|node:events/i);
});

function collectFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(target));
    else files.push(target);
  }
  return files;
}
