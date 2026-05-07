const { Emitter, CompositeDisposable, Disposable } = require("atom");
const lint = require("./lint");
const exec = require("./exec");
const config = require("./config");
const indie = require("./indie");

const GRAMMAR_SCOPES = [
  "source.js",
  "source.jsx",
  "source.es6",
  "source.js.jsx",
  "source.babel",
  "source.js-semantic",
  "source.ts",
  "source.tsx",
];

let disposables;

function activate() {
  const emitter = new Emitter();

  disposables = new CompositeDisposable();
  disposables.add(emitter);

  disposables.add(
    atom.commands.add("atom-workspace", {
      "linter-eslint-redux:reload": () => {
        exec.resetEngine();
        indie.resetEngine();
      },
      "linter-eslint-redux:lint-projects": () => {
        indie.runScan();
      },
      "linter-eslint-redux:lint-selected": () => {
        indie.runSelectedScan();
      },
    }),
  );

  disposables.add(
    atom.commands.add(".tree-view", {
      "linter-eslint-redux:lint-selected": () => {
        indie.runSelectedScan();
      },
    }),
  );

  // Reset indie engine when project paths change
  disposables.add(
    atom.project.onDidChangePaths(() => {
      indie.resetEngine();
    }),
  );

  config.onActivate(atom, emitter, disposables);
}

function deactivate() {
  indie.dispose();
  disposables.dispose();
}

function provideLinter() {
  return {
    grammarScopes: GRAMMAR_SCOPES,
    scope: "file",
    name: "ESLint",
    lintsOnChange: true,
    lint: lint.lint,
  };
}

function consumeIndie(registerIndie) {
  const delegate = registerIndie({
    name: "ESLint/Project",
    deleteOnOpen: atom.config.get("linter-eslint-redux.deleteOnOpen"),
  });
  disposables.add(delegate);
  indie.register(delegate);
}

function consumeBusySignal(busySignal) {
  exec.setBusySignal(busySignal);
  indie.setBusySignal(busySignal);
}

function consumeTreeView(treeView) {
  indie.setTreeView(treeView);
  return new Disposable(() => {
    indie.setTreeView(null);
  });
}

module.exports = {
  activate,
  deactivate,
  provideLinter,
  consumeIndie,
  consumeBusySignal,
  consumeTreeView,
};
