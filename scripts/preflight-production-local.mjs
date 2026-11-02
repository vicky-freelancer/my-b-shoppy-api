import { fileURLToPath } from 'node:url';
import { databaseConfig } from '../src/commerce/database.mjs';

export async function preflight(env, connect) {
  if (env.MARIADB_PROFILE !== 'production' || env.MARIADB_PRODUCTION_TRANSPORT !== 'local') throw new Error('CONFIG_REFUSED');
  const config = databaseConfig(env);
  if (!config) throw new Error('CONFIG_REFUSED');
  // Avoid driver initialization SQL: this collation is sent in the handshake,
  // and local timezone disables the connector's SET time_zone query.
  const { host, port, user, password, database, connectTimeout } = config;
  const connection = await connect({host, port, user, password, database, connectTimeout, collation:'utf8mb4_unicode_ci', timezone:'local', multipleStatements:false});
  try {
    const [row] = await connection.query('SELECT DATABASE() AS db, CURRENT_USER() AS account, VERSION() AS version');
    if (row?.db !== database || typeof row.account !== 'string' || row.account.split('@')[0] !== user || !/^\d+\.\d+\.\d+.*MariaDB/i.test(row.version)) throw new Error('IDENTITY_MISMATCH');
    return {version:row.version};
  } finally { await connection.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { default: mariadb } = await import('mariadb');
    const result = await preflight(process.env, options => mariadb.createConnection(options));
    console.log(`Connection successful; database and account match; server: ${result.version}`);
  } catch (error) {
    const safeCodes = new Set(['CONFIG_REFUSED','DATABASE_TARGET_REFUSED','DATABASE_PROFILE_REFUSED','DATABASE_TRANSPORT_REFUSED','PRODUCTION_DATABASE_NOT_APPROVED','DATABASE_CONFIGURATION_INCOMPLETE','DATABASE_PORT_REFUSED','IDENTITY_MISMATCH','ECONNREFUSED','ETIMEDOUT','ER_ACCESS_DENIED_ERROR','ER_BAD_DB_ERROR']);
    const candidate = error.code || error.message;
    console.error('Connection preflight failed: ' + (safeCodes.has(candidate) ? candidate : 'CONNECTION_OR_QUERY_FAILED'));
    process.exitCode = 1;
  }
}
