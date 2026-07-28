import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KIMI_ROOT = path.join(ROOT, "plugins", "kimi");

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, ...segments), "utf8"));
}

function workflow(name) {
  return fs.readFileSync(path.join(ROOT, ".github", "workflows", name), "utf8");
}

test("the root is a Kimi-only marketplace and workspace", () => {
  const workspace = readJson("package.json");
  const marketplace = readJson(".claude-plugin", "marketplace.json");

  assert.equal(workspace.name, "model-companions-kimi-workspace");
  assert.equal(workspace.private, true);
  assert.deepEqual(workspace.workspaces, ["plugins/kimi"]);
  assert.equal("build" in workspace.scripts, false);
  assert.equal(fs.existsSync(path.join(ROOT, "plugins", "glm")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "plugins", "shared")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "scripts", "sync-runtime.mjs")), false);

  assert.equal(marketplace.name, "model-companions-kimi");
  assert.match(marketplace.version, /^\d+\.\d+\.\d+/);
  assert.equal(typeof marketplace.description, "string");
  assert.equal(Object.hasOwn(marketplace, "metadata"), false);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, "kimi");
  assert.equal(marketplace.plugins[0].source, "./plugins/kimi");
  assert.equal(Object.hasOwn(marketplace.plugins[0], "version"), false);

  const ignored = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8").split(/\r?\n/);
  for (const entry of ["node_modules/", ".env", ".env.*", "!.env.example", "npm-debug.log*"]) {
    assert.equal(ignored.includes(entry), true, `.gitignore omits ${entry}`);
  }
});

test("root scripts and release workflow are Kimi-only", () => {
  const scripts = readJson("package.json").scripts;
  assert.equal(scripts["test:kimi"], "npm --prefix plugins/kimi test");
  assert.equal(scripts["release:check:kimi"], "npm run release:check");
  assert.equal(scripts["release:check:kimi:strict"], "npm run release:check:strict");
  assert.match(scripts["validate:kimi"], /version:check:kimi/);
  assert.match(scripts["validate:kimi"], /claude plugin validate --strict \./);
  assert.equal(scripts["validate:kimi"].includes("npm --prefix plugins/kimi run validate"), true);
  assert.doesNotMatch(JSON.stringify(scripts), /glm/i);

  const release = workflow("release-artifacts.yml");
  assert.match(release, /tags:\s*\n\s+- v\*/);
  assert.match(release, /npm run release:check:strict/);
  assert.match(release, /node scripts\/verify-release-target\.mjs "\$RELEASE_TAG"/);
  assert.match(release, /node scripts\/release-checksums\.mjs --output release/);
  assert.match(release, /sha256sum --check SHA256SUMS/);
  assert.match(release, /actions\/attest@[0-9a-f]{40}/);
  assert.match(release, /artifact-metadata: write/);
  assert.match(release, /path:\s*\|\s*\n\s+release\/\*\.tgz\s*\n\s+release\/SHA256SUMS/);
  assert.doesNotMatch(release, /glm|--provider|kimi-v\*/i);
});

test("validation, dependency, release, and canary workflows keep bounded trust", () => {
  const ci = workflow("ci.yml");
  const releaseChecks = workflow("release-checks.yml");
  // Push and pull requests run Linux only. The release workflow adds macOS and
  // the full Node range. Windows is deliberately absent from both because its
  // suite has never passed, and the README documents it as untested.
  assert.match(ci, /os: \[ubuntu-latest\]/);
  assert.doesNotMatch(ci, /windows-latest|macos-latest/);
  assert.match(releaseChecks, /os: \[ubuntu-latest, macos-latest\]/);
  assert.doesNotMatch(releaseChecks, /windows-latest/);
  assert.match(releaseChecks, /node: \["18\.18\.0", "20", "22"\]/);
  assert.match(releaseChecks, /claude-version:\s*\["2\.1\.169", "latest"\]/);
  assert.match(releaseChecks, /matrix\.claude-version == 'latest'[\s\S]*npm run test:claude-smoke/);
  // The release lane must stay off the push path so it cannot appear as a
  // skipped job on every commit.
  assert.match(releaseChecks, /^on:\n  push:\n    tags: \["v\*"\]/m);

  const dependabot = fs.readFileSync(path.join(ROOT, ".github", "dependabot.yml"), "utf8");
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.match(dependabot, /interval: monthly/);
  assert.match(dependabot, /open-pull-requests-limit: 3/);

  const canary = workflow("provider-canary.yml");
  assert.match(canary, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(canary, /^\s+(?:push|pull_request):/m);
  assert.match(canary, /timeout-minutes: 10/);
  assert.match(canary, /secrets\.KIMI_MODEL_API_KEY/);
  assert.match(canary, /--timeout 2m/);
  assert.match(canary, /--model "\$KIMI_MODEL_NAME"/);
  assert.doesNotMatch(canary, /GLM|ZAI_|extended_glm|inputs\.provider/i);

  for (const source of [ci, releaseChecks, workflow("release-artifacts.yml"), canary]) {
    for (const match of source.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      assert.match(match[1], /@[0-9a-f]{40}$/, `workflow action is not pinned: ${match[1]}`);
    }
  }
});

test("the marketplace entry is a self-contained, version-matched package", () => {
  const entry = readJson(".claude-plugin", "marketplace.json").plugins[0];
  const manifest = readJson("plugins", "kimi", ".claude-plugin", "plugin.json");
  const packageJson = readJson("plugins", "kimi", "package.json");

  assert.equal(manifest.name, entry.name);
  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.scripts.test, "npm run check && node --test");
  assert.doesNotMatch(packageJson.scripts.test, /[*?\[]/);
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.mcpServers.companion.args, ["${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs", "mcp"]);
  assert.equal(fs.existsSync(path.join(KIMI_ROOT, "tests")), true);
  assert.deepEqual(fs.readFileSync(path.join(KIMI_ROOT, "LICENSE")), fs.readFileSync(path.join(ROOT, "LICENSE")));

  const runtime = fs.readFileSync(path.join(KIMI_ROOT, "scripts", "companion.mjs"), "utf8");
  assert.doesNotMatch(runtime, /from\s+["']\.\.\//);
  assert.match(runtime, new RegExp(`const VERSION = ${JSON.stringify(manifest.version)}`));
  assert.doesNotMatch(runtime, /\bGLM\b|ZAI_|GLM_API_KEY|CLAUDE_BIN|ANTHROPIC_BASE_URL/);
  assert.doesNotMatch(runtime, /MODEL_COMPANION_PLUGIN_ROOT|function pluginRoot/);
});

test("Kimi commands are MCP-only, package-namespaced, and deny GLM tool names", () => {
  const uppercaseDenyRules = Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}*`);
  const expected = ["ask.md", "cancel.md", "cleanup.md", "config.md", "explore.md", "models.md", "plan.md", "result.md", "review.md", "session.md", "setup.md", "status.md", "usage.md"];
  const routedTools = { ask: "run_task", cancel: "cancel", cleanup: "cleanup", config: "config", explore: "explore", models: "models", plan: "plan", result: "result", review: "review", session: "session", setup: "setup", status: "status", usage: "usage" };
  const commandRoot = path.join(KIMI_ROOT, "commands");
  assert.deepEqual(fs.readdirSync(commandRoot).sort(), expected);
  for (const filename of expected) {
    const source = fs.readFileSync(path.join(commandRoot, filename), "utf8");
    const toolNames = [...source.matchAll(/mcp__plugin_kimi_companion__[a-z0-9_]+/g)].map(([name]) => name);
    assert.ok(toolNames.length >= 2, `${filename} must name its routed tool in the hook and instructions`);
    assert.equal(new Set(toolNames).size, 1, `${filename} may route to only one companion tool`);
    assert.equal(toolNames[0], `mcp__plugin_kimi_companion__${routedTools[path.basename(filename, ".md")]}`);
    assert.doesNotMatch(source, /\$ARGUMENTS|Bash\(/);
    assert.match(source, /disable-model-invocation:\s*true/);
    const disallowed = source.match(/^disallowed-tools:\s*"([^"]+)"$/m)?.[1];
    assert.deepEqual(disallowed?.split(" "), uppercaseDenyRules);
    assert.doesNotMatch(disallowed || "", /\[/);
    assert.doesNotMatch(source, /^allowed-tools:/m);
    assert.match(source, /PreToolUse:[\s\S]*matcher:\s*"\*"[\s\S]*type:\s*command[\s\S]*command:\s*node/);
    assert.match(source, /\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/tool-gate\.mjs/);
  }

  const gate = path.join(KIMI_ROOT, "scripts", "tool-gate.mjs");
  const routeTool = "mcp__plugin_kimi_companion__status";
  const invokeGate = (toolName, configured = routeTool) => spawnSync(process.execPath, [gate, configured], {
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: {} }),
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 1024 * 1024
  });
  assert.equal(JSON.parse(invokeGate(routeTool).stdout).hookSpecificOutput.permissionDecision, "allow");
  assert.equal(JSON.parse(invokeGate("Bash").stdout).hookSpecificOutput.permissionDecision, "deny");
  const crossProvider = invokeGate(routeTool, "mcp__plugin_glm_companion__status");
  assert.equal(crossProvider.status, 0, crossProvider.stderr);
  assert.equal(JSON.parse(crossProvider.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("the structured-output contract is conformance-only", () => {
  const contract = fs.readFileSync(path.join(ROOT, "docs", "structured-output-v2.md"), "utf8");
  const runtime = fs.readFileSync(path.join(KIMI_ROOT, "scripts", "companion.mjs"), "utf8");
  assert.match(contract, /schemaVersion/);
  assert.match(contract, /structuredContent/);
  assert.match(runtime, /schemaVersion:\s*(?:JSON_SCHEMA_VERSION|2)/);
  assert.doesNotMatch(runtime, /docs\/structured-output-v2|plugins\/(?:kimi|glm)\/scripts/);
});
