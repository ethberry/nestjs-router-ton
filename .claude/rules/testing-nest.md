---
paths:
  - "**/*.unit-spec.ts"
  - "**/*.e2e-spec.ts"
  - "**/test/**/*.ts"
---

<!-- Shared rule (stacks: nestjs). Maintained outside this repository; local edits are overwritten. -->

# Tests in Nest repositories

Adds to the `testing` rule.

- Mock at the boundary of the system under test: another service's provider client, an external provider, the chain client, the transfer bus. Mock them through Nest DI (`app.get(Provider)` + `jest.spyOn`, or `overrideModule`), not by patching Node's HTTP stack for the whole process.
- In e2e tests, keep your own code real inside the boundary: services, repositories, DTO validation, the database (test Postgres / LocalStack from the repository's test compose).
- Tests that touch a database run only against a throwaway test database (its own container or schema, created for the run), never against a shared stand or a developer's database. Seed `tearDown` deletes exactly the rows its setup created; an empty criteria (`delete({})`) is never a cleanup.
- In a unit test of one service, its repositories are the boundary: mock their named methods (see the `typeorm` rule where it applies), never the database client underneath.
- New tests do not mock TypeORM itself (`Repository`, `DataSource`, query builder, `findOne`, `manager`). Existing tests that do are legacy; do not spread the pattern.
