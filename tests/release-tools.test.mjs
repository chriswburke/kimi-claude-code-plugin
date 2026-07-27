import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolatedNpmEnvironment, resolveNpmInvocation } from "../scripts/npm-launcher.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function copyFile(sourceRoot, destinationRoot, relative) {
  const destination = path.join(destinationRoot, relative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(sourceRoot, relative), destination);
}

function readJson(root, relative) {
  return JSON.parse(fs.readFileSync(path.join(root, relative), "utf8"));
}

function runNode(script, args, cwd, options = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    env: options.env || process.env,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true
  });
}

function spawnNode(script, args, cwd, options = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for ${path.basename(script)} ${args.join(" ")}.`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, completed };
}

async function waitForLockPhase(root, phase, processHandle) {
  const ownerFile = path.join(root, ".claude-plugin", ".version-bump.lock", "owner.json");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Version process exited before reaching lock phase ${phase}.`);
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, "utf8"));
      if (owner.phase === phase) return owner;
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for version lock phase ${phase}.`);
}

async function waitForTestMarker(root, slug, processHandle) {
  const marker = path.join(root, ".claude-plugin", `.version-bump.test.${slug}`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error(`Version process exited before creating test marker ${slug}.`);
    try {
      if (fs.lstatSync(marker).isFile()) return marker;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for version test marker ${slug}.`);
}

async function waitForOwnerlessLock(root, processHandle) {
  const lockDirectory = path.join(root, ".claude-plugin", ".version-bump.lock");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) throw new Error("Version process exited before pausing with an ownerless lock.");
    try {
      const stat = fs.lstatSync(lockDirectory);
      if (stat.isDirectory() && fs.readdirSync(lockDirectory).length === 0) return stat;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for an ownerless version lock.");
}

function copyVersionFixture(temporary) {
  const files = [
    "scripts/bump-version.mjs",
    ".claude-plugin/marketplace.json",
    "plugins/kimi/package.json",
    "plugins/kimi/.claude-plugin/plugin.json",
    "plugins/kimi/scripts/companion.mjs"
  ];
  for (const file of files) copyFile(ROOT, temporary, file);
  return files;
}

function isolatedEnvironment(temporary) {
  const env = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL", "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const home = path.join(temporary, "home");
  const cache = path.join(temporary, "npm-cache");
  fs.mkdirSync(home);
  fs.mkdirSync(cache);
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    npm_config_cache: cache,
    npm_config_userconfig: path.join(home, "user.npmrc"),
    npm_config_globalconfig: path.join(home, "global.npmrc"),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false"
  };
}

function filesBelow(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(target));
    else files.push(target);
  }
  return files;
}

test("npm launcher bypasses Windows command shims and uses Node with npm-cli.js", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-npm-launcher-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const node = path.join(temporary, "node.exe");
  const npmCli = path.join(temporary, "node_modules", "npm", "bin", "npm-cli.js");
  const shim = path.join(temporary, "npm.cmd");
  fs.mkdirSync(path.dirname(npmCli), { recursive: true });
  fs.writeFileSync(node, "test node executable\n");
  fs.writeFileSync(npmCli, "test npm cli\n");
  fs.writeFileSync(shim, "malicious shim\n");

  const invocation = resolveNpmInvocation({ execPath: node, platform: "win32" });
  assert.equal(invocation.command, fs.realpathSync(node));
  assert.deepEqual(invocation.argsPrefix, [fs.realpathSync(npmCli)]);
  assert.equal(invocation.npmCli, fs.realpathSync(npmCli));
  assert.doesNotMatch(invocation.command, /\.cmd$/i);

  const environment = isolatedNpmEnvironment(temporary, { PATH: temporary, HOME: "/untrusted", VOLTA_HOME: "/untrusted" });
  assert.equal(environment.PATH, temporary);
  assert.equal(environment.HOME, path.join(temporary, "npm-home"));
  assert.equal(Object.hasOwn(environment, "VOLTA_HOME"), false);
});

test("release tags use conventional v<semver> names and must match plugin.json", () => {
  const script = path.join(ROOT, "scripts", "verify-release-target.mjs");
  const version = readJson(ROOT, "plugins/kimi/.claude-plugin/plugin.json").version;
  const accepted = runNode(script, [`v${version}`], ROOT);
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.match(accepted.stdout, new RegExp(`kimi@${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const mismatch = runNode(script, ["v9.8.7-wrong.1"], ROOT);
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match .*plugin\.json version/);
  for (const denied of [`kimi-v${version}`, `glm-v${version}`]) {
    const result = runNode(script, [denied], ROOT);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must match v<semver>/);
  }
  const manual = runNode(script, [], ROOT);
  assert.equal(manual.status, 0, manual.stderr || manual.stdout);
});

test("version tooling advances Kimi and the marketplace separately", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const target = "9.8.7-test.1";
  const marketplaceBefore = readJson(temporary, ".claude-plugin/marketplace.json").version;

  const first = runNode(script, ["kimi", target, "--marketplace-version", "9.8.7-market.1"], temporary);
  assert.equal(first.error, undefined, first.error?.message);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, target);
  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").version, "9.8.7-market.1");
  assert.notEqual(readJson(temporary, ".claude-plugin/marketplace.json").version, marketplaceBefore);
  assert.match(fs.readFileSync(path.join(temporary, "plugins/kimi/scripts/companion.mjs"), "utf8"), /^const VERSION = "9\.8\.7-test\.1";$/m);

  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").plugins.some((entry) => Object.hasOwn(entry, "version")), false);
  const checked = runNode(script, ["--check"], temporary);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);

  const before = fs.readFileSync(path.join(temporary, ".claude-plugin/marketplace.json"), "utf8");
  const invalid = runNode(script, ["kimi", "1.02.0", "--marketplace-version", "9.8.7-market.3"], temporary);
  assert.notEqual(invalid.status, 0);
  assert.equal(fs.readFileSync(path.join(temporary, ".claude-plugin/marketplace.json"), "utf8"), before);

  const nonAdvancing = runNode(script, ["kimi", target, "--marketplace-version", "9.8.7-market.3"], temporary);
  assert.notEqual(nonAdvancing.status, 0);
  assert.match(nonAdvancing.stderr, /Requested kimi version .* must advance/);
  assert.equal(fs.readFileSync(path.join(temporary, ".claude-plugin/marketplace.json"), "utf8"), before);

  const marketplace = readJson(temporary, ".claude-plugin/marketplace.json");
  marketplace.plugins.push({ ...marketplace.plugins[0], name: "glm", source: "./plugins/glm" });
  fs.writeFileSync(path.join(temporary, ".claude-plugin", "marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
  const extraProvider = runNode(script, ["--check"], temporary);
  assert.notEqual(extraProvider.status, 0);
  assert.match(extraProvider.stderr, /Marketplace plugin set must be exactly: kimi/);
});

test("concurrent Kimi bumps serialize their marketplace snapshots", async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-concurrent-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const first = spawnNode(script, ["kimi", "9.8.7-concurrent.1", "--marketplace-version", "9.8.7-market.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_SNAPSHOT_GATE: "release-concurrent"
    }
  });
  const owner = await waitForLockPhase(temporary, "snapshot", first.child);
  assert.deepEqual(Object.keys(owner).sort(), ["createdAtMs", "phase", "pid", "providers", "schemaVersion", "token", "updatedAtMs"]);
  assert.deepEqual(owner.providers, ["kimi"]);
  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  assert.deepEqual(fs.readdirSync(lockDirectory), ["owner.json"]);
  assert.ok(fs.statSync(path.join(lockDirectory, "owner.json")).size <= 512);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(lockDirectory).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(lockDirectory, "owner.json")).mode & 0o077, 0);
  }
  const second = spawnNode(script, ["kimi", "9.8.7-concurrent.2", "--marketplace-version", "9.8.7-market.2"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER: "contender-concurrent"
    }
  });
  await waitForTestMarker(temporary, "contender-concurrent", second.child);
  fs.writeFileSync(path.join(temporary, ".claude-plugin", ".version-bump.test.release-concurrent"), "release\n", { mode: 0o600 });
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
  assert.equal(firstResult.status, 0, firstResult.stderr || firstResult.stdout);
  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);

  const marketplace = readJson(temporary, ".claude-plugin/marketplace.json");
  assert.equal(marketplace.version, "9.8.7-market.2");
  assert.equal(marketplace.plugins.some((entry) => Object.hasOwn(entry, "version")), false);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-concurrent.2");
  const checked = runNode(script, ["--check"], temporary);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
});

test("a contended rollback cannot overwrite a later successful Kimi bump", async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-rollback-race-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const first = spawnNode(script, ["kimi", "9.8.7-rolled-back.1", "--marketplace-version", "9.8.7-rollback.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_SNAPSHOT_GATE: "release-rollback",
      MODEL_COMPANION_TEST_BUMP_FAIL_AFTER_WRITE: "4"
    }
  });
  await waitForLockPhase(temporary, "snapshot", first.child);
  const second = spawnNode(script, ["kimi", "9.8.7-survives.1", "--marketplace-version", "9.8.7-survives.2"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER: "contender-rollback"
    }
  });
  await waitForTestMarker(temporary, "contender-rollback", second.child);
  fs.writeFileSync(path.join(temporary, ".claude-plugin", ".version-bump.test.release-rollback"), "release\n", { mode: 0o600 });
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
  assert.notEqual(firstResult.status, 0);
  assert.match(firstResult.stderr, /Injected version commit failure/);
  assert.equal(secondResult.status, 0, secondResult.stderr || secondResult.stdout);

  const marketplace = readJson(temporary, ".claude-plugin/marketplace.json");
  assert.equal(marketplace.plugins.some((entry) => Object.hasOwn(entry, "version")), false);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-survives.1");
  assert.equal(marketplace.version, "9.8.7-survives.2");
  const checked = runNode(script, ["--check"], temporary);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
});

test("two stale-lock waiters fail closed without an ABA replacement", async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-stale-lock-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const oldTime = Date.now() - 10 * 60_000;
  const ownerFile = path.join(lockDirectory, "owner.json");
  fs.writeFileSync(ownerFile, `${JSON.stringify({
    schemaVersion: 2,
    pid: 0x7fff_ffff,
    token: "a".repeat(48),
    createdAtMs: oldTime,
    updatedAtMs: oldTime,
    phase: "snapshot",
    providers: ["kimi"]
  })}\n`, { mode: 0o600 });
  fs.utimesSync(lockDirectory, new Date(oldTime), new Date(oldTime));
  const lockIdentity = fs.statSync(lockDirectory);
  const ownerBefore = fs.readFileSync(ownerFile);
  const marketplaceBefore = fs.readFileSync(path.join(temporary, ".claude-plugin", "marketplace.json"));
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const first = spawnNode(script, ["kimi", "9.8.7-stale.1", "--marketplace-version", "9.8.7-stale.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_LOCK_WAIT_MS: "400",
      MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER: "stale-kimi"
    }
  });
  const second = spawnNode(script, ["kimi", "9.8.7-stale.2", "--marketplace-version", "9.8.7-stale.2"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_LOCK_WAIT_MS: "400",
      MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER: "stale-kimi-two"
    }
  });
  await Promise.all([
    waitForTestMarker(temporary, "stale-kimi", first.child),
    waitForTestMarker(temporary, "stale-kimi-two", second.child)
  ]);
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
  for (const result of [firstResult, secondResult]) {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Automatic lock recovery is disabled to prevent an ABA race/);
    assert.match(result.stderr, /bump-version\.mjs --recover/);
  }
  const afterIdentity = fs.statSync(lockDirectory);
  assert.equal(afterIdentity.dev, lockIdentity.dev);
  assert.equal(afterIdentity.ino, lockIdentity.ino);
  assert.deepEqual(fs.readFileSync(ownerFile), ownerBefore);
  assert.deepEqual(fs.readFileSync(path.join(temporary, ".claude-plugin", "marketplace.json")), marketplaceBefore);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, readJson(ROOT, "plugins/kimi/package.json").version);
});

test("version recovery rejects noncanonical lock provider claims", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-lock-providers-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  const ownerFile = path.join(lockDirectory, "owner.json");
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const marketplaceBefore = fs.readFileSync(path.join(temporary, ".claude-plugin", "marketplace.json"));

  for (const providers of [[], ["kimi", "kimi"], ["glm"], ["glm", "kimi"], ["other"]]) {
    const now = Date.now();
    fs.writeFileSync(ownerFile, `${JSON.stringify({
      schemaVersion: 2,
      pid: 0x7fff_ffff,
      token: "a".repeat(48),
      createdAtMs: now,
      updatedAtMs: now,
      phase: "acquired",
      providers
    })}\n`, { mode: 0o600 });
    const refused = runNode(script, ["--recover"], temporary);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /invalid provider list|noncanonical provider list/);
    assert.deepEqual(fs.readFileSync(path.join(temporary, ".claude-plugin", "marketplace.json")), marketplaceBefore);
  }
});

test("a paused ownerless acquisition cannot overwrite a replacement lock", async (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-ownerless-lock-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const first = spawnNode(script, ["kimi", "9.8.7-ownerless.1", "--marketplace-version", "9.8.7-ownerless.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_ACQUIRE_GATE: "release-ownerless"
    }
  });
  const initialIdentity = await waitForOwnerlessLock(temporary, first.child);
  const second = spawnNode(script, ["kimi", "9.8.7-must-not-run.1", "--marketplace-version", "9.8.7-ownerless.2"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_LOCK_WAIT_MS: "400",
      MODEL_COMPANION_TEST_BUMP_CONTENDED_MARKER: "ownerless-contender"
    }
  });
  await waitForTestMarker(temporary, "ownerless-contender", second.child);
  const secondResult = await second.completed;
  assert.notEqual(secondResult.status, 0);
  assert.match(secondResult.stderr, /no complete owner record/);
  assert.match(secondResult.stderr, /Automatic lock recovery is disabled to prevent an ABA race/);
  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  const afterWaitIdentity = fs.statSync(lockDirectory);
  assert.equal(afterWaitIdentity.dev, initialIdentity.dev);
  assert.equal(afterWaitIdentity.ino, initialIdentity.ino);
  assert.deepEqual(fs.readdirSync(lockDirectory), []);

  const displaced = path.join(temporary, ".claude-plugin", ".version-bump.displaced-test");
  fs.renameSync(lockDirectory, displaced);
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  const replacementOwner = `${JSON.stringify({
    schemaVersion: 2,
    pid: process.pid,
    token: "b".repeat(48),
    createdAtMs: Date.now(),
    updatedAtMs: Date.now(),
    phase: "acquired",
    providers: ["kimi"]
  })}\n`;
  fs.writeFileSync(path.join(lockDirectory, "owner.json"), replacementOwner, { mode: 0o600 });
  const replacementIdentity = fs.statSync(lockDirectory);
  fs.writeFileSync(path.join(temporary, ".claude-plugin", ".version-bump.test.release-ownerless"), "release\n", { mode: 0o600 });
  const firstResult = await first.completed;
  assert.notEqual(firstResult.status, 0);
  assert.match(firstResult.stderr, /lock identity changed during an owner write/);
  assert.match(firstResult.stderr, /refusing to clean up an uninitialized replacement lock/);
  const finalReplacementIdentity = fs.statSync(lockDirectory);
  assert.equal(finalReplacementIdentity.dev, replacementIdentity.dev);
  assert.equal(finalReplacementIdentity.ino, replacementIdentity.ino);
  assert.equal(fs.readFileSync(path.join(lockDirectory, "owner.json"), "utf8"), replacementOwner);
  const displacedIdentity = fs.statSync(displaced);
  assert.equal(displacedIdentity.dev, initialIdentity.dev);
  assert.equal(displacedIdentity.ino, initialIdentity.ino);
  assert.deepEqual(fs.readdirSync(displaced), []);
  assert.notEqual(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-ownerless.1");
  assert.notEqual(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-must-not-run.1");
});

test("ownerless crash windows fail closed for manual lock inspection", (context) => {
  const acquiring = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-ownerless-acquiring-"));
  const releasing = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-ownerless-releasing-"));
  context.after(() => {
    fs.rmSync(acquiring, { recursive: true, force: true });
    fs.rmSync(releasing, { recursive: true, force: true });
  });

  copyVersionFixture(acquiring);
  const acquiringScript = path.join(acquiring, "scripts", "bump-version.mjs");
  const killedAcquire = runNode(acquiringScript, ["kimi", "9.8.7-ownerless.1", "--marketplace-version", "9.8.7-ownerless.1"], acquiring, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AT_OWNER_TEMP: "acquired"
    }
  });
  assert.notEqual(killedAcquire.status, 0);
  const refusedAcquire = runNode(acquiringScript, ["--recover"], acquiring);
  assert.notEqual(refusedAcquire.status, 0);
  assert.match(refusedAcquire.stderr, /lock has no owner record/);
  assert.equal(fs.existsSync(path.join(acquiring, ".claude-plugin", ".version-bump.journal.json")), false);
  assert.equal(readJson(acquiring, "plugins/kimi/package.json").version, "1.0.0");

  copyVersionFixture(releasing);
  const releasingScript = path.join(releasing, "scripts", "bump-version.mjs");
  const killedRelease = runNode(releasingScript, ["kimi", "9.8.7-ownerless.2", "--marketplace-version", "9.8.7-ownerless.2"], releasing, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AFTER_OWNER_UNLINK: "1"
    }
  });
  assert.notEqual(killedRelease.status, 0);
  const releaseLock = path.join(releasing, ".claude-plugin", ".version-bump.lock");
  assert.deepEqual(fs.readdirSync(releaseLock), []);
  assert.equal(fs.existsSync(path.join(releasing, ".claude-plugin", ".version-bump.journal.json")), false);
  const refusedRelease = runNode(releasingScript, ["--recover"], releasing);
  assert.notEqual(refusedRelease.status, 0);
  assert.match(refusedRelease.stderr, /lock has no owner record/);
  assert.equal(readJson(releasing, "plugins/kimi/package.json").version, "9.8.7-ownerless.2");
});

test("version locking refuses a symlink without touching its target", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-lock-symlink-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const target = path.join(temporary, "outside-lock-target");
  const marker = path.join(target, "marker.txt");
  fs.mkdirSync(target);
  fs.writeFileSync(marker, "untouched\n");
  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  try {
    fs.symlinkSync(target, lockDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") return context.skip("Creating a test symlink is not permitted on this host.");
    throw error;
  }
  const result = runNode(path.join(temporary, "scripts", "bump-version.mjs"), ["kimi", "9.8.7-symlink.1", "--marketplace-version", "9.8.7-symlink.1"], temporary);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /transaction lock is unsafe|real directory, not a symlink/i);
  assert.equal(fs.readFileSync(marker, "utf8"), "untouched\n");
  assert.equal(fs.lstatSync(lockDirectory).isSymbolicLink(), true);
});

test("version tooling refuses a symlinked package directory without touching its target", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-package-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-package-target-"));
  context.after(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  copyVersionFixture(temporary);
  const packageDirectory = path.join(temporary, "plugins", "kimi", ".claude-plugin");
  const externalManifest = path.join(outside, "plugin.json");
  fs.copyFileSync(path.join(packageDirectory, "plugin.json"), externalManifest);
  const before = fs.readFileSync(externalManifest);
  fs.rmSync(packageDirectory, { recursive: true });
  try {
    fs.symlinkSync(outside, packageDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM") return context.skip("Creating a test symlink is not permitted on this host.");
    throw error;
  }

  const result = runNode(path.join(temporary, "scripts", "bump-version.mjs"), ["kimi", "9.8.7-symlink.1", "--marketplace-version", "9.8.7-symlink.1"], temporary);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Managed version path is unsafe/);
  assert.deepEqual(fs.readFileSync(externalManifest), before);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
});

test("version tooling operates without a sibling package and rejects GLM targets", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-check-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const file of [
    "scripts/bump-version.mjs",
    ".claude-plugin/marketplace.json",
    "plugins/kimi/package.json",
    "plugins/kimi/.claude-plugin/plugin.json",
    "plugins/kimi/scripts/companion.mjs"
  ]) copyFile(ROOT, temporary, file);

  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const expectedVersion = readJson(temporary, "plugins/kimi/package.json").version;
  const selected = runNode(script, ["--check", "kimi"], temporary);
  assert.equal(selected.status, 0, selected.stderr || selected.stdout);
  assert.equal(selected.stdout.trim(), `Version metadata is consistent: kimi@${expectedVersion}; marketplace@1.0.0`);
  assert.doesNotMatch(selected.stdout, /glm@/);

  const bumped = runNode(script, ["kimi", "9.8.7-independent.1", "--marketplace-version", "9.8.7-independent.1"], temporary);
  assert.equal(bumped.status, 0, bumped.stderr || bumped.stdout);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-independent.1");
  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").version, "9.8.7-independent.1");
  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").plugins.some((entry) => Object.hasOwn(entry, "version")), false);

  const deniedGlm = runNode(script, ["--check", "glm"], temporary);
  assert.notEqual(deniedGlm.status, 0);
  assert.match(deniedGlm.stderr, /--check \[kimi\]/);
  assert.equal(fs.existsSync(path.join(temporary, "plugins", "glm")), false);

  const invalid = runNode(script, ["--check", "other"], temporary);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /--check \[kimi\]/);
});

test("version tooling restores every committed file after a mid-commit failure", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-rollback-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const files = copyVersionFixture(temporary);
  const versionFiles = files.filter((file) => file !== "scripts/bump-version.mjs");
  const originals = new Map(versionFiles.map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
  const result = runNode(
    path.join(temporary, "scripts", "bump-version.mjs"),
    ["kimi", "9.8.7-test.3", "--marketplace-version", "9.8.7-test.3"],
    temporary,
    { env: { ...process.env, NODE_ENV: "test", MODEL_COMPANION_TEST_BUMP_FAIL_AFTER_WRITE: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected version commit failure/);
  for (const [file, original] of originals) assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} was not rolled back byte-for-byte`);
});

test("version tooling rolls back a marketplace rename when its directory sync fails", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-post-rename-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const copied = copyVersionFixture(temporary);
  const originals = new Map(copied
    .filter((file) => file !== "scripts/bump-version.mjs")
    .map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const result = runNode(script, ["kimi", "9.8.7-post-rename.1", "--marketplace-version", "9.8.7-post-rename.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_FAIL_AFTER_ATOMIC_RENAME: "4"
    }
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected failure after an atomic version rename/);
  for (const [file, original] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} survived the post-rename rollback`);
  }
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
});

test("durable journal recovers a process kill after every coordinated write", (context) => {
  const temporaryRoots = [];
  context.after(() => {
    for (const temporary of temporaryRoots) fs.rmSync(temporary, { recursive: true, force: true });
  });
  for (let boundary = 1; boundary <= 4; boundary += 1) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `model-companions-version-kill-${boundary}-`));
    temporaryRoots.push(temporary);
    const copied = copyVersionFixture(temporary);
    const originals = new Map(copied
      .filter((file) => file !== "scripts/bump-version.mjs")
      .map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
    const script = path.join(temporary, "scripts", "bump-version.mjs");
    const killed = runNode(script, ["kimi", "9.8.7-crash.1", "--marketplace-version", "9.8.7-crash.1"], temporary, {
      env: {
        ...process.env,
        NODE_ENV: "test",
        MODEL_COMPANION_TEST_BUMP_KILL_AFTER_WRITE: String(boundary)
      }
    });
    assert.notEqual(killed.status, 0, `write boundary ${boundary} did not kill the transaction`);
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), true);
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), true);

    const recovered = runNode(script, ["--recover"], temporary);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    assert.match(recovered.stdout, /Rolled back an interrupted version transaction/);
    for (const [file, original] of originals) {
      assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} did not recover at write boundary ${boundary}`);
    }
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), false);
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
    const checked = runNode(script, ["--check"], temporary);
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
  }
});

test("durable journal removes transaction-owned pre-rename files after every atomic write", (context) => {
  const temporaryRoots = [];
  context.after(() => {
    for (const temporary of temporaryRoots) fs.rmSync(temporary, { recursive: true, force: true });
  });
  for (let boundary = 1; boundary <= 4; boundary += 1) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `model-companions-atomic-kill-${boundary}-`));
    temporaryRoots.push(temporary);
    const copied = copyVersionFixture(temporary);
    const originals = new Map(copied
      .filter((file) => file !== "scripts/bump-version.mjs")
      .map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
    const script = path.join(temporary, "scripts", "bump-version.mjs");
    const killed = runNode(script, ["kimi", "9.8.7-atomic.1", "--marketplace-version", "9.8.7-atomic.1"], temporary, {
      env: {
        ...process.env,
        NODE_ENV: "test",
        MODEL_COMPANION_TEST_BUMP_KILL_AFTER_ATOMIC_TEMP: String(boundary)
      }
    });
    assert.notEqual(killed.status, 0, `atomic boundary ${boundary} did not kill the transaction`);
    const temporaries = filesBelow(temporary).filter((file) => /\.version-bump\.[0-9a-f]{48}\.tmp$/.test(file));
    assert.equal(temporaries.length, 1, `atomic boundary ${boundary} did not retain one owned temporary`);

    const recovered = runNode(script, ["--recover"], temporary);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    for (const [file, original] of originals) {
      assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} did not recover at atomic boundary ${boundary}`);
    }
    assert.equal(filesBelow(temporary).some((file) => /\.version-bump\.[0-9a-f]{48}\.tmp$/.test(file)), false);
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
  }
});

test("recovery never deletes an atomic temporary owned by another transaction", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-foreign-atomic-temp-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const killed = runNode(script, ["kimi", "9.8.7-foreign-temp.1", "--marketplace-version", "9.8.7-foreign-temp.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AFTER_ATOMIC_TEMP: "1"
    }
  });
  assert.notEqual(killed.status, 0);
  const owner = readJson(temporary, ".claude-plugin/.version-bump.lock/owner.json");
  const owned = filesBelow(temporary).filter((file) => file.endsWith(`.version-bump.${owner.token}.tmp`));
  assert.equal(owned.length, 1);
  const foreignToken = owner.token === "b".repeat(48) ? "c".repeat(48) : "b".repeat(48);
  const foreign = owned[0].replace(owner.token, foreignToken);
  fs.writeFileSync(foreign, "foreign transaction\n", { mode: 0o600 });

  const refused = runNode(script, ["--recover"], temporary);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /unowned atomic-write temporary file/);
  assert.equal(fs.existsSync(owned[0]), true);
  assert.equal(fs.existsSync(foreign), true);

  fs.unlinkSync(foreign);
  const recovered = runNode(script, ["--recover"], temporary);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.equal(fs.existsSync(owned[0]), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
});

test("durable journal finalizes a transaction killed after its commit marker", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-version-committed-kill-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyVersionFixture(temporary);
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const killed = runNode(script, ["kimi", "9.8.7-committed.1", "--marketplace-version", "9.8.7-committed.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AFTER_COMMITTED: "1"
    }
  });
  assert.notEqual(killed.status, 0);
  const recovered = runNode(script, ["--recover"], temporary);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /Finalized a committed version transaction/);
  assert.equal(readJson(temporary, "plugins/kimi/.claude-plugin/plugin.json").version, "9.8.7-committed.1");
  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").version, "9.8.7-committed.1");
});

test("durable journal recovers every publication and owner-transition boundary", (context) => {
  const temporaryRoots = [];
  context.after(() => {
    for (const temporary of temporaryRoots) fs.rmSync(temporary, { recursive: true, force: true });
  });
  for (const boundary of ["temporary", "published", "snapshot"]) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `model-companions-journal-${boundary}-`));
    temporaryRoots.push(temporary);
    const copied = copyVersionFixture(temporary);
    const originals = new Map(copied
      .filter((file) => file !== "scripts/bump-version.mjs")
      .map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
    const script = path.join(temporary, "scripts", "bump-version.mjs");
    const killed = runNode(script, ["kimi", "9.8.7-journal.1", "--marketplace-version", "9.8.7-journal.1"], temporary, {
      env: {
        ...process.env,
        NODE_ENV: "test",
        MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL: boundary
      }
    });
    assert.notEqual(killed.status, 0, `${boundary} did not kill the transaction`);
    const journal = path.join(temporary, ".claude-plugin", ".version-bump.journal.json");
    const journalTemps = fs.readdirSync(path.join(temporary, ".claude-plugin"))
      .filter((name) => /^\.version-bump\.journal\.[0-9a-f]{48}\.tmp$/.test(name));
    if (boundary === "temporary") {
      assert.equal(fs.existsSync(journal), false);
      assert.equal(journalTemps.length, 1);
    } else {
      assert.equal(fs.existsSync(journal), true);
      assert.equal(journalTemps.length, 0);
    }
    const recovered = runNode(script, ["--recover"], temporary);
    assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
    for (const [file, original] of originals) {
      assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} did not recover at ${boundary}`);
    }
    assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);
    assert.equal(fs.existsSync(journal), false);
    assert.equal(fs.readdirSync(path.join(temporary, ".claude-plugin")).some((name) => name.includes(".journal.")), false);
  }
});

test("durable journal recovers an interrupted lock-owner publication", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-owner-publication-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const copied = copyVersionFixture(temporary);
  const originals = new Map(copied
    .filter((file) => file !== "scripts/bump-version.mjs")
    .map((file) => [file, fs.readFileSync(path.join(temporary, file))]));
  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const killed = runNode(script, ["kimi", "9.8.7-owner-temp.1", "--marketplace-version", "9.8.7-owner-temp.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AT_OWNER_TEMP: "snapshot"
    }
  });
  assert.notEqual(killed.status, 0);

  const lockDirectory = path.join(temporary, ".claude-plugin", ".version-bump.lock");
  const owner = readJson(temporary, ".claude-plugin/.version-bump.lock/owner.json");
  assert.equal(owner.phase, "acquired");
  assert.deepEqual(fs.readdirSync(lockDirectory).sort(), [`.owner.${owner.token}.tmp`, "owner.json"]);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), true);

  const recovered = runNode(script, ["--recover"], temporary);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /Rolled back an interrupted version transaction/);
  for (const [file, original] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(temporary, file)), original, `${file} did not survive owner publication recovery`);
  }
  assert.equal(fs.existsSync(lockDirectory), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), false);
});

test("terminal journal removal is recoverable after commit and rollback", (context) => {
  const committed = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-journal-removed-"));
  const rolledBack = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-journal-recovery-removed-"));
  context.after(() => {
    fs.rmSync(committed, { recursive: true, force: true });
    fs.rmSync(rolledBack, { recursive: true, force: true });
  });

  copyVersionFixture(committed);
  const committedScript = path.join(committed, "scripts", "bump-version.mjs");
  const killedCommit = runNode(committedScript, ["kimi", "9.8.7-removed.1", "--marketplace-version", "9.8.7-removed.1"], committed, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL: "removed"
    }
  });
  assert.notEqual(killedCommit.status, 0);
  assert.equal(fs.existsSync(path.join(committed, ".claude-plugin", ".version-bump.journal.json")), false);
  const finalized = runNode(committedScript, ["--recover"], committed);
  assert.equal(finalized.status, 0, finalized.stderr || finalized.stdout);
  assert.match(finalized.stdout, /Validated terminal version state/);
  assert.equal(readJson(committed, "plugins/kimi/.claude-plugin/plugin.json").version, "9.8.7-removed.1");

  const copied = copyVersionFixture(rolledBack);
  const originals = new Map(copied
    .filter((file) => file !== "scripts/bump-version.mjs")
    .map((file) => [file, fs.readFileSync(path.join(rolledBack, file))]));
  const rolledBackScript = path.join(rolledBack, "scripts", "bump-version.mjs");
  const killedWrite = runNode(rolledBackScript, ["kimi", "9.8.7-recover.1", "--marketplace-version", "9.8.7-recover.1"], rolledBack, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AFTER_WRITE: "3"
    }
  });
  assert.notEqual(killedWrite.status, 0);
  const killedRecovery = runNode(rolledBackScript, ["--recover"], rolledBack, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL: "recovery-removed"
    }
  });
  assert.notEqual(killedRecovery.status, 0);
  assert.equal(fs.existsSync(path.join(rolledBack, ".claude-plugin", ".version-bump.journal.json")), false);
  const recoveredAgain = runNode(rolledBackScript, ["--recover"], rolledBack);
  assert.equal(recoveredAgain.status, 0, recoveredAgain.stderr || recoveredAgain.stdout);
  for (const [file, original] of originals) {
    assert.deepEqual(fs.readFileSync(path.join(rolledBack, file)), original, `${file} did not survive terminal rollback recovery`);
  }
});

test("terminal recovery after journal removal remains provider isolated", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-terminal-isolation-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const file of [
    "scripts/bump-version.mjs",
    ".claude-plugin/marketplace.json",
    "plugins/kimi/package.json",
    "plugins/kimi/.claude-plugin/plugin.json",
    "plugins/kimi/scripts/companion.mjs"
  ]) copyFile(ROOT, temporary, file);

  const script = path.join(temporary, "scripts", "bump-version.mjs");
  const killed = runNode(script, ["kimi", "9.8.7-terminal.1", "--marketplace-version", "9.8.7-terminal.1"], temporary, {
    env: {
      ...process.env,
      NODE_ENV: "test",
      MODEL_COMPANION_TEST_BUMP_KILL_AT_JOURNAL: "removed"
    }
  });
  assert.notEqual(killed.status, 0);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.journal.json")), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), true);
  assert.equal(fs.existsSync(path.join(temporary, "plugins", "glm")), false);

  const recovered = runNode(script, ["--recover"], temporary);
  assert.equal(recovered.status, 0, recovered.stderr || recovered.stdout);
  assert.match(recovered.stdout, /Validated terminal version state/);
  assert.equal(readJson(temporary, "plugins/kimi/package.json").version, "9.8.7-terminal.1");
  assert.equal(readJson(temporary, ".claude-plugin/marketplace.json").version, "9.8.7-terminal.1");
  assert.equal(fs.existsSync(path.join(temporary, "plugins", "glm")), false);
  assert.equal(fs.existsSync(path.join(temporary, ".claude-plugin", ".version-bump.lock")), false);

  const checked = runNode(script, ["--check", "kimi"], temporary);
  assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});

test("package suites remain version-agnostic after a coordinated synthetic bump", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-bumped-suite-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  for (const file of ["package.json", ".claude-plugin/marketplace.json", "scripts/bump-version.mjs"]) copyFile(ROOT, temporary, file);
  fs.cpSync(path.join(ROOT, "plugins"), path.join(temporary, "plugins"), { recursive: true });
  for (const provider of ["kimi"]) {
    const currentVersion = readJson(temporary, `plugins/${provider}/package.json`).version;
    const literal = new RegExp(`["'\`]${currentVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    for (const file of filesBelow(path.join(temporary, "plugins", provider, "tests")).filter((name) => name.endsWith(".mjs") || name.endsWith(".cjs"))) {
      assert.doesNotMatch(fs.readFileSync(file, "utf8"), literal, `${path.relative(temporary, file)} hardcodes the package version`);
    }
  }
  const bumped = runNode(path.join(temporary, "scripts", "bump-version.mjs"), ["kimi", "9.8.7-test.2", "--marketplace-version", "9.8.7-test.2"], temporary);
  assert.equal(bumped.status, 0, bumped.stderr || bumped.stdout);
  const environment = isolatedEnvironment(temporary);
  for (const provider of ["kimi"]) {
    const expectedVersion = readJson(temporary, `plugins/${provider}/package.json`).version;
    const runtime = path.join(temporary, "plugins", provider, "scripts", "companion.mjs");
    const initialized = spawnSync(process.execPath, [runtime, "mcp"], {
      cwd: path.dirname(runtime),
      env: environment,
      input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true
    });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    const response = JSON.parse(initialized.stdout.trim());
    assert.deepEqual(response.result.serverInfo, { name: `${provider}-companion`, version: expectedVersion });
  }
});

test("checksum publication preflights collisions without leaving an archive", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-checksum-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "release");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "SHA256SUMS"), "existing\n");
  const result = runNode(path.join(ROOT, "scripts", "release-checksums.mjs"), ["--output", output], ROOT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to overwrite/);
  assert.deepEqual(fs.readdirSync(output), ["SHA256SUMS"]);
});

test("checksum publication never overwrites a colliding archive", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-checksum-archive-collision-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "release");
  const script = path.join(ROOT, "scripts", "release-checksums.mjs");
  const created = runNode(script, ["--output", output], ROOT);
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const archive = fs.readdirSync(output).find((name) => name.endsWith(".tgz"));
  assert.ok(archive);
  fs.unlinkSync(path.join(output, "SHA256SUMS"));
  const before = fs.readFileSync(path.join(output, archive));

  const refused = runNode(script, ["--output", output], ROOT);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing to overwrite existing release artifact/);
  assert.deepEqual(fs.readFileSync(path.join(output, archive)), before);
  assert.deepEqual(fs.readdirSync(output), [archive]);
});

test("checksum publication removes a destination created by a failed write", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-checksum-failure-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "release");
  fs.mkdirSync(output);
  const result = runNode(
    path.join(ROOT, "scripts", "release-checksums.mjs"),
    ["--output", output],
    ROOT,
    { env: { ...process.env, NODE_ENV: "test", MODEL_COMPANION_TEST_RELEASE_FAIL_AFTER_CREATE: "1" } }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Injected release publication failure/);
  assert.deepEqual(fs.readdirSync(output), []);
});

test("checksum publication creates and verifies the Kimi archive", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-checksum-all-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, "release");
  const result = runNode(
    path.join(ROOT, "scripts", "release-checksums.mjs"),
    ["--output", output],
    ROOT
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Created 1 release archives/);
  const names = fs.readdirSync(output).sort();
  const archives = names.filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1);
  assert.deepEqual(names, [...archives, "SHA256SUMS"].sort());
  const lines = fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const listed = new Set();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([^/\\]+\.tgz)$/.exec(line);
    assert.ok(match, `invalid checksum line: ${line}`);
    assert.equal(archives.includes(match[2]), true);
    assert.equal(listed.has(match[2]), false);
    listed.add(match[2]);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(path.join(output, match[2]))).digest("hex");
    assert.equal(match[1], digest);
  }
  assert.deepEqual([...listed].sort(), archives);
});

test("checksum publication rejects any file outside the exact provider package policy", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "model-companions-checksum-policy-"));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  copyFile(ROOT, temporary, "scripts/release-checksums.mjs");
  copyFile(ROOT, temporary, "scripts/package-policy.mjs");
  copyFile(ROOT, temporary, "scripts/npm-launcher.mjs");
  fs.cpSync(path.join(ROOT, "plugins", "kimi"), path.join(temporary, "plugins", "kimi"), { recursive: true });
  fs.writeFileSync(path.join(temporary, "plugins", "kimi", "scripts", "credentials.pem"), "must never be packed\n");
  const output = path.join(temporary, "release");
  const result = runNode(
    path.join(temporary, "scripts", "release-checksums.mjs"),
    ["--output", output],
    temporary,
    { env: isolatedEnvironment(temporary) }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact release policy/);
  assert.deepEqual(fs.existsSync(output) ? fs.readdirSync(output) : [], []);
});
