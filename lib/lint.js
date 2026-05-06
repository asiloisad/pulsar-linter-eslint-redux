const exec = require("./exec");

/**
 *  Linter interface function.
 *  @param  {TextEditor} texteditor
 *  @return {Promise<Array<Message>>|null}
 */
async function lint(texteditor) {
  // Restrict linting to visible workspace editors to avoid
  // linting with wrong project .eslintrc when switching projects.
  if (!atom.workspace.getTextEditors().includes(texteditor)) {
    return null;
  }

  const filepath = texteditor.getPath();
  const projectRoot = atom.project.relativizePath(filepath)[0];

  // Skip files not in a project
  if (!projectRoot) {
    return [];
  }

  const engineInfo = await exec.getEngine(projectRoot);
  if (!engineInfo) {
    return [];
  }

  try {
    const ignored = await engineInfo.engine.isPathIgnored(filepath);
    if (ignored) return [];
  } catch {
    // If isPathIgnored fails, proceed with linting
  }

  const fileText = texteditor.getText();
  const report = await exec.exec(filepath, fileText, projectRoot);
  return exec.handle(texteditor, report);
}

module.exports = { lint };
