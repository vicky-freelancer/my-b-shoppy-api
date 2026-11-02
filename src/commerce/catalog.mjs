import { CATEGORIES,Fault,requireThat,text,slug,id,integer,validateProduct } from './domain.mjs';
export class CatalogService {
  constructor(repo){this.repo=repo;}
  categories(admin=false){return this.repo.run(async r=>(await r.categories(admin)).map(c=>({...c,is_active:!!c.is_active,image_url:c.image_storage_key?'/media/'+c.image_storage_key:'',count:Number(c.product_count??0),startingPrice:Number(c.starting_price_paise??0)/100})));}
  subcategories(admin=false){return this.repo.run(async r=>(await r.subcategories(admin)).map(s=>({...s,id:String(s.id),is_active:!!s.is_active,featured_image:'/media/'+s.storage_key})));}
  list(options,admin=false){return this.repo.run(r=>r.list(options,admin));}
  product(key,admin=false){return this.repo.run(async r=>{const p=await r.product(key,admin);if(!p)throw new Fault(404,'PRODUCT_NOT_FOUND');return p;});}
  async save(input,productId,actor){return this.repo.transaction(async r=>{
    const existing=productId?await r.product(id(productId),true,true):null;
    if(productId&&!existing)throw new Fault(404,'PRODUCT_NOT_FOUND');
    if(existing){requireThat(input.row_version!==undefined&&String(input.row_version)===String(existing.row_version),'PRODUCT_CHANGED',409);}
    const merged={...existing,...input};
    // Numeric rupee aliases from stored DTOs are explicitly validated once.
    const p=validateProduct(merged);return r.saveProduct(p,existing,actor);
  });}
  lifecycle(productId,action,actor){return this.repo.transaction(r=>r.publication(productId,action,actor));}
  saveSubcategory(input,subcategoryId,actor){
    const category_id=text(input.category_id,100);requireThat(CATEGORIES.some(c=>c.id===category_id),'INVALID_CATEGORY');
    const name=text(input.name,80);requireThat(name.length>=2,'INVALID_SUBCATEGORY_NAME');
    const s={category_id,name,slug:slug(input.slug||name),featured_asset_id:id(input.featured_asset_id),is_active:input.is_active===false?0:1,sort_order:integer(input.sort_order??0,-2147483648)};
    return this.repo.transaction(r=>r.saveSubcategory(s,subcategoryId,actor));
  }
  async archiveSubcategory(sid,actor){return this.repo.transaction(async r=>{
    const result=await r.query('UPDATE subcategories SET is_active=0 WHERE id=?',[id(sid)]);requireThat(Number(result.affectedRows)===1,'SUBCATEGORY_NOT_FOUND',404);await r.audit(actor,'subcategory.archive','subcategory',sid);return {success:true};
  });}
  async bootstrap(actor){return this.repo.transaction(async r=>{
    for(const c of CATEGORIES){
      const [existing]=await r.query('SELECT id,name,slug,sort_order FROM categories WHERE id=? FOR UPDATE',[c.id]);
      if(existing){requireThat(existing.name===c.name&&existing.slug===c.slug&&Number(existing.sort_order)===c.sort_order,'CATEGORY_BOOTSTRAP_CONFLICT',409);continue;}
      await r.query('INSERT INTO categories(id,name,slug,sort_order) VALUES(?,?,?,?)',[c.id,c.name,c.slug,c.sort_order]);
    }await r.audit(actor,'categories.bootstrap','category','canonical-ten');return r.categories(true);
  });}
  async updateCategory(categoryId,input,actor){
    requireThat(CATEGORIES.some(c=>c.id===categoryId),'INVALID_CATEGORY');
    requireThat(Object.keys(input).every(k=>['is_active','image_asset_id'].includes(k)),'IMMUTABLE_CATEGORY_IDENTITY');
    if(input.is_active!==undefined)requireThat(typeof input.is_active==='boolean','INVALID_ACTIVE_FLAG');
    return this.repo.transaction(async r=>{
      if(input.image_asset_id)requireThat((await r.asset(id(input.image_asset_id)))?.state==='ready','IMAGE_NOT_READY');
      const result=await r.query('UPDATE categories SET is_active=COALESCE(?,is_active),image_asset_id=COALESCE(?,image_asset_id) WHERE id=?',[input.is_active===undefined?null:input.is_active?1:0,input.image_asset_id?id(input.image_asset_id):null,categoryId]);
      requireThat(Number(result.affectedRows)===1,'CATEGORY_NOT_FOUND',404);await r.audit(actor,'category.update','category',categoryId);return (await r.categories(true)).find(c=>c.id===categoryId);
    });
  }
  async updateOrder(orderId,input,actor){
    requireThat(Object.keys(input).every(k=>['status','notes','tracking_number','archive'].includes(k)),'IMMUTABLE_ORDER_FIELDS',403);
    return this.repo.transaction(async r=>{
      const [o]=await r.query('SELECT id,status,payment_status FROM orders WHERE id=? FOR UPDATE',[text(orderId,64)]);if(!o)throw new Fault(404,'ORDER_NOT_FOUND');
      const transitions={pending:['confirmed','cancelled'],confirmed:['shipped','cancelled'],shipped:['delivered','returned'],delivered:['returned'],cancelled:[],returned:[]};
      if(input.status&&input.status!==o.status){requireThat(transitions[o.status]?.includes(input.status),'INVALID_ORDER_TRANSITION',409);if(['confirmed','shipped','delivered'].includes(input.status))requireThat(o.payment_status==='paid','PAYMENT_NOT_CAPTURED',409);}
      await r.query('UPDATE orders SET status=?,admin_notes=COALESCE(?,admin_notes),tracking_number=COALESCE(?,tracking_number),archived_at=CASE WHEN ?=1 THEN UTC_TIMESTAMP(6) ELSE archived_at END WHERE id=?',[input.status||o.status,input.notes===undefined?null:text(input.notes,20000,true),input.tracking_number===undefined?null:text(input.tracking_number,191,true),input.archive===true?1:0,orderId]);
      await r.audit(actor,'order.update','order',orderId);return {success:true};
    });
  }
}
