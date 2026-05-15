const fs = require("fs");
const path = require("path");
const readline = require("readline");

let projectRoot = null;
let useBuiltin = true;
let debugMode = false;
let engine = null;
let source = null;
let noConfig = false;

function log(...args) {
  if (debugMode) {
    sendMessage({
      type: "log",
      args: args.map((arg) => String(arg)),
    });
  }
}

function isNoConfigError(error) {
  const msg = String(error.message || error);
  return (
    msg.includes("No ESLint configuration found") ||
    msg.includes("no-config-found") ||
    msg.includes("Could not find config file")
  );
}

function resolveProjectEslint() {
  const projectEslintPath = path.join(projectRoot, "node_modules", "eslint");
  if (!fs.existsSync(projectEslintPath)) {
    log("Project ESLint not found:", projectEslintPath);
    return null;
  }

  const mod = require(projectEslintPath);
  const { ESLint } = mod;
  if (typeof ESLint !== "function") {
    throw new Error(`ESLint class not exported (keys: ${Object.keys(mod).join(", ")})`);
  }

  const version = require(path.join(projectEslintPath, "package.json")).version;
  log(`Project ESLint found: v${version}`, projectEslintPath);
  return { ESLint, version, source: "project", path: projectEslintPath };
}

function resolveBundledEslint(version) {
  try {
    if (version === "v10") {
      const { ESLint } = require("eslint10");
      const pkgPath = require.resolve("eslint10/package.json");
      const eslintVersion = require(pkgPath).version;
      return { ESLint, version: eslintVersion, source: "bundled-v10" };
    }

    const { ESLint } = require("eslint8");
    const pkgPath = require.resolve("eslint8/package.json");
    const eslintVersion = require(pkgPath).version;
    return { ESLint, version: eslintVersion, source: "bundled-v8" };
  } catch (error) {
    log(`Bundled ESLint ${version} error:`, error.message);
    return null;
  }
}

function resolveEslint() {
  const projectEslint = resolveProjectEslint();
  if (projectEslint) return projectEslint;
  if (!useBuiltin) return null;

  return resolveBundledEslint("v8") || resolveBundledEslint("v10");
}

function createEngine(resolved) {
  engine = new resolved.ESLint({ cwd: projectRoot });
  source = resolved.source;
  noConfig = false;
  log(`Using ESLint ${resolved.source}${resolved.version ? ` v${resolved.version}` : ""}`);
}

function initialize(options) {
  projectRoot = options.projectRoot;
  useBuiltin = options.useBuiltin;
  debugMode = options.debugMode;

  const resolved = resolveEslint();
  if (!resolved) {
    log("No ESLint available");
    return { ready: false };
  }

  createEngine(resolved);
  return { ready: true, source };
}

function getFallbackVersions() {
  if (!useBuiltin) return [];

  if (source === "bundled-v8") return ["v10"];
  if (source === "bundled-v10") return ["v8"];

  return ["v8", "v10"];
}

async function lintWithFallbackVersions(filepath, filetext) {
  for (const version of getFallbackVersions()) {
    const resolved = resolveBundledEslint(version);
    if (!resolved || resolved.source === source) continue;

    createEngine(resolved);
    try {
      const results = await engine.lintText(filetext, { filePath: filepath });
      log(
        "lintText fallback result:",
        filepath,
        resolved.source,
        `${results.length} result(s), ${results.reduce(
          (count, result) => count + (result.messages ? result.messages.length : 0),
          0,
        )} message(s)`,
      );
      return { results };
    } catch (error) {
      if (!isNoConfigError(error)) throw error;
      log("Fallback ESLint has no config:", resolved.source, String(error.message || error));
    }
  }

  return null;
}

async function lintText(filepath, filetext) {
  if (noConfig) {
    return { results: [{ messages: [] }] };
  }

  try {
    const results = await engine.lintText(filetext, { filePath: filepath });
    log(
      "lintText result:",
      filepath,
      `${results.length} result(s), ${results.reduce(
        (count, result) => count + (result.messages ? result.messages.length : 0),
        0,
      )} message(s)`,
    );
    return { results };
  } catch (error) {
    if (isNoConfigError(error)) {
      const fallbackReport = await lintWithFallbackVersions(filepath, filetext);
      if (fallbackReport) return fallbackReport;
    } else {
      throw error;
    }

    noConfig = true;
    log("No ESLint config found, skipping project");
    return { results: [{ messages: [] }] };
  }
}

async function handleRequest(message) {
  if (typeof message.debugMode === "boolean") {
    debugMode = message.debugMode;
  }

  if (message.type === "init") {
    return initialize(message);
  }

  if (!engine) {
    throw new Error("ESLint worker has not been initialized");
  }

  if (message.type === "isPathIgnored") {
    try {
      const ignored = await engine.isPathIgnored(message.filepath);
      log("isPathIgnored result:", message.filepath, ignored);
      return ignored;
    } catch (error) {
      if (isNoConfigError(error)) {
        log("isPathIgnored no-config fallback:", message.filepath, String(error.message || error));
        return false;
      }
      throw error;
    }
  }

  if (message.type === "lintText") {
    return lintText(message.filepath, message.filetext);
  }

  throw new Error(`Unknown ESLint worker request: ${message.type}`);
}

function sendMessage(message) {
  if (process.connected) {
    process.send(message);
  } else {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }
}

function onMessage(message) {
  if (!message || !message.id) return;

  handleRequest(message)
    .then((result) => {
      sendMessage({ type: "response", id: message.id, result });
    })
    .catch((error) => {
      sendMessage({
        type: "response",
        id: message.id,
        error: String(error.message || error),
      });
    });
}

if (process.connected) {
  process.on("message", onMessage);
} else {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;

    try {
      onMessage(JSON.parse(line));
    } catch (error) {
      sendMessage({
        type: "log",
        args: ["Protocol parse error:", String(error.message || error)],
      });
    }
  });
}
