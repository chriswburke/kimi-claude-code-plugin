#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL_ROOT = fs.realpathSync(ROOT);
const PROVIDERS = ["kimi"];
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const LOCK_PARENT = path.join(ROOT, ".claude-plugin");
const LOCK_DIRECTORY = path.join(LOCK_PARENT, ".version-bump.lock");
const LOCK_OWNER_FILE = "owner.json";
const JOURNAL_FILE = path.join(LOCK_PARENT, ".version-bump.journal.json");
const LOCK_SCHEMA_VERSION = 2;
const JOURNAL_SCHEMA_VERSION = 1;
const LOCK_OWNER_MAX_BYTES = 512;
const JOURNAL_MAX_BYTES = 2 * 1024 * 1024;
const ATOMIC_TEMP_PATTERN = /^\.[A-Za-z0-9._-]+\.version-bump\.[0-9a-f]{48}\.tmp$/;
const LOCK_WAIT_MS = 30_000;
const LOCK_CLOCK_SKEW_MS = 60_000;
const LOCK_POLL_MS = 50;
const LOCK_PHASES = new Set([
  "acquired", "snapshot", "commit", "committed", "complete",
  "recover-cleanup", "recover-rollback", "recover-commit", "recovered"
]);

function packageFiles(provider) {
  return {
    packageFile: `plugins/${provider}/package.json`,
    manifestFile: `plugins/${provider}/.claude-plugin/plugin.json`,
    runtimeFile: `plugins/${provider}/scripts/companion.mjs`
  };
}

function managedFile(file) {
  const target = path.join(ROOT, file);
  const relative = path.relative(ROOT, target);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Managed version path is unsafe: ${file}.`);
  }
  for (let directory = path.dirname(target); directory !== ROOT; directory = path.dirname(directory)) {
    const stat = fs.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Managed version path is unsafe: ${file} has a non-directory or symbolic-link parent.`);
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Managed version path is unsafe: ${file} must be a regular file.`);
  const realTarget = fs.realpathSync(target);
  const realRelative = path.relative(REAL_ROOT, realTarget);
  if (realRelative === "" || realRelative === ".." || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error(`Managed version path is unsafe: ${file} resolves outside the repository.`);
  }
  return { target, stat };
}

function readText(file) {
  return fs.readFileSync(managedFile(file).target, "utf8");
}

function readJson(file, source = readText(file)) {
  try { return JSON.parse(source); }
  catch { throw new Error(`${file} is not valid JSON.`); }
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function testSlug(name) {
  if (process.env.NODE_ENV !== "test" || process.env[name] === undefined) return undefined;
  const value = process.env[name];
  if (!/^[a-z0-9-]{1,32}$/.test(value)) throw new Error(`${name} must be a lowercase test slug.`);
  return value;
}

function testMarkerFile(slug) {
  return path.join(LOCK_PARENT, `.version-bump.test.${slug}`);
}

function signalTestContention() {
  const slug = testSlug("MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER");
  if (slug === undefined) return;
  fs.writeFileSync(testMarkerFile(slug), "contended\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function waitForTestGate(environmentName, label) {
  const slug = testSlug(environmentName);
  if (slug === undefined) return;
  const gate = testMarkerFile(slug);
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const stat = fs.lstatSync(gate);
      if (stat.isSymbolicLink() || !stat.isFile()) throw lockError(`the test ${label} gate must be a regular file.`);
      assertPrivateMode(stat, `test ${label} gate`);
      if (stat.size > 64) throw lockError(`the test ${label} gate exceeds its size limit.`);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the test ${label} gate.`);
      sleepSync(10);
    }
  }
}

function waitForTestSnapshotGate() {
  waitForTestGate("MODEL_COMPANION_TEST_BUMP_SNAPSHOT_GATE", "snapshot");
}

function waitForTestAcquireGate() {
  waitForTestGate("MODEL_COMPANION_TEST_BUMP_ACQUIRE_GATE", "acquisition");
}

function lockError(message) {
  return new Error(`Version transaction lock is unsafe: ${message}`);
}

function assertPrivateMode(stat, label) {
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw lockError(`${label} must not grant group or other permissions.`);
  }
}

function assertLockParentSafe() {
  const stat = fs.lstatSync(LOCK_PARENT);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw lockError(`${path.relative(ROOT, LOCK_PARENT)} must be a real directory, not a symlink.`);
  }
}

function readBoundedRegularFileNoFollow(file, maximumBytes) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink() || !before.isFile()) throw lockError(`${path.basename(file)} must be a regular file.`);
  assertPrivateMode(before, path.basename(file));
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw lockError(`${path.basename(file)} changed while it was being inspected.`);
    }
    if (opened.size <= 0 || opened.size > maximumBytes) {
      throw lockError(`${path.basename(file)} must contain between 1 and ${maximumBytes} bytes.`);
    }
    const content = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < content.length) {
      const count = fs.readSync(descriptor, content, offset, content.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    if (offset > maximumBytes) throw lockError(`${path.basename(file)} exceeds ${maximumBytes} bytes.`);
    return content.subarray(0, offset).toString("utf8");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function parseLockOwner(source) {
  let owner;
  try { owner = JSON.parse(source); }
  catch { throw lockError(`${LOCK_OWNER_FILE} is not valid JSON.`); }
  if (!owner || typeof owner !== "object" || Array.isArray(owner)) throw lockError(`${LOCK_OWNER_FILE} must be a JSON object.`);
  const expectedKeys = ["createdAtMs", "phase", "pid", "providers", "schemaVersion", "token", "updatedAtMs"];
  const keys = Object.keys(owner).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw lockError(`${LOCK_OWNER_FILE} has an unexpected schema.`);
  }
  if (owner.schemaVersion !== LOCK_SCHEMA_VERSION) throw lockError(`${LOCK_OWNER_FILE} has an unsupported schema version.`);
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fff_ffff) throw lockError(`${LOCK_OWNER_FILE} has an invalid pid.`);
  if (typeof owner.token !== "string" || !/^[0-9a-f]{48}$/.test(owner.token)) throw lockError(`${LOCK_OWNER_FILE} has an invalid token.`);
  if (!Number.isSafeInteger(owner.createdAtMs) || owner.createdAtMs <= 0) throw lockError(`${LOCK_OWNER_FILE} has an invalid creation time.`);
  if (!Number.isSafeInteger(owner.updatedAtMs) || owner.updatedAtMs < owner.createdAtMs) throw lockError(`${LOCK_OWNER_FILE} has an invalid update time.`);
  if (owner.createdAtMs > Date.now() + LOCK_CLOCK_SKEW_MS || owner.updatedAtMs > Date.now() + LOCK_CLOCK_SKEW_MS) {
    throw lockError(`${LOCK_OWNER_FILE} has a timestamp too far in the future.`);
  }
  if (!LOCK_PHASES.has(owner.phase)) throw lockError(`${LOCK_OWNER_FILE} has an invalid phase.`);
  if (!Array.isArray(owner.providers) || owner.providers.length < 1 || owner.providers.length > PROVIDERS.length) {
    throw lockError(`${LOCK_OWNER_FILE} has an invalid provider list.`);
  }
  const canonicalProviders = PROVIDERS.filter((provider) => owner.providers.includes(provider));
  if (new Set(owner.providers).size !== owner.providers.length
      || canonicalProviders.length !== owner.providers.length
      || canonicalProviders.some((provider, index) => provider !== owner.providers[index])) {
    throw lockError(`${LOCK_OWNER_FILE} has a noncanonical provider list.`);
  }
  return owner;
}

function readLockOwner(directory = LOCK_DIRECTORY) {
  return parseLockOwner(readBoundedRegularFileNoFollow(path.join(directory, LOCK_OWNER_FILE), LOCK_OWNER_MAX_BYTES));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameProviderList(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((provider, index) => provider === right[index]);
}

function ownerMatchesLock(owner, lock) {
  return owner.token === lock.token
    && owner.pid === lock.ownerPid
    && sameProviderList(owner.providers, lock.providers);
}

function inspectLockDirectory() {
  const stat = fs.lstatSync(LOCK_DIRECTORY);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw lockError(`${path.relative(ROOT, LOCK_DIRECTORY)} must be a real directory, not a symlink.`);
  assertPrivateMode(stat, path.basename(LOCK_DIRECTORY));
  return stat;
}

function inspectExistingLockOnce(expectedIdentity) {
  const entries = fs.readdirSync(LOCK_DIRECTORY, { withFileTypes: true });
  const ownerEntry = entries.find((entry) => entry.name === LOCK_OWNER_FILE);
  const owner = ownerEntry ? readLockOwner() : undefined;
  const temporaryPattern = owner ? new RegExp(`^\\.owner\\.${owner.token}\\.tmp$`) : /^\.owner\.[0-9a-f]{48}\.tmp$/;
  let sawOwner = false;
  let temporaryCount = 0;
  for (const entry of entries) {
    if (entry.name === LOCK_OWNER_FILE && owner) {
      sawOwner = true;
      continue;
    }
    if (temporaryPattern.test(entry.name)) {
      temporaryCount += 1;
      const stat = fs.lstatSync(path.join(LOCK_DIRECTORY, entry.name));
      if (entry.isSymbolicLink() || !entry.isFile() || stat.isSymbolicLink() || !stat.isFile()) {
        throw lockError("a temporary owner must be a regular file.");
      }
      assertPrivateMode(stat, "temporary lock owner");
      if (stat.size > LOCK_OWNER_MAX_BYTES) throw lockError("a temporary owner exceeds its size limit.");
      continue;
    }
    throw lockError(`the lock directory contains unexpected entry ${JSON.stringify(entry.name)}.`);
  }
  if ((owner && !sawOwner) || temporaryCount > 1) throw lockError("the lock directory contents do not match its owner state.");
  const current = inspectLockDirectory();
  if (!sameFileIdentity(current, expectedIdentity)) return undefined;
  return { owner };
}

function inspectExistingLock(expectedIdentity) {
  try { return inspectExistingLockOnce(expectedIdentity); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertOwnedLockEntries() {
  const entries = fs.readdirSync(LOCK_DIRECTORY);
  if (entries.length !== 1 || entries[0] !== LOCK_OWNER_FILE) {
    throw lockError("the active lock directory contains unexpected entries.");
  }
}

function lockTimeoutError(waitMilliseconds, owner) {
  const state = owner
    ? `owner pid ${owner.pid}, phase ${owner.phase}, last updated ${Math.max(0, Date.now() - owner.updatedAtMs)}ms ago`
    : "no complete owner record (the acquiring process may be paused or interrupted)";
  return new Error([
    `Timed out waiting ${waitMilliseconds}ms for the version transaction lock; ${state}.`,
    "Automatic lock recovery is disabled to prevent an ABA race from displacing a live replacement lock.",
    "After confirming that no version bump process owns it, run node scripts/bump-version.mjs --recover."
  ].join(" "));
}

function assertOwnerWriteState(lock, phase, temporaryName, includeTemporary) {
  const current = inspectLockDirectory();
  if (!sameFileIdentity(current, lock.identity)) throw lockError("lock identity changed during an owner write.");
  const expectedEntries = phase === "acquired" ? [] : [LOCK_OWNER_FILE];
  if (includeTemporary) expectedEntries.push(temporaryName);
  const actualEntries = fs.readdirSync(LOCK_DIRECTORY).sort();
  expectedEntries.sort();
  if (actualEntries.length !== expectedEntries.length || actualEntries.some((entry, index) => entry !== expectedEntries[index])) {
    throw lockError("lock contents changed during an owner write.");
  }
  if (phase !== "acquired") {
    const owner = readLockOwner();
    if (!ownerMatchesLock(owner, lock)) {
      throw lockError("lock ownership changed during the transaction.");
    }
  }
}

function writeNewLockOwner(lock, phase) {
  const now = Math.max(Date.now(), lock.createdAtMs);
  const owner = {
    schemaVersion: LOCK_SCHEMA_VERSION,
    pid: process.pid,
    token: lock.token,
    createdAtMs: lock.createdAtMs,
    updatedAtMs: now,
    phase,
    providers: [...lock.providers]
  };
  const content = jsonText(owner);
  if (Buffer.byteLength(content) > LOCK_OWNER_MAX_BYTES) throw lockError(`${LOCK_OWNER_FILE} exceeds its size limit.`);
  const target = path.join(LOCK_DIRECTORY, LOCK_OWNER_FILE);
  const temporaryName = `.owner.${lock.token}.tmp`;
  const temporary = path.join(LOCK_DIRECTORY, temporaryName);
  let descriptor;
  try {
    assertOwnerWriteState(lock, phase, temporaryName, false);
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    killAtOwnerTemporaryBoundary(phase);
    assertOwnerWriteState(lock, phase, temporaryName, true);
    fs.renameSync(temporary, target);
    try { fs.chmodSync(target, 0o600); } catch { /* Windows ACLs are authoritative. */ }
    fsyncDirectory(LOCK_DIRECTORY);
    const currentDirectory = inspectLockDirectory();
    const publishedOwner = readLockOwner();
    if (!sameFileIdentity(currentDirectory, lock.identity)
        || publishedOwner.token !== lock.token
        || publishedOwner.pid !== process.pid
        || !sameProviderList(publishedOwner.providers, lock.providers)) {
      throw lockError("lock ownership changed after an owner write.");
    }
    lock.ownerPid = process.pid;
    assertOwnedLockEntries();
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

function removeOwnedOwnerTemporary(lock) {
  const temporaryName = `.owner.${lock.token}.tmp`;
  const temporary = path.join(LOCK_DIRECTORY, temporaryName);
  let temporaryStat;
  try { temporaryStat = fs.lstatSync(temporary); }
  catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (temporaryStat.isSymbolicLink() || !temporaryStat.isFile()) {
    throw lockError("the interrupted temporary owner must be a regular file.");
  }
  assertPrivateMode(temporaryStat, "interrupted temporary lock owner");
  if (temporaryStat.size > LOCK_OWNER_MAX_BYTES) throw lockError("the interrupted temporary owner exceeds its size limit.");

  const current = inspectLockDirectory();
  const owner = readLockOwner();
  const expectedEntries = [temporaryName, LOCK_OWNER_FILE].sort();
  const actualEntries = fs.readdirSync(LOCK_DIRECTORY).sort();
  if (!sameFileIdentity(current, lock.identity)
    || !ownerMatchesLock(owner, lock)
    || actualEntries.length !== expectedEntries.length
    || actualEntries.some((entry, index) => entry !== expectedEntries[index])) {
    throw lockError("lock ownership changed before interrupted owner cleanup.");
  }
  fs.unlinkSync(temporary);
  fsyncDirectory(LOCK_DIRECTORY);
  return true;
}

function acquireTransactionLock(providers) {
  const canonicalProviders = PROVIDERS.filter((provider) => providers?.includes(provider));
  if (!Array.isArray(providers)
      || providers.length < 1
      || providers.length > PROVIDERS.length
      || new Set(providers).size !== providers.length
      || canonicalProviders.length !== providers.length
      || canonicalProviders.some((provider, index) => provider !== providers[index])) {
    throw lockError("a transaction requires a canonical provider list.");
  }
  assertLockParentSafe();
  const waitMilliseconds = testInteger("MODEL_COMPANION_TEST_BUMP_LOCK_WAIT_MS", 5_000) ?? LOCK_WAIT_MS;
  const deadline = Date.now() + waitMilliseconds;
  let signalledContention = false;
  let observedOwner;
  while (true) {
    try {
      fs.mkdirSync(LOCK_DIRECTORY, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let stat;
      try { stat = inspectLockDirectory(); }
      catch (inspectionError) {
        if (inspectionError?.code === "ENOENT") continue;
        throw inspectionError;
      }
      const observation = inspectExistingLock(stat);
      if (observation === undefined) continue;
      observedOwner = observation.owner;
      if (!signalledContention) {
        signalTestContention();
        signalledContention = true;
      }
      if (Date.now() >= deadline) throw lockTimeoutError(waitMilliseconds, observedOwner);
      sleepSync(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
      continue;
    }
    try { fs.chmodSync(LOCK_DIRECTORY, 0o700); } catch { /* Windows ACLs are authoritative. */ }
    fsyncDirectory(LOCK_PARENT);
    const identity = inspectLockDirectory();
    const lock = {
      token: crypto.randomBytes(24).toString("hex"),
      createdAtMs: Date.now(),
      identity,
      ownerPid: process.pid,
      providers: Object.freeze([...providers])
    };
    try {
      waitForTestAcquireGate();
      writeNewLockOwner(lock, "acquired");
      return lock;
    } catch (error) {
      let cleanupError;
      try {
        const current = inspectLockDirectory();
        if (!sameFileIdentity(current, lock.identity)) throw lockError("refusing to clean up an uninitialized replacement lock.");
        if (fs.readdirSync(LOCK_DIRECTORY).length === 0) {
          fs.rmdirSync(LOCK_DIRECTORY);
          fsyncDirectory(LOCK_PARENT);
        }
      } catch (candidate) {
        if (candidate?.code !== "ENOENT") cleanupError = candidate;
      }
      if (cleanupError) throw new Error(`${error.message}\nUninitialized lock cleanup also failed: ${cleanupError.message}`, { cause: error });
      throw error;
    }
  }
}

function releaseTransactionLock(lock) {
  const current = inspectLockDirectory();
  const owner = readLockOwner();
  if (!sameFileIdentity(current, lock.identity) || !ownerMatchesLock(owner, lock)) {
    throw lockError("refusing to release a lock owned by another transaction.");
  }
  assertOwnedLockEntries();
  fs.unlinkSync(path.join(LOCK_DIRECTORY, LOCK_OWNER_FILE));
  fsyncDirectory(LOCK_DIRECTORY);
  if (process.env.NODE_ENV === "test" && process.env.MODEL_COMPANION_TEST_BUMP_KILL_AFTER_OWNER_UNLINK === "1") forceTestProcessExit();
  const emptied = inspectLockDirectory();
  if (!sameFileIdentity(emptied, lock.identity) || fs.readdirSync(LOCK_DIRECTORY).length !== 0) {
    throw lockError("lock identity or contents changed during release.");
  }
  fs.rmdirSync(LOCK_DIRECTORY);
  fsyncDirectory(LOCK_PARENT);
}

function withTransactionLock(providers, callback) {
  const lock = acquireTransactionLock(providers);
  let result;
  let primaryError;
  try {
    result = callback(lock);
  } catch (error) {
    primaryError = error;
  }
  if (!primaryError?.retainVersionLock) {
    try {
      releaseTransactionLock(lock);
    } catch (cleanupError) {
      if (!primaryError) throw cleanupError;
      throw new Error(`${primaryError.message}\nVersion transaction lock cleanup also failed: ${cleanupError.message}`, { cause: primaryError });
    }
  }
  if (primaryError) {
    if (primaryError.retainVersionLock) {
      throw new Error(`${primaryError.message}\nThe durable version journal was retained. Run node scripts/bump-version.mjs --recover after this process exits.`, { cause: primaryError });
    }
    throw primaryError;
  }
  return result;
}

function testInteger(name, maximum) {
  if (process.env.NODE_ENV !== "test" || process.env[name] === undefined) return undefined;
  const raw = process.env[name];
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name} must be a positive integer in test mode.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > maximum) throw new Error(`${name} exceeds its test-mode limit of ${maximum}.`);
  return value;
}

function killAtJournalBoundary(boundary) {
  if (process.env.NODE_ENV !== "test") return;
  const configured = process.env.MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL;
  if (configured === undefined) return;
  const allowed = new Set(["temporary", "published", "snapshot", "removed", "recovery-removed"]);
  if (!allowed.has(configured)) throw new Error("MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL has an invalid test boundary.");
  if (configured === boundary) forceTestProcessExit();
}

function killAtOwnerTemporaryBoundary(phase) {
  if (process.env.NODE_ENV !== "test") return;
  const configured = process.env.MODEL_COMPANION_TEST_BUMP_KILL_AT_OWNER_TEMP;
  if (configured === undefined) return;
  if (!LOCK_PHASES.has(configured)) throw new Error("MODEL_COMPANION_TEST_BUMP_KILL_AT_OWNER_TEMP has an invalid phase.");
  if (configured === phase) forceTestProcessExit();
}

function usage() {
  return [
    "Usage:",
    "  node scripts/bump-version.mjs --check [kimi]",
    "  node scripts/bump-version.mjs --recover",
    "  node scripts/bump-version.mjs kimi <version> --marketplace-version <version>"
  ].join("\n");
}

function assertVersion(value, label) {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new Error(`${label} is not a valid semantic version: ${value ?? "<missing>"}`);
  }
}

function compareVersions(left, right) {
  const leftMatch = left.match(VERSION_PATTERN);
  const rightMatch = right.match(VERSION_PATTERN);
  if (!leftMatch || !rightMatch) throw new Error("Cannot compare invalid semantic versions.");
  const compareNumeric = (leftValue, rightValue) => {
    if (leftValue.length !== rightValue.length) return leftValue.length < rightValue.length ? -1 : 1;
    if (leftValue === rightValue) return 0;
    return leftValue < rightValue ? -1 : 1;
  };
  for (let index = 1; index <= 3; index += 1) {
    const comparison = compareNumeric(leftMatch[index], rightMatch[index]);
    if (comparison !== 0) return comparison;
  }
  const leftPre = leftMatch[4]?.split(".");
  const rightPre = rightMatch[4]?.split(".");
  if (!leftPre && !rightPre) return 0;
  if (!leftPre) return 1;
  if (!rightPre) return -1;
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPre[index] === undefined) return -1;
    if (rightPre[index] === undefined) return 1;
    if (leftPre[index] === rightPre[index]) continue;
    const leftNumeric = /^\d+$/.test(leftPre[index]);
    const rightNumeric = /^\d+$/.test(rightPre[index]);
    if (leftNumeric && rightNumeric) return compareNumeric(leftPre[index], rightPre[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPre[index] < rightPre[index] ? -1 : 1;
  }
  return 0;
}

function marketplaceEntry(marketplace, provider) {
  const matches = marketplace.plugins?.filter((candidate) => candidate?.name === provider) || [];
  if (matches.length !== 1) throw new Error(`Marketplace must contain exactly one ${provider} entry; found ${matches.length}.`);
  return matches[0];
}

function runtimeVersion(file, source) {
  const matches = [...source.matchAll(/^const VERSION = "([^"]+)";$/gm)];
  if (matches.length !== 1) throw new Error(`${file} must contain exactly one const VERSION declaration.`);
  return matches[0][1];
}

function stateReader(overrides = new Map()) {
  return (file) => overrides.has(file) ? overrides.get(file) : readText(file);
}

function selectedProviders(target) {
  if (PROVIDERS.includes(target)) return [target];
  throw new Error(usage());
}

function validateState(read = stateReader(), providers = PROVIDERS) {
  const marketplace = readJson(MARKETPLACE_FILE, read(MARKETPLACE_FILE));
  const versions = [];
  const failures = [];
  const seenNames = new Set();
  for (const entry of marketplace.plugins || []) {
    if (typeof entry?.name !== "string" || seenNames.has(entry.name)) failures.push(`Marketplace plugin name is missing or duplicated: ${entry?.name ?? "<missing>"}.`);
    else seenNames.add(entry.name);
  }
  if (!Array.isArray(marketplace.plugins)
      || marketplace.plugins.length !== PROVIDERS.length
      || PROVIDERS.some((provider) => !seenNames.has(provider))) {
    failures.push(`Marketplace plugin set must be exactly: ${PROVIDERS.join(", ")}.`);
  }
  for (const provider of providers) {
    const files = packageFiles(provider);
    const packageJson = readJson(files.packageFile, read(files.packageFile));
    const manifest = readJson(files.manifestFile, read(files.manifestFile));
    let entry;
    try { entry = marketplaceEntry(marketplace, provider); } catch (error) { failures.push(error.message); continue; }
    const version = manifest.version;
    try { assertVersion(version, `${files.manifestFile} version`); } catch (error) { failures.push(error.message); }
    if (packageJson.version !== version) failures.push(`${files.packageFile} version must equal plugin authority ${version}.`);
    if (Object.hasOwn(entry, "version")) failures.push(`Marketplace ${provider} entry must omit version because plugin.json is authoritative.`);
    if (manifest.name !== provider) failures.push(`${files.manifestFile} name must be ${provider}.`);
    try {
      const runtime = runtimeVersion(files.runtimeFile, read(files.runtimeFile));
      if (runtime !== version) failures.push(`${files.runtimeFile} VERSION must equal ${version}.`);
    } catch (error) { failures.push(error.message); }
    versions.push(version);
  }
  try { assertVersion(marketplace.version, "Marketplace version"); } catch (error) { failures.push(error.message); }
  if (typeof marketplace.description !== "string" || !marketplace.description.trim()) failures.push("Marketplace must have a top-level description.");
  if (Object.hasOwn(marketplace, "metadata")) failures.push("Marketplace metadata must use preferred top-level fields.");
  if (failures.length) throw new Error(`Version metadata is inconsistent:\n${failures.join("\n")}`);
  return { marketplace, versions };
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Preserve the original failure. */ }
  }
}

function atomicTemporaryFile(file, token) {
  const target = path.join(ROOT, file);
  return path.join(path.dirname(target), `.${path.basename(target)}.version-bump.${token}.tmp`);
}

function atomicWrite(file, content, lock) {
  if (!lock || typeof lock.token !== "string" || !/^[0-9a-f]{48}$/.test(lock.token)) {
    throw lockError("an atomic version write requires the active transaction token.");
  }
  const { target, stat: targetStat } = managedFile(file);
  const mode = targetStat.mode;
  const temporary = atomicTemporaryFile(file, lock.token);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", mode);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    const killAfterTemporaries = testInteger("MODEL_COMPANION_TEST_BUMP_KILL_AFTER_ATOMIC_TEMP", 10_000);
    atomicWrite.temporaryCount = (atomicWrite.temporaryCount || 0) + 1;
    if (killAfterTemporaries === atomicWrite.temporaryCount) forceTestProcessExit();
    fs.renameSync(temporary, target);
    const failAfterRenames = testInteger("MODEL_COMPANION_TEST_BUMP_FAIL_AFTER_ATOMIC_RENAME", 10_000);
    atomicWrite.renameCount = (atomicWrite.renameCount || 0) + 1;
    if (failAfterRenames === atomicWrite.renameCount) throw new Error("Injected failure after an atomic version rename.");
    fsyncDirectory(path.dirname(target));
    try { fs.chmodSync(target, mode); } catch { /* Windows ACLs are authoritative. */ }
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

function removeOwnedAtomicTemporaries(lock, files) {
  const expected = new Map([...files].map((file) => [atomicTemporaryFile(file, lock.token), file]));
  const directories = new Set([...expected.keys()].map((file) => path.dirname(file)));
  const owned = [];
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!ATOMIC_TEMP_PATTERN.test(entry.name)) continue;
      const filename = path.join(directory, entry.name);
      if (!expected.has(filename)) throw journalError(`an unowned atomic-write temporary file exists at ${path.relative(ROOT, filename)}.`);
      const stat = fs.lstatSync(filename);
      if (entry.isSymbolicLink() || !entry.isFile() || stat.isSymbolicLink() || !stat.isFile()) {
        throw journalError(`${path.relative(ROOT, filename)} must be a regular file.`);
      }
      if (stat.size > JOURNAL_MAX_BYTES) throw journalError(`${path.relative(ROOT, filename)} exceeds the recovery size limit.`);
      owned.push({ filename, stat });
    }
  }
  const synced = new Set();
  for (const { filename, stat } of owned) {
    const currentLock = inspectLockDirectory();
    const owner = readLockOwner();
    const currentTemporary = fs.lstatSync(filename);
    if (!sameFileIdentity(currentLock, lock.identity)
      || !ownerMatchesLock(owner, lock)
      || currentTemporary.isSymbolicLink()
      || !currentTemporary.isFile()
      || !sameFileIdentity(currentTemporary, stat)) {
      throw lockError("lock ownership or an atomic-write temporary changed before cleanup.");
    }
    fs.unlinkSync(filename);
    synced.add(path.dirname(filename));
  }
  for (const directory of synced) fsyncDirectory(directory);
  return owned.length;
}

function sha256Text(content) {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function expectedJournalFiles(providers) {
  const files = new Set([MARKETPLACE_FILE]);
  for (const provider of providers) Object.values(packageFiles(provider)).forEach((file) => files.add(file));
  return [...files].sort();
}

function journalError(message) {
  return lockError(`the durable journal is unsafe: ${message}`);
}

function parseJournal(source) {
  let journal;
  try { journal = JSON.parse(source); }
  catch { throw journalError("it is not valid JSON."); }
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) throw journalError("it must be a JSON object.");
  const expectedKeys = ["createdAtMs", "files", "providers", "schemaVersion", "token"];
  const keys = Object.keys(journal).sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw journalError("it has an unexpected schema.");
  }
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION) throw journalError("it has an unsupported schema version.");
  if (typeof journal.token !== "string" || !/^[0-9a-f]{48}$/.test(journal.token)) throw journalError("it has an invalid token.");
  if (!Number.isSafeInteger(journal.createdAtMs) || journal.createdAtMs <= 0 || journal.createdAtMs > Date.now() + LOCK_CLOCK_SKEW_MS) {
    throw journalError("it has an invalid creation time.");
  }
  if (!Array.isArray(journal.providers) || journal.providers.length < 1 || journal.providers.length > PROVIDERS.length) {
    throw journalError("it has an invalid provider list.");
  }
  const canonicalProviders = PROVIDERS.filter((provider) => journal.providers.includes(provider));
  if (new Set(journal.providers).size !== journal.providers.length
      || canonicalProviders.length !== journal.providers.length
      || canonicalProviders.some((provider, index) => provider !== journal.providers[index])) {
    throw journalError("its provider list is not canonical.");
  }
  const expectedFiles = expectedJournalFiles(journal.providers);
  if (!Array.isArray(journal.files) || journal.files.length !== expectedFiles.length) {
    throw journalError("its file list is incomplete.");
  }
  const decoded = new Map();
  for (const [index, entry] of journal.files.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw journalError("a file entry is invalid.");
    const entryKeys = Object.keys(entry).sort();
    const expectedEntryKeys = ["original", "originalSha256", "path", "replacementSha256"];
    if (entryKeys.length !== expectedEntryKeys.length || entryKeys.some((key, keyIndex) => key !== expectedEntryKeys[keyIndex])) {
      throw journalError("a file entry has an unexpected schema.");
    }
    if (entry.path !== expectedFiles[index]) throw journalError("its file paths do not match the selected providers.");
    if (typeof entry.original !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(entry.original)) throw journalError(`${entry.path} has invalid original bytes.`);
    const original = Buffer.from(entry.original, "base64");
    if (!original.length || original.toString("base64") !== entry.original) throw journalError(`${entry.path} has noncanonical original bytes.`);
    if (!/^[0-9a-f]{64}$/.test(entry.originalSha256) || !/^[0-9a-f]{64}$/.test(entry.replacementSha256)) {
      throw journalError(`${entry.path} has an invalid digest.`);
    }
    const originalText = original.toString("utf8");
    if (Buffer.from(originalText, "utf8").compare(original) !== 0 || sha256Text(originalText) !== entry.originalSha256) {
      throw journalError(`${entry.path} original bytes do not match their digest.`);
    }
    decoded.set(entry.path, { ...entry, originalText });
  }
  return { ...journal, decoded };
}

function readJournal() {
  return parseJournal(readBoundedRegularFileNoFollow(JOURNAL_FILE, JOURNAL_MAX_BYTES));
}

function journalTemporaryFile(token) {
  return path.join(LOCK_PARENT, `.version-bump.journal.${token}.tmp`);
}

function journalTemporaryEntries() {
  return fs.readdirSync(LOCK_PARENT)
    .filter((name) => /^\.version-bump\.journal\.[0-9a-f]{48}\.tmp$/.test(name));
}

function inspectOwnedJournalTemporary(token) {
  const expectedName = path.basename(journalTemporaryFile(token));
  const entries = journalTemporaryEntries();
  if (entries.some((name) => name !== expectedName)) throw journalError("an unowned journal temporary file exists.");
  if (!entries.includes(expectedName)) return false;
  const filename = journalTemporaryFile(token);
  const before = fs.lstatSync(filename);
  if (before.isSymbolicLink() || !before.isFile()) throw journalError("its owned temporary path is not a regular file.");
  assertPrivateMode(before, "temporary version journal");
  if (before.size > JOURNAL_MAX_BYTES) throw journalError("its owned temporary file exceeds the size limit.");
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let descriptor;
  try {
    descriptor = fs.openSync(filename, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(opened, before)) throw journalError("its owned temporary file changed during inspection.");
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  return true;
}

function assertJournalAbsent() {
  try {
    fs.lstatSync(JOURNAL_FILE);
    throw new Error("A durable version journal already exists. Run node scripts/bump-version.mjs --recover before starting another bump.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryEntries = journalTemporaryEntries();
  if (temporaryEntries.length) throw new Error("A durable version journal temporary file already exists. Run node scripts/bump-version.mjs --recover before starting another bump.");
}

function writeJournal(lock, changes, originals, providers) {
  assertJournalAbsent();
  if (providers.length !== lock.providers.length
      || providers.some((provider, index) => provider !== lock.providers[index])) {
    throw journalError("its provider list does not match the active lock.");
  }
  const files = [...changes.keys()].sort().map((file) => {
    const original = originals.get(file);
    const replacement = changes.get(file);
    return {
      path: file,
      original: Buffer.from(original, "utf8").toString("base64"),
      originalSha256: sha256Text(original),
      replacementSha256: sha256Text(replacement)
    };
  });
  const journal = {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    token: lock.token,
    createdAtMs: Math.max(Date.now(), lock.createdAtMs),
    providers: [...providers],
    files
  };
  const content = jsonText(journal);
  if (Buffer.byteLength(content) > JOURNAL_MAX_BYTES) throw journalError(`it exceeds ${JOURNAL_MAX_BYTES} bytes.`);
  const temporary = journalTemporaryFile(lock.token);
  let descriptor;
  try {
    const current = inspectLockDirectory();
    const owner = readLockOwner();
    if (!sameFileIdentity(current, lock.identity) || !ownerMatchesLock(owner, lock)) {
      throw lockError("lock ownership changed before the journal write.");
    }
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    killAtJournalBoundary("temporary");
    fs.renameSync(temporary, JOURNAL_FILE);
    fsyncDirectory(LOCK_PARENT);
    try { fs.chmodSync(JOURNAL_FILE, 0o600); } catch { /* Windows ACLs are authoritative. */ }
    const persisted = readJournal();
    if (persisted.token !== lock.token || !sameProviderList(persisted.providers, lock.providers)) {
      throw journalError("its transaction identity changed after publication.");
    }
    killAtJournalBoundary("published");
  } finally {
    if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Preserve the original failure. */ }
    try { fs.unlinkSync(temporary); } catch { /* Renamed or never created. */ }
  }
}

function removeJournal(lock) {
  const journal = readJournal();
  if (journal.token !== lock.token || !sameProviderList(journal.providers, lock.providers)) {
    throw journalError("its transaction identity does not match the active lock.");
  }
  fs.unlinkSync(JOURNAL_FILE);
  fsyncDirectory(LOCK_PARENT);
}

function removeOwnedJournalTemporary(lock) {
  if (!inspectOwnedJournalTemporary(lock.token)) return false;
  const current = inspectLockDirectory();
  const owner = readLockOwner();
  if (!sameFileIdentity(current, lock.identity) || !ownerMatchesLock(owner, lock)) {
    throw lockError("lock ownership changed before temporary journal cleanup.");
  }
  fs.unlinkSync(journalTemporaryFile(lock.token));
  fsyncDirectory(LOCK_PARENT);
  return true;
}

function forceTestProcessExit() {
  try { process.kill(process.pid, "SIGKILL"); }
  catch { process.abort(); }
}

function commitChanges(lock, changes, originals, providers = PROVIDERS) {
  const committed = [];
  const failAfterWrites = testInteger("MODEL_COMPANION_TEST_BUMP_FAIL_AFTER_WRITE", 10_000);
  const killAfterWrites = testInteger("MODEL_COMPANION_TEST_BUMP_KILL_AFTER_WRITE", 10_000);
  try {
    for (const [file, content] of changes) {
      committed.push(file);
      atomicWrite(file, content, lock);
      if (killAfterWrites === committed.length) forceTestProcessExit();
      if (failAfterWrites === committed.length) throw new Error("Injected version commit failure.");
    }
    validateState(stateReader(), providers);
  } catch (error) {
    const rollbackFailures = [];
    for (const file of committed.reverse()) {
      try { atomicWrite(file, originals.get(file), lock); }
      catch (rollbackError) { rollbackFailures.push(`${file}: ${rollbackError.message}`); }
    }
    if (!rollbackFailures.length) {
      try { removeOwnedAtomicTemporaries(lock, changes.keys()); }
      catch (rollbackError) { rollbackFailures.push(`temporary cleanup: ${rollbackError.message}`); }
    }
    if (!rollbackFailures.length) {
      try { validateState(stateReader(), providers); }
      catch (rollbackError) { rollbackFailures.push(`validation: ${rollbackError.message}`); }
    }
    if (!rollbackFailures.length) {
      try {
        writeNewLockOwner(lock, "recovered");
        removeJournal(lock);
        killAtJournalBoundary("recovery-removed");
      }
      catch (rollbackError) { rollbackFailures.push(`journal: ${rollbackError.message}`); }
    }
    if (rollbackFailures.length) {
      const retained = new Error(`${error.message}\nRollback also failed:\n${rollbackFailures.join("\n")}`);
      retained.retainVersionLock = true;
      throw retained;
    }
    throw error;
  }
}

function check(target = "kimi") {
  const providers = selectedProviders(target);
  const { marketplace, versions } = validateState(stateReader(), providers);
  process.stdout.write(`Version metadata is consistent: ${providers.map((provider, index) => `${provider}@${versions[index]}`).join(", ")}; marketplace@${marketplace.version}\n`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

function recover() {
  assertLockParentSafe();
  let identity;
  try { identity = inspectLockDirectory(); }
  catch (error) {
    if (error?.code === "ENOENT") {
      if (fs.existsSync(JOURNAL_FILE) || journalTemporaryEntries().length) {
        throw journalError("journal state exists without a transaction lock; restore the affected files from version control before removing it.");
      }
      process.stdout.write("No interrupted version transaction needs recovery.\n");
      return;
    }
    throw error;
  }
  const observation = inspectExistingLock(identity);
  if (!observation?.owner) throw lockError("the lock has no owner record; confirm its origin before removing it manually.");
  const owner = observation.owner;
  if (processIsAlive(owner.pid)) throw new Error(`Refusing recovery because version transaction owner pid ${owner.pid} is still active.`);
  const lock = {
    token: owner.token,
    createdAtMs: owner.createdAtMs,
    identity,
    ownerPid: owner.pid,
    providers: Object.freeze([...owner.providers])
  };
  removeOwnedOwnerTemporary(lock);

  const hasJournal = fs.existsSync(JOURNAL_FILE);
  const hasOwnedTemporary = inspectOwnedJournalTemporary(owner.token);
  if (hasJournal && hasOwnedTemporary) throw journalError("both a published journal and its temporary file exist.");

  if (["acquired", "recover-cleanup"].includes(owner.phase) && !hasJournal) {
    writeNewLockOwner(lock, "recover-cleanup");
    if (hasOwnedTemporary) removeOwnedJournalTemporary(lock);
    releaseTransactionLock(lock);
    process.stdout.write("Removed an interrupted pre-commit version lock; no files required restoration.\n");
    return;
  }

  if (!hasJournal) {
    if (!["committed", "complete", "recover-commit", "recover-rollback", "recovered"].includes(owner.phase)) {
      throw journalError(`it is missing during nonterminal phase ${owner.phase}.`);
    }
    writeNewLockOwner(lock, ["recover-rollback", "recovered"].includes(owner.phase) ? "recovered" : "complete");
    validateState(stateReader(), lock.providers);
    releaseTransactionLock(lock);
    process.stdout.write("Validated terminal version state and removed its interrupted lock.\n");
    return;
  }

  const journal = readJournal();
  if (journal.token !== owner.token
      || journal.createdAtMs < owner.createdAtMs
      || journal.providers.length !== lock.providers.length
      || journal.providers.some((provider, index) => provider !== lock.providers[index])) {
    throw journalError("its identity does not match the interrupted transaction.");
  }
  const finalize = ["committed", "complete", "recover-commit"].includes(owner.phase);
  const alreadyRolledBack = owner.phase === "recovered";
  if (!["acquired", "snapshot", "commit", "committed", "complete", "recover-rollback", "recover-commit", "recovered"].includes(owner.phase)) {
    throw lockError(`phase ${owner.phase} cannot be recovered.`);
  }
  const observed = new Map();
  for (const [file, entry] of journal.decoded) {
    const current = readText(file);
    const digest = sha256Text(current);
    if (digest !== entry.originalSha256 && digest !== entry.replacementSha256) {
      throw journalError(`${file} differs from both the original and intended replacement; no recovery files were changed.`);
    }
    observed.set(file, { current, digest, entry });
  }
  if (finalize && [...observed.values()].some(({ digest, entry }) => digest !== entry.replacementSha256)) {
    throw journalError("a committed transaction does not contain every intended replacement; no recovery files were changed.");
  }
  if (alreadyRolledBack && [...observed.values()].some(({ digest, entry }) => digest !== entry.originalSha256)) {
    throw journalError("a recovered transaction does not contain every original file; no recovery files were changed.");
  }

  writeNewLockOwner(lock, finalize ? "recover-commit" : alreadyRolledBack ? "recovered" : "recover-rollback");
  removeOwnedAtomicTemporaries(lock, journal.decoded.keys());
  if (!finalize && !alreadyRolledBack) {
    for (const [file, { digest, entry }] of observed) {
      if (digest !== entry.originalSha256) atomicWrite(file, entry.originalText, lock);
    }
    validateState(stateReader(), journal.providers);
  } else {
    validateState(stateReader(), journal.providers);
  }
  writeNewLockOwner(lock, finalize ? "complete" : "recovered");
  removeJournal(lock);
  killAtJournalBoundary("recovery-removed");
  releaseTransactionLock(lock);
  process.stdout.write(finalize
    ? "Finalized a committed version transaction and removed its journal.\n"
    : "Rolled back an interrupted version transaction from its durable journal.\n");
}

function bump(target, version, marketplaceVersion) {
  assertVersion(version, "Requested version");
  assertVersion(marketplaceVersion, "Requested marketplace version");
  const selected = [target];
  if (!selected.every((provider) => PROVIDERS.includes(provider))) throw new Error(usage());
  withTransactionLock(selected, (lock) => {
    assertJournalAbsent();
    const currentState = validateState(stateReader(), selected);
    for (const [index, provider] of selected.entries()) {
      if (compareVersions(version, currentState.versions[index]) <= 0) {
        throw new Error(`Requested ${provider} version ${version} must advance ${currentState.versions[index]}.`);
      }
    }
    if (compareVersions(marketplaceVersion, currentState.marketplace.version) <= 0) {
      throw new Error(`Requested marketplace version ${marketplaceVersion} must advance ${currentState.marketplace.version}.`);
    }
    const touched = new Set([MARKETPLACE_FILE]);
    for (const provider of selected) Object.values(packageFiles(provider)).forEach((file) => touched.add(file));
    const originals = new Map([...touched].map((file) => [file, readText(file)]));
    const changes = new Map();
    const marketplace = readJson(MARKETPLACE_FILE, originals.get(MARKETPLACE_FILE));

    for (const provider of selected) {
      const files = packageFiles(provider);
      const packageJson = readJson(files.packageFile, originals.get(files.packageFile));
      const manifest = readJson(files.manifestFile, originals.get(files.manifestFile));
      packageJson.version = version;
      manifest.version = version;
      changes.set(files.packageFile, jsonText(packageJson));
      changes.set(files.manifestFile, jsonText(manifest));
      const runtime = originals.get(files.runtimeFile);
      runtimeVersion(files.runtimeFile, runtime);
      changes.set(files.runtimeFile, runtime.replace(/^const VERSION = "[^"]+";$/m, `const VERSION = ${JSON.stringify(version)};`));
    }

    marketplace.version = marketplaceVersion;
    changes.set(MARKETPLACE_FILE, jsonText(marketplace));

    validateState(stateReader(changes), selected);
    try {
      writeJournal(lock, changes, originals, selected);
      writeNewLockOwner(lock, "snapshot");
      killAtJournalBoundary("snapshot");
      waitForTestSnapshotGate();
      writeNewLockOwner(lock, "commit");
      commitChanges(lock, changes, originals, selected);
      writeNewLockOwner(lock, "committed");
      if (process.env.NODE_ENV === "test" && process.env.MODEL_COMPANION_TEST_BUMP_KILL_AFTER_COMMITTED === "1") forceTestProcessExit();
      writeNewLockOwner(lock, "complete");
      removeJournal(lock);
      killAtJournalBoundary("removed");
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      let retainedState = false;
      try {
        retainedState = fs.existsSync(JOURNAL_FILE) || inspectOwnedJournalTemporary(lock.token);
      } catch (inspectionError) {
        const unsafe = new Error(`${failure.message}\nCould not inspect durable journal state: ${inspectionError.message}`, { cause: failure });
        unsafe.retainVersionLock = true;
        throw unsafe;
      }
      if (retainedState) failure.retainVersionLock = true;
      throw failure;
    }
  });
  process.stdout.write(`Updated Kimi to ${version} and marketplace to ${marketplaceVersion}.\n`);
}

const args = process.argv.slice(2);
try {
  if ((args.length === 1 || args.length === 2) && args[0] === "--check") check(args[1]);
  else if (args.length === 1 && args[0] === "--recover") recover();
  else if (args.length === 4 && args[2] === "--marketplace-version") bump(args[0], args[1], args[3]);
  else throw new Error(usage());
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
