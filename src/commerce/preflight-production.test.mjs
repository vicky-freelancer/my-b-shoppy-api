import test from 'node:test';
import assert from 'node:assert/strict';
import { preflight } from '../../scripts/preflight-production-local.mjs';

const env={NODE_ENV:'production',MARIADB_ENABLED:'true',MARIADB_PROFILE:'production',MARIADB_PRODUCTION_TRANSPORT:'local',MARIADB_PRODUCTION_APPROVED:'true',MARIADB_HOST:'127.0.0.1',MARIADB_PORT:'3306',MARIADB_DATABASE:'u839831098_mybshoppyDB',MARIADB_USER:'u839831098_adminmybshoppy',MARIADB_PRODUCTION_ACCOUNT:'u839831098_adminmybshoppy',MARIADB_PASSWORD:'test-only'};
test('preflight issues only the identity SELECT and closes the connection',async()=>{
  const queries=[];let closed=false;
  const result=await preflight(env,async options=>{
    assert.equal(options.host,'127.0.0.1');assert.equal(options.port,3306);assert.equal(options.collation,'utf8mb4_unicode_ci');assert.equal(options.timezone,'local');
    return {async query(q){queries.push(q);return [{db:env.MARIADB_DATABASE,account:env.MARIADB_USER+'@localhost',version:'11.8.9-MariaDB'}];},async end(){closed=true;}};
  });
  assert.deepEqual(result,{version:'11.8.9-MariaDB'});assert.deepEqual(queries,['SELECT DATABASE() AS db, CURRENT_USER() AS account, VERSION() AS version']);assert.equal(closed,true);
});
test('preflight refuses wrong target before connecting',async()=>{
  let called=false;
  await assert.rejects(preflight({...env,MARIADB_HOST:'srv1275.hstgr.io'},async()=>{called=true;}));
  assert.equal(called,false);
});
test('preflight refuses a mismatched authenticated identity and closes connection',async()=>{
  let closed=false;
  await assert.rejects(preflight(env,async()=>({async query(){return [{db:env.MARIADB_DATABASE,account:'other@localhost',version:'11.8.9-MariaDB'}];},async end(){closed=true;}})),/IDENTITY_MISMATCH/);
  assert.equal(closed,true);
});
