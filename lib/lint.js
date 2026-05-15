const exec = require("./exec");
const { log } = require("./resolve");

/**
 *  Linter interface function.
 *  @param  {TextEditor} texteditor
 *  @return {Promise<Array<Message>>|null}
 */
async function lint(texteditor) {
  // Restrict linting to visible workspace editors to avoid
  // linting with wrong project .eslintrc when switching projects.
  if (!atom.workspace.getTextEditors().includes(texteditor)) {
    log("Skipping lint for non-workspace editor");
    return null;
  }

  const filepath = texteditor.getPath();
  const projectRoot = atom.project.relativizePath(filepath)[0];

  // Skip files not in a project
  if (!projectRoot) {
    log("Skipping lint outside project:", filepath);
    return [];
  }

  const engineInfo = await exec.getEngine(projectRoot);
  if (!engineInfo) {
    log("Skipping lint because no ESLint engine is available:", projectRoot);
    return [];
  }

  try {
    const ignored = await engineInfo.engine.isPathIgnored(filepath);
    if (ignored) {
      log("Skipping ignored file:", filepath);
      return [];
    }
  } catch {
    // If isPathIgnored fails, proceed with linting
  }

  const fileText = texteditor.getText();
  const report = await exec.exec(filepath, fileText, projectRoot);
  const messages = exec.handle(texteditor, report);
  log("Lint returned messages:", filepath, messages.length);
  return messages;
}

module.exports = { lint };
