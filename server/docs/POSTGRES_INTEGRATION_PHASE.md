# PostgreSQL Integration Phase Commands

## Phase 2 disposable environment

Infrastructure inspection found:

- PostgreSQL 18.6 is installed at `C:\Program Files\PostgreSQL\18`.
- PostgreSQL service `postgresql-x64-18` is installed and running.
- Docker and Docker Compose are not installed or available on `PATH`.
- No project Docker configuration exists.

A dedicated local PostgreSQL database is therefore the practical option. A Docker container is preferred on systems that already support Docker, but it is not available on this machine.

Do not use the existing `hms` database.

Create the dedicated role and database from an administrator terminal without changing the repository `.env`:

```sql
CREATE ROLE hms_integration_user LOGIN;
CREATE DATABASE hms_postgres_integration_test OWNER hms_integration_user;
```

Set the role password interactively:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -U postgres -h localhost -d postgres
```

At the `psql` prompt:

```sql
\password hms_integration_user
\q
```

Then configure a disposable shell session only, replacing `<password>` with an URL-encoded password:

```powershell
$env:NODE_ENV = 'test'
$env:TEST_DATABASE_URL = 'postgresql://hms_integration_user:<password>@localhost:5432/hms_postgres_integration_test'
$env:TEST_DATABASE_ALLOWED_HOSTS = 'localhost'
$env:ALLOW_TEST_DATABASE_RESET = 'true'
$env:TEST_DATABASE_RESET_CONFIRM = 'HMS_DISPOSABLE_DATABASE_RESET'
```

Do not clear or reuse any production `DATABASE_URL` in the disposable shell. The configuration guard will compare the test target against `DATABASE_URL`.

The role should be granted no privileges outside `hms_postgres_integration_test`. Do not grant the integration role access to `hms` or administrative PostgreSQL roles.

All commands below require a separately created disposable PostgreSQL database. They must not target the repository's development `hms` database.

## Read-only configuration check

```powershell
node --input-type=module -e "import { assertDisposableTestDatabase } from './src/db/testSafety.js'; assertDisposableTestDatabase(process.env)"
```

This validates configuration and prints the database target without opening a database connection.

After setting the disposable connection variables, verify connectivity and the selected database without changing data:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' "$env:TEST_DATABASE_URL" `
  --set=ON_ERROR_STOP=1 `
  --command="SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

The `current_database()` result must be exactly `hms_postgres_integration_test`.

## Migration verification

After setting `NODE_ENV=test`, `TEST_DATABASE_URL`, `ALLOW_TEST_DATABASE_RESET=true`, and the dedicated reset confirmation, run:

```powershell
node --check src/db/migrations/20261001000000_initial_schema.js
npx knex --knexfile knexfile.js migrate:status
npx knex --knexfile knexfile.js migrate:latest
```

The status and latest commands are destructive only when pending migrations are applied. Run them only against the disposable database.

## Migration rollback and reapplication

```powershell
npx knex --knexfile knexfile.js migrate:rollback --all
npx knex --knexfile knexfile.js migrate:latest
```

These commands remove every migrated HMS table and recreate them in the configured test database.

## PostgreSQL integration tests

```powershell
npm run test:integration
```

Vitest global setup validates all database safety conditions, prints the normalized target, rolls back migrations, and reapplies migrations before tests. Integration tests seed the disposable database.

## Complete isolated and integration suite

```powershell
npm test
npm run test:integration
```

## Seed cleaning and test cleanup

```powershell
npm run db:reset
```

This is destructive: it truncates all public tables, restarts affected sequences, and inserts demo data only when the disposable database guards pass.

At the end of testing, delete or recreate the disposable database using PostgreSQL administration tooling operated outside this repository.

Before destructive cleanup, connect to `postgres` or another administrative maintenance database so `hms_postgres_integration_test` is not in active use:

```powershell
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -U postgres -h localhost -d postgres `
  --set=ON_ERROR_STOP=1 `
  --command="DROP DATABASE hms_postgres_integration_test;"
& 'C:\Program Files\PostgreSQL\18\bin\psql.exe' -U postgres -h localhost -d postgres `
  --set=ON_ERROR_STOP=1 `
  --command="DROP ROLE hms_integration_user;"
```

These cleanup commands are destructive and permanently remove the disposable database and role. Remove this shell's test environment variables afterward:

```powershell
Remove-Item Env:NODE_ENV, Env:TEST_DATABASE_URL, Env:TEST_DATABASE_ALLOWED_HOSTS, Env:ALLOW_TEST_DATABASE_RESET, Env:TEST_DATABASE_RESET_CONFIRM
```

Never set `TEST_DATABASE_URL` to the existing development `hms` database. Never omit the dedicated reset confirmation.
