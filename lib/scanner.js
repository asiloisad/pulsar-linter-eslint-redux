const fs = require("fs");
const path = require("path");

function isNoConfigError(error) {
  const msg = String(error.message || error);
  return (
    msg.includes("No ESLint configuration found") ||
    msg.includes("no-config-found") ||
    msg.includes("Could not find config file")
  );
}

function resolveProjectEslint(projectPath) {
  const projectEslintPath = path.join(projectPath, "node_modules", "eslint");
  if (!fs.existsSync(projectEslintPath)) return null;

  const { ESLint } = require(projectEslintPath);
  if (typeof ESLint !== "function") return null;

  return { ESLint, source: "project" };
}

function resolveBundledEslint(version) {
  try {
    if (version === "v10") {
      const { ESLint } = require("eslint10");
      return { ESLint, source: "bundled-v10" };
    }

    const { ESLint } = require("eslint8");
    return { ESLint, source: "bundled-v8" };
  } catch {
    return null;
  }
}

function resolveEslint(projectPath, useBuiltin) {
  const projectEslint = resolveProjectEslint(projectPath);
  if (projectEslint) return projectEslint;
  if (!useBuiltin) return null;

  return resolveBundledEslint("v8") || resolveBundledEslint("v10");
}

async function lintProject(projectPath, useBuiltin) {
  const resolved = resolveEslint(projectPath, useBuiltin);
  if (!resolved) return { results: [] };

  const engine = new resolved.ESLint({
    cwd: projectPath,
    errorOnUnmatchedPattern: false,
  });

  try {
    return { results: await engine.lintFiles(projectPath) };
  } catch (error) {
    if (isNoConfigError(error) && resolved.source === "bundled-v8") {
      const alternate = resolveBundledEslint("v10");
      if (alternate) {
        try {
          const alternateEngine = new alternate.ESLint({
            cwd: projectPath,
            errorOnUnmatchedPattern: false,
          });
          return { results: await alternateEngine.lintFiles(projectPath) };
        } catch (alternateError) {
          if (isNoConfigError(alternateError)) return { results: [] };
          throw alternateError;
        }
      }
    }

    if (isNoConfigError(error)) return { results: [] };
    throw error;
  }
}

module.exports = function(projectPaths, useBuiltin) {
  const done = this.async();

  (async () => {
    const results = [];
    const errors = [];

    for (const projectPath of projectPaths) {
      try {
        const report = await lintProject(projectPath, useBuiltin);
        results.push(...report.results);
      } catch (error) {
        errors.push({
          projectPath,
          message: String(error.message || error),
        });
      }
    }

    emit("linter-eslint-redux:project-scan", { results, errors });
  })()
    .catch((error) => {
      emit("linter-eslint-redux:project-scan", {
        results: [],
        errors: [
          {
            message: String(error.message || error),
          },
        ],
      });
    })
    .then(done);
};
