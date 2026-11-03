import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Fault, normalizeItems, text, digest, requireThat } from './commerce/domain.mjs';
import { quote } from './commerce/checkout.mjs';
import { verifyCheckoutSignature, validateCapturedPayment } from './payment-security.mjs';

const ACCESS_TOKEN=/^[a-f0-9]{64}$/;
const PROVIDER_ID=/^[A-Za-z0-9_-]{1,64}$/;
const CHECKOUT_FIELDS=new Set(['items','idempotency_key','customer']);
const CUSTOMER_FIELDS=new Set(['customer_name','phone','email','city','address','country','notes']);
const PAYMENT_MARKER='Razorpay payment: ';

function sameHex(left,right){
  const a=String(left??''),b=String(right??'');
  return a.length===b.length&&a.length>0&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
}
function paymentMarker(notes){
  const match=/(?:^|\n)Razorpay payment: ([A-Za-z0-9_-]{1,64})(?=\n|$)/.exec(String(notes??''));
  return match?.[1]||null;
}
function withPaymentMarker(notes,paymentId){
  const base=String(notes??'').split('\n').filter(line=>!line.startsWith(PAYMENT_MARKER)).join('\n').trim();
  return base?base+'\n'+PAYMENT_MARKER+paymentId:PAYMENT_MARKER+paymentId;
}
function customer(input){
  requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>CUSTOMER_FIELDS.has(key)),'INVALID_CUSTOMER_FIELDS');
  const result={
    customer_name:text(input.customer_name),phone:text(input.phone,32),email:text(input.email,254,true)||null,
    city:text(input.city),address:text(input.address,10000),country:text(input.country),notes:text(input.notes,2000,true),
  };
  requireThat(result.phone.replace(/\D/g,'').length>=6&&(!result.email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)),'INVALID_CONTACT');
  return result;
}
function statusFor(order,paymentId){
  return {
    order_id:order.id,payment_status:order.payment_status,total_paise:Number(order.total_paise),currency:order.currency,
    key_id:order.key_id,...(paymentId?{payment_id:paymentId}:{}),
  };
}

export function createLegacyCheckout({repo,env={},request=fetch}={}){
  requireThat(!!repo,'MARIADB_NOT_CONFIGURED',503);
  const keyId=env.RAZORPAY_KEY_ID||'',keySecret=env.RAZORPAY_KEY_SECRET||'';

  async function provider(path,body){
    if(!keyId||!keySecret)throw new Fault(503,'PAYMENT_PROVIDER_DISABLED');
    let response;
    try{
      response=await request('https://api.razorpay.com/v1/'+path,{
        method:body?'POST':'GET',
        headers:{Authorization:'Basic '+Buffer.from(keyId+':'+keySecret).toString('base64'),'Content-Type':'application/json'},
        body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(8000),
      });
    }catch{throw new Fault(503,'PROVIDER_OUTCOME_UNKNOWN');}
    const data=await response.json().catch(()=>({}));
    if(!response.ok)throw new Fault(503,'PROVIDER_UNAVAILABLE');
    return data;
  }

  async function lockedOrder(r,orderId,token,lock=false){
    const [order]=await r.query('SELECT id,payment_status,total_paise,currency,access_token_hash,status,admin_notes FROM orders WHERE id=?'+(lock?' FOR UPDATE':''),[orderId]);
    if(!order||!sameHex(order.access_token_hash,digest(token)))throw new Fault(404,'ORDER_NOT_FOUND');
    return order;
  }

  async function session(_req,res){
    res.set('Cache-Control','no-store').json({ok:true});
  }

  async function create(req,res){
    const input=req.body||{};
    requireThat(Object.keys(input).every(key=>CHECKOUT_FIELDS.has(key)),'UNTRUSTED_CHECKOUT_FIELDS');
    const items=normalizeItems(input.items),details=customer(input.customer),products=new Map();
    await repo.run(async r=>{
      for(const item of items)if(!products.has(item.product_id))products.set(item.product_id,await r.product(item.product_id,true,true));
    });
    const q=quote(items,products),orderId=randomUUID(),token=randomBytes(32).toString('hex');
    const providerOrder=await provider('orders',{
      amount:q.total,currency:'INR',receipt:'mbs'+orderId.replace(/-/g,'').slice(0,32),payment_capture:1,
      notes:{internal_order_id:orderId},
    });
    requireThat(providerOrder&&PROVIDER_ID.test(providerOrder.id)&&providerOrder.currency==='INR'&&Number(providerOrder.amount)===q.total,'PROVIDER_ORDER_MISMATCH',409);
    await repo.transaction(async r=>{
      await r.query('INSERT INTO orders(id,customer_name,email,phone,city,address,country,delivery_notes,status,payment_status,payment_method,currency,subtotal_paise,shipping_paise,total_paise,access_token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[
        orderId,details.customer_name,details.email,details.phone,details.city,details.address,details.country,details.notes,
        'pending','pending','razorpay','INR',q.subtotal,q.shipping,q.total,digest(token),
      ]);
      let lineNumber=0;
      for(const line of q.lines)await r.query('INSERT INTO order_items(order_id,line_number,product_id,variant_id,title_snapshot,sku_snapshot,category_snapshot,variant_snapshot,quantity,unit_price_paise,mrp_paise,line_total_paise) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[
        orderId,++lineNumber,line.product_id,line.variant_id,line.title,line.sku,line.category,line.variant,line.quantity,line.unit,line.mrp,line.amount,
      ]);
    });
    res.set('Cache-Control','no-store').json({order_id:orderId,provider_order_id:providerOrder.id,key_id:keyId,total_paise:q.total,currency:'INR',access_token:token});
  }

  async function status(req,res){
    const token=req.get('x-order-token')||'';
    requireThat(ACCESS_TOKEN.test(token),'ORDER_ACCESS_REQUIRED',401);
    requireThat(PROVIDER_ID.test(req.params.id),'ORDER_NOT_FOUND',404);
    const order=await repo.run(r=>lockedOrder(r,req.params.id,token));
    res.set('Cache-Control','no-store').json(statusFor({...order,key_id:keyId},paymentMarker(order.admin_notes)));
  }

  async function confirm(req,res){
    const token=req.get('x-order-token')||'';
    requireThat(ACCESS_TOKEN.test(token),'ORDER_ACCESS_REQUIRED',401);
    requireThat(PROVIDER_ID.test(req.params.id),'ORDER_NOT_FOUND',404);
    const input=req.body||{};
    const providerOrderId=text(input.razorpay_order_id,64),paymentId=text(input.razorpay_payment_id,64),signature=input.razorpay_signature;
    requireThat(PROVIDER_ID.test(providerOrderId),'INVALID_PROVIDER_ORDER');
    requireThat(PROVIDER_ID.test(paymentId),'INVALID_PAYMENT_ID');
    requireThat(typeof signature==='string'&&/^[a-f0-9]{64}$/i.test(signature),'INVALID_PAYMENT_SIGNATURE',400);
    const order=await repo.run(r=>lockedOrder(r,req.params.id,token));
    const recorded=paymentMarker(order.admin_notes);
    if(recorded&&recorded!==paymentId)throw new Fault(409,'PAYMENT_ALREADY_RECORDED');
    if(order.payment_status==='paid'){
      return res.set('Cache-Control','no-store').json(statusFor({...order,key_id:keyId},recorded||paymentId));
    }
    const providerOrder=await provider('orders/'+encodeURIComponent(providerOrderId));
    requireThat(providerOrder?.id===providerOrderId&&providerOrder.currency==='INR'&&Number(providerOrder.amount)===Number(order.total_paise)&&providerOrder.notes?.internal_order_id===order.id,'PROVIDER_ORDER_MISMATCH',409);
    const facts=await provider('payments/'+encodeURIComponent(paymentId));
    requireThat(facts?.id===paymentId&&facts.order_id===providerOrderId,'PROVIDER_PAYMENT_MISMATCH',409);
    requireThat(verifyCheckoutSignature({storedProviderOrderId:providerOrderId,paymentId,signature,keySecret}),'INVALID_PAYMENT_SIGNATURE',400);
    requireThat(validateCapturedPayment({providerOrderId,currency:'INR',amountPaise:Number(order.total_paise)},facts).valid,'CAPTURE_FACTS_MISMATCH',409);
    const result=await repo.transaction(async r=>{
      const current=await lockedOrder(r,order.id,token,true),prior=paymentMarker(current.admin_notes);
      if(current.payment_status==='paid')return statusFor({...current,key_id:keyId},prior||paymentId);
      if(prior&&prior!==paymentId)throw new Fault(409,'PAYMENT_ALREADY_RECORDED');
      const lines=await r.query('SELECT line_number,product_id,quantity FROM order_items WHERE order_id=? ORDER BY line_number',[order.id]);
      const quantities=new Map();
      for(const line of lines){const productId=String(line.product_id);quantities.set(productId,(quantities.get(productId)||0)+Number(line.quantity));}
      let stockConflict=false;
      for(const [productId,quantity] of quantities){
        const [inventory]=await r.query('SELECT on_hand FROM inventory WHERE product_id=? FOR UPDATE',[productId]);
        if(!inventory||Number(inventory.on_hand)<quantity){stockConflict=true;break;}
      }
      const notes=withPaymentMarker(current.admin_notes,paymentId);
      if(stockConflict){
        await r.query("UPDATE orders SET payment_status='review_required',admin_notes=? WHERE id=?",[notes,order.id]);
        return statusFor({...current,payment_status:'review_required',admin_notes:notes,key_id:keyId},paymentId);
      }
      for(const [productId,quantity] of quantities){
        await r.query('UPDATE inventory SET on_hand=on_hand-?,row_version=row_version+1 WHERE product_id=?',[quantity,productId]);
        await r.query("INSERT INTO inventory_movements(product_id,operation_key,kind,on_hand_delta,reserved_delta,reason,actor_ref) VALUES(?,?,'adjust',?,0,'Legacy checkout sale','legacy-checkout')",[productId,'legacy-sale:'+order.id+':'+productId,-quantity]);
      }
      await r.query("UPDATE orders SET payment_status='paid',status='confirmed',paid_at=UTC_TIMESTAMP(6),admin_notes=? WHERE id=?",[notes,order.id]);
      return statusFor({...current,payment_status:'paid',status:'confirmed',admin_notes:notes,key_id:keyId},paymentId);
    });
    res.set('Cache-Control','no-store').json(result);
  }

  return {session,create,status,confirm};
}
