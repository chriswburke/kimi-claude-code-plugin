const COMMON_FILES = Object.freeze([
  ".claude-plugin/plugin.json",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "package.json",
  "scripts/companion.mjs",
  "scripts/tool-gate.mjs"
]);

const PACKAGE_FILES = Object.freeze({
  kimi: Object.freeze([
    ...COMMON_FILES,
    "assets/kimi-explorer.md",
    "assets/kimi-planner.md",
    "assets/kimi-reviewer.md",
    ...["ask", "cancel", "cleanup", "config", "explore", "models", "plan", "result", "review", "session", "setup", "status", "usage"]
      .map((command) => `commands/${command}.md`)
  ].sort())
});

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/")) return false;
  const segments = value.split("/");
  return !segments.some((segment) => !segment || segment === "." || segment === "..")
    && segments.join("/") === value;
}

export function expectedPackageFiles(provider) {
  const files = PACKAGE_FILES[provider];
  if (!files) throw new Error(`Unknown package policy provider: ${provider}`);
  return [...files];
}

export function expectedPackageDirectories(provider) {
  const directories = new Set();
  for (const file of expectedPackageFiles(provider)) {
    const segments = file.split("/");
    segments.pop();
    while (segments.length) {
      directories.add(segments.join("/"));
      segments.pop();
    }
  }
  return directories;
}

export function assertExactPackageFiles(provider, entries) {
  if (!Array.isArray(entries)) throw new Error(`${provider} npm pack report did not contain a file list.`);
  const observed = entries.map((entry) => typeof entry === "string" ? entry : entry?.path);
  if (observed.some((filename) => !safeRelativePath(filename))) {
    throw new Error(`${provider} npm pack report contained an unsafe path.`);
  }
  const observedSet = new Set(observed);
  if (observedSet.size !== observed.length) throw new Error(`${provider} npm pack report contained duplicate paths.`);
  const expected = new Set(expectedPackageFiles(provider));
  const missing = [...expected].filter((filename) => !observedSet.has(filename));
  const unexpected = [...observedSet].filter((filename) => !expected.has(filename));
  if (missing.length || unexpected.length) {
    const details = {
      missing: missing.slice(0, 20),
      unexpected: unexpected.slice(0, 20),
      additionalMissing: Math.max(0, missing.length - 20),
      additionalUnexpected: Math.max(0, unexpected.length - 20)
    };
    throw new Error(`${provider} package contents differ from the exact release policy: ${JSON.stringify(details)}`);
  }
  return observedSet;
}
