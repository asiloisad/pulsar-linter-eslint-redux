const { Directory, Task } = require("atom");
const path = require("path");
const fs = require("fs");
const { minimatch } = require("minimatch");

const { resetCache, log } = require("./resolve");

/**
 * Project-wide ESLint linter using the indie linter API.
 * Scans all project files from disk via ESLint's lintFiles() and reports
 * results through the linter-bundle IndieDelegate.
 */
class ProjectLinter {
  constructor() {
    this.indieDelegate = null;
    this.busySignal = null;
    this.busyMessage = null;
    this.scanning = false;
    this.scanId = 0;
    this.task = null;
    this.treeView = null;
  }

  /**
   * Store the IndieDelegate obtained from linter-bundle.
   * @param {IndieDelegate} delegate
   */
  register(delegate) {
    this.indieDelegate = delegate;
  }

  setBusySignal(busySignal) {
    this.busySignal = busySignal;
  }

  setTreeView(treeView) {
    this.treeView = treeView;
  }

  startBusyMessage() {
    this.disposeBusyMessage();
    if (this.busySignal && typeof this.busySignal.reportBusy === "function") {
      this.busyMessage = this.busySignal.reportBusy("Scanning project with ESLint");
    }
  }

  disposeBusyMessage() {
    if (this.busyMessage && typeof this.busyMessage.dispose === "function") {
      this.busyMessage.dispose();
    }
    this.busyMessage = null;
  }

  async isPathIgnored(filePath, ignoreGlob, ignoreVCS) {
    if (!filePath) return true;

    if (ignoreVCS) {
      try {
        const directory = new Directory(filePath);
        const repository = await atom.project.repositoryForDirectory(directory);
        if (repository && repository.isPathIgnored(filePath)) {
          return true;
        }
      } catch (error) {
        log("VCS ignore check failed:", String(error.message || error));
      }
    }

    if (!ignoreGlob) return false;
    const normalizedFilePath = process.platform === "win32" ? filePath.replace(/\\/g, "/") : filePath;
    return minimatch(normalizedFilePath, ignoreGlob);
  }

  async filterIgnoredResults(results) {
    const ignoreGlob = atom.config.get("linter-bundle.ignoreGlob");
    const ignoreVCS = atom.config.get("core.excludeVcsIgnoredPaths");
    const ignored = new Map();
    const filtered = [];

    for (const result of results) {
      const filePath = result.filePath;
      if (!ignored.has(filePath)) {
        ignored.set(filePath, await this.isPathIgnored(filePath, ignoreGlob, ignoreVCS));
      }
      if (!ignored.get(filePath)) {
        filtered.push(result);
      }
    }

    return filtered;
  }

  /**
   * Run the project-wide ESLint scan.
   * Scans all files; linter-bundle handles dedup with file-scoped linter via joinWith.
   */
  getProjectPathForPath(filePath) {
    return atom.project.getPaths().find((projectPath) => {
      const relativePath = path.relative(projectPath, filePath);
      return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
    });
  }

  getSelectedScanItems() {
    if (!this.treeView || typeof this.treeView.selectedPaths !== "function") return [];

    const selectedPaths = this.treeView.selectedPaths()
      .filter(Boolean)
      .filter((selectedPath, index, paths) => paths.indexOf(selectedPath) === index)
      .filter((selectedPath) => {
        try {
          return fs.existsSync(selectedPath);
        } catch {
          return false;
        }
      });

    const scanItemsByProject = new Map();
    for (const selectedPath of selectedPaths) {
      const projectPath = this.getProjectPathForPath(selectedPath);
      if (!projectPath) continue;

      if (!scanItemsByProject.has(projectPath)) {
        scanItemsByProject.set(projectPath, {
          projectPath,
          targetPaths: [],
        });
      }
      scanItemsByProject.get(projectPath).targetPaths.push(selectedPath);
    }

    return Array.from(scanItemsByProject.values());
  }

  runSelectedScan() {
    const scanItems = this.getSelectedScanItems();
    if (!scanItems.length) {
      atom.notifications.addWarning("ESLint selected scan skipped", {
        detail: "Select one or more files or folders in the tree view first.",
        dismissable: true,
      });
      return;
    }

    this.runScan(scanItems);
  }

  runScan(scanItems = null) {
    if (!this.indieDelegate) return;
    if (this.scanning) return;

    this.scanning = true;
    this.startBusyMessage();

    const resolvedScanItems = scanItems || atom.project.getPaths();
    if (!resolvedScanItems.length) {
      this.disposeBusyMessage();
      this.scanning = false;
      return;
    }

    const taskPath = path.join(__dirname, "scanner.js");
    const useBuiltin = atom.config.get("linter-eslint-redux.useBuiltin");
    const scanId = ++this.scanId;
    let receivedResults = false;
    const task = Task.once(taskPath, resolvedScanItems, useBuiltin, () => {
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
      this.disposeBusyMessage();
    });
    this.task = task;

    task.on("linter-eslint-redux:project-scan", async ({ results = [], errors = [] } = {}) => {
      if (scanId !== this.scanId || !this.indieDelegate) return;
      receivedResults = true;

      const allMessages = [];
      results = await this.filterIgnoredResults(results);
      if (scanId !== this.scanId || !this.indieDelegate) return;

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
      this.disposeBusyMessage();
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
    this.disposeBusyMessage();
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
    this.disposeBusyMessage();
    this.scanning = false;
    this.busySignal = null;
    this.treeView = null;
    this.indieDelegate = null;
  }
}

module.exports = new ProjectLinter();
