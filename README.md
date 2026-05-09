# linter-eslint-redux

ESLint linter provider with bundled v8 and v10 support. Uses project-installed ESLint when available, falls back to bundled version.

## Features

- **Project ESLint first**: uses ESLint from your project's `node_modules` if installed.
- **Bundled fallback**: includes ESLint v8 and v10, no global install needed.
- **Multi-project support**: each project in workspace uses its own ESLint independently.
- **Silent mode**: if no ESLint config is found, the package silently does nothing.
- **Ignore support**: respects `.eslintignore` files.
- **Precise highlighting**: token-level range highlighting for lint messages.
- **Auto-fix**: supports fix suggestions from ESLint rules.

## Installation

To install `linter-eslint-redux` search for [linter-eslint-redux](https://web.pulsar-edit.dev/packages/linter-eslint-redux) in the Install pane of the Pulsar settings or run `ppm install linter-eslint-redux`. Alternatively, you can run `ppm install asiloisad/pulsar-linter-eslint-redux` to install a package directly from the GitHub repository.

## Plugins

If your project uses TypeScript, React, or other plugins, install ESLint locally:

```bash
npm install eslint @typescript-eslint/parser @typescript-eslint/eslint-plugin
```

The bundled ESLint is minimal and intended for basic linting only (no plugins).

## How It Works

1. **Project ESLint**: First checks for ESLint in your project's `node_modules/eslint`.
2. **Bundled fallback**: If no project ESLint found, tries bundled v8, then v10.
3. **Silent skip**: If no ESLint config found (tried both versions), silently skips the project.

**Caching:** ESLint resolution and config detection happen on first lint and are cached per project. Use `linter-eslint-redux:reload` to clear the cache and re-detect (e.g., after installing ESLint or adding a config file).

## Commands

Commands available in `atom-workspace`:

- `linter-eslint-redux:reload`: reset the ESLint engine cache and re-detect,
- `linter-eslint-redux:lint-projects`: lint all files in the project.

## Troubleshooting

Enable **Debug Mode** in settings and open the developer console (View → Developer → Toggle Developer Tools).

**Project ESLint found:**

```
[linter-eslint-redux] Project: C:\projects\my-app
[linter-eslint-redux] Project ESLint found: v10.0.0
[linter-eslint-redux] Path: C:\projects\my-app\node_modules\eslint
```

**Using bundled ESLint:**

```
[linter-eslint-redux] Project: C:\projects\my-app
[linter-eslint-redux] Project ESLint not found: No eslint in project node_modules
[linter-eslint-redux] Using bundled ESLint: bundled-v8, v8.57.1
```

**No config found:**

```
[linter-eslint-redux] No ESLint config found (tried both v8 and v10), skipping project
```

## Example Configs

**ESLint v8** (`.eslintrc.js`):

```ka
module.exports = {
  env: { browser: true, es2021: true, node: true },
  extends: "eslint:recommended",
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: {},
};
```

**ESLint v10** (`eslint.config.js`):

```js
const js = require("@eslint/js");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { console: "readonly" },
    },
    rules: {},
  },
];
```

## Contributing

Got ideas to make this package better, found a bug, or want to help add new features? Just drop your thoughts on GitHub. Any feedback is welcome!
