# Production readiness notes

## Persistent media

Uploaded files and `/media/:key` reads resolve through the same configured directory; media metadata remains in MariaDB. Resolution happens once when the commerce app is created.

- Set `MEDIA_DIRECTORY` to an absolute path on a persistent, backed-up volume writable by the API process. In production, relative paths are rejected.
- Production paths inside Hostinger versioned deployment directories (`hbuilds`, `versions`, `releases`) are rejected at startup so a release cannot silently delete media. Keep media outside those directories.
- If `MEDIA_DIRECTORY` is unset in production, the default is `$HOME/mybshoppy-media` (falling back to `USERPROFILE`/the OS home). This is outside versioned deployment directories, but it must still be writable, backed up, and retained across releases.
- Development defaults to `var/media` under the process working directory and accepts relative paths.
- Setting a new directory does not migrate existing files. Restarts and releases must retain the same path. Multiple API instances need access to the same consistent storage.

Recommended Hostinger configuration (set manually in the deployment environment, not by application code):

```
MEDIA_DIRECTORY=/home/<account>/mybshoppy-media
```

Confirm that the Node process can create/write files in that directory before entering products. The upload endpoint `/api/v1/admin/media` and the read endpoint `/media/:key` use this same path; existing authentication, CSRF, origin checks, size limits, image signature checks and image re-encoding are unchanged.

### Media diagnostics

- Missing file for an existing `media_assets` row: HTTP `503`, code `MEDIA_FILE_UNAVAILABLE`; server log event `file_missing` with the storage key and no absolute public path.
- Missing, inaccessible or non-directory media path: HTTP `503`, code `MEDIA_DIRECTORY_UNAVAILABLE`; server log event `directory_unavailable` with a safe reason such as `missing` or `inaccessible`.
- Corrupt or changed file contents: HTTP `503`, code `MEDIA_INTEGRITY_FAILED`.
- Invalid/traversal filename: HTTP `404`, code `INVALID_MEDIA_PATH`.

Public error bodies contain only stable codes. Absolute storage paths are never returned to clients.

### Recovering or re-uploading existing missing images

Changing the configuration or deploying this code does **not** recover any existing missing file. Treat an image as recovered only after `/media/<key>` returns `200` and the file matches the `media_assets` `byte_size` and `sha256`.

1. Do not delete `media_assets` or `product_images` records. Do not rewrite `sha256`/`byte_size` to match an unrelated file.
2. Take a read-only inventory of the expected files (use a separately approved read-only database session):

   ```sql
   SELECT id, storage_key, byte_size, sha256
   FROM media_assets
   WHERE state = 'ready'
   ORDER BY id;
   ```

3. Inventory the configured directory on the server:

   ```sh
   find "$MEDIA_DIRECTORY" -maxdepth 1 -type f -name '*.webp' -printf '%f\n' | sort
   ```

4. If the file exists in an old build/release directory, search it read-only without deleting anything:

   ```sh
   find /home/<account>/domains/<domain>/hbuilds -type f -name '<storage_key>.webp' 2>/dev/null
   ```

   Repeat for `versions`/`releases` only if those directories are in use. Before copying, verify `sha256sum <file>` equals the database `sha256` and the size equals `byte_size`. Copy with `cp -p` into `$MEDIA_DIRECTORY`, leave the source in place, then re-request `/media/<key>`. The server re-checks size and hash on every request.

5. If no verified source file exists, re-upload the image through the authenticated admin media flow (`POST /api/v1/admin/media` or the admin UI) and point the product/category/subcategory at the new asset. This creates a new `media_assets` row and UUID filename; it does not delete or rewrite the old record.
6. If neither the file nor a source image is available, restore it from an approved backup. Never fabricate an empty/replacement file under an existing storage key.

The specific file `8af76d5f-d017-44ea-8575-550376400da0.webp` must be located and verified or re-uploaded by the operator; this document alone does not confirm its recovery.

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
