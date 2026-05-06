const path = require("path");
const fs = require("fs");

const PACKAGE_NAME = "linter-eslint-redux";

// Cache stores Promise<result | null> per project root to prevent duplicate loads
const cache = new Map();

function log(...args) {
  if (atom.config.get(`${PACKAGE_NAME}.debugMode`)) {
    console.log(`[${PACKAGE_NAME}]`, ...args);
  }
}

/**
 * Get bundled ESLint asynchronously, deferring the heavy require() via setImmediate.
 * @param {"v8" | "v9"} version
 * @returns {Promise<{ ESLint: class, version: string, source: string } | null>}
 */
function getBundledEslint(version) {
  return new Promise((resolve) => {
    setImmediate(() => {
      try {
        if (version === "v9") {
          const { ESLint } = require("eslint9");
          const pkgPath = require.resolve("eslint9/package.json");
          const ver = require(pkgPath).version;
          resolve({ ESLint, version: ver, source: "bundled-v9" });
        } else {
          const { ESLint } = require("eslint8");
          const pkgPath = require.resolve("eslint8/package.json");
          const ver = require(pkgPath).version;
          resolve({ ESLint, version: ver, source: "bundled-v8" });
        }
      } catch (e) {
        log(`Bundled ESLint ${version} error:`, e.message);
        resolve(null);
      }
    });
  });
}

/**
 * Resolve ESLint for a specific project asynchronously.
 * Returns a cached Promise so concurrent callers share a single load.
 * Priority: 1) Project local, 2) Bundled v8, 3) Bundled v9
 * @param {string} projectRoot
 * @returns {Promise<{ ESLint: class, version: string, source: string } | null>}
 */
function resolveEslint(projectRoot) {
  if (cache.has(projectRoot)) {
    return cache.get(projectRoot);
  }

  const promise = _doResolve(projectRoot);
  cache.set(projectRoot, promise);
  return promise;
}

async function _doResolve(projectRoot) {
  log("Project:", projectRoot);

  if (projectRoot) {
    const projectEslintPath = path.join(projectRoot, "node_modules", "eslint");
    if (fs.existsSync(projectEslintPath)) {
      try {
        const result = await new Promise((resolve, reject) => {
          setImmediate(() => {
            try {
              const mod = require(projectEslintPath);
              const { ESLint } = mod;
              if (typeof ESLint !== "function") {
                throw new Error(`ESLint class not exported (keys: ${Object.keys(mod).join(", ")})`);
              }
              const version = require(path.join(projectEslintPath, "package.json")).version;
              resolve({ ESLint, version, source: "project", path: projectEslintPath });
            } catch (e) {
              reject(e);
            }
          });
        });
        log(`Project ESLint found: v${result.version}`);
        log(`Path: ${projectEslintPath}`);
        return result;
      } catch (e) {
        log("Project ESLint not found:", e.message);
      }
    } else {
      log("Project ESLint not found: No eslint in project node_modules");
    }
  }

  const useBuiltin = atom.config.get(`${PACKAGE_NAME}.useBuiltin`);
  if (!useBuiltin) {
    log("Bundled fallback disabled");
    log("No ESLint available");
    return null;
  }

  let result = await getBundledEslint("v8");
  if (!result) {
    result = await getBundledEslint("v9");
  }

  if (result) {
    log(`Using bundled ESLint: ${result.source}, v${result.version}`);
  } else {
    log("No ESLint available");
  }

  return result;
}

function resetCache() {
  cache.clear();
  log("Cache cleared");
}

module.exports = { resolveEslint, resetCache, log, getBundledEslint };
