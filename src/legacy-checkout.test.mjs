import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createLegacyCheckout } from './legacy-checkout.mjs';

function fakeResponse(body){
  return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
}

function fakeRepository(){
  const repo={
    productRow:{id:'1',title:'Test Product',sku:'TEST-1',category:'Test',is_active:true,archived_at:null,category_active:true,subcategory_id:null,sale_price_paise:10000,mrp_paise:12000,on_hand:5,reserved:0,variant_options:[{id:'11',label:'Gold',is_active:true}]},
    order:null,items:[],stock:new Map([['1',5]]),movements:[],
    run(fn){return fn(this);},transaction(fn){return fn(this);},
    async product(key){return String(key)===this.productRow.id?structuredClone(this.productRow):null;},
    async query(q,values=[]){
      if(q.startsWith('INSERT INTO orders(')){
        this.order={id:values[0],customer_name:values[1],email:values[2],phone:values[3],city:values[4],address:values[5],country:values[6],delivery_notes:values[7],status:values[8],payment_status:values[9],payment_method:values[10],currency:values[11],subtotal_paise:values[12],shipping_paise:values[13],total_paise:values[14],access_token_hash:values[15],admin_notes:null};
        return {affectedRows:1};
      }
      if(q.startsWith('INSERT INTO order_items(')){this.items.push({line_number:values[1],product_id:String(values[2]),quantity:Number(values[8])});return {affectedRows:1};}
      if(q.startsWith('SELECT id,payment_status,total_paise,currency,access_token_hash,status,admin_notes FROM orders'))return this.order&&this.order.id===values[0]?[this.order]:[];
      if(q.startsWith('SELECT line_number,product_id,quantity FROM order_items'))return this.items;
      if(q.startsWith('SELECT on_hand FROM inventory'))return [{on_hand:this.stock.get(String(values[0]))??0}];
      if(q.startsWith('UPDATE inventory SET on_hand=on_hand-?')){this.stock.set(String(values[1]),this.stock.get(String(values[1]))-Number(values[0]));return {affectedRows:1};}
      if(q.startsWith('INSERT INTO inventory_movements')){this.movements.push({product_id:String(values[0]),quantity:-Number(values[2])});return {affectedRows:1};}
      if(q.startsWith("UPDATE orders SET payment_status='paid'")){this.order.payment_status='paid';this.order.status='confirmed';this.order.admin_notes=values[0];return {affectedRows:1};}
      if(q.startsWith("UPDATE orders SET payment_status='review_required'")){this.order.payment_status='review_required';this.order.admin_notes=values[0];return {affectedRows:1};}
      throw new Error('Unsupported SQL: '+q);
    },
  };
  return repo;
}

function response(){
  return {headers:{},set(name,value){this.headers[name]=value;return this;},json(body){this.body=body;return this;}};
}

test('legacy checkout records order, verifies capture, and consumes stock once',async()=>{
  const repo=fakeRepository();
  let providerOrderId='';
  const request=async(url,options={})=>{
    if(url.endsWith('/orders')){
      const body=JSON.parse(options.body);
      providerOrderId='order_test';
      return fakeResponse({id:providerOrderId,amount:body.amount,currency:'INR',notes:body.notes});
    }
    if(url.endsWith('/orders/order_test'))return fakeResponse({id:providerOrderId,amount:16000,currency:'INR',notes:{internal_order_id:repo.order.id}});
    if(url.endsWith('/payments/pay_test'))return fakeResponse({id:'pay_test',order_id:providerOrderId,amount:16000,currency:'INR',status:'captured',captured:true});
    throw new Error('Unexpected provider URL: '+url);
  };
  const checkout=createLegacyCheckout({repo,env:{RAZORPAY_KEY_ID:'rzp_test_local',RAZORPAY_KEY_SECRET:'secret'},request});
  const createResponse=response();
  await checkout.create({body:{
    items:[{product_id:'1',variant_id:'11',quantity:1}],
    idempotency_key:'checkout-key-0001',
    customer:{customer_name:'Test Buyer',phone:'9876543210',email:'buyer@example.com',city:'Delhi',address:'1 Test Street',country:'India',notes:''},
  }},createResponse);
  assert.equal(createResponse.body.total_paise,16000);
  assert.equal(createResponse.body.provider_order_id,'order_test');
  assert.match(createResponse.body.access_token,/^[a-f0-9]{64}$/);
  assert.equal(repo.order.total_paise,16000);
  assert.equal(repo.items.length,1);

  const token=createResponse.body.access_token,orderId=createResponse.body.order_id;
  const statusRequest={params:{id:orderId},get:name=>name==='x-order-token'?token:''};
  const pending=response();
  await checkout.status(statusRequest,pending);
  assert.equal(pending.body.payment_status,'pending');

  const signature=createHmac('sha256','secret').update('order_test|pay_test').digest('hex');
  const confirmRequest={params:{id:orderId},get:name=>name==='x-order-token'?token:'',body:{razorpay_order_id:'order_test',razorpay_payment_id:'pay_test',razorpay_signature:signature}};
  const paid=response();
  await checkout.confirm(confirmRequest,paid);
  assert.equal(paid.body.payment_status,'paid');
  assert.equal(paid.body.payment_id,'pay_test');
  assert.equal(repo.stock.get('1'),4);
  assert.equal(repo.movements.length,1);

  const replay=response();
  await checkout.confirm(confirmRequest,replay);
  assert.equal(replay.body.payment_status,'paid');
  assert.equal(repo.stock.get('1'),4);
  assert.equal(repo.movements.length,1);
});
