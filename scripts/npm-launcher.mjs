import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const PASSTHROUGH_ENVIRONMENT = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "SHELL",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"
]);

function regularFile(filename) {
  try {
    return fs.statSync(filename).isFile();
  } catch {
    return false;
  }
}

function insideDirectory(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

export function resolveNpmInvocation({
  execPath = process.execPath,
  platform = process.platform
} = {}) {
  if (!regularFile(execPath)) throw new Error(`Node executable is not a regular file: ${execPath}`);
  const node = fs.realpathSync(execPath);
  const executableDirectory = path.dirname(node);
  const installationRoot = platform === "win32"
    ? executableDirectory
    : path.dirname(executableDirectory);
  const candidates = platform === "win32"
    ? [
        path.join(installationRoot, "node_modules", "npm", "bin", "npm-cli.js"),
        path.join(installationRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js")
      ]
    : [
        path.join(installationRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        path.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js")
      ];

  for (const candidate of candidates) {
    if (!regularFile(candidate)) continue;
    const npmCli = fs.realpathSync(candidate);
    if (!insideDirectory(installationRoot, npmCli)) continue;
    return Object.freeze({
      command: node,
      argsPrefix: Object.freeze([npmCli]),
      npmCli
    });
  }
  throw new Error(`Could not resolve the npm CLI bundled with Node at ${node}.`);
}

export function isolatedNpmEnvironment(temporary, source = process.env) {
  const environment = {};
  for (const key of PASSTHROUGH_ENVIRONMENT) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
  const home = path.join(temporary, "npm-home");
  const cache = path.join(temporary, "npm-cache");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(cache, { recursive: true });
  return {
    ...environment,
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
