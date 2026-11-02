# Production readiness notes

## Persistent media

The commerce API already reads `MEDIA_DIRECTORY` when creating its media service. Set it to an absolute path on a persistent, backed-up volume writable by the API process. Uploaded files and `/media/:key` reads use the same directory; media metadata remains in MariaDB. Without the variable the existing default is `var/media` relative to the process working directory. Restarts and releases must retain the same volume and path. Setting a new directory does not migrate existing files: inventory the existing media and plan a separately approved copy and integrity verification before switching. Do not delete the old directory. Multiple API instances need access to the same consistent storage.

## Production schema inspection — approval required before execution

Do not use the application database pool for this inspection: its guard intentionally permits only the isolated test account and database. Once explicitly approved, identify the exact production host, database, and read-only account out of band. Verify the connection uses an authenticated, encrypted channel (or an approved local tunnel) and that the account has metadata visibility only for the intended database. Use an interactive client with its secure password prompt; do not place passwords in commands, files, logs, or shell history. Check the displayed database and account before continuing; stop if either is unexpected. Do not run application code, migrations, DDL, DML, stored routines, or queries against customer data.

The following statements inspect metadata only. Run them interactively in the explicitly selected production database after approval. Save the output securely; review it for sensitive definitions before sharing. Metadata visibility depends on account privileges, so missing objects may indicate insufficient access rather than absence.

```sql
SELECT DATABASE() AS selected_database, CURRENT_USER() AS authenticated_account, VERSION() AS server_version;
SELECT TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME;
SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA
 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION;
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;
SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE
 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() ORDER BY TABLE_NAME, CONSTRAINT_NAME;
SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
 FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL
 ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION;
SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE, ACTION_TIMING, EVENT_MANIPULATION
 FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE() ORDER BY EVENT_OBJECT_TABLE, TRIGGER_NAME;
```

Compare the resulting schema, keys, constraints, storage engines and triggers with the repository's catalog requirements in `src/commerce/database.mjs` and the proposed durable checkout contract. Obtain separately approved, read-only access to definitions if their details are needed. This inspection neither proves production data correctness nor authorizes any schema change.

## Production runtime configuration (prepared, not deployed)

The production profile requires all of the following runtime settings. The actual account and Hostinger endpoint must be confirmed independently; the account allowlist is the single deployment-owned `MARIADB_PRODUCTION_ACCOUNT` value, which must exactly match `MARIADB_USER` and MariaDB `CURRENT_USER()`. Protect both settings as deployment configuration. It is not a compiled-in account allowlist. Do not set `MARIADB_LOCAL_EXECUTION_APPROVED` to select production.

```
NODE_ENV=production
MARIADB_ENABLED=true
MARIADB_PROFILE=production
MARIADB_PRODUCTION_APPROVED=true
MARIADB_PRODUCTION_TRANSPORT=local
MARIADB_HOST=127.0.0.1
MARIADB_PORT=3306
MARIADB_DATABASE=u839831098_mybshoppyDB
MARIADB_PRODUCTION_ACCOUNT=u839831098_adminmybshoppy
MARIADB_USER=u839831098_adminmybshoppy
MARIADB_PASSWORD=<injected runtime secret>
MEDIA_DIRECTORY=<absolute persistent writable path outside deployments>
CHECKOUT_ENABLED=false
```

The explicitly selected local transport uses unencrypted TCP only to 127.0.0.1:3306 and requires the exact production account and database shown above. Use it only after confirming the Node process shares the database network namespace and that the local connection is acceptable for the hosting environment. Hostinger phpMyAdmin connectivity alone does not establish this. Remote transport is the default and always requires TLS certificate verification using the Node trust store; its certificate and hostname compatibility have not been verified. A remote endpoint requiring a custom CA needs a separately reviewed configuration change. The hosting filesystem path also remains to be confirmed.

## Production installation (not authorized or database validated)

`schema/001_production_draft.sql` is the current versioned installation candidate. The guarded installer `scripts/install-production-schema.mjs` checks the production profile, explicit installer approval, exact database and configured account, MariaDB 11.8.9, session safeguards and an empty schema before issuing DDL. It issues one statement at a time and stops on errors or warnings; MariaDB DDL commits independently. Prevent other writers/installers during installation and verify target identity and backup separately. The installer is not a substitute for database validation or an independent review. Do not run it until both have passed and production installation has been separately approved.

After those prerequisites and with the above environment set securely, explicitly set `PRODUCTION_SCHEMA_INSTALL_APPROVED=true` only for the installation invocation, then run:

```
node scripts/install-production-schema.mjs
```

Remove the installation approval flag afterward. On any failure, stop and inspect metadata and server diagnostics privately; do not blindly retry or drop objects. Follow `schema/001_review_and_rollback.md`. After installation verify schema, provision an admin through a separately reviewed production procedure, initialize categories, configure persistent media, and verify catalog readiness before entering products. Checkout remains disabled.
