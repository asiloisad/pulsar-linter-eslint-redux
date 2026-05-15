const { Range } = require("atom");
const { fork } = require("child_process");
const path = require("path");
const { resetCache, log } = require("./resolve");

const WORKER_PATH = path.join(__dirname, "worker.js");

// Worker cache per project: Map<projectRoot, WorkerClient>
const workers = new Map();

let busySignal = null;
const busyMessages = new Map();

function setBusySignal(signal) {
  busySignal = signal;
}

function startBusyMessage(projectRoot, title) {
  disposeBusyMessage(projectRoot);
  if (busySignal && typeof busySignal.reportBusy === "function") {
    busyMessages.set(projectRoot, busySignal.reportBusy(title));
  }
}

function disposeBusyMessage(projectRoot) {
  const busyMessage = busyMessages.get(projectRoot);
  if (busyMessage && typeof busyMessage.dispose === "function") {
    busyMessage.dispose();
  }
  busyMessages.delete(projectRoot);
}

function disposeBusyMessages() {
  for (const projectRoot of busyMessages.keys()) {
    disposeBusyMessage(projectRoot);
  }
}

class WorkerClient {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.enginePromise = null;
    this.noEngine = false;

    this.child = fork(WORKER_PATH, [], {
      cwd: __dirname,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      execArgv: [],
      silent: true,
    });

    this.child.on("message", (message) => this.handleMessage(message));
    this.child.stdout.on("data", (data) => log("[worker stdout]", data.toString().trim()));
    this.child.stderr.on("data", (data) => log("[worker stderr]", data.toString().trim()));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      log("ESLint worker exited:", this.projectRoot, code || signal || "unknown");
      workers.delete(this.projectRoot);
      this.rejectAll(new Error(`ESLint worker exited (${code || signal || "unknown"})`));
    });
  }

  handleMessage(message) {
    if (!message) return;

    if (message.type === "log") {
      log("[worker]", ...message.args);
      return;
    }

    if (message.type !== "response") return;

    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  request(type, payload = {}) {
    if (!this.child || !this.child.connected) {
      return Promise.reject(new Error("ESLint worker is not running"));
    }

    const id = this.nextRequestId++;
    const promise = new Promise((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
    });

    this.child.send({ id, type, ...payload }, (error) => {
      if (!error) return;
      const pending = this.pendingRequests.get(id);
      if (!pending) return;
      this.pendingRequests.delete(id);
      pending.reject(error);
    });

    return promise;
  }

  ensureEngine() {
    if (this.noEngine) return Promise.resolve(null);
    if (this.enginePromise) return this.enginePromise;

    startBusyMessage(this.projectRoot, "Loading ESLint");
    this.enginePromise = this.request("init", {
      projectRoot: this.projectRoot,
      useBuiltin: atom.config.get("linter-eslint-redux.useBuiltin"),
      debugMode: atom.config.get("linter-eslint-redux.debugMode"),
    })
      .then((result) => {
        if (!result || !result.ready) {
          this.noEngine = true;
          return null;
        }

        return {
          source: result.source,
          engine: {
            isPathIgnored: (filepath) =>
              this.request("isPathIgnored", {
                filepath,
                debugMode: atom.config.get("linter-eslint-redux.debugMode"),
              }),
            lintText: (filetext, options) =>
              this.request("lintText", {
                filetext,
                filepath: options && options.filePath,
                debugMode: atom.config.get("linter-eslint-redux.debugMode"),
              }),
          },
        };
      })
      .finally(() => {
        disposeBusyMessage(this.projectRoot);
      });

    return this.enginePromise;
  }

  dispose() {
    this.rejectAll(new Error("ESLint worker disposed"));

    if (this.child) {
      this.child.removeAllListeners();
      if (this.child.connected) {
        this.child.disconnect();
      }
      this.child.kill();
    }
    this.child = null;
  }
}

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
  if (!workers.has(projectRoot)) {
    log("Starting ESLint worker:", projectRoot);
    workers.set(projectRoot, new WorkerClient(projectRoot));
  }

  return workers.get(projectRoot).ensureEngine();
}

function resetEngine() {
  for (const worker of workers.values()) {
    worker.dispose();
  }
  workers.clear();
  disposeBusyMessages();
  resetCache();
}

/**
 *  Lint a single file using ESLint.
 *  @param {string} filepath - Path to the file being linted
 *  @param {string} filetext - Content of the file
 *  @param {string} projectRoot - Project root path for ESLint resolution
 */
async function exec(filepath, filetext, projectRoot) {
  const engineInfo = await getEngine(projectRoot);
  if (!engineInfo) {
    return { results: [{ messages: [] }] };
  }

  try {
    const report = await engineInfo.engine.lintText(filetext, { filePath: filepath });
    log(
      "ESLint worker report:",
      filepath,
      report && report.results
        ? `${report.results.length} result(s), ${report.results.reduce(
            (count, result) => count + (result.messages ? result.messages.length : 0),
            0,
          )} message(s)`
        : "empty report",
    );
    return report;
  } catch (error) {
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

module.exports = { exec, handle, resetEngine, getEngine, setBusySignal, dispose: resetEngine };
