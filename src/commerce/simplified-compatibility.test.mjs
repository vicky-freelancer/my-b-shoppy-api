import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { Database, REQUIRED_COLUMNS } from './database.mjs';
import { createCommerceApp } from './app.mjs';
import { Repository } from './repository.mjs';
import { validateProduct } from './domain.mjs';

test('backend-root manifest and lock support standalone ESM installation',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8'));
  const lock=JSON.parse(await readFile(new URL('../../package-lock.json',import.meta.url),'utf8'));
  assert.equal(manifest.type,'module');
  assert.equal(manifest.scripts.start,'node src/server.mjs');
  assert.deepEqual(lock.packages[''].dependencies,manifest.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies,manifest.devDependencies);
  for(const name of Object.keys(manifest.dependencies))assert.ok(lock.packages['node_modules/'+name],name);
  assert.equal(manifest.scripts['fixtures:mariadb'],undefined);
});

for(const [mode,env] of [
  ['UNCONFIGURED',{}],
  ['TEST',{RAZORPAY_KEY_ID:'rzp_test_local',RAZORPAY_KEY_SECRET:'synthetic-secret'}],
  ['LIVE',{RAZORPAY_KEY_ID:'rzp_live_local',RAZORPAY_KEY_SECRET:'synthetic-secret'}],
])for(const state of ['ready','not-ready','error'])test(`MariaDB health retains ${mode} fields when database is ${state}`,async t=>{
  const database={async health(){if(state==='error')throw new Error('private-password-and-connection-string');return {ready:state==='ready'};}};
  const app=createCommerceApp({database,env});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const response=await fetch(base+'/api/health');
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.ok,true);
  assert.equal(body.razorpayConfigured,mode!=='UNCONFIGURED');
  assert.equal(body.mode,mode);
  assert.equal(body.durableCheckoutReady,false);
  assert.equal(body.checkoutEnabled,false);
  assert.deepEqual(body.database,{ready:state==='ready'});
  assert.ok(!JSON.stringify(body).includes('synthetic-secret'));
  assert.ok(!JSON.stringify(body).includes('private-password'));
  const readiness=await fetch(base+'/api/v1/health');
  assert.equal(readiness.status,state==='ready'?200:state==='error'?500:503);
});

// Driver doubles only: no database driver, connection or SQL execution.
const columnRows=()=>Object.entries(REQUIRED_COLUMNS).flatMap(([table_name,names])=>names.split(' ').map(column_name=>({table_name,column_name})));
function driver({columns=columnRows(),session={},warnings=false}={}){
  const calls=[];
  const connection={destroyed:false,released:false,async query(q,values){
    calls.push({q,values});
    if(q==='SHOW WARNINGS LIMIT 1')return warnings?[{Level:'Warning'}]:[];
    if(q.startsWith('SELECT DATABASE'))return [{db:'u839831098_phase6btest',account:'u839831098_phase6btest@localhost',version:'11.4.5-MariaDB',fk:1,ck:1,active:0,autocommit:1,read_only:0,...session}];
    if(q.includes('information_schema.COLUMNS'))return columns;
    return [];
  },destroy(){this.destroyed=true;},release(){this.released=true;}};
  return {connection,calls,db:new Database({getConnection:async()=>connection})};
}

test('readiness covers exactly the revised 15-table columns without a Phase 6 ledger',async()=>{
  const schema=await readFile(new URL('../../test-fixtures/001_initial_schema.revised.sql',import.meta.url),'utf8');
  const expected=Object.fromEntries([...schema.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) ENGINE=InnoDB/g)].map(([,name,body])=>[name,[...body.matchAll(/^\s*([a-z][a-z_0-9]*)\s+(?:BIGINT|INT|SMALLINT|TINYINT|VARCHAR|CHAR|TEXT|LONGTEXT|BINARY|BOOLEAN|DECIMAL|DATETIME)\b/gm)].map(m=>m[1]).join(' ')]));
  assert.equal(Object.keys(expected).length,15);
  assert.deepEqual(REQUIRED_COLUMNS,expected);
  const fake=driver();
  assert.deepEqual(await fake.db.health(),{ready:true,database:'isolated-test'});
  assert.equal(fake.connection.released,true);
  assert.ok(!fake.calls.some(({q})=>q.includes('schema_versions')||q.includes('payment_attempts')));
  assert.deepEqual(fake.calls.find(({q})=>q.includes('information_schema.COLUMNS')).values,['u839831098_phase6btest']);
});

for(const table of Object.keys(REQUIRED_COLUMNS))test('readiness refuses missing table '+table,async()=>{
  const fake=driver({columns:columnRows().filter(row=>row.table_name!==table)});
  await assert.rejects(fake.db.connection(),/DATABASE_SCHEMA_NOT_READY/);
  assert.equal(fake.connection.destroyed,true);
});
test('readiness refuses a missing stock movement field',async()=>{
  const fake=driver({columns:columnRows().filter(row=>!(row.table_name==='inventory_movements'&&row.column_name==='reserved_delta'))});
  await assert.rejects(fake.db.connection(),/DATABASE_SCHEMA_NOT_READY/);
});
for(const session of [{db:'u839831098_mybshoppyDB'},{account:'root@localhost'},{version:'8.0.40-MySQL'},{fk:0},{ck:0},{active:1},{autocommit:0},{read_only:1}])test('readiness retains session guard '+JSON.stringify(session),async()=>{
  const fake=driver({session});
  await assert.rejects(fake.db.connection(),/DATABASE_SESSION_REFUSED/);
  assert.equal(fake.connection.destroyed,true);
});
test('readiness still rejects SQL warnings',async()=>{
  await assert.rejects(driver({warnings:true}).db.connection(),/DATABASE_WARNING/);
});

test('actual product repository records adjustment-only movements using revised columns',async()=>{
  const calls=[];
  const repo=new Repository(null,{async query(q,values){calls.push({q,values});if(q==='SHOW WARNINGS LIMIT 1')return [];return {insertId:1n,affectedRows:1};}});
  repo.product=async()=>({id:'1'});
  const input=validateProduct({title:'Local test clip',sku:'LOCAL-CLIP',category_id:'hair-accessories',sale_price:'199.99',mrp:'299',quantity:5,variants:['Gold','Rose Gold'],badges:['NEW']});
  await repo.saveProduct(input,null,'1');
  const movement=calls.find(({q})=>q.startsWith('INSERT INTO inventory_movements'));
  assert.ok(movement);
  assert.deepEqual(movement.values,['1',5,'1']);
  assert.match(movement.q,/'adjust',\?,0/);
  const product=calls.find(({q})=>q.startsWith('INSERT INTO products'));
  assert.equal(product.values[6],19999);
  assert.equal(calls.filter(({q})=>q.startsWith('INSERT INTO inventory(')).length,1);
  assert.equal(calls.filter(({q})=>q.startsWith('INSERT INTO product_variants')).length,2);
  calls.length=0;
  await repo.saveProduct({...input,quantity:3},{id:'1',on_hand:5,reserved:0},'1');
  assert.deepEqual(calls.find(({q})=>q.startsWith('INSERT INTO inventory_movements')).values,['1',-2,'1']);
  assert.ok(calls.some(({q})=>q.includes('row_version=row_version+1')));
});

test('catalog payments stay closed despite flags/injected services; webhook validation remains intact',async t=>{
  let calls=0;
  const forbidden=()=>{calls++;throw new Error('Payment/database service must not run');};
  const token='a'.repeat(64),origin='http://localhost:3000',secret='local-webhook-secret';
  const app=createCommerceApp({repo:{run:forbidden,transaction:forbidden},catalog:{},auth:{session:async()=>({user:{id:'1'},csrfToken:token})},
    checkout:new Proxy({},{get:()=>forbidden}),checkoutEnabled:true,
    env:{CHECKOUT_ENABLED:'true',RAZORPAY_KEY_ID:'rzp_test_local',RAZORPAY_KEY_SECRET:'local',RAZORPAY_WEBHOOK_SECRET:secret,RAZORPAY_ACCOUNT_ID:'acc_local',RAZORPAY_TEST_REQUESTS_APPROVED:'true'}});
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port;
  const headers={origin,cookie:'myb_admin='+token,'x-csrf-token':token,'content-type':'application/json'};
  const status=await fetch(base+'/api/checkout/status');
  assert.equal((await status.json()).enabled,false);
  for(const [method,path] of [['GET','/api/v1/checkout/session'],['POST','/api/v1/checkout'],['GET','/api/v1/orders/order_local'],['POST','/api/v1/orders/order_local/confirm'],['POST','/api/v1/admin/payments/reconcile'],['POST','/api/create-order'],['POST','/api/verify-payment']]){
    const response=await fetch(base+path,{method,headers,...(method==='POST'?{body:'{}'}:{})});
    assert.equal(response.status,503,path);
    assert.equal((await response.json()).code,'CHECKOUT_TEMPORARILY_UNAVAILABLE');
    assert.equal(response.headers.get('cache-control'),'no-store');
  }
  const raw=JSON.stringify({account_id:'acc_local',event:'payment.captured'});
  for(const [signature,expected] of [['bad',400],[createHmac('sha256',secret).update(raw).digest('hex'),503]]){
    const response=await fetch(base+'/api/razorpay-webhook',{method:'POST',headers:{'content-type':'application/json','x-razorpay-signature':signature,'x-razorpay-event-id':'evt_local'},body:raw});
    assert.equal(response.status,expected);
  }
  assert.equal((await fetch(base+'/api/v1/orders/order_local/confirm',{method:'POST',headers:{...headers,origin:'https://other.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/v1/admin/payments/reconcile',{method:'POST',headers:{...headers,'x-csrf-token':'bad'},body:'{}'})).status,403);
  assert.equal(calls,0);
});
