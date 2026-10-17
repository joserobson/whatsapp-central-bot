# Repository Guidelines

## Project Structure & Module Organization

`src/server.js` starts the service; `src/app.js` defines the Fastify routes. Configuration validation and reload live in `src/config.js`, message parsing and reply text in `src/message.js`, SQLite persistence in `src/state.js`, and delivery logic in `src/worker.js`. Distributor settings are in `config/distribuidoras.json`; integration-style tests are in `test/service.test.js`. Consult `README.md` for operation and `SPEC-DIGIARK-WHATSAPP-DISTRIBUIDORAS.md` for behavior and acceptance criteria.

## Build, Test, and Development Commands

Use Node.js 22 or newer. Run `npm ci` to install the locked dependencies, `npm test` to run the Node test suite, and `npm start` to launch the server with environment variables loaded. Copy `.env.example` to `.env` and supply local credentials before starting. `docker compose up -d --build` builds and starts the container with persistent SQLite state. There is no separate compile or lint script.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, single-quoted JavaScript strings, and semicolons, matching `src/`. Name files by responsibility (`config.js`, `worker.js`) and tests `*.test.js`. Keep route handlers small and put validation, state transitions, and delivery behavior in their respective modules. No formatter or linter is configured; follow adjacent code when editing.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add behavior-focused cases to `test/service.test.js` for webhook authentication, deduplication, cooldowns, configuration reloads, and uncertain delivery when those flows change. Use temporary files and injected HTTP requests or send functions so tests do not contact Evolution or require a running container. Run `npm test` before proposing a change; no coverage threshold is configured.

## Commit & Pull Request Guidelines

This repository has no commits yet, so no established commit-message convention exists. Use a short imperative subject that names the change, such as `Add webhook retry test`. In pull requests, describe the behavior changed, relevant spec or issue, test results, and any configuration or deployment impact. Include screenshots only for changes with a visual interface.

## Security & Configuration

Never commit `.env`, `.local/`, SQLite files, API keys, webhook secrets, or customer phone data. Keep `config/distribuidoras.json` valid and publish edits through an atomic rename so the running service never reads a partial file. Keep the service at one replica because delivery state relies on local SQLite.

## Agent Instructions

When the user sends `#commit`, check Git status, review changed project files, compose a suitable commit message, and commit only relevant project changes.
