// Scripted repository contracts, not real MariaDB isolation/constraint tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CheckoutService } from './checkout.mjs';
function scenario({paid=false,prior=false,reservation='held',inventory=true}={}){
  const writes=[];let transactions=0;
  const attempt={id:'1',order_id:'order-test',provider_order_id:'order_provider',currency:'INR',expected_amount_paise:16000,state:'ready'};
  const repo={async transaction(fn){transactions++;return fn({async query(q,args){
    if(q.startsWith('SELECT * FROM payment_attempts'))return [attempt];
    if(q.startsWith('SELECT id,payment_status'))return [{id:attempt.order_id,payment_status:paid?'paid':'pending'}];
    if(q.startsWith('SELECT order_id FROM payment_receipts'))return prior?[{order_id:attempt.order_id}]:[];
    if(q.startsWith('SELECT id,state FROM inventory_reservations'))return [{id:'1',state:reservation}];
    if(q.startsWith('SELECT id,product_id,quantity'))return [{id:'1',product_id:'1',quantity:1}];
    writes.push({q,args});return {affectedRows:inventory?1:0};
  }});}};
  const service=new CheckoutService(repo,{}, {accountRef:'test-account'});
  return {service,writes,transactions:()=>transactions,payment:{id:'pay_test',order_id:'order_provider',currency:'INR',amount:16000,status:'captured',captured:true}};
}
test('captured API facts consume held inventory once and mark persisted order paid',async()=>{
  const s=scenario();await s.service.finalize(s.payment);
  assert.equal(s.transactions(),1);assert.equal(s.writes.filter(x=>x.q.startsWith('UPDATE inventory SET')).length,1);
  assert.ok(s.writes.some(x=>x.q.includes("payment_status='paid'")));
  const receipt=s.writes.find(x=>x.q.startsWith('INSERT INTO payment_receipts'));assert.equal(receipt.args.at(-1),null);
});
test('duplicate captured receipt has no writes or duplicate deduction',async()=>{const s=scenario({prior:true});await s.service.finalize(s.payment);assert.deepEqual(s.writes,[]);});
test('second capture preserves paid order and queues review without stock deduction',async()=>{
  const s=scenario({paid:true});await s.service.finalize(s.payment);
  assert.ok(s.writes.some(x=>x.q.includes('review_required')));assert.ok(!s.writes.some(x=>x.q.startsWith('UPDATE orders')||x.q.startsWith('UPDATE inventory SET')));
});
test('late captured payment persists evidence and review without consuming released stock',async()=>{
  const s=scenario({reservation:'released'});await s.service.finalize(s.payment);
  assert.ok(s.writes.some(x=>x.q.startsWith('INSERT INTO payment_receipts')));assert.ok(s.writes.some(x=>x.q.includes("payment_status='review_required'")));
  assert.ok(!s.writes.some(x=>x.q.startsWith('UPDATE inventory SET')));
});
for(const change of [{amount:1},{currency:'USD'},{status:'authorized',captured:false}])test('untrusted capture facts cannot mutate order '+JSON.stringify(change),async()=>{
  const s=scenario();await assert.rejects(s.service.finalize({...s.payment,...change}),/CAPTURE_FACTS_MISMATCH/);assert.deepEqual(s.writes,[]);
});
test('inventory conflict throws inside the same finalization transaction',async()=>{const s=scenario({inventory:false});await assert.rejects(s.service.finalize(s.payment),/INVENTORY_FINALIZATION_CONFLICT/);});
test('worker recovers pre-provider commit gap and queues unresolved reviews without releasing stock',async()=>{
  const statements=[],recovered=[];
  const repo={run:fn=>fn(repo),transaction:fn=>fn(repo),async query(q){statements.push(q);if(q.startsWith('SELECT order_id FROM payment_attempts'))return [{order_id:'committed-order'}];return [];}};
  const service=new CheckoutService(repo,{});service.ensureProviderOrder=async id=>recovered.push(id);
  const result=await service.reconcile();assert.deepEqual(recovered,['committed-order']);assert.equal(result.examined_creating,1);
  assert.ok(statements.some(q=>q.includes("a.provider_order_id IS NULL")));assert.ok(statements.some(q=>q.includes("'review_reservation'")));
  assert.ok(!statements.some(q=>q.includes("SET state='released'")||q.startsWith('UPDATE inventory SET')));
});
