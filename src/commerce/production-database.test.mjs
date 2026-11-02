import test from 'node:test';
import assert from 'node:assert/strict';
import { databaseConfig, Database, REQUIRED_COLUMNS } from './database.mjs';

const env={NODE_ENV:'production',MARIADB_ENABLED:'true',MARIADB_PROFILE:'production',MARIADB_PRODUCTION_APPROVED:'true',MARIADB_HOST:'db.example.test',MARIADB_DATABASE:'u839831098_mybshoppyDB',MARIADB_USER:'production_account',MARIADB_PRODUCTION_ACCOUNT:'production_account',MARIADB_PASSWORD:'test-secret'};
test('production uses exact configured account and certificate verification',()=>{
  const config=databaseConfig(env);
  assert.equal(config.database,'u839831098_mybshoppyDB');
  assert.equal(config.user,'production_account');
  assert.deepEqual(config.ssl,{rejectUnauthorized:true});
});
for(const changes of [{NODE_ENV:'development'},{MARIADB_PRODUCTION_APPROVED:'false'},{MARIADB_DATABASE:'u839831098_phase6btest'},{MARIADB_USER:'other'},{MARIADB_USER:'u839831098_phase6btest',MARIADB_PRODUCTION_ACCOUNT:'u839831098_phase6btest'},{MARIADB_PRODUCTION_ACCOUNT:''},{MARIADB_PROFILE:'unknown'},{MARIADB_HOST:''}])
  test('production guard rejects '+JSON.stringify(changes),()=>assert.throws(()=>databaseConfig({...env,...changes})));
test('production session verifies connected database, account and required columns',async()=>{
  let session={db:env.MARIADB_DATABASE,account:env.MARIADB_USER+'@localhost',version:'11.8.9-MariaDB',fk:1,ck:1,active:0,autocommit:1,read_only:0};
  const columns=Object.entries(REQUIRED_COLUMNS).flatMap(([table_name,names])=>names.split(' ').map(column_name=>({table_name,column_name})));
  const connection={destroy(){},release(){},async query(q){if(q.startsWith('SELECT DATABASE'))return [session];if(q.includes('information_schema.COLUMNS'))return columns;return [];}};
  const db=new Database({getConnection:async()=>connection},{database:env.MARIADB_DATABASE,user:env.MARIADB_USER,profile:'production'});
  assert.deepEqual(await db.health(),{ready:true,database:'production'});
  session={...session,account:'other@localhost'};
  await assert.rejects(db.connection(),/DATABASE_SESSION_REFUSED/);
  session={...session,account:env.MARIADB_USER+'@localhost',db:'u839831098_phase6btest'};
  await assert.rejects(db.connection(),/DATABASE_SESSION_REFUSED/);
});

const localEnv={...env,MARIADB_PRODUCTION_TRANSPORT:'local',MARIADB_HOST:'127.0.0.1',MARIADB_PORT:'3306',MARIADB_USER:'u839831098_adminmybshoppy',MARIADB_PRODUCTION_ACCOUNT:'u839831098_adminmybshoppy'};
test('production local mode uses only the approved loopback target',()=>{
  const config=databaseConfig(localEnv);
  assert.equal(config.host,'127.0.0.1');assert.equal(config.port,3306);
  assert.equal(config.user,'u839831098_adminmybshoppy');assert.equal(config.ssl,undefined);
});
for(const changes of [{MARIADB_HOST:'localhost'},{MARIADB_HOST:'127.0.0.2'},{MARIADB_HOST:'srv1275.hstgr.io'},{MARIADB_PORT:'3307'},{MARIADB_DATABASE:'u839831098_phase6btest'},{MARIADB_USER:'other',MARIADB_PRODUCTION_ACCOUNT:'other'},{MARIADB_PRODUCTION_APPROVED:'false'},{NODE_ENV:'test'},{MARIADB_PRODUCTION_TRANSPORT:'LOCAL'}])
  test('production local rejects '+JSON.stringify(changes),()=>assert.throws(()=>databaseConfig({...localEnv,...changes})));
test('remote remains TLS verified even when pointed at loopback',()=>assert.deepEqual(databaseConfig({...localEnv,MARIADB_PRODUCTION_TRANSPORT:'remote'}).ssl,{rejectUnauthorized:true}));
test('isolated test target cannot be changed by production local transport',()=>assert.throws(()=>databaseConfig({...localEnv,MARIADB_PROFILE:'isolated-test',MARIADB_LOCAL_EXECUTION_APPROVED:'true'})));
