import readline from 'node:readline';
import { hashPassword } from '../src/commerce/auth.mjs';
import { createDatabase, databaseConfig, sql } from '../src/commerce/database.mjs';

async function readPassword() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required');
  process.stdout.write('Admin password (12–256 characters): ');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let password = '';
    function finish(error) {
      process.stdin.removeListener('keypress', onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
      if (error) reject(error); else resolve(password);
    }
    function onKey(text, key = {}) {
      if (key.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
      if (key.name === 'return' || key.name === 'enter') return finish();
      if (key.name === 'backspace') password = Array.from(password).slice(0, -1).join('');
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) password += text;
    }
    process.stdin.on('keypress', onKey);
  });
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Interactive terminal required');
  const config = databaseConfig(process.env);
  if (process.env.MARIADB_PROFILE !== 'production' || !config || config.database !== 'u839831098_mybshoppyDB' || config.user !== 'u839831098_adminmybshoppy') throw new Error('Production database required');
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const login = await new Promise(resolve => prompt.question('Admin username: ', resolve));
  prompt.close();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(login)) throw new Error('Invalid admin username');
  const password = await readPassword();
  const passwordHash = await hashPassword(password);
  const database = await createDatabase(process.env);
  try {
    await database.transaction(c => sql(c,
      'INSERT INTO admin_users (singleton_slot, login_id, password_hash, is_active, credential_version) VALUES (?, ?, ?, ?, ?)',
      [1, login, passwordHash, 1, 1]));
    console.log('Production admin account provisioned.');
  } finally {
    await database.close();
  }
}

main().catch(() => {
  console.error('Provisioning did not report success. An existing account was not overwritten. Check the test database configuration, input policy, and account state before retrying; a connection failure during commit can leave the outcome unknown.');
  process.exitCode = 1;
});
