import { readFile } from 'node:fs/promises';
import { databaseConfig } from '../src/commerce/database.mjs';

// DDL is not atomic. This tool never retries or rolls back a partial install.
async function main() {
  if (process.env.MARIADB_PROFILE !== 'production' || process.env.PRODUCTION_SCHEMA_INSTALL_APPROVED !== 'true') throw new Error('INSTALL_NOT_APPROVED');
  const config = databaseConfig(process.env);
  if (!config || config.database !== 'u839831098_mybshoppyDB') throw new Error('TARGET_REFUSED');
  const source = await readFile(new URL('../schema/001_production_draft.sql', import.meta.url), 'utf8');
  const statements = source.replace(/^\s*--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean);
  if (statements.length !== 22 || statements.some(s => !/^CREATE TABLE\s+[a-z_]+\s*\(/i.test(s))) throw new Error('SCHEMA_FILE_REFUSED');
  const { default: mariadb } = await import('mariadb');
  const connection = await mariadb.createConnection(config);
  let completed = 0;
  try {
    const [session] = await connection.query('SELECT DATABASE() db,CURRENT_USER() account,VERSION() version,@@session.foreign_key_checks fk,@@session.check_constraint_checks ck,@@session.in_transaction active,@@session.autocommit autocommit,@@session.tx_read_only read_only');
    if (session.db !== config.database || session.account.split('@')[0] !== config.user || !/^11\.8\.9.*MariaDB/i.test(session.version) || Number(session.fk) !== 1 || Number(session.ck) !== 1 || Number(session.active) !== 0 || Number(session.autocommit) !== 1 || Number(session.read_only) !== 0) throw new Error('SESSION_REFUSED');
    const [row] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [config.database]);
    if (Number(row.n) !== 0) throw new Error('SCHEMA_NOT_EMPTY');
    for (const statement of statements) {
      await connection.query(statement);
      completed++;
      const warnings = await connection.query('SHOW WARNINGS LIMIT 1');
      if (warnings.length) throw new Error('DDL_WARNING');
    }
    console.log('Schema installation completed: 22 tables. Verify schema metadata before using the API.');
  } catch (error) {
    console.error(`Installation stopped after ${completed} successful DDL statements. DDL commits independently; inspect the target and the server error before retrying. Error code: ${String(error.code || error.message || 'UNKNOWN').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`);
    process.exitCode = 1;
  } finally { await connection.end(); }
}
main().catch(() => { console.error('Installation refused or connection failed; check configuration and target.'); process.exitCode = 1; });
