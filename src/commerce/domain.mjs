import { createHash } from 'node:crypto';

export const CATEGORIES = Object.freeze([
  ['ad-jewellery','AD Jewellery'], ['hair-accessories','Hair Accessories'],
  ['anti-tarnish-jewellery','Anti Tarnish Jewellery'], ['ear-rings','Ear Rings'],
  ['bows-and-scrunchies','Bows & Scrunchies'], ['bags','Bags'], ['mobile-charms','Mobile Charms'],
  ['key-chains','Key Chains'], ['men-accessories','Mens Accessories'], ['stationery-and-gifts','Stationery & Gifts'],
].map(([id,name],sort_order)=>Object.freeze({id,name,slug:id,sort_order,is_active:true})));
export class Fault extends Error {
  constructor(status,code,message=code) { super(message); this.status=status; this.code=code; }
}
export const requireThat=(condition,code,status=422)=>{if(!condition)throw new Fault(status,code);};
export function id(value) {
  const s=String(value??''); requireThat(/^[1-9]\d{0,19}$/.test(s)&&BigInt(s)<=18446744073709551615n,'INVALID_ID'); return s;
}
export function text(value,max=255,optional=false) {
  requireThat(typeof value==='string'||(optional&&value==null),'INVALID_TEXT');
  const s=String(value??'').trim(); requireThat((optional||s.length>0)&&s.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s),'INVALID_TEXT'); return s;
}
export function integer(value,min=0,max=2147483647) {requireThat(Number.isSafeInteger(value)&&value>=min&&value<=max,'INVALID_INTEGER');return value;}
export function paise(value) {
  const s=String(value??''); requireThat(/^(0|[1-9]\d{0,9})(\.\d{1,2})?$/.test(s),'INVALID_PRICE');
  const [whole,fraction='']=s.split('.'); const n=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  return integer(n,0,999999999999);
}
export const digest=value=>createHash('sha256').update(value).digest('hex');
export const slug=value=>{const result=text(value,191).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');requireThat(result.length>0&&!/^\d+$/.test(result),'INVALID_SLUG');return result;};
export const safeJSON=value=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?v.toString():v);
export function canonical(value) {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
  return value;
}
export function validateProduct(input) {
  const title=text(input.title??input.name),sku=text(input.sku,191).toUpperCase();
  requireThat(/^[A-Z0-9][A-Z0-9_.-]*$/.test(sku),'INVALID_SKU');
  const category_id=text(input.category_id,100); requireThat(CATEGORIES.some(c=>c.id===category_id),'INVALID_CATEGORY');
  const sale_price_paise=paise(input.sale_price),mrp_paise=paise(input.mrp);
  requireThat(mrp_paise>=sale_price_paise,'MRP_BELOW_PRICE');
  const variants=(input.variants??['Standard']).map(v=>text(typeof v==='string'?v:v.label,191));
  requireThat(variants.length>0&&variants.length<=50&&new Set(variants.map(v=>v.toLowerCase())).size===variants.length,'INVALID_VARIANTS');
  const badges=(input.badges??[]).map(v=>text(v,100)); requireThat(badges.length<=20&&new Set(badges).size===badges.length,'INVALID_BADGES');
  return {title,sku,slug:slug(input.slug||title),category_id,subcategory_id:input.subcategory_id?id(input.subcategory_id):null,
    sale_price_paise,mrp_paise,quantity:integer(input.quantity??0),variants,badges,
    description:text(input.description,20000,true),subtitle:text(input.subtitle,2000,true),material:text(input.material,255,true),stone:text(input.stone,255,true),
    image_asset_id:input.image_asset_id?id(input.image_asset_id):null,
    rating:input.rating===undefined?0:Number(input.rating),reviews_count:integer(input.reviews_count??0)};
}
export function normalizeItems(items) {
  requireThat(Array.isArray(items)&&items.length>0&&items.length<=50,'INVALID_CART'); const merged=new Map();
  for(const item of items){
    requireThat(item&&Object.keys(item).every(k=>['product_id','variant_id','quantity'].includes(k)),'UNTRUSTED_CART_FIELDS');
    const product_id=id(item.product_id),variant_id=id(item.variant_id),quantity=integer(item.quantity,1,999),key=product_id+':'+variant_id;
    const prior=merged.get(key); merged.set(key,{product_id,variant_id,quantity:integer((prior?.quantity??0)+quantity,1,999)});
  }
  return [...merged.values()].sort((a,b)=>BigInt(a.product_id)<BigInt(b.product_id)?-1:BigInt(a.product_id)>BigInt(b.product_id)?1:a.variant_id.localeCompare(b.variant_id));
}
