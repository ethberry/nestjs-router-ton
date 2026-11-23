# nestjs-ton

`@ethberry/nestjs-ton`: a NestJS module that reads TON block by block and routes the incoming messages of watched accounts to controllers (`@EventPattern`), the way `@ethberry/nestjs-viem` routes EVM logs. A single package, not a monorepo.

## Place in the package levels

Level 1: no dependencies on other `@ethberry/*` runtime packages.

## Commands

- Base branch: `main`.
- Install: `npm ci` (the lockfile is committed).
- Build: `npm run build` (`tsc`). Lint: `npm run lint`. Typecheck: `npm run typecheck`.
- Test: `npm run test`. It needs the local network: `docker compose up -d --build --wait` (`ton` = MyLocalTon, healthy about a minute after first start; `ton-api` = TON Center v2 on 8082, built from `ton-api/Dockerfile`).
- CI (`ci-test.yml`): by hand only; starts the network, then install, lint, build, test.

## Gotchas

- ESM only (`nodenext`, `.js` in relative imports). Jest runs with `NODE_OPTIONS=--experimental-vm-modules`.
- `@ton/core` and `@nestjs/*` are peers: one copy per app.
- The tests send from MyLocalTon's `main-wallet` (wallet v3, id 42, masterchain); its key is read from the `ton` container (`docker exec`, `TON_CONTAINER`). A recreated `ton` volume is a new network with a new wallet.
- The C++ TON Center images (v2 and the v3 indexer) die with SIGILL on Apple silicon; `ton-api` is the Python `ton-http-api`.
- The chain test waits for real blocks: `testTimeout` in `jest.config.json` is raised for it (the testing rule's exception for chain tests).
- Container names `ton`, `ton-api` and their ports are the same as in other EthBerry stands: one stand at a time; never `docker rm`, use `docker stop` / `docker start`.

## Docs

Usage is in `README.md`; how the reader works is in [docs/](docs/README.md). Rules are in `.claude/rules/`, synced from the shared agent kit.
