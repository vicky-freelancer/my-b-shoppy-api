import { randomUUID,createHmac } from 'node:crypto';
import { Fault,requireThat,normalizeItems,text,canonical,digest } from './domain.mjs';
import { validateCapturedPayment,verifyCheckoutSignature } from '../payment-security.mjs';

export const LIVE_CHECKOUT_RELEASE_APPROVED=false;
export function quote(items,products){
  const stock=new Map();let subtotal=0;
  const lines=items.map(item=>{
    const p=products.get(item.product_id);requireThat(p&&p.is_active&&!p.archived_at&&p.category_active&&(p.subcategory_id==null||p.subcategory_active),'PRODUCT_UNAVAILABLE',409);
    const v=p.variant_options.find(v=>String(v.id)===item.variant_id&&v.is_active);requireThat(!!v,'VARIANT_UNAVAILABLE',409);
    const unit=Number(p.sale_price_paise),mrp=Number(p.mrp_paise),amount=unit*item.quantity;
    requireThat(Number.isSafeInteger(unit)&&unit>=0&&unit<=mrp&&Number.isSafeInteger(amount),'INVALID_STORED_PRICE',409);
    subtotal+=amount;requireThat(Number.isSafeInteger(subtotal)&&subtotal<=999999999999,'ORDER_LIMIT');
    stock.set(p.id,(stock.get(p.id)||0)+item.quantity);
    return {...item,title:p.title,sku:p.sku,category:p.category,variant:v.label,unit,mrp,amount};
  });
  for(const [pid,qty] of stock){const p=products.get(pid);requireThat(Number(p.on_hand)-Number(p.reserved)>=qty,'INSUFFICIENT_STOCK',409);}
  requireThat(subtotal>0,'ZERO_TOTAL_NOT_PAYABLE');return {lines,stock,subtotal,shipping:6000,total:subtotal+6000,currency:'INR'};
}
const accessFor=(scope,orderId)=>createHmac('sha256',scope).update('order:'+orderId).digest('hex');
export class RazorpayTestProvider {
  constructor(env,request=fetch){this.env=env;this.request=request;}
  config(){requireThat(this.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')&&this.env.RAZORPAY_KEY_SECRET&&this.env.RAZORPAY_TEST_REQUESTS_APPROVED==='true','PAYMENT_PROVIDER_DISABLED',503);}
  async call(route,body){
    this.config();let response;
    try{response=await this.request('https://api.razorpay.com/v1/'+route,{method:body?'POST':'GET',headers:{Authorization:'Basic '+Buffer.from(this.env.RAZORPAY_KEY_ID+':'+this.env.RAZORPAY_KEY_SECRET).toString('base64'),'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000)});}
    catch{throw new Fault(503,'PROVIDER_OUTCOME_UNKNOWN');}
    if(!response.ok)throw new Fault(503,'PROVIDER_UNAVAILABLE');return response.json();
  }
  create(order){return this.call('orders',{amount:order.total,currency:'INR',receipt:order.receipt,notes:{internal_order_id:order.id}});}
  payment(paymentId){requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(paymentId),'INVALID_PAYMENT_ID');return this.call('payments/'+encodeURIComponent(paymentId));}
  payments(orderId){requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(orderId),'INVALID_PROVIDER_ORDER');return this.call('orders/'+encodeURIComponent(orderId)+'/payments');}
}
export class CheckoutService {
  constructor(repo,provider,{keyId='',keySecret='',accountRef='isolated-test',environment='test'}={}){this.repo=repo;this.provider=provider;this.keyId=keyId;this.keySecret=keySecret;this.accountRef=accountRef;this.environment=environment;requireThat(environment==='test','LIVE_PAYMENTS_REFUSED',503);}
  async create(scope,input){
    requireThat(/^[a-f0-9]{64}$/.test(scope),'GUEST_SESSION_REQUIRED',401);
    requireThat(input&&Object.keys(input).every(k=>['items','idempotency_key','customer'].includes(k)),'UNTRUSTED_CHECKOUT_FIELDS');
    const key=text(input.idempotency_key,128);requireThat(/^[A-Za-z0-9_-]{16,128}$/.test(key),'INVALID_IDEMPOTENCY_KEY');
    const items=normalizeItems(input.items),c=input.customer||{};
    requireThat(Object.keys(c).every(k=>['customer_name','phone','email','city','address','country','notes'].includes(k)),'INVALID_CUSTOMER_FIELDS');
    const customer={customer_name:text(c.customer_name),phone:text(c.phone,32),email:text(c.email,254,true)||null,city:text(c.city),address:text(c.address,10000),country:text(c.country,100),notes:text(c.notes,2000,true)};
    requireThat(customer.phone.replace(/\D/g,'').length>=6&&(!customer.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)),'INVALID_CONTACT');
    const hash=digest(JSON.stringify(canonical({items,customer}))),scopeHash=digest(scope);
    let orderId;
    try{orderId=await this.repo.transaction(async r=>{
      const [prior]=await r.query('SELECT order_id,request_hash FROM checkout_requests WHERE scope_hash=? AND idempotency_key=? FOR UPDATE',[scopeHash,key]);
      if(prior){requireThat(prior.request_hash===hash,'IDEMPOTENCY_CONFLICT',409);return prior.order_id;}
      const products=new Map();for(const item of items)if(!products.has(item.product_id))products.set(item.product_id,await r.product(item.product_id,true,true));
      const q=quote(items,products),oid=randomUUID(),token=accessFor(scope,oid);
      await r.query('INSERT INTO orders(id,customer_name,email,phone,city,address,country,delivery_notes,subtotal_paise,total_paise,access_token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)',[oid,customer.customer_name,customer.email,customer.phone,customer.city,customer.address,customer.country,customer.notes,q.subtotal,q.total,digest(token)]);
      await r.query('INSERT INTO checkout_requests(scope_hash,idempotency_key,request_hash,order_id) VALUES(?,?,?,?)',[scopeHash,key,hash,oid]);
      const reservation=await r.query('INSERT INTO inventory_reservations(order_id,review_after) VALUES(?,UTC_TIMESTAMP(6)+INTERVAL 15 MINUTE)',[oid]);
      let number=0;for(const line of q.lines){
        const item=await r.query('INSERT INTO order_items(order_id,line_number,product_id,variant_id,title_snapshot,sku_snapshot,category_snapshot,variant_snapshot,quantity,unit_price_paise,mrp_paise,line_total_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[oid,++number,line.product_id,line.variant_id,line.title,line.sku,line.category,line.variant,line.quantity,line.unit,line.mrp,line.amount]);
        const reserved=await r.query('INSERT INTO reservation_items(reservation_id,order_id,order_item_id,product_id,quantity) VALUES(?,?,?,?,?)',[String(reservation.insertId),oid,String(item.insertId),line.product_id,line.quantity]);
        await r.query("INSERT INTO inventory_movements(product_id,reservation_item_id,operation_key,kind,on_hand_delta,reserved_delta,reason,actor_ref) VALUES(?,?,?,'reserve',0,?,'Checkout reservation','guest')",[line.product_id,String(reserved.insertId),'reserve:'+oid+':'+number,line.quantity]);
      }
      for(const [pid,qty] of q.stock){const result=await r.query('UPDATE inventory SET reserved=reserved+?,row_version=row_version+1 WHERE product_id=? AND on_hand-reserved>=?',[qty,pid,qty]);requireThat(Number(result.affectedRows)===1,'INSUFFICIENT_STOCK',409);}
      await r.query('INSERT INTO payment_attempts(order_id,attempt_number,account_ref,environment,receipt_key,expected_amount_paise) VALUES(?,1,?,?,?,?)',[oid,this.accountRef,this.environment,'mbs-'+oid.slice(0,32),q.total]);
      await r.query("INSERT INTO outbox_jobs(order_id,kind,dedupe_key,available_at) VALUES(?,'create_provider_order',?,UTC_TIMESTAMP(6))",[oid,'create:'+oid]);return oid;
    });}catch(e){
      // Safe duplicate-key/deadlock response: caller retries the SAME key; no hidden replay of a network call.
      if([1062,1213,1205].includes(e.errno))throw new Fault(409,'CHECKOUT_RETRY_SAME_KEY');throw e;
    }
    await this.ensureProviderOrder(orderId);
    return this.status(orderId,accessFor(scope,orderId),true);
  }
  async ensureProviderOrder(orderId){
    const attempt=await this.repo.transaction(async r=>{
      const [a]=await r.query('SELECT id,order_id,receipt_key,expected_amount_paise,state FROM payment_attempts WHERE order_id=? FOR UPDATE',[orderId]);
      if(!a||a.state!=='creating')return null;
      // Commit claim BEFORE network. Unknown never becomes automatically retryable.
      await r.query("UPDATE payment_attempts SET state='unknown',reconcile_after=UTC_TIMESTAMP(6)+INTERVAL 1 MINUTE WHERE id=?",[a.id]);return a;
    });if(!attempt)return;
    let providerOrder;
    try{providerOrder=await this.provider.create({id:orderId,receipt:attempt.receipt_key,total:Number(attempt.expected_amount_paise)});}
    catch{ return; } // Durable unknown + reservation survives; explicit reconciliation required.
    requireThat(providerOrder&&/^[A-Za-z0-9_-]{1,64}$/.test(providerOrder.id)&&providerOrder.currency==='INR'&&Number(providerOrder.amount)===Number(attempt.expected_amount_paise),'PROVIDER_ORDER_MISMATCH',409);
    await this.repo.transaction(async r=>{
      await r.query("UPDATE payment_attempts SET provider_order_id=?,state='ready' WHERE id=? AND state='unknown' AND provider_order_id IS NULL",[providerOrder.id,attempt.id]);
      await r.query("UPDATE outbox_jobs SET kind='reconcile_payment',state='pending',available_at=UTC_TIMESTAMP(6)+INTERVAL 1 MINUTE WHERE dedupe_key=?",['create:'+orderId]);
    });
  }
  async status(orderId,token,includeAccess=false){
    requireThat(typeof token==='string'&&/^[a-f0-9]{64}$/.test(token),'ORDER_ACCESS_REQUIRED',401);
    return this.repo.run(async r=>{
      const [o]=await r.query('SELECT id,payment_status,total_paise,currency,access_token_hash FROM orders WHERE id=? AND access_token_hash=?',[text(orderId,64),digest(token)]);if(!o)throw new Fault(404,'ORDER_NOT_FOUND');
      const [a]=await r.query('SELECT provider_order_id,state FROM payment_attempts WHERE order_id=? ORDER BY attempt_number DESC LIMIT 1',[orderId]);
      return {order_id:o.id,payment_status:o.payment_status,total_paise:Number(o.total_paise),currency:o.currency,provider_order_id:a?.provider_order_id||null,provider_state:a?.state,key_id:this.keyId,...(includeAccess?{access_token:token}:{})};
    });
  }
  async confirm(orderId,token,input){
    const status=await this.status(orderId,token);
    requireThat(input.razorpay_order_id===status.provider_order_id&&verifyCheckoutSignature({storedProviderOrderId:status.provider_order_id,paymentId:input.razorpay_payment_id,signature:input.razorpay_signature,keySecret:this.keySecret}),'INVALID_PAYMENT_SIGNATURE',400);
    const facts=await this.provider.payment(input.razorpay_payment_id);
    requireThat(facts?.id===input.razorpay_payment_id,'PROVIDER_PAYMENT_MISMATCH',409);
    // Keep sanitized authenticated evidence even if stock finalization rolls back.
    const bodySha256=digest(JSON.stringify(canonical({id:facts.id,order_id:facts.order_id,amount:facts.amount,currency:facts.currency,status:facts.status,captured:facts.captured})));
    const receipt=await this.persistEvent({eventId:'api:'+facts.id+':'+bodySha256.slice(0,16),eventType:'api.payment.observed',bodySha256,paymentId:facts.id,providerOrderId:facts.order_id,amountPaise:facts.amount,currency:facts.currency,paymentStatus:facts.status});
    requireThat(receipt?.durable===true,'PAYMENT_EVIDENCE_NOT_DURABLE',503);
    await this.finalize(facts);return this.status(orderId,token);
  }
  async persistEvent(event){
    requireThat(event.eventId.length<=128&&event.eventType.length<=64,'EVENT_LIMIT',400);
    requireThat((!event.paymentId||/^[A-Za-z0-9_-]{1,64}$/.test(event.paymentId))&&(!event.providerOrderId||/^[A-Za-z0-9_-]{1,64}$/.test(event.providerOrderId)),'PROVIDER_ID_LIMIT',400);
    return this.repo.transaction(async r=>{
      const [prior]=await r.query('SELECT body_sha256 FROM payment_events WHERE account_ref=? AND environment=? AND provider_event_id=? FOR UPDATE',[this.accountRef,this.environment,event.eventId]);
      if(prior)return prior.body_sha256===event.bodySha256?{durable:true,eventId:event.eventId,bodySha256:event.bodySha256}:{conflict:true};
      await r.query('INSERT INTO payment_events(account_ref,environment,provider_event_id,event_type,body_sha256,provider_order_id,provider_payment_id,amount_paise,currency,provider_status) VALUES(?,?,?,?,?,?,?,?,?,?)',[this.accountRef,this.environment,event.eventId,event.eventType,event.bodySha256,event.providerOrderId,event.paymentId,event.amountPaise,event.currency,event.paymentStatus]);
      return {durable:true,eventId:event.eventId,bodySha256:event.bodySha256};
    });
  }
  async finalize(payment){
    return this.repo.transaction(async r=>{
      const [a]=await r.query('SELECT * FROM payment_attempts WHERE account_ref=? AND environment=? AND provider_order_id=? FOR UPDATE',[this.accountRef,this.environment,payment.order_id]);requireThat(!!a,'UNKNOWN_PAYMENT_ASSOCIATION',409);
      requireThat(validateCapturedPayment({providerOrderId:a.provider_order_id,currency:a.currency,amountPaise:Number(a.expected_amount_paise)},payment).valid,'CAPTURE_FACTS_MISMATCH',409);
      const [o]=await r.query('SELECT id,payment_status FROM orders WHERE id=? FOR UPDATE',[a.order_id]);
      const [prior]=await r.query('SELECT order_id FROM payment_receipts WHERE account_ref=? AND environment=? AND provider_payment_id=?',[this.accountRef,this.environment,payment.id]);
      if(prior){requireThat(prior.order_id===a.order_id,'PAYMENT_ASSOCIATION_CONFLICT',409);return;}
      // API003 permits unknown provider capture time. verified_at records our
      // observation; payment.created_at is never misrepresented as capture time.
      await r.query("INSERT INTO payment_receipts(attempt_id,order_id,account_ref,environment,provider_order_id,provider_payment_id,amount_paise,currency,captured_at,evidence_source) VALUES(?,?,?,?,?,?,?,?,FROM_UNIXTIME(?),'provider_api')",[a.id,a.order_id,this.accountRef,this.environment,payment.order_id,payment.id,payment.amount,payment.currency,Number.isSafeInteger(payment.captured_at)?payment.captured_at:null]);
      if(o.payment_status==='paid'){await r.query("INSERT INTO outbox_jobs(order_id,kind,dedupe_key,state,available_at) VALUES(?,'reconcile_payment',?,'review_required',UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE state='review_required'",[o.id,'extra-capture:'+payment.id]);return;}
      const [reservation]=await r.query('SELECT id,state FROM inventory_reservations WHERE order_id=? FOR UPDATE',[o.id]);
      if(reservation?.state!=='held'||a.state==='closed'){
        await r.query("UPDATE orders SET payment_status='review_required' WHERE id=?",[o.id]);
        await r.query("INSERT INTO outbox_jobs(order_id,kind,dedupe_key,state,available_at) VALUES(?,'reconcile_payment',?,'review_required',UTC_TIMESTAMP(6)) ON DUPLICATE KEY UPDATE state='review_required'",[o.id,'late-capture:'+payment.id]);return;
      }
      const lines=await r.query('SELECT id,product_id,quantity FROM reservation_items WHERE reservation_id=? ORDER BY product_id,id FOR UPDATE',[reservation.id]);
      for(const line of lines){const result=await r.query('UPDATE inventory SET on_hand=on_hand-?,reserved=reserved-?,row_version=row_version+1 WHERE product_id=? AND reserved>=? AND on_hand>=?',[line.quantity,line.quantity,line.product_id,line.quantity,line.quantity]);requireThat(Number(result.affectedRows)===1,'INVENTORY_FINALIZATION_CONFLICT',409);
        await r.query("INSERT INTO inventory_movements(product_id,reservation_item_id,operation_key,kind,on_hand_delta,reserved_delta,reason,actor_ref) VALUES(?,?,?,'consume',?,?,'Verified capture','payment-worker')",[line.product_id,line.id,'consume:'+o.id+':'+line.id,-Number(line.quantity),-Number(line.quantity)]);}
      await r.query("UPDATE inventory_reservations SET state='consumed',closed_at=UTC_TIMESTAMP(6) WHERE id=?",[reservation.id]);
      await r.query("UPDATE payment_attempts SET state='captured' WHERE id=?",[a.id]);
      await r.query("UPDATE orders SET payment_status='paid',paid_at=UTC_TIMESTAMP(6),status='confirmed' WHERE id=?",[o.id]);
      await r.query("UPDATE outbox_jobs SET state='done',lease_owner=NULL,lease_until=NULL WHERE order_id=? AND kind IN ('create_provider_order','reconcile_payment') AND state<>'review_required'",[o.id]);
    });
  }
  async reconcile(limit=20){
    // Recover an order committed before its first provider call. The same durable
    // claim in ensureProviderOrder prevents two workers making that call twice.
    const creating=await this.repo.run(r=>r.query("SELECT order_id FROM payment_attempts WHERE state='creating' ORDER BY id LIMIT ?",[limit]));
    for(const a of creating)try{await this.ensureProviderOrder(a.order_id);}catch{/* Preserve unknown state and review evidence. */}
    const events=await this.repo.run(r=>r.query("SELECT id,provider_payment_id FROM payment_events WHERE state IN ('received','retry') ORDER BY id LIMIT ?",[limit]));
    for(const event of events){try{if(!event.provider_payment_id)throw new Fault(409,'UNKNOWN_EVENT');await this.finalize(await this.provider.payment(event.provider_payment_id));await this.repo.run(r=>r.query("UPDATE payment_events SET state='processed',processed_at=UTC_TIMESTAMP(6) WHERE id=?",[event.id]));}
      catch(e){await this.repo.run(r=>r.query("UPDATE payment_events SET state=?,last_error_code=? WHERE id=?",[e.status===409?'quarantined':'retry',e.code||'RECONCILE_FAILED',event.id]));}}
    const attempts=await this.repo.run(r=>r.query("SELECT provider_order_id FROM payment_attempts WHERE state IN ('ready','unknown') AND provider_order_id IS NOT NULL ORDER BY id LIMIT ?",[limit]));
    for(const a of attempts){try{const result=await this.provider.payments(a.provider_order_id);for(const p of result.items||[])if(p.status==='captured'&&p.captured===true)await this.finalize(p);}catch{/* Retry later; no release/capture/refund on ambiguity. */}}
    await this.repo.transaction(async r=>{
      await r.query("UPDATE outbox_jobs j JOIN payment_attempts a ON a.order_id=j.order_id SET j.state='review_required',j.lease_owner=NULL,j.lease_until=NULL WHERE j.kind='create_provider_order' AND a.state='unknown' AND a.provider_order_id IS NULL AND a.reconcile_after<=UTC_TIMESTAMP(6)");
      await r.query("INSERT INTO outbox_jobs(order_id,kind,dedupe_key,state,available_at) SELECT order_id,'review_reservation',CONCAT('reservation-review:',id),'review_required',UTC_TIMESTAMP(6) FROM inventory_reservations WHERE state='held' AND review_after<=UTC_TIMESTAMP(6) ON DUPLICATE KEY UPDATE dedupe_key=VALUES(dedupe_key)");
    });
    return {examined_creating:creating.length,examined_events:events.length,examined_attempts:attempts.length};
  }
}
