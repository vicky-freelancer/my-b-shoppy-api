import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { CATEGORIES,paise,normalizeItems,validateProduct,Fault } from './domain.mjs';
import { databaseConfig,Database,sql,REQUIRED_COLUMNS } from './database.mjs';
import { hashPassword,checkPassword,csrfFor } from './auth.mjs';
import { CatalogService } from './catalog.mjs';
import { CheckoutService,quote,RazorpayTestProvider } from './checkout.mjs';
import { MediaService } from './media.mjs';
import { buildTestCatalog } from './test-catalog.mjs';
import { MemoryTestRepository } from './memory-test-repository.mjs';
import { createCommerceApp } from './app.mjs';
import { parseTestOrigins } from '../runtime-config.mjs';

test('100-product manifest is deterministic and balanced with owned subcategories/images',()=>{
  const a=buildTestCatalog();assert.deepEqual(a,buildTestCatalog());assert.equal(a.products.length,100);assert.equal(new Set(a.products.map(p=>p.slug)).size,100);assert.equal(new Set(a.products.map(p=>p.sku)).size,100);
  for(const c of CATEGORIES)assert.equal(a.products.filter(p=>p.category_id===c.id).length,10);
  for(const p of a.products){assert.ok(p.title.startsWith('TEST '));assert.ok(p.mrp>=p.sale_price&&p.quantity>0);assert.ok(a.images.some(i=>i.ref===p.image_ref));assert.ok(a.subcategories.some(s=>s.category_id+':'+s.slug===p.subcategory_ref));}
});
for(const value of [-1,0,1.5,1000,NaN,Infinity,'1'])test('cart quantity rejects '+String(value),()=>assert.throws(()=>normalizeItems([{product_id:'1',variant_id:'1',quantity:value}])));
test('cart merges variant retries but keeps distinct variants',()=>assert.deepEqual(normalizeItems([{product_id:'1',variant_id:'2',quantity:1},{product_id:'1',variant_id:'2',quantity:2}]),[{product_id:'1',variant_id:'2',quantity:3}]));
for(const field of ['price','amount','shipping','discount'])test('cart rejects authoritative browser field '+field,()=>assert.throws(()=>normalizeItems([{product_id:'1',variant_id:'2',quantity:1,[field]:1}])));
test('decimal pricing uses exact paise and rejects fractional paise',()=>{assert.equal(paise('10.01'),1001);assert.equal(paise(0.1),10);assert.throws(()=>paise('1.001'));assert.throws(()=>paise('-1'));});
for(const change of [{category_id:'unknown'},{mrp:1,sale_price:2},{quantity:-1},{variants:[]},{variants:['Gold','gold']},{sku:'bad sku'}])test('product validation rejects '+JSON.stringify(change),()=>assert.throws(()=>validateProduct({...buildTestCatalog().products[0],...change})));
for(const change of [{MARIADB_DATABASE:'u839831098_mybshoppyDB'},{MARIADB_HOST:'remote.example'},{MARIADB_USER:'root'},{MARIADB_LOCAL_EXECUTION_APPROVED:'false'}])test('database connection guard rejects '+Object.keys(change),()=>assert.throws(()=>databaseConfig({MARIADB_ENABLED:'true',MARIADB_LOCAL_EXECUTION_APPROVED:'true',MARIADB_HOST:'127.0.0.1',MARIADB_DATABASE:'u839831098_phase6btest',MARIADB_USER:'u839831098_phase6btest',MARIADB_PASSWORD:randomBytes(16).toString('hex'),...change})));
test('database disabled by default creates no pool',()=>assert.equal(databaseConfig({}),null));
test('adaptive password hash is salted, verifies only matching password',async()=>{const p=randomBytes(20).toString('base64url');const a=await hashPassword(p),b=await hashPassword(p);assert.notEqual(a,b);assert.ok(a.length<=255);assert.equal(await checkPassword(p,a),true);assert.equal(await checkPassword(p+'x',a),false);assert.equal(await checkPassword(p,'invalid'),false);});

test('shared variants use one stock balance and shipping once for multi-product quote',async()=>{
  const r=new MemoryTestRepository(true);const p=await r.product('1',true),p2=await r.product('11',true);const products=new Map([['1',p],['11',p2]]);
  const q=quote([{product_id:'1',variant_id:'1',quantity:2},{product_id:'1',variant_id:'2',quantity:3},{product_id:'11',variant_id:'21',quantity:1}],products);
  assert.equal(q.stock.get('1'),5);assert.equal(q.shipping,6000);assert.equal(q.total,q.subtotal+6000);assert.equal(q.lines.length,3);
  p.on_hand=4;assert.throws(()=>quote([{product_id:'1',variant_id:'1',quantity:2},{product_id:'1',variant_id:'2',quantity:3}],products),/INSUFFICIENT_STOCK/);
});
for(const mutation of ['inactive','wrongVariant','absent','zeroPrice'])test('trusted quote rejects '+mutation,async()=>{
  const r=new MemoryTestRepository(true),p=await r.product('1',true);const products=new Map([['1',p]]);let variant='1';
  if(mutation==='inactive')p.is_active=false;if(mutation==='wrongVariant')variant='999';if(mutation==='absent')products.clear();if(mutation==='zeroPrice')p.sale_price_paise=0;
  assert.throws(()=>quote([{product_id:'1',variant_id:variant,quantity:1}],products));
});
test('provider refuses LIVE or unapproved requests before network',async()=>{
  let calls=0;const p=new RazorpayTestProvider({RAZORPAY_KEY_ID:'rzp_live_unused'},()=>{calls++;throw Error();});await assert.rejects(p.payment('pay_test'));assert.equal(calls,0);
});
test('provider timeout becomes unknown without capture or refund',async()=>{
  const seen=[];const p=new RazorpayTestProvider({RAZORPAY_KEY_ID:'rzp_test_ephemeral',RAZORPAY_KEY_SECRET:randomBytes(16).toString('hex'),RAZORPAY_TEST_REQUESTS_APPROVED:'true'},async(url,options)=>{seen.push([url,options]);throw Error();});
  await assert.rejects(p.create({id:'test',receipt:'test',total:10000}),/PROVIDER_OUTCOME_UNKNOWN/);assert.equal(seen.length,1);assert.ok(!seen[0][0].includes('capture'));assert.ok(!seen[0][0].includes('refund'));
});
test('database transaction rollback and unknown commit discard connection (driver mock)',async()=>{
  let active=0,destroyed=0,released=0,commitFails=false;
  const conn={async query(q){if(q.startsWith('SELECT DATABASE'))return [{db:'u839831098_phase6btest',account:'u839831098_phase6btest@localhost',version:'11.8.9-MariaDB',fk:1,ck:1,active,autocommit:1,read_only:0}];if(q.includes('information_schema.COLUMNS'))return Object.entries(REQUIRED_COLUMNS).flatMap(([table_name,columns])=>columns.split(' ').map(column_name=>({table_name,column_name})));if(q.startsWith('SELECT @@'))return [{active}];return [];},async beginTransaction(){active=1;},async commit(){if(commitFails)throw Error();active=0;},async rollback(){active=0;},release(){released++;},destroy(){destroyed++;}};
  const db=new Database({getConnection:async()=>conn});await assert.rejects(db.transaction(async()=>{throw new Fault(409,'ROLLBACK_TEST');}),/ROLLBACK_TEST/);assert.equal(active,0);assert.equal(released,1);
  commitFails=true;await assert.rejects(db.transaction(async()=>1),/COMMIT_OUTCOME_UNKNOWN/);assert.equal(destroyed,1);
});
test('SQL warnings are not silently accepted',async()=>{const c={async query(q){return q==='SHOW WARNINGS LIMIT 1'?[{Level:'Warning'}]:[];}};await assert.rejects(sql(c,'SELECT 1'),/DATABASE_WARNING/);});
test('provider creation claim is committed before network and not retried while unknown (repository contract)',async()=>{
  const state={claimed:false,calls:0};const repo={async transaction(fn){return fn({async query(q){if(q.startsWith('SELECT'))return [{id:'1',state:state.claimed?'unknown':'creating',receipt_key:'r',expected_amount_paise:10000}];state.claimed=true;return {affectedRows:1};}});}};
  const service=new CheckoutService(repo,{async create(){assert.equal(state.claimed,true);state.calls++;throw Error();}});await service.ensureProviderOrder('o');await service.ensureProviderOrder('o');assert.equal(state.calls,1);
});

test('API contract: public catalog, protected CRUD, CSRF, publication, archive, uploads and no COD',async()=>{
  const repo=new MemoryTestRepository(true),catalog=new CatalogService(repo),token=randomBytes(32).toString('hex'),password=randomBytes(20).toString('hex');let valid=true;
  const user={id:'1',name:'test-only',role:'Super Admin'};
  const auth={async login(login,p){if(login!=='test-only'||p!==password)throw new Fault(401,'INVALID_CREDENTIALS');return {token,user,csrfToken:csrfFor(token)};},async session(t){if(!valid||t!==token)throw new Fault(401,'AUTH_REQUIRED');return {user,csrfToken:csrfFor(token)};},async logout(){valid=false;}};
  const directory=await mkdtemp(path.join(tmpdir(),'myb-maria-api-'));const media=new MediaService(repo,directory);
  const testOrigins=parseTestOrigins({DEPLOYMENT_PROFILE:'isolated-test',TEST_ALLOWED_ORIGINS:'https://test.example'});
  const app=createCommerceApp({repo,catalog,auth,media,allowedOrigins:['http://localhost:3000',...testOrigins],env:{NODE_ENV:'production'}}),server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const request=(p,options={})=>fetch(base+p,options);const origin=testOrigins[0];
  try{
    const page=await(await request('/api/v1/products')).json();assert.equal(page.count,100);assert.equal(page.products.length,20);
    const cat=await(await request('/api/v1/products?categoryId=ad-jewellery')).json();assert.equal(cat.count,10);
    assert.equal((await(await request('/api/v1/products?q=TEST%20Hair')).json()).count,10);
    assert.equal((await request('/api/v1/admin/products')).status,401);
    for(const blockedOrigin of [undefined,'https://test.example.evil','http://test.example','https://test.example:8443']){
      const deniedHeaders={'content-type':'application/json',...(blockedOrigin?{origin:blockedOrigin}:{})};
      assert.equal((await request('/api/admin/login',{method:'POST',headers:deniedHeaders,body:JSON.stringify({userId:'test-only',password})})).status,403);
    }
    const login=await request('/api/admin/login',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({userId:'test-only',password})});assert.equal(login.status,200);assert.match(login.headers.get('set-cookie'),/HttpOnly/);assert.match(login.headers.get('set-cookie'),/SameSite=Strict/);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    assert.match(login.headers.get('set-cookie'), /__Host-myb_admin=/);
    const headers={origin,cookie:'__Host-myb_admin='+token,'content-type':'application/json','x-csrf-token':csrfFor(token)};
    assert.equal((await request('/api/v1/admin/products',{method:'POST',headers:{...headers,origin:'https://test.example.evil'},body:'{}'})).status,403);
    assert.equal((await request('/api/v1/admin/products',{method:'POST',headers:{...headers,origin:'http://localhost:3000','x-csrf-token':'bad'},body:'{}'})).status,403);
    assert.equal((await request('/api/v1/admin/products',{method:'POST',headers:{...headers,'x-csrf-token':'bad'},body:'{}'})).status,403);
    const data={...buildTestCatalog().products[0],slug:'test-new-product',sku:'TEST-NEW-PRODUCT',image_asset_id:'1',subcategory_id:'1'};
    const created=await(await request('/api/v1/admin/products',{method:'POST',headers,body:JSON.stringify(data)})).json();assert.equal(created.product.is_active,false);const pid=created.product.id;
    assert.equal((await(await request('/api/v1/products')).json()).count,100);
    assert.equal((await request('/api/v1/admin/products/'+pid+'/publish',{method:'POST',headers,body:'{}'})).status,200);
    assert.equal((await(await request('/api/v1/products')).json()).count,101);
    assert.equal((await request('/api/v1/admin/products/'+pid,{method:'PATCH',headers,body:JSON.stringify({...data,row_version:0})})).status,409);
    assert.equal((await request('/api/v1/admin/products/'+pid,{method:'DELETE',headers})).status,200);assert.equal((await(await request('/api/v1/products')).json()).count,100);assert.ok(repo.products.has(pid));
    const png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();const form=new FormData();form.set('image',new Blob([png],{type:'image/png'}),'image.png');
    const upload=await request('/api/v1/admin/media',{method:'POST',headers:{origin,cookie:headers.cookie,'x-csrf-token':headers['x-csrf-token']},body:form});assert.equal(upload.status,201);const asset=(await upload.json()).asset;
    assert.equal((await request(asset.url)).status,200);
    const invalid=new FormData();invalid.set('image',new Blob(['<svg></svg>'],{type:'image/svg+xml'}),'image.svg');assert.equal((await request('/api/v1/admin/media',{method:'POST',headers:{origin,cookie:headers.cookie,'x-csrf-token':headers['x-csrf-token']},body:invalid})).status,422);
    assert.equal((await request('/api/v1/checkout',{method:'POST',headers:{origin,'content-type':'application/json'},body:'{}'})).status,503);
    assert.equal((await request('/api/v1/admin/orders',{method:'POST',headers,body:JSON.stringify({payment_method:'cod'})})).status,404);
    assert.equal((await request('/api/admin/logout',{method:'POST',headers,body:'{}'})).status,200);assert.equal((await request('/api/admin/session',{headers:{cookie:headers.cookie}})).status,401);
  }finally{await new Promise(r=>server.close(r));if(path.dirname(directory)===path.resolve(tmpdir())&&path.basename(directory).startsWith('myb-maria-api-'))await rm(directory,{recursive:true});}
});
