# Build and publishing

How the package is built, what a published package contains, how a release is made.

## Build

- `npm run build` compiles with `tsc` into `dist/` (`prebuild` empties it). ESM (`"type": "module"`, `nodenext`), exports from `dist/index.js` with `.d.ts` and source maps, target es2022.
- Specs, `test-utils.ts` and `src/fixtures` (the test jetton code) are excluded by `tsconfig.json`; tests type-check through `tsconfig.test.json` (`npm run typecheck`, part of `npm run test`).
- Not obfuscated: a single-package repository publishes plain code.

## What a published package contains

`dist/`, `README.md`, `LICENSE`, `package.json`. The guard is `.npmignore` (`src`, configs, specs, docs, agent files, `docker-compose.yml`, dot-files). Check before a release: `npm pack --dry-run`.

## Dependencies and peers

- Exact versions in `dependencies` / `devDependencies`; the lockfile is committed and installs use `npm ci`.
- `@nestjs/*`, `rxjs` and `@ton/core` are peers (one `^` range from the tested devDependency version): they hold shared state or are installed by the consuming app.
- `cron` is a peer too: the reader's `CronJob` goes into `@nestjs/schedule`'s `SchedulerRegistry`, which pins its own `cron`; a pinned copy here would be a second one once `@nestjs/schedule` moves.
- `exports` lists `types` first, as TypeScript resolves the first matching condition.
- `ton-api/Dockerfile` stays on Python 3.11: pydantic v1 of `ton-http-api` fails on 3.12 and later.

## Release

Registries: GitHub Packages `https://npm.pkg.github.com/` and npmjs `https://registry.npmjs.org/` (public).

Manual (local), from a clean checkout of `origin/main` with the network running (`docker compose up -d --build --wait`):

1. `git fetch && git checkout -B main origin/main`; `npm ci`; `npm run lint`; `npm run test`; `npm run build`; `npm pack --dry-run`.
2. `npm version minor -m '[Manual release] [skip ci] %s'` (the bump is chosen by the change).
3. GitHub Packages: `npm publish --@ethberry:registry=https://npm.pkg.github.com/`.
4. npmjs: `npm publish --access public` with a user config that maps `@ethberry` to npmjs and holds the token from the environment (never in a file of the repository).
5. `git push && git push --tags`.

CI: `ci-test.yml` (by hand: network, install, lint, build, test) and `manual.yml` (by hand: the release steps above to both registries, input `bump`). `manual.yml` authenticates to GitHub Packages before `npm ci`: the lockfile resolves the `@ethberry` dev packages (`cross-env`, `eslint-config`) from GitHub Packages, which refuses an install without a token (401). Secrets the release workflow reads: `GITHUBEMAIL`, `GITHUBTOKEN`, `GITHUBUSER`, `NPM_EMAIL`, `NPM_TOKEN`, `NPM_USER`.
