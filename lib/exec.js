const { Range } = require("atom");
const { resolveEslint, resetCache, log, getBundledEslint } = require("./resolve");

// Engine cache per project: Map<projectRoot, Promise<{ engine, source } | null>>
const engines = new Map();

// Projects with no ESLint config (tried both v8 and v9) - skip linting entirely
const noConfigProjects = new Set();

/**
 *  Generate a range for a lint message position.
 *  Uses endLine/endColumn from ESLint when available for precise highlighting.
 *  Falls back to highlighting to end of line if not provided.
 */
function generateRange(textEditor, line, column, endLine, endColumn) {
  const buffer = textEditor.getBuffer();
  const lineMax = buffer.getLineCount() - 1;
  const lineNumber = Math.max(0, Math.min(line, lineMax));
  const lineText = buffer.lineForRow(lineNumber) || "";
  let colStart = typeof column === "number" && column > -1 ? column : 0;

  if (colStart > lineText.length) {
    colStart = lineText.length;
  }

  if (typeof endLine === "number" && typeof endColumn === "number") {
    const endLineNumber = Math.max(0, Math.min(endLine, lineMax));
    return [
      [lineNumber, colStart],
      [endLineNumber, endColumn],
    ];
  }

  return [
    [lineNumber, colStart],
    [lineNumber, lineText.length],
  ];
}

/**
 * Get or create ESLint engine for a project asynchronously.
 * Returns a cached Promise so concurrent callers share a single load.
 * @returns {Promise<{ engine: ESLint, source: string } | null>}
 */
function getEngine(projectRoot) {
  if (engines.has(projectRoot)) {
    return engines.get(projectRoot);
  }

  const promise = resolveEslint(projectRoot).then((resolved) => {
    if (!resolved) return null;
    const engine = new resolved.ESLint({ cwd: projectRoot });
    return { engine, source: resolved.source };
  });

  engines.set(projectRoot, promise);
  return promise;
}

/**
 * Try alternate bundled ESLint version
 */
async function tryAlternateVersion(projectRoot, currentSource) {
  const altVersion = currentSource === "bundled-v8" ? "v9" : "v8";
  const resolved = await getBundledEslint(altVersion);
  if (!resolved) return null;

  log(`Trying alternate bundled ESLint: ${resolved.source}`);
  const engine = new resolved.ESLint({ cwd: projectRoot });
  const result = { engine, source: resolved.source };
  engines.set(projectRoot, Promise.resolve(result));
  return result;
}

function resetEngine() {
  engines.clear();
  noConfigProjects.clear();
  resetCache();
}

/**
 * Check if error is "no config found"
 */
function isNoConfigError(error) {
  const msg = String(error.message || error);
  return (
    msg.includes("No ESLint configuration found") ||
    msg.includes("no-config-found") ||
    msg.includes("Could not find config file")
  );
}

/**
 *  Lint a single file using ESLint.
 *  @param {string} filepath - Path to the file being linted
 *  @param {string} filetext - Content of the file
 *  @param {string} projectRoot - Project root path for ESLint resolution
 */
async function exec(filepath, filetext, projectRoot) {
  if (noConfigProjects.has(projectRoot)) {
    return { results: [{ messages: [] }] };
  }

  const engineInfo = await getEngine(projectRoot);
  if (!engineInfo) {
    return { results: [{ messages: [] }] };
  }

  try {
    const results = await engineInfo.engine.lintText(filetext, { filePath: filepath });
    return { results };
  } catch (error) {
    if (isNoConfigError(error)) {
      if (engineInfo.source.startsWith("bundled-")) {
        const altInfo = await tryAlternateVersion(projectRoot, engineInfo.source);
        if (altInfo) {
          try {
            const results = await altInfo.engine.lintText(filetext, { filePath: filepath });
            return { results };
          } catch (altError) {
            if (isNoConfigError(altError)) {
              noConfigProjects.add(projectRoot);
              log("No ESLint config found (tried both v8 and v9), skipping project");
            } else {
              log("ESLint error:", String(altError.message || altError));
            }
            return { results: [{ messages: [] }] };
          }
        }
      }
      noConfigProjects.add(projectRoot);
      log("No ESLint config found, skipping project");
      return { results: [{ messages: [] }] };
    }
    log("ESLint error:", String(error.message || error));
    return {
      results: [
        {
          messages: [
            {
              line: 1,
              column: 1,
              message: String(error.message || error),
              ruleId: "error",
              severity: 2,
            },
          ],
        },
      ],
    };
  }
}

/**
 *  Handle the report returned by a linter run.
 */
function handle(texteditor, report) {
  if (!report || !report.results || !report.results.length) {
    return [];
  }

  return report.results[0].messages.map(
    ({ column = 1, endColumn, endLine, line, message, ruleId, severity, fix }) => {
      const fileBuffer = texteditor.getBuffer();
      const lineLength = fileBuffer.lineLengthForRow(line - 1);
      const colStart = column - 1 > lineLength ? lineLength + 1 : column;
      const position = generateRange(
        texteditor,
        line - 1,
        colStart - 1,
        endLine != null ? endLine - 1 : undefined,
        endColumn != null ? endColumn - 1 : undefined,
      );
      const file = texteditor.getPath();

      return {
        severity: severity === 1 ? "warning" : "error",
        excerpt: `${ruleId || "fatal"}: ${message}`,
        solutions: fix
          ? [
              {
                position: new Range(
                  fileBuffer.positionForCharacterIndex(fix.range[0]),
                  fileBuffer.positionForCharacterIndex(fix.range[1]),
                ),
                replaceWith: fix.text,
              },
            ]
          : null,
        location: { file, position },
      };
    },
  );
}

module.exports = { exec, handle, resetEngine, getEngine };
