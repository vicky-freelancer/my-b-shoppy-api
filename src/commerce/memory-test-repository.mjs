// TEST DOUBLE ONLY. Never imported by the application entry point or environment flag.
// Simulates repository contracts; cannot certify MariaDB constraints/isolation.
import { buildTestCatalog } from './test-catalog.mjs';
import { Fault,requireThat } from './domain.mjs';
export class MemoryTestRepository {
  constructor(seed=false){this.products=new Map();this.media=new Map();this.cats=[];this.subs=[];this.audits=[];this.tail=Promise.resolve();if(seed)this.seed();}
  seed(){const f=buildTestCatalog();this.cats=f.categories;this.subs=f.subcategories.map((s,i)=>({...s,id:String(i+1),featured_asset_id:'1',storage_key:'test.webp'}));this.media.set('1',{id:'1',state:'ready',storage_key:'test.webp'});
    for(const [i,p] of f.products.entries())this.products.set(String(i+1),{...p,id:String(i+1),category:this.cats.find(c=>c.id===p.category_id).name,subcategory_id:String(Math.floor(i/10)+1),image_asset_id:'1',image_url:'/media/test.webp',cover_image:'/media/test.webp',is_active:true,archived_at:null,row_version:1,on_hand:p.quantity,reserved:0,available_quantity:p.quantity,in_stock:true,sale_price_paise:p.sale_price*100,mrp_paise:p.mrp*100,variant_options:p.variants.map((label,j)=>({id:String(i*2+j+1),label,is_active:true})),created_at:'2026-01-01T00:00:00.000Z',category_active:true,subcategory_active:true});}
  run(fn){return fn(this);}
  async transaction(fn){let release;const prior=this.tail;this.tail=new Promise(r=>release=r);await prior;const snapshot=structuredClone({products:this.products,media:this.media,cats:this.cats,subs:this.subs,audits:this.audits});try{return await fn(this);}catch(e){Object.assign(this,snapshot);throw e;}finally{release();}}
  async categories(admin=false){return this.cats.filter(c=>admin||c.is_active);}
  async subcategories(admin=false){return this.subs.filter(s=>admin||s.is_active);}
  async asset(id){return this.media.get(String(id));}
  async mediaByKey(key){return [...this.media.values()].find(m=>m.storage_key===key&&m.state==='ready');}
  async insertMedia(a){const id=String(this.media.size+1);const row={...a,id,state:'ready'};this.media.set(id,row);return row;}
  async audit(actor,action,type,resource){this.audits.push({actor,action,type,resource});}
  async product(key,admin=false){const p=this.products.get(String(key))||[...this.products.values()].find(p=>p.slug===key);return p&&(admin||(p.is_active&&!p.archived_at))?structuredClone(p):null;}
  async list(o={},admin=false){
    let all=[...this.products.values()].filter(p=>(admin?(o.includeArchived==='true'||!p.archived_at):p.is_active&&!p.archived_at)&&(!o.categoryId||p.category_id===o.categoryId)&&(!o.subcategoryId||p.subcategory_id===o.subcategoryId)&&(!o.q||(p.title+' '+p.description+' '+p.category).toLowerCase().includes(String(o.q).toLowerCase())));
    if(o.featured==='true')all=all.filter(p=>p.badges.length);const sorts={'price-asc':(a,b)=>a.sale_price-b.sale_price,'price-desc':(a,b)=>b.sale_price-a.sale_price};if(sorts[o.sort])all.sort(sorts[o.sort]);
    const size=Number(o.pageSize||20),page=Number(o.page||1);return {products:structuredClone(all.slice((page-1)*size,page*size)),count:all.length};
  }
  async saveProduct(p,existing,actor){
    requireThat(![...this.products.values()].some(x=>x.sku===p.sku&&x.id!==existing?.id),'UNIQUE_CONFLICT',409);
    requireThat(!p.subcategory_id||this.subs.some(s=>String(s.id)===p.subcategory_id&&s.category_id===p.category_id),'SUBCATEGORY_OWNER_MISMATCH');
    for(const assetId of p.image_asset_ids??(p.image_asset_id?[p.image_asset_id]:[]))requireThat(this.media.get(assetId)?.state==='ready','IMAGE_NOT_READY');
    const id=existing?.id||String(this.products.size+1),reserved=Number(existing?.reserved||0);requireThat(p.quantity>=reserved,'STOCK_BELOW_RESERVATIONS',409);
    const cover=p.image_asset_ids===undefined?p.image_asset_id:p.image_asset_ids[0];
    const row={...existing,...p,image_asset_id:cover,id,row_version:Number(existing?.row_version||0)+1,sale_price:p.sale_price_paise/100,mrp:p.mrp_paise/100,on_hand:p.quantity,reserved,is_active:true,
      category:this.cats.find(c=>c.id===p.category_id)?.name,category_active:true,subcategory_active:true,variants:p.variants,variant_options:p.variants.map((label,j)=>({id:String(Number(id)*100+j),label,is_active:true})),image_url:cover?'/media/'+this.media.get(cover).storage_key:'',created_at:'2026-01-01T00:00:00Z'};
    this.products.set(id,row);await this.audit(actor,'product.save','product',id);return structuredClone(row);
  }
  async publication(id,action,actor){const p=this.products.get(String(id));if(!p)throw new Fault(404,'PRODUCT_NOT_FOUND');if(action==='publish'){requireThat(p.image_asset_id&&p.variants.length&&!p.archived_at,'PRODUCT_NOT_PUBLISHABLE');p.is_active=true;}else if(action==='draft')p.is_active=false;else if(action==='archive'){p.is_active=false;p.archived_at='2026-01-01T00:00:00Z';}else throw new Fault(422,'INVALID_LIFECYCLE');await this.audit(actor,'product.'+action,'product',id);return structuredClone(p);}
  async deleteProduct(id,actor){if(!this.products.has(String(id)))throw new Fault(404,'PRODUCT_NOT_FOUND');this.products.delete(String(id));await this.audit(actor,'product.delete','product',id);return {success:true,archived:false};}
  async saveSubcategory(s,id){if(!id)id=String(this.subs.length+1);const row={...s,id,storage_key:this.media.get(String(s.featured_asset_id))?.storage_key};const i=this.subs.findIndex(x=>x.id===id);if(i<0)this.subs.push(row);else this.subs[i]=row;return row;}
  async orders(){return [];}
  async orderCount(){return 0;}
  async query(q,values=[]){
    if(q.startsWith('SELECT id,name,slug,sort_order FROM categories'))return this.cats.filter(c=>c.id===values[0]);
    if(q.startsWith('INSERT INTO categories')){this.cats.push({id:values[0],name:values[1],slug:values[2],sort_order:values[3],is_active:true});return {affectedRows:1};}
    throw new Error('Unsupported test-double SQL; add an explicit contract assertion instead of pretending to run MariaDB.');
  }
}
