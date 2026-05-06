const { resolveEslint, resetCache, log } = require("./resolve");

/**
 * Project-wide ESLint linter using the indie linter API.
 * Scans all project files from disk via ESLint's lintFiles() and reports
 * results through the linter-bundle IndieDelegate.
 */
class ProjectLinter {
  constructor() {
    this.indieDelegate = null;
    this.engines = new Map(); // Map<projectPath, Promise<ESLint instance | null>>
    this.scanning = false;
  }

  /**
   * Store the IndieDelegate obtained from linter-bundle.
   * @param {IndieDelegate} delegate
   */
  register(delegate) {
    this.indieDelegate = delegate;
  }

  /**
   * Get or create ESLint engine for a specific project path.
   * Returns a cached Promise so concurrent callers share a single load.
   * @param {string} projectPath
   * @returns {Promise<ESLint|null>}
   */
  getEngine(projectPath) {
    if (this.engines.has(projectPath)) {
      return this.engines.get(projectPath);
    }

    const promise = resolveEslint(projectPath).then((resolved) => {
      if (!resolved) return null;
      return new resolved.ESLint({
        cwd: projectPath,
        errorOnUnmatchedPattern: false,
      });
    });

    this.engines.set(projectPath, promise);
    return promise;
  }

  /**
   * Run the project-wide ESLint scan.
   * Scans all files; linter-bundle handles dedup with file-scoped linter via joinWith.
   */
  async runScan() {
    if (!this.indieDelegate) return;
    if (this.scanning) return;

    this.scanning = true;

    const projectPaths = atom.project.getPaths();
    if (!projectPaths.length) {
      this.scanning = false;
      return;
    }

    const allMessages = [];

    try {
      for (const projectPath of projectPaths) {
        const engine = await this.getEngine(projectPath);
        if (!engine) {
          log(`Skipping project (no ESLint): ${projectPath}`);
          continue;
        }

        let results;
        try {
          results = await engine.lintFiles(projectPath);
        } catch (error) {
          const msg = String(error.message || error);
          if (msg.includes("No ESLint configuration found") || msg.includes("no-config-found")) {
            continue;
          }
          log("Project scan error:", error);
          atom.notifications.addWarning("ESLint project scan failed", {
            detail: msg,
            dismissable: true,
          });
          continue;
        }

        for (const result of results) {
          if (!result.messages || !result.messages.length) continue;

          for (const m of result.messages) {
            allMessages.push(this.convertMessage(result.filePath, m));
          }
        }
      }

      this.indieDelegate.setAllMessages(allMessages, {
        showProjectView: true,
      });
    } catch (error) {
      log("Project scan failed:", error);
    } finally {
      this.scanning = false;
    }
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
    this.engines.clear();
    resetCache();
  }

  /**
   * Dispose all resources.
   */
  dispose() {
    this.engines.clear();
    this.indieDelegate = null;
  }
}

module.exports = new ProjectLinter();
