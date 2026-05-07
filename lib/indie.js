const { Task } = require("atom");
const path = require("path");

const { resetCache, log } = require("./resolve");

/**
 * Project-wide ESLint linter using the indie linter API.
 * Scans all project files from disk via ESLint's lintFiles() and reports
 * results through the linter-bundle IndieDelegate.
 */
class ProjectLinter {
  constructor() {
    this.indieDelegate = null;
    this.scanning = false;
    this.scanId = 0;
    this.task = null;
  }

  /**
   * Store the IndieDelegate obtained from linter-bundle.
   * @param {IndieDelegate} delegate
   */
  register(delegate) {
    this.indieDelegate = delegate;
  }

  /**
   * Run the project-wide ESLint scan.
   * Scans all files; linter-bundle handles dedup with file-scoped linter via joinWith.
   */
  runScan() {
    if (!this.indieDelegate) return;
    if (this.scanning) return;

    this.scanning = true;

    const projectPaths = atom.project.getPaths();
    if (!projectPaths.length) {
      this.scanning = false;
      return;
    }

    const taskPath = path.join(__dirname, "scanner.js");
    const useBuiltin = atom.config.get("linter-eslint-redux.useBuiltin");
    const scanId = ++this.scanId;
    let receivedResults = false;
    const task = Task.once(taskPath, projectPaths, useBuiltin, () => {
      if (scanId !== this.scanId || !this.indieDelegate || receivedResults) return;

      this.indieDelegate.setAllMessages([], {
        showProjectView: true,
      });
      atom.notifications.addWarning("ESLint project scan failed", {
        detail: "The scan task finished without returning results.",
        dismissable: true,
      });
      this.scanning = false;
      this.task = null;
    });
    this.task = task;

    task.on("linter-eslint-redux:project-scan", ({ results = [], errors = [] } = {}) => {
      if (scanId !== this.scanId || !this.indieDelegate) return;
      receivedResults = true;

      const allMessages = [];

      for (const result of results) {
        if (!result.messages || !result.messages.length) continue;

        for (const m of result.messages) {
          allMessages.push(this.convertMessage(result.filePath, m));
        }
      }

      this.indieDelegate.setAllMessages(allMessages, {
        showProjectView: true,
      });

      for (const error of errors) {
        log("Project scan error:", error);
        atom.notifications.addWarning("ESLint project scan failed", {
          detail: error.projectPath ? `${error.projectPath}\n\n${error.message}` : error.message,
          dismissable: true,
        });
      }

      this.scanning = false;
      this.task = null;
    });
  }

  /**
   * Convert an ESLint LintMessage to linter message format.
   * Maps 1-based ESLint coordinates to 0-based position arrays.
   * @param {string} filePath
   * @param {Object} msg - ESLint LintMessage
   * @returns {Object} Linter message
   */
  convertMessage(filePath, msg) {
    const { column = 1, endColumn, endLine, line, message, ruleId, severity } = msg;

    const startRow = Math.max(0, (line || 1) - 1);
    const startCol = Math.max(0, (column || 1) - 1);

    let endRow, endCol;
    if (typeof endLine === "number" && typeof endColumn === "number") {
      endRow = Math.max(0, endLine - 1);
      endCol = Math.max(0, endColumn - 1);
    } else {
      endRow = startRow;
      endCol = startCol;
    }

    return {
      severity: severity === 1 ? "warning" : "error",
      excerpt: `${ruleId || "fatal"}: ${message}`,
      location: {
        file: filePath,
        position: [
          [startRow, startCol],
          [endRow, endCol],
        ],
      },
    };
  }

  /**
   * Reset the ESLint engines so they are re-created on next scan.
   */
  resetEngine() {
    this.scanId++;
    this.scanning = false;
    if (this.task && typeof this.task.terminate === "function") {
      this.task.terminate();
    }
    this.task = null;
    resetCache();
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    this.scanId++;
    if (this.task && typeof this.task.terminate === "function") {
      this.task.terminate();
    }
    this.task = null;
    this.scanning = false;
    this.indieDelegate = null;
  }
}

module.exports = new ProjectLinter();
