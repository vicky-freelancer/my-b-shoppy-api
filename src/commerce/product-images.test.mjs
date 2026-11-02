import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProduct } from './domain.mjs';
import { Repository } from './repository.mjs';

const input={title:'Example',sku:'EXAMPLE',category_id:'hair-accessories',sale_price:100,mrp:200,quantity:1,variants:['Standard']};
test('product image list validates and preserves the legacy field',()=>{
  assert.deepEqual(validateProduct({...input,image_asset_ids:['2','3']}).image_asset_ids,['2','3']);
  assert.equal(validateProduct({...input,image_asset_id:'2'}).image_asset_id,'2');
  assert.throws(()=>validateProduct({...input,image_asset_ids:['2','2']}),/INVALID_PRODUCT_IMAGES/);
  assert.throws(()=>validateProduct({...input,image_asset_ids:Array(11).fill('2')}),/INVALID_PRODUCT_IMAGES/);
});
test('repository checks every asset and saves images in requested order',async()=>{
  const calls=[];
  const repo=new Repository(null,{async query(q,values){if(q==='SHOW WARNINGS LIMIT 1')return [];calls.push({q,values});return {insertId:1n,affectedRows:1};}});
  repo.asset=async id=>({id,state:'ready'});repo.product=async()=>({id:'1'});
  await repo.saveProduct(validateProduct({...input,image_asset_ids:['2','3']}),null,'1');
  assert.deepEqual(calls.filter(x=>x.q.startsWith('INSERT INTO product_images')).map(x=>x.values),[['1',0,'2'],['1',1,'3']]);
});
test('repository rejects an unavailable image before any writes',async()=>{
  const calls=[];const repo=new Repository(null,{async query(q){calls.push(q);return [];}});
  repo.asset=async id=>({state:id==='2'?'ready':'staged'});
  await assert.rejects(repo.saveProduct(validateProduct({...input,image_asset_ids:['2','3']}),null,'1'),/IMAGE_NOT_READY/);
  assert.deepEqual(calls,[]);
});
test('product output includes usable media URLs for every image',async()=>{
  const repo=new Repository(null,{async query(q){if(q==='SHOW WARNINGS LIMIT 1')return [];if(q.includes('FROM product_images'))return [{asset_id:2n,position:0,storage_key:'first.webp'},{asset_id:3n,position:1,storage_key:'second.webp'}];return [];}});
  const product=await repo.enrich({id:1,category_id:'hair-accessories',subcategory_id:null,sale_price_paise:100,mrp_paise:100,on_hand:1,reserved:0});
  assert.deepEqual(product.images.map(i=>[i.asset_id,i.url]),[['2','/media/first.webp'],['3','/media/second.webp']]);
});
