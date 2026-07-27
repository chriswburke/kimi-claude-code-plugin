import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
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

function runAsync(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runtime, ...args], {
      cwd: options.cwd || pluginRoot,
      env: options.env || process.env,
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

test("background cancellation terminates the managed provider group before success", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const started = run(["run", "task", "--background", "wait"], { cwd: repository, env });
  assert.equal(started.status, 0, started.stderr);
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  assert.ok(isAlive(pids.providerPid));
  assert.ok(isAlive(pids.grandchildPid));

  const cancelled = run(["cancel", id], { cwd: repository, env, timeout: 15_000 });
  assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
  assert.match(cancelled.stdout, /Cancelled/);
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid));

  const result = run(["result", id], { cwd: repository, env });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /cancelled/);
});

test("heartbeat replacement stays readable during concurrent status, result, and cancel requests", { timeout: 25_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "stable-read-pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const started = run(["run", "task", "--background", "stress stable metadata reads"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id, `${started.stdout}\n${started.stderr}`);
  await poll(() => fs.existsSync(recordFile) && /\trunning\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  await new Promise((resolve) => setTimeout(resolve, 900));

  const readers = Array.from({ length: 6 }, (_, index) => index % 2 === 0
    ? runAsync(["status", id, "--json"], { cwd: repository, env })
    : runAsync(["result", id, "--json"], { cwd: repository, env }));
  const cancellation = runAsync(["cancel", id, "--json"], { cwd: repository, env });
  const [cancelled, observations] = await Promise.all([cancellation, Promise.all(readers)]);
  assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
  for (const observation of observations) {
    const combined = `${observation.stdout}\n${observation.stderr}`;
    assert.doesNotMatch(combined, /JOB_METADATA_INVALID|STATE_PATH_UNSAFE|STATE_FILE_CHANGED|INTERNAL_ERROR/);
    if (observation.status !== 0) {
      const document = JSON.parse(observation.stdout);
      assert.equal(document.error.code, "JOB_ACTIVE");
    }
  }
  await poll(() => /\tcancelled\t/.test(run(["status", id], { cwd: repository, env }).stdout));
});

test("background recovery removes an ownerless pristine pre-usage provision", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_PAUSE_AFTER_BACKGROUND_MANIFEST: "1"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "--background", "crash before usage"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  t.after(() => { if (isAlive(owner.pid)) process.kill(owner.pid, "SIGKILL"); });

  const state = path.join(temporary, "state");
  const manifestPath = await poll(() => fs.existsSync(state) && findFile(state, ".provision.json"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.usageCreated, false);
  assert.equal(manifest.jobPersisted, false);
  assert.equal(manifest.slotId, null);
  assert.equal(findFile(state, `${manifest.usageRecordId}.json`), undefined);

  const closed = new Promise((resolve) => owner.once("close", resolve));
  process.kill(owner.pid, "SIGKILL");
  await closed;
  const recovered = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(manifestPath), false);
  assert.equal(JSON.parse(recovered.stdout).data.aggregates.runs, 0);
});

test("an unpublished background manifest temporary is retained for manual inspection", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const prompt = "must not enter unpublished recovery metadata";
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_PAUSE_BACKGROUND_MANIFEST_PUBLICATION: "1"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "--background", prompt], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  t.after(() => { if (isAlive(owner.pid)) process.kill(owner.pid, "SIGKILL"); });

  const state = path.join(temporary, "state");
  const unpublished = await poll(() => fs.existsSync(state) && findFile(state, ".tmp"));
  assert.match(path.basename(unpublished), /^kimi-[a-z0-9]+-[a-f0-9]{8}\.provision\.json\.\d+\.[a-f0-9]{10}\.tmp$/);
  const metadata = fs.readFileSync(unpublished, "utf8");
  assert.doesNotMatch(metadata, new RegExp(prompt));
  assert.equal(JSON.parse(metadata).usageCreated, false);

  const closed = new Promise((resolve) => owner.once("close", resolve));
  process.kill(owner.pid, "SIGKILL");
  await closed;
  const inspected = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).data.aggregates.runs, 0);
  assert.equal(fs.existsSync(unpublished), true);
  assert.match(fs.readFileSync(path.join(pluginRoot, "README.md"), "utf8"), /unpublished provisional-manifest temporary/);

  fs.unlinkSync(unpublished);
  assert.equal(fs.existsSync(unpublished), false);
});

test("background provisioning recovers usage, prompt, and slot after owner death before job save", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_COMPANION_MAX_CONCURRENCY: "1",
    KIMI_TEST_PAUSE_BEFORE_BACKGROUND_JOB_SAVE: "1"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "--background", "crash before durable job"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  t.after(() => { if (isAlive(owner.pid)) process.kill(owner.pid, "SIGKILL"); });

  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const file = fs.existsSync(state) && findFile(state, ".provision.json");
    if (!file) return undefined;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    const prompt = path.join(path.dirname(file), `${manifest.id}.d`, "request.prompt");
    return manifest.usageCreated && manifest.slotId && fs.existsSync(prompt) ? { file, manifest, prompt } : undefined;
  });
  const usagePath = findFile(state, `${observed.manifest.usageRecordId}.json`);
  const slotPath = findFile(state, `${observed.manifest.slotId}.json`);
  const jobPath = path.join(path.dirname(observed.file), `${observed.manifest.id}.json`);
  assert.ok(usagePath && slotPath);
  assert.equal(fs.existsSync(jobPath), false);

  const closed = new Promise((resolve) => owner.once("close", resolve));
  process.kill(owner.pid, "SIGKILL");
  await closed;
  const movedRepository = `${repository}.moved`;
  fs.renameSync(repository, movedRepository);
  t.after(() => {
    if (!fs.existsSync(repository) && fs.existsSync(movedRepository)) {
      fs.renameSync(movedRepository, repository);
    }
  });
  const recovered = run(
    ["usage", "--json", "--window=all", "--scope=all"],
    { cwd: pluginRoot, env }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  const report = JSON.parse(recovered.stdout).data;
  assert.equal(report.aggregates.runs, 1);
  assert.equal(report.aggregates.execution.background, 1);
  assert.equal(report.aggregates.outcomes.active, 0);
  assert.equal(report.aggregates.outcomes.interrupted, 1);
  assert.equal(report.aggregates.providerLaunched, 0);
  assert.equal(fs.existsSync(observed.file), false);
  assert.equal(fs.existsSync(observed.prompt), false);
  assert.equal(fs.existsSync(path.dirname(observed.prompt)), false);
  assert.equal(fs.existsSync(slotPath), false);
  const usage = JSON.parse(fs.readFileSync(usagePath, "utf8"));
  assert.equal(usage.jobId, observed.manifest.id);
  assert.equal(usage.outcome, "interrupted");

  fs.renameSync(movedRepository, repository);
  const resumedEnv = fakeEnvironment(temporary, { KIMI_COMPANION_MAX_CONCURRENCY: "1" });
  const resumed = run(["run", "task", "--background", "after provisional recovery"], { cwd: repository, env: resumedEnv });
  assert.equal(resumed.status, 0, resumed.stderr);
  const resumedId = resumed.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(resumedId);
  await poll(() => /\tfinished\t/.test(run(["status", resumedId], { cwd: repository, env: resumedEnv }).stdout));
});

test("background recovery reclaims a SIGKILL-interrupted prompt atomic write", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_PAUSE_ATOMIC_TARGET: "request.prompt"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "--background", "sensitive atomic prompt"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  t.after(() => { if (isAlive(owner.pid)) process.kill(owner.pid, "SIGKILL"); });

  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const manifestPath = fs.existsSync(state) && findFile(state, ".provision.json");
    if (!manifestPath) return undefined;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (!manifest.slotId) return undefined;
    const artifacts = path.join(path.dirname(manifestPath), `${manifest.id}.d`);
    if (!fs.existsSync(artifacts)) return undefined;
    const temporaryName = fs.readdirSync(artifacts).find((name) =>
      new RegExp(`^request\\.prompt\\.${manifest.ownerPid}\\.[a-f0-9]{10}\\.tmp$`).test(name));
    return temporaryName
      ? { manifestPath, manifest, artifacts, promptTemporary: path.join(artifacts, temporaryName) }
      : undefined;
  });
  const usagePath = findFile(state, `${observed.manifest.usageRecordId}.json`);
  const slotPath = findFile(state, `${observed.manifest.slotId}.json`);
  assert.ok(usagePath && slotPath);
  assert.match(fs.readFileSync(observed.promptTemporary, "utf8"), /sensitive atomic prompt/);

  const closed = new Promise((resolve) => owner.once("close", resolve));
  process.kill(owner.pid, "SIGKILL");
  await closed;
  const recovered = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).data.aggregates.outcomes.interrupted, 1);
  assert.equal(fs.existsSync(observed.promptTemporary), false);
  assert.equal(fs.existsSync(observed.artifacts), false);
  assert.equal(fs.existsSync(slotPath), false);
  assert.equal(fs.existsSync(observed.manifestPath), false);
  assert.equal(JSON.parse(fs.readFileSync(usagePath, "utf8")).outcome, "interrupted");
});

test("background recovery preserves a foreign atomic-temp lookalike as fail-closed evidence", { skip: process.platform === "win32", timeout: 20_000 }, async (t) => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_PAUSE_ATOMIC_TARGET: "request.prompt"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "--background", "retain foreign evidence"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  t.after(() => { if (isAlive(owner.pid)) process.kill(owner.pid, "SIGKILL"); });

  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const manifestPath = fs.existsSync(state) && findFile(state, ".provision.json");
    if (!manifestPath) return undefined;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const artifacts = path.join(path.dirname(manifestPath), `${manifest.id}.d`);
    if (!manifest.slotId || !fs.existsSync(artifacts)) return undefined;
    const ownerTemporary = fs.readdirSync(artifacts).find((name) =>
      new RegExp(`^request\\.prompt\\.${manifest.ownerPid}\\.[a-f0-9]{10}\\.tmp$`).test(name));
    return ownerTemporary
      ? { manifestPath, manifest, artifacts, ownerTemporary: path.join(artifacts, ownerTemporary) }
      : undefined;
  });
  const foreignTemporary = path.join(
    observed.artifacts,
    `request.prompt.${process.pid}.deadbeef00.tmp`
  );
  fs.writeFileSync(foreignTemporary, "retain", { mode: 0o600 });

  const closed = new Promise((resolve) => owner.once("close", resolve));
  process.kill(owner.pid, "SIGKILL");
  await closed;
  const refused = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(refused.status, 1, refused.stderr);
  assert.equal(JSON.parse(refused.stdout).error.code, "CLEANUP_UNSAFE_ARTIFACTS");
  assert.equal(fs.existsSync(observed.ownerTemporary), false);
  assert.equal(fs.readFileSync(foreignTemporary, "utf8"), "retain");
  assert.equal(fs.existsSync(observed.manifestPath), true);

  fs.unlinkSync(foreignTemporary);
  const recovered = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).data.aggregates.outcomes.interrupted, 1);
  assert.equal(fs.existsSync(observed.artifacts), false);
  assert.equal(fs.existsSync(observed.manifestPath), false);
});

test("a live worker remains active despite a stale heartbeat", { skip: process.platform === "win32" }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "stale-heartbeat-pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const started = run(["run", "task", "--background", "keep", "alive"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  const metadataPath = await poll(() => findFile(path.join(temporary, "state"), `${id}.json`));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.ok(metadata.workerPid);

  process.kill(metadata.workerPid, "SIGSTOP");
  try {
    const stale = { ...metadata, heartbeatAt: "1970-01-01T00:00:00.000Z" };
    const stalePath = `${metadataPath}.${process.pid}.stale`;
    fs.writeFileSync(stalePath, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(stalePath, metadataPath);
    assert.equal(JSON.parse(fs.readFileSync(metadataPath, "utf8")).heartbeatAt, stale.heartbeatAt);
    const status = run(["status", id], { cwd: repository, env });
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /\trunning\t/);
  } finally {
    process.kill(metadata.workerPid, "SIGCONT");
  }

  const cancelled = run(["cancel", id], { cwd: repository, env, timeout: 15_000 });
  assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
});

test("normal completion removes descendants before recording finished", { skip: process.platform === "win32" }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "leftover-pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "leave-child", FAKE_RECORD_FILE: recordFile });
  const started = run(["run", "task", "--background", "leave", "no", "children"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  assert.equal(isAlive(pids.providerPid), false);
  assert.equal(isAlive(pids.grandchildPid), false);
});

test("Windows task-tree control covers cancellation, owner loss, and completion descendants", { skip: process.platform !== "win32", timeout: 40_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();

  const cancelRecord = path.join(temporary, "windows-cancel.json");
  const cancelEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: cancelRecord });
  const cancelStart = run(["run", "task", "--background", "cancel the Windows tree"], { cwd: repository, env: cancelEnvironment });
  const cancelId = cancelStart.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(cancelId, `${cancelStart.stdout}\n${cancelStart.stderr}`);
  const cancelPids = await poll(() => fs.existsSync(cancelRecord) && JSON.parse(fs.readFileSync(cancelRecord, "utf8")));
  const cancelled = run(["cancel", cancelId, "--json"], { cwd: repository, env: cancelEnvironment, timeout: 20_000 });
  assert.equal(cancelled.status, 0, `${cancelled.stdout}\n${cancelled.stderr}`);
  await poll(() => !isAlive(cancelPids.providerPid) && !isAlive(cancelPids.grandchildPid));

  const ownerRecord = path.join(temporary, "windows-owner-loss.json");
  const ownerEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: ownerRecord });
  const owner = spawn(process.execPath, [runtime, "run", "task", "lose the Windows owner"], {
    cwd: repository,
    env: ownerEnvironment,
    stdio: "ignore"
  });
  const ownerPids = await poll(() => fs.existsSync(ownerRecord) && JSON.parse(fs.readFileSync(ownerRecord, "utf8")));
  const manifest = await poll(() => {
    const file = findFile(path.join(temporary, "state"), ".manifest.json");
    if (!file) return undefined;
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value.guardPid ? { file, value } : undefined;
  });
  process.kill(owner.pid, "SIGKILL");
  await new Promise((resolve) => owner.once("close", resolve));
  await poll(() => !isAlive(ownerPids.providerPid) && !isAlive(ownerPids.grandchildPid) && !isAlive(manifest.value.guardPid));
  const recovered = run(["usage", "--json", "--window=all"], { cwd: repository, env: ownerEnvironment });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(manifest.file), false);

  const completionRecord = path.join(temporary, "windows-completion.json");
  const completionEnvironment = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "leave-child", FAKE_RECORD_FILE: completionRecord });
  const completionStart = run(["run", "task", "--background", "clean completion descendants"], { cwd: repository, env: completionEnvironment });
  const completionId = completionStart.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(completionId, `${completionStart.stdout}\n${completionStart.stderr}`);
  const completionPids = await poll(() => fs.existsSync(completionRecord) && JSON.parse(fs.readFileSync(completionRecord, "utf8")));
  await poll(() => /\tfinished\t/.test(run(["status", completionId], { cwd: repository, env: completionEnvironment }).stdout));
  await poll(() => !isAlive(completionPids.providerPid) && !isAlive(completionPids.grandchildPid));
});

test("guard lease loss cleans providers after a worker crash", { skip: process.platform === "win32" }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "crash-pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const started = run(["run", "task", "--background", "survive", "worker", "crash"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  const metadataPath = await poll(() => findFile(path.join(temporary, "state"), `${id}.json`));
  const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
  assert.ok(metadata.workerPid);
  process.kill(metadata.workerPid, "SIGKILL");
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid));
  await poll(() => /\tinterrupted\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const usage = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(usage.status, 0, usage.stderr);
  const report = JSON.parse(usage.stdout).data;
  assert.equal(report.aggregates.outcomes.interrupted, 1);
  assert.equal(report.aggregates.providerLaunched, 1);
});

test("foreground owner SIGKILL terminates the managed provider group and recovery clears private state without mutating dry-run", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "foreground-owner-death.json");
  const env = fakeEnvironment(temporary, {
    FAKE_PROVIDER_MODE: "wait",
    FAKE_RECORD_FILE: recordFile,
    KIMI_COMPANION_MAX_CONCURRENCY: "1"
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "owner death"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const file = findFile(state, ".manifest.json");
    if (!file) return undefined;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest.kind === "task" && manifest.guardPid && manifest.slotId ? { file, manifest } : undefined;
  });
  const usagePath = findFile(state, `${observed.manifest.usageRecordId}.json`);
  const artifactDirectory = path.join(path.dirname(observed.file), `${observed.manifest.id}.d`);
  const slotPath = findFile(state, `${observed.manifest.slotId}.json`);
  assert.ok(usagePath && slotPath && fs.existsSync(artifactDirectory));

  process.kill(owner.pid, "SIGKILL");
  await new Promise((resolve) => owner.once("close", resolve));
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid) && !isAlive(observed.manifest.guardPid));

  const beforeDryRun = {
    manifest: fs.readFileSync(observed.file, "utf8"),
    manifestMtime: fs.statSync(observed.file).mtimeMs,
    usage: fs.readFileSync(usagePath, "utf8"),
    usageMtime: fs.statSync(usagePath).mtimeMs
  };
  const dryRun = run(["cleanup", "--older-than", "1ms", "--dry-run", "--json"], { cwd: repository, env });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.equal(fs.readFileSync(observed.file, "utf8"), beforeDryRun.manifest);
  assert.equal(fs.statSync(observed.file).mtimeMs, beforeDryRun.manifestMtime);
  assert.equal(fs.readFileSync(usagePath, "utf8"), beforeDryRun.usage);
  assert.equal(fs.statSync(usagePath).mtimeMs, beforeDryRun.usageMtime);
  assert.equal(JSON.parse(fs.readFileSync(usagePath, "utf8")).outcome, null);

  const usage = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(usage.status, 0, usage.stderr);
  const report = JSON.parse(usage.stdout).data;
  assert.equal(report.aggregates.outcomes.active, 0);
  assert.equal(report.aggregates.outcomes.interrupted, 1);
  assert.equal(report.aggregates.providerLaunched, 1);
  assert.equal(fs.existsSync(observed.file), false);
  assert.equal(fs.existsSync(artifactDirectory), false);
  assert.equal(fs.existsSync(slotPath), false);
  assert.equal(JSON.parse(fs.readFileSync(usagePath, "utf8")).outcome, "interrupted");

  const resumed = run(["run", "task", "after recovery"], {
    cwd: repository,
    env: fakeEnvironment(temporary, { KIMI_COMPANION_MAX_CONCURRENCY: "1" })
  });
  assert.equal(resumed.status, 0, resumed.stderr);
});

test("ACP owner SIGKILL terminates its POSIX process group and recovers session usage", { skip: process.platform === "win32", timeout: 20_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "acp-owner-death.json");
  const env = fakeEnvironment(temporary, {
    FAKE_ACP_MODE: "hang",
    FAKE_ACP_LEAVE_CHILD: "1",
    FAKE_RECORD_FILE: recordFile
  });
  const owner = spawn(process.execPath, [runtime, "session", "--experimental", "start", "--json", "owner death"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  const pids = await poll(() => {
    if (!fs.existsSync(recordFile)) return undefined;
    const record = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    return record.grandchildPid && record.requests.some((request) => request.method === "session/prompt") ? record : undefined;
  });
  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const file = findFile(state, ".manifest.json");
    if (!file) return undefined;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest.kind === "session" && manifest.guardPid && manifest.providerLaunched ? { file, manifest } : undefined;
  });
  const usagePath = findFile(state, `${observed.manifest.usageRecordId}.json`);
  assert.ok(usagePath);

  process.kill(owner.pid, "SIGKILL");
  await new Promise((resolve) => owner.once("close", resolve));
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid) && !isAlive(observed.manifest.guardPid));
  const usage = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(usage.status, 0, usage.stderr);
  const report = JSON.parse(usage.stdout).data;
  assert.equal(report.aggregates.kinds.session, 1);
  assert.equal(report.aggregates.outcomes.active, 0);
  assert.equal(report.aggregates.outcomes.interrupted, 1);
  assert.equal(report.aggregates.providerLaunched, 1);
  assert.equal(fs.existsSync(observed.file), false);
  assert.equal(JSON.parse(fs.readFileSync(usagePath, "utf8")).outcome, "interrupted");
});

test("foreground recovery preserves persisted byte metrics after usage finalization fails", { timeout: 15_000 }, async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "foreground-accounting-retry.json");
  const env = fakeEnvironment(temporary, {
    FAKE_PROVIDER_HOLD_AFTER_RECORD_MS: "800",
    FAKE_RECORD_FILE: recordFile
  });
  const owner = spawn(process.execPath, [runtime, "run", "task", "persist metrics"], {
    cwd: repository,
    env,
    stdio: "ignore"
  });
  await poll(() => fs.existsSync(recordFile));
  const state = path.join(temporary, "state");
  const observed = await poll(() => {
    const file = findFile(state, ".manifest.json");
    if (!file) return undefined;
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest.providerLaunched ? { file, manifest } : undefined;
  });
  const usagePath = findFile(state, `${observed.manifest.usageRecordId}.json`);
  assert.ok(usagePath);
  const savedUsagePath = `${usagePath}.saved`;
  fs.renameSync(usagePath, savedUsagePath);
  fs.mkdirSync(usagePath, { mode: 0o700 });
  const exitStatus = await new Promise((resolve) => owner.once("close", resolve));
  assert.equal(exitStatus, 1);
  assert.equal(fs.existsSync(observed.file), true);
  const retainedManifest = JSON.parse(fs.readFileSync(observed.file, "utf8"));
  assert.ok(retainedManifest.outputBytes > 0);
  assert.equal(fs.existsSync(path.join(path.dirname(observed.file), `${retainedManifest.id}.d`)), false);
  assert.equal(
    fs.readdirSync(path.dirname(usagePath)).some((name) => name.endsWith(".tmp")),
    false,
    "failed atomic writes must remove their private temporary"
  );

  fs.rmdirSync(usagePath);
  fs.renameSync(savedUsagePath, usagePath);
  const usage = run(["usage", "--json", "--window=all"], { cwd: repository, env });
  assert.equal(usage.status, 0, usage.stderr);
  const report = JSON.parse(usage.stdout).data;
  assert.equal(report.aggregates.outcomes.active, 0);
  assert.equal(report.aggregates.outcomes.interrupted, 1);
  const recovered = JSON.parse(fs.readFileSync(usagePath, "utf8"));
  assert.ok(recovered.bytes.output >= retainedManifest.outputBytes);
  assert.equal(fs.existsSync(observed.file), false);
});

test("owner SIGKILL also terminates detached provider probe trees", { skip: process.platform === "win32", timeout: 10_000 }, async () => {
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "probe-owner-death.json");
  const env = fakeEnvironment(temporary, { FAKE_PROBE_HANG_TREE: "1", FAKE_RECORD_FILE: recordFile });
  const owner = spawn(process.execPath, [runtime, "setup", "--json"], { env, stdio: "ignore" });
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  process.kill(owner.pid, "SIGKILL");
  await new Promise((resolve) => owner.once("close", resolve));
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid));
});

test("MCP cancellation before launch never starts the provider", async () => {
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "should-not-start.json");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "do not start" } } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } }
  ];
  const result = await mcpExchange({
    messages,
    responseId: 2,
    env: fakeEnvironment(temporary, { FAKE_RECORD_FILE: recordFile })
  });
  const response = parseJsonLines(result.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/);
  assert.equal(fs.existsSync(recordFile), false);
});

test("MCP cancellation cannot authorize detached background work", async () => {
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "background-should-not-start.json");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "--background do not start" } } },
    { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 2, reason: "test" } }
  ];
  const result = await mcpExchange({
    messages,
    responseId: 2,
    env: fakeEnvironment(temporary, { FAKE_RECORD_FILE: recordFile })
  });
  const response = parseJsonLines(result.stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/);
  assert.equal(fs.existsSync(recordFile), false);
});

test("closing MCP input aborts an active provider and descendants", { skip: process.platform === "win32" }, async () => {
  const temporary = temporaryDirectory();
  const recordFile = path.join(temporary, "foreground-pids.json");
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "wait", FAKE_RECORD_FILE: recordFile });
  const child = spawn(process.execPath, [runtime, "mcp"], {
    cwd: pluginRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_task", arguments: { rawArguments: "wait" } } })}\n`);
  const pids = await poll(() => fs.existsSync(recordFile) && JSON.parse(fs.readFileSync(recordFile, "utf8")));
  child.stdin.end();
  const status = await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`MCP server did not exit: ${stderr}`)), 15_000))
  ]);
  assert.equal(status, 0, stderr);
  const response = parseJsonLines(stdout).find((message) => message.id === 2);
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /cancelled/);
  await poll(() => !isAlive(pids.providerPid) && !isAlive(pids.grandchildPid));
  const usage = run(["usage", "--json", "--window=all"], { cwd: pluginRoot, env });
  assert.equal(usage.status, 0, usage.stderr);
  const report = JSON.parse(usage.stdout).data;
  assert.equal(report.aggregates.execution.foreground, 1);
  assert.equal(report.aggregates.outcomes.cancelled, 1);
});

test("failed background results retain stdout and stderr once", async () => {
  const repository = createChangedRepository();
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary, { FAKE_PROVIDER_MODE: "fail" });
  const started = run(["run", "task", "--background", "fail", "safely"], { cwd: repository, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfailed\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const result = run(["result", id], { cwd: repository, env });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /"prompt":"fail safely"/);
  assert.match(result.stdout, /fake Kimi diagnostic/);
  assert.equal(result.stdout.match(/fake Kimi diagnostic/g)?.length, 1);
  assert.equal(result.stdout.match(/KIMI exited with 3/g)?.length, 1);
});

test("background state is private, atomic, and repository-scoped", async () => {
  const repository = createChangedRepository();
  const subdirectory = path.join(repository, "nested");
  fs.mkdirSync(subdirectory);
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const started = run(["run", "task", "--background", "quick"], { cwd: subdirectory, env });
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(run(["status", id], { cwd: repository, env }).stdout));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  assert.ok(metadata);
  assert.equal(fs.existsSync(path.join(path.dirname(metadata), `${id}.provision.json`)), false);
  assert.equal(fs.statSync(metadata).mode & 0o777, 0o600);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.dirname(metadata)).mode & 0o777, 0o700);
  const parsed = JSON.parse(fs.readFileSync(metadata, "utf8"));
  assert.equal(parsed.provider, "kimi");
  assert.equal(parsed.workspaceRoot, fs.realpathSync(repository));
  assert.equal(run(["status", id], { cwd: temporaryDirectory(), env }).status, 1);
});

test("worker and guard internal entry points reject unauthenticated use", () => {
  const temporary = temporaryDirectory();
  const env = fakeEnvironment(temporary);
  const worker = run(["_worker", "kimi-invalid-deadbeef", "wrong-token", pluginRoot], { env });
  assert.notEqual(worker.status, 0);
  assert.match(worker.stderr, /Job not found|Invalid job ID/);

  const guard = run(["_guard", "task", "", path.join(temporary, "request.prompt"), pluginRoot], { env });
  assert.notEqual(guard.status, 0);
  assert.match(guard.stderr, /authenticated owner IPC channel/);
});
