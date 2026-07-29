import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  createChangedRepository,
  fakeEnvironment,
  findFile,
  poll,
  run,
  runtime,
  temporaryDirectory
} from "./helpers.mjs";

function workspaceJobs(temporary, repository) {
  const key = crypto.createHash("sha256")
    .update(fs.realpathSync(repository))
    .digest("hex")
    .slice(0, 16);
  return path.join(
    temporary,
    "state",
    "model-companions",
    "kimi",
    "workspaces",
    key,
    "jobs"
  );
}

function collect(child, timeout = 15_000) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error(`Timed out waiting for child ${child.pid}`));
    }, timeout);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function spawnBackground(repository, env, prompt) {
  return spawn(
    process.execPath,
    [runtime, "run", "task", "--background", prompt],
    { cwd: repository, env, stdio: ["ignore", "pipe", "pipe"] }
  );
}

function stateLockDocument(pid, token, birthIdentity = null) {
  return {
    schemaVersion: 1,
    pid,
    token,
    acquiredAt: new Date().toISOString(),
    birthIdentity
  };
}

function writeStateLock(lock, owner) {
  fs.mkdirSync(lock, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(lock, "owner.json"),
    `${JSON.stringify(owner, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function retireTestLock(lock, owner) {
  const retired = `${lock}.retired-${owner.token}`;
  fs.renameSync(lock, retired);
  fs.unlinkSync(path.join(retired, "owner.json"));
  fs.rmdirSync(retired);
}

function markerEquals(file, value) {
  try { return fs.readFileSync(file, "utf8") === value; }
  catch { return false; }
}

function writePartialPreparation(lock, pid, token) {
  const preparation = `${lock}.prepare-${pid}-${token}`;
  fs.mkdirSync(preparation, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(preparation, "owner.json"), "{", { mode: 0o600 });
  return preparation;
}

function stateLockResidue(directory) {
  const residue = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (/\.lock(?:$|\.(?:prepare-\d+-[a-f0-9]{32}|retired-[a-f0-9]{32})$)/.test(entry.name)) {
      residue.push(target);
    }
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      residue.push(...stateLockResidue(target));
    }
  }
  return residue;
}

function cleanupTemporaryDirectories(t, ...directories) {
  t.after(() => {
    for (const directory of directories) {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 50
      });
    }
  });
}

async function waitForBackgroundJob(repository, env, output) {
  const id = output.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id, output);
  await poll(() => /\tfinished\t/.test(
    run(["status", id], { cwd: repository, env }).stdout
  ));
  return id;
}

test("state locks publish completely and ordinary release leaves no residue", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const jobs = workspaceJobs(temporary, repository);
  const pausedEnv = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_STATE_LOCK_PAUSE: "before-publish",
    KIMI_TEST_STATE_LOCK_BASENAME: "concurrency.lock"
  });
  const owner = spawnBackground(repository, pausedEnv, "prepublish crash");
  const ownerResult = collect(owner);
  t.after(() => { try { owner.kill("SIGKILL"); } catch {} });

  await poll(() => fs.existsSync(jobs)
    && fs.readdirSync(jobs).some((name) =>
      new RegExp(`^concurrency\\.lock\\.prepare-${owner.pid}-[a-f0-9]{32}$`).test(name)
    ));
  assert.equal(fs.existsSync(path.join(jobs, "concurrency.lock")), false);
  owner.kill("SIGKILL");
  await ownerResult;

  const resumed = run(
    ["run", "task", "--background", "recover prepublish"],
    { cwd: repository, env: fakeEnvironment(temporary) }
  );
  assert.equal(resumed.status, 0, resumed.stderr);
  await waitForBackgroundJob(repository, fakeEnvironment(temporary), resumed.stdout);
  await poll(() => stateLockResidue(path.join(temporary, "state")).length === 0);
  assert.deepEqual(stateLockResidue(path.join(temporary, "state")), []);
  assert.equal(findFile(path.join(temporary, "state"), ".reserve"), undefined);
});

test("state-lock release crash retains evidence without blocking a replacement", {
  skip: process.platform === "win32",
  timeout: 20_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const jobs = workspaceJobs(temporary, repository);
  const env = fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_STATE_LOCK_PAUSE: "after-live-retire",
    KIMI_TEST_STATE_LOCK_BASENAME: "concurrency.lock"
  });
  const owner = spawnBackground(repository, env, "release crash");
  const ownerResult = collect(owner);
  t.after(() => { try { owner.kill("SIGKILL"); } catch {} });
  const evidence = await poll(() => {
    if (!fs.existsSync(jobs)) return undefined;
    return fs.readdirSync(jobs).find((name) =>
      /^concurrency\.lock\.retired-[a-f0-9]{32}$/.test(name)
    );
  });
  assert.equal(fs.existsSync(path.join(jobs, "concurrency.lock")), false);
  owner.kill("SIGKILL");
  await ownerResult;

  const replacement = run(
    ["run", "task", "--background", "replacement owner"],
    { cwd: repository, env: fakeEnvironment(temporary) }
  );
  assert.equal(replacement.status, 0, replacement.stderr);
  await waitForBackgroundJob(repository, fakeEnvironment(temporary), replacement.stdout);
  assert.equal(fs.existsSync(path.join(jobs, evidence)), true);
});

test("two stale reclaimers cannot remove a replacement state-lock owner", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const jobs = workspaceJobs(temporary, repository);
  fs.mkdirSync(jobs, { recursive: true, mode: 0o700 });
  const lock = path.join(jobs, "concurrency.lock");
  const stale = stateLockDocument(99_999_999, "11111111111111111111111111111111");
  writeStateLock(lock, stale);

  const first = spawnBackground(repository, fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_STATE_LOCK_PAUSE: "before-stale-retire",
    KIMI_TEST_STATE_LOCK_BASENAME: "concurrency.lock"
  }), "first reclaimer");
  const firstResult = collect(first);
  t.after(() => { try { first.kill("SIGKILL"); } catch {} });
  await poll(() => fs.existsSync(lock)
    && fs.readdirSync(jobs).some((name) =>
      new RegExp(`^concurrency\\.lock\\.prepare-${first.pid}-`).test(name)
    ));

  const second = spawnBackground(repository, fakeEnvironment(temporary, {
    NODE_ENV: "test",
    KIMI_TEST_STATE_LOCK_PAUSE: "after-publish",
    KIMI_TEST_STATE_LOCK_BASENAME: "concurrency.lock"
  }), "replacement holder");
  const secondResult = collect(second);
  t.after(() => { try { second.kill("SIGKILL"); } catch {} });
  const replacementOwner = await poll(() => {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
      return owner.token !== stale.token ? owner : undefined;
    } catch { return undefined; }
  });
  assert.equal(fs.existsSync(`${lock}.retired-${stale.token}`), true);

  process.kill(first.pid, "SIGCONT");
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterDelayedReclaimer = JSON.parse(
    fs.readFileSync(path.join(lock, "owner.json"), "utf8")
  );
  assert.equal(afterDelayedReclaimer.token, replacementOwner.token);
  process.kill(second.pid, "SIGCONT");
  const [firstCompleted, secondCompleted] = await Promise.all([
    firstResult,
    secondResult
  ]);
  assert.equal(firstCompleted.status, 0, firstCompleted.stderr);
  assert.equal(secondCompleted.status, 0, secondCompleted.stderr);
  await waitForBackgroundJob(
    repository,
    fakeEnvironment(temporary),
    firstCompleted.stdout
  );
  await waitForBackgroundJob(
    repository,
    fakeEnvironment(temporary),
    secondCompleted.stdout
  );
  assert.equal(fs.existsSync(`${lock}.retired-${stale.token}`), true);
});

// The busy-lock path below spins through the acquire retries and spawns ps to
// verify the holder's birth identity, so it is the slowest call in this file.
// Keep the budget generous: a tight one fails on a loaded runner by killing the
// command, which surfaces as a null exit status rather than a real assertion.
test("state-lock identity is PID-reuse aware and ambiguous owners fail closed", {
  skip: process.platform === "win32",
  timeout: 45_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const started = run(
    ["run", "task", "--background", "identity seed"],
    { cwd: repository, env }
  );
  assert.equal(started.status, 0, started.stderr);
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(
    run(["status", id], { cwd: repository, env }).stdout
  ));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  assert.ok(metadata);
  const lock = metadata.replace(/\.json$/, ".lock");
  const ambiguous = stateLockDocument(
    process.pid,
    "22222222222222222222222222222222",
    null
  );
  writeStateLock(lock, ambiguous);
  const blocked = run(
    ["result", id, "--json"],
    { cwd: repository, env }
  );
  assert.equal(blocked.status, 1);
  const blockedEnvelope = JSON.parse(blocked.stdout);
  assert.equal(blockedEnvelope.error.code, "STATE_LOCK_BUSY");
  assert.match(blockedEnvelope.error.hint, /PID was reused/i);
  retireTestLock(lock, ambiguous);

  const reused = stateLockDocument(
    process.pid,
    "33333333333333333333333333333333",
    "0".repeat(64)
  );
  writeStateLock(lock, reused);
  const recovered = run(
    ["result", id, "--json"],
    {
      cwd: repository,
      env: {
        ...env,
        NODE_ENV: "test",
        KIMI_TEST_STATE_LOCK_BIRTH_IDENTITY: "1".repeat(64)
      }
    }
  );
  assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
  assert.equal(fs.existsSync(`${lock}.retired-${reused.token}`), true);

  fs.writeFileSync(lock, "", { mode: 0o600 });
  const startedAt = Date.now();
  const invalid = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(invalid.status, 1);
  assert.ok(Date.now() - startedAt < 3_000);
  const invalidEnvelope = JSON.parse(invalid.stdout);
  assert.equal(invalidEnvelope.error.code, "STATE_LOCK_UNSAFE");
  assert.match(invalidEnvelope.error.hint, /remove only the named invalid lock/i);
  fs.unlinkSync(lock);

  const symlinkTarget = path.join(temporary, "lock-symlink-target");
  fs.mkdirSync(symlinkTarget, { mode: 0o700 });
  fs.symlinkSync(symlinkTarget, lock, "dir");
  const symlinked = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(symlinked.status, 1);
  const symlinkEnvelope = JSON.parse(symlinked.stdout);
  assert.equal(symlinkEnvelope.error.code, "STATE_LOCK_UNSAFE");
  assert.match(symlinkEnvelope.error.hint, /remove only the named invalid lock/i);
  fs.unlinkSync(lock);

  const releaseOwner = spawn(process.execPath, [
    runtime,
    "result",
    id,
    "--json"
  ], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_PAUSE: "after-publish",
      KIMI_TEST_STATE_LOCK_BASENAME: `${id}.lock`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const releaseResult = collect(releaseOwner);
  t.after(() => { try { releaseOwner.kill("SIGKILL"); } catch {} });
  await poll(() => fs.existsSync(path.join(lock, "owner.json")));
  fs.unlinkSync(path.join(lock, "owner.json"));
  fs.rmdirSync(lock);
  process.kill(releaseOwner.pid, "SIGCONT");
  const missingRelease = await releaseResult;
  assert.equal(missingRelease.status, 1);
  const missingReleaseEnvelope = JSON.parse(missingRelease.stdout);
  assert.equal(missingReleaseEnvelope.error.code, "STATE_LOCK_UNSAFE");
  assert.match(missingReleaseEnvelope.error.message, /disappeared before release/i);
});

test("portable state-lock lifecycle fails closed and recovers dead owners", {
  timeout: 25_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const started = run(
    ["run", "task", "--background", "portable lock lifecycle"],
    { cwd: repository, env }
  );
  assert.equal(started.status, 0, started.stderr);
  const id = await waitForBackgroundJob(repository, env, started.stdout);
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  assert.ok(metadata);
  const lock = metadata.replace(/\.json$/, ".lock");

  const ordinary = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  await poll(() => !fs.existsSync(lock));

  const dead = stateLockDocument(
    99_999_999,
    "cccccccccccccccccccccccccccccccc"
  );
  writeStateLock(lock, dead);
  const recovered = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(`${lock}.retired-${dead.token}`), true);

  const live = stateLockDocument(
    process.pid,
    "dddddddddddddddddddddddddddddddd",
    null
  );
  writeStateLock(lock, live);
  const blocked = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(blocked.status, 1);
  assert.equal(JSON.parse(blocked.stdout).error.code, "STATE_LOCK_BUSY");
  retireTestLock(lock, live);

  fs.writeFileSync(lock, "", { mode: 0o600 });
  const invalid = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, "STATE_LOCK_UNSAFE");
  fs.unlinkSync(lock);
});

test("state-lock read and preparation races preserve valid replacements", {
  skip: process.platform === "win32",
  timeout: 35_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const started = run(
    ["run", "task", "--background", "state-lock race seed"],
    { cwd: repository, env }
  );
  assert.equal(started.status, 0, started.stderr);
  const id = await waitForBackgroundJob(repository, env, started.stdout);
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  const lock = metadata.replace(/\.json$/, ".lock");

  const original = stateLockDocument(
    99_999_999,
    "88888888888888888888888888888888"
  );
  writeStateLock(lock, original);
  const readMarker = path.join(temporary, "owner-read.marker");
  const reader = spawn(process.execPath, [runtime, "result", id, "--json"], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_PAUSE:
        "after-owner-directory-stat,after-owner-read-error",
      KIMI_TEST_STATE_LOCK_BASENAME: `${id}.lock`,
      KIMI_TEST_STATE_LOCK_PAUSE_MARKER: readMarker
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const readerResult = collect(reader, 25_000);
  t.after(() => { try { reader.kill("SIGKILL"); } catch {} });
  await poll(() => markerEquals(readMarker, "after-owner-directory-stat"));
  fs.renameSync(lock, `${lock}.retired-${original.token}`);
  process.kill(reader.pid, "SIGCONT");
  await poll(() => markerEquals(readMarker, "after-owner-read-error"));
  const replacement = stateLockDocument(
    process.pid,
    "99999999999999999999999999999999",
    null
  );
  writeStateLock(lock, replacement);
  process.kill(reader.pid, "SIGCONT");
  const raced = await readerResult;
  assert.equal(raced.status, 1, `${raced.stdout}\n${raced.stderr}`);
  assert.equal(JSON.parse(raced.stdout).error.code, "STATE_LOCK_BUSY");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")).token,
    replacement.token
  );
  retireTestLock(lock, replacement);

  const partialToken = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const partial = writePartialPreparation(lock, process.pid, partialToken);
  const retained = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(retained.status, 0, retained.stderr);
  assert.equal(fs.existsSync(partial), true);
  fs.writeFileSync(
    path.join(partial, "owner.json"),
    `${JSON.stringify(stateLockDocument(
      process.pid,
      partialToken,
      "0".repeat(64)
    ))}\n`,
    { mode: 0o600 }
  );
  const reused = run(["result", id, "--json"], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_BIRTH_IDENTITY: "1".repeat(64)
    }
  });
  assert.equal(reused.status, 0, reused.stderr);
  assert.equal(fs.existsSync(partial), false);

  const symlinkPreparation = `${lock}.prepare-${process.pid}-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`;
  const symlinkTarget = path.join(temporary, "partial-owner-target.json");
  fs.mkdirSync(symlinkPreparation, { mode: 0o700 });
  fs.writeFileSync(symlinkTarget, "{}\n", { mode: 0o600 });
  fs.symlinkSync(symlinkTarget, path.join(symlinkPreparation, "owner.json"));
  const poisoned = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(poisoned.status, 1);
  assert.equal(JSON.parse(poisoned.stdout).error.code, "STATE_LOCK_UNSAFE");
  fs.unlinkSync(path.join(symlinkPreparation, "owner.json"));
  fs.rmdirSync(symlinkPreparation);

  const deadToken = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const deadPartial = `${lock}.prepare-99999999-${deadToken}`;
  writeStateLock(deadPartial, stateLockDocument(99_999_999, deadToken));
  const cleanupMarker = path.join(temporary, "preparation-cleanup.marker");
  const first = spawn(process.execPath, [runtime, "result", id, "--json"], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_PAUSE: "after-preparation-owner-unlink",
      KIMI_TEST_STATE_LOCK_BASENAME: `${id}.lock`,
      KIMI_TEST_STATE_LOCK_PAUSE_MARKER: cleanupMarker
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const firstResult = collect(first, 25_000);
  t.after(() => { try { first.kill("SIGKILL"); } catch {} });
  await poll(() => markerEquals(cleanupMarker, "after-preparation-owner-unlink"));
  const second = run(["result", id, "--json"], { cwd: repository, env });
  assert.equal(second.status, 0, second.stderr);
  process.kill(first.pid, "SIGCONT");
  const firstCompleted = await firstResult;
  assert.equal(firstCompleted.status, 0, firstCompleted.stderr);
  assert.equal(fs.existsSync(deadPartial), false);
});

test("generic orphan scan covers every Kimi state-lock store", {
  timeout: 20_000
}, (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const jobs = workspaceJobs(temporary, repository);
  const usage = path.join(path.dirname(jobs), "usage");
  const cases = [
    path.join(jobs, "concurrency.lock"),
    path.join(jobs, "kimi-seed-aaaaaaaa.lock"),
    path.join(usage, "kimi-run-seed-aaaaaaaaaaaaaaaa.lock"),
    path.join(jobs, "foreground-seed-aaaaaaaa.manifest.lock"),
    path.join(jobs, "kimi-seed-bbbbbbbb.provision.lock")
  ];
  cases.forEach((file, index) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeStateLock(file, stateLockDocument(
      99_999_999,
      String(index + 4).repeat(32)
    ));
  });

  const swept = run(
    ["usage", "--local", "--window=all", "--scope=repo", "--json"],
    { cwd: repository, env }
  );
  assert.equal(swept.status, 0, swept.stderr);
  cases.forEach((file, index) => {
    assert.equal(fs.existsSync(file), false);
    assert.equal(
      fs.existsSync(`${file}.retired-${String(index + 4).repeat(32)}`),
      true
    );
  });
});

test("cleanup owner death after job deletion is found by the orphan lock scan", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const started = run(
    ["run", "task", "--background", "orphan cleanup lock"],
    { cwd: repository, env }
  );
  assert.equal(started.status, 0, started.stderr);
  const id = started.stdout.match(/kimi-[a-z0-9]+-[a-f0-9]{8}/)?.[0];
  assert.ok(id);
  await poll(() => /\tfinished\t/.test(
    run(["status", id], { cwd: repository, env }).stdout
  ));
  const metadata = findFile(path.join(temporary, "state"), `${id}.json`);
  assert.ok(metadata);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const cleanup = spawn(process.execPath, [
    runtime,
    "cleanup",
    "--older-than",
    "1ms",
    "--confirm",
    "--json"
  ], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_PAUSE: "after-metadata-delete",
      KIMI_TEST_STATE_LOCK_BASENAME: `${id}.lock`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const cleanupResult = collect(cleanup);
  t.after(() => { try { cleanup.kill("SIGKILL"); } catch {} });
  const jobLock = metadata.replace(/\.json$/, ".lock");
  await poll(() => !fs.existsSync(metadata) && fs.existsSync(jobLock));
  cleanup.kill("SIGKILL");
  await cleanupResult;

  const recovered = run(
    ["cleanup", "--older-than", "1ms", "--confirm", "--json"],
    { cwd: repository, env }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(jobLock), false);
  assert.ok(fs.readdirSync(path.dirname(jobLock)).some((name) =>
    new RegExp(`^${id}\\.lock\\.retired-[a-f0-9]{32}$`).test(name)
  ));
});

test("cleanup owner death after usage deletion is found by the orphan lock scan", {
  skip: process.platform === "win32",
  timeout: 25_000
}, async (t) => {
  const temporary = temporaryDirectory();
  const repository = createChangedRepository();
  cleanupTemporaryDirectories(t, temporary, repository);
  const env = fakeEnvironment(temporary);
  const foreground = run(
    ["run", "task", "foreground usage cleanup"],
    { cwd: repository, env }
  );
  assert.equal(foreground.status, 0, foreground.stderr);
  const usageDirectory = path.join(
    path.dirname(workspaceJobs(temporary, repository)),
    "usage"
  );
  const usageRecords = fs.readdirSync(usageDirectory).filter((name) =>
    /^kimi-run-[a-z0-9]+-[a-f0-9]{16}\.json$/.test(name)
  );
  assert.equal(usageRecords.length, 1);
  const usageFile = path.join(usageDirectory, usageRecords[0]);
  const usage = JSON.parse(fs.readFileSync(usageFile, "utf8"));
  assert.match(usage.id, /^kimi-run-[a-z0-9]+-[a-f0-9]{16}$/);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const cleanup = spawn(process.execPath, [
    runtime,
    "cleanup",
    "--older-than",
    "1ms",
    "--confirm",
    "--json"
  ], {
    cwd: repository,
    env: {
      ...env,
      NODE_ENV: "test",
      KIMI_TEST_STATE_LOCK_PAUSE: "after-usage-delete",
      KIMI_TEST_STATE_LOCK_BASENAME: `${usage.id}.lock`
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const cleanupResult = collect(cleanup);
  t.after(() => { try { cleanup.kill("SIGKILL"); } catch {} });
  const usageLock = usageFile.replace(/\.json$/, ".lock");
  await poll(() => !fs.existsSync(usageFile) && fs.existsSync(usageLock));
  cleanup.kill("SIGKILL");
  await cleanupResult;

  const recovered = run(
    ["cleanup", "--older-than", "1ms", "--confirm", "--json"],
    { cwd: repository, env }
  );
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.existsSync(usageLock), false);
  assert.ok(fs.readdirSync(path.dirname(usageLock)).some((name) =>
    new RegExp(`^${usage.id}\\.lock\\.retired-[a-f0-9]{32}$`).test(name)
  ));
});
