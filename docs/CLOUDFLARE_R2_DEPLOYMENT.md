# Cloudflare R2 Deployment

## Bucket setup

Create two private R2 buckets:

- one upload bucket for patient documents
- one backup bucket for PostgreSQL dumps

Keep public access disabled. Configure TLS at the application and R2 endpoint. R2 at-rest encryption is provider-managed; application-level encryption is not implemented.

## API token permissions

Create separate least-privilege API tokens if practical. Each token should permit object read/write/list/delete operations only for its assigned bucket and no account-wide resources.

Never place credentials in Git, Render repository variables as plaintext, `VITE_*` variables, or frontend code.

## Render configuration

Set these values only in the Render dashboard secret environment:

```text
STORAGE_PROVIDER=r2
R2_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET_UPLOADS=<private-upload-bucket>
R2_BUCKET_BACKUPS=<private-backup-bucket>
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_REGION=auto
```

Verify the actual R2 endpoint returned by Cloudflare. Dashboard-only bucket names, credentials, and endpoint details cannot be confirmed from this repository.

## Existing local file migration

Existing lab-report rows keep `file_path` for backward compatibility. New rows also record `storage_provider`, `storage_key`, `storage_bucket`, and `storage_status`.

Existing files should be migrated by a separately approved, rate-limited operator job:

1. Inventory each database row and verify that the local file exists.
2. Calculate its SHA-256.
3. Upload it to the uploads bucket.
4. Verify remote size and checksum.
5. Update storage metadata only after verification.
6. Retain the local copy until all rows have been reconciled.
7. Report missing or unreadable local files instead of silently marking them migrated.

Do not assume old production files exist.

## Backup workflow

The application creates a PostgreSQL custom-format dump with `pg_dump`, hashes it, uploads it to the private backup bucket, verifies remote size and checksum, then records success.

The `pg_dump` executable must exist on Render. Set `PG_DUMP_PATH` to its executable name/path. Passwords are supplied through the `PGPASSWORD` environment variable and must not appear in logs or arguments.

Temporary dumps are created in a server temporary directory with owner-only permissions where supported.

## Manual restore

Restore only into a separately created disposable PostgreSQL database after verification of the dump file and database target.

Example operator commands are run interactively and must not be added as application endpoints:

```text
pg_restore --clean --if-exists --no-owner --dbname=<disposable-database-url> <downloaded-backup.dump>
```

Verify:

- database connection target and database name
- restored table counts and critical sample records
- application migrations
- application read-only startup
- patient-document references
- PostgreSQL provider/SSL compatibility

Only an authorized operator may then schedule an explicitly approved production recovery process.

## Production enforcement and migration safety

Production startup requires `STORAGE_PROVIDER=r2`. Do not set `STORAGE_PROVIDER=local` in production.
The database storage and reconciliation migrations have not been executed as part of this repository update.

## Orphan reconciliation

Uploads that reach R2 but cannot be persisted in PostgreSQL are written to the
`storage_reconciliations` table when database access remains available. Administrators with
`system.backup` may review records and retry deletion from the `/api/system/storage-reconciliations`
workflow. Cleanup actions are audited. If the database is unavailable, the application logs a
sanitized operational record containing provider, operation and object key without credentials.

## Backup retention states

Retention moves an eligible, verified backup through:

`ready -> pending_deletion -> deleted`

A remote deletion failure moves the record to `deletion_failed` and creates reconciliation state so it
can be retried. If deletion succeeds but final database metadata fails, the record is kept in
`pending_metadata_reconciliation`. Retention never deletes unverified records or the only remaining
verified backup.

## Legacy file inventory

Legacy backup rows without `storage_key` are not automatically deleted. Administrators with
`system.backup` can review `/api/system/backups/legacy-inventory`, confirm each physical file location,
and manually approve safe cleanup. Existing records and objects must be preserved while inventory is
unknown. Historical local backups remain a manual recovery responsibility.

## Isolated storage tests

Run storage adapter tests without database global setup:

```text
npm run test:storage -w server
```

These tests use temporary directories and mocked clients. They must not access PostgreSQL, R2, or Render.

Database integration tests are separate and destructive:

```text
npm run test:integration -w server
```

This command requires `TEST_DATABASE_URL`, `ALLOW_TEST_DATABASE_RESET=true`, an explicitly allowlisted
non-production disposable database host, and refuses production DATABASE_URL targets. `npm test` is
reserved for isolated storage tests and must not run database migrations or rollbacks.

## Administrative reconciliation permissions

Lab-object reconciliation requires both `storage.reconcile` and `lab.process`. Backup reconciliation
requires both `storage.reconcile` and `system.backup`; the list route requires `storage.reconcile`.
Retries are atomic and recheck lab and backup references before deletion. Never grant reconciliation
permissions merely to expose patient documents or backups.

## Shared object lifecycle

Object identity is `provider + bucket + storage_key`. The lifecycle registry adds
`active`, `pending_deletion`, `deletion_failed`, and `deleted` states.

Lab and backup metadata persistence registers an object reference in the same database
transaction as its database row. Reference creation is rejected when lifecycle is pending,
deleted, or unknown. Reconciliation and retention deletion claim lifecycle rows with row locks
and short leases before remote deletion.

Remote deletion is retried idempotently. Exactly-once PostgreSQL/R2 execution is not assumed:
R2 may receive repeated delete requests while the lifecycle row records and recovers durable state.
Crash scenarios:

- Crash before remote deletion: `pending_deletion` remains recoverable.
- Crash after remote deletion before metadata commit: the retry lease allows repeated deletion and
  then completion to become durable.
- Crash after database commit before response: retries observe the final lifecycle state and remain idempotent.
- Expired leases are reclaimable by authorized retention or reconciliation workflows.
- Database unavailable: deletion is not started unless the pending state can be committed.
- Object storage unavailable: lifecycle remains pending or failure state for operational retry.

The required migration order is:

1. `20261107000000_object_storage_metadata.js`
2. `20261107001000_storage_reconciliation.js`
3. `20261107002000_object_storage_lifecycle.js`

These migrations have not been executed and no Cloudflare/Render configuration has been performed.

## Rollback

Keep `STORAGE_PROVIDER=local` until migration verification is complete. The forward migration does not remove `lab_reports.file_path`.

During dual-storage migration, retain legacy files and database keys. If R2 is unavailable, do not silently fall back in production when `STORAGE_PROVIDER=r2`; investigate storage errors and keep new writes blocked.

Rollback of database metadata should not delete uploaded objects automatically.

## Troubleshooting

- Missing R2 configuration: check required Render secret variables.
- Authentication failure: rotate/reconfigure the least-privilege API token.
- Endpoint failure: verify the HTTPS endpoint and account-specific hostname.
- Missing uploads: compare database storage keys with bucket objects; do not silently regenerate keys.
- Backup failure: verify `pg_dump`, database connectivity, temp-directory permissions, R2 upload permissions, and remote checksum verification.

## Production checklist

- [ ] Both buckets are private.
- [ ] Separate least-privilege credentials are configured.
- [ ] Render secrets are configured outside source control.
- [ ] `STORAGE_PROVIDER=r2`.
- [ ] Local legacy files are inventoried and migrated.
- [ ] Lab-report authorization and audit tests pass.
- [ ] Manual and scheduled backups are verified.
- [ ] Remote checksums and sizes match.
- [ ] Retention preserves at least the last valid backup.
- [ ] A disposable restore succeeds.
- [ ] `pg_dump` and compatible `pg_restore` availability is confirmed.
- [ ] No credentials or public object URLs appear in frontend code or logs.
