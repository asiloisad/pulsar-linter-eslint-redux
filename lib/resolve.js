const path = require("path");
const fs = require("fs");

const PACKAGE_NAME = "linter-eslint-redux";

// Cache per project root: Map<projectRoot, { ESLint, version, source } | null>
const cache = new Map();

function log(...args) {
  if (atom.config.get(`${PACKAGE_NAME}.debugMode`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

/**
 * Get bundled ESLint
 * @param {"v8" | "v9"} version
 * @returns {{ ESLint: class, version: string, source: string } | null}
 */
function getBundledEslint(version) {
  try {
    if (version === "v9") {
      const { ESLint } = require("eslint9");
      const pkgPath = require.resolve("eslint9/package.json");
      const ver = require(pkgPath).version;
      return { ESLint, version: ver, source: "bundled-v9" };
    } else {
      const { ESLint } = require("eslint8");
      const pkgPath = require.resolve("eslint8/package.json");
      const ver = require(pkgPath).version;
      return { ESLint, version: ver, source: "bundled-v8" };
    }
  } catch (e) {
    log(`Bundled ESLint ${version} error:`, e.message);
    return null;
  }
}

/**
 * Resolve ESLint for a specific project
 * Priority: 1) Project local, 2) Bundled v8, 3) Bundled v9
 * @param {string} projectRoot - Project root path
 * @returns {{ ESLint: class, version: string, source: string } | null}
 */
function resolveEslint(projectRoot) {
  // Check cache first
  if (cache.has(projectRoot)) {
    return cache.get(projectRoot);
  }

  log("Project:", projectRoot);
  let result = null;

  // Try project local ESLint first
  if (projectRoot) {
    try {
      // Check if eslint exists directly in project's node_modules
      const projectEslintPath = path.join(projectRoot, "node_modules", "eslint");
      if (!fs.existsSync(projectEslintPath)) {
        throw new Error("No eslint in project node_modules");
      }
      const mod = require(projectEslintPath);
      const { ESLint } = mod;
      if (typeof ESLint !== "function") {
        throw new Error(`ESLint class not exported (keys: ${Object.keys(mod).join(", ")})`);
      }
      const version = require(path.join(projectEslintPath, "package.json")).version;
      result = { ESLint, version, source: "project", path: projectEslintPath };
      log(`Project ESLint found: v${version}`);
      log(`Path: ${projectEslintPath}`);
    } catch (e) {
      log("Project ESLint not found:", e.message);
    }
  }

  // Fall back to bundled ESLint
  if (!result) {
    const useBuiltin = atom.config.get(`${PACKAGE_NAME}.useBuiltin`);

    if (!useBuiltin) {
      log("Bundled fallback disabled");
    } else {
      // Try v8 first, then v9
      result = getBundledEslint("v8");
      if (!result) {
        result = getBundledEslint("v9");
      }
      if (result) {
        log(`Using bundled ESLint: ${result.source}, v${result.version}`);
      }
    }
  }

  if (!result) {
    log("No ESLint available");
  }

  // Cache result (even if null)
  cache.set(projectRoot, result);
  return result;
}

function resetCache() {
  cache.clear();
  log("Cache cleared");
}

module.exports = { resolveEslint, resetCache, log, getBundledEslint };
