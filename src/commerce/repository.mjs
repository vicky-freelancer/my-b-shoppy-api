import { sql } from './database.mjs';
import { Fault,id,requireThat } from './domain.mjs';

const PUBLIC="p.is_active=1 AND p.archived_at IS NULL AND c.is_active=1 AND (s.id IS NULL OR s.is_active=1) AND EXISTS(SELECT 1 FROM product_variants v WHERE v.product_id=p.id AND v.is_active=1) AND EXISTS(SELECT 1 FROM product_images pi JOIN media_assets ma ON ma.id=pi.asset_id AND ma.state='ready' WHERE pi.product_id=p.id AND pi.position=0)";
const FROM='products p JOIN categories c ON c.id=p.category_id LEFT JOIN subcategories s ON s.id=p.subcategory_id JOIN inventory i ON i.product_id=p.id';
export class Repository {
  constructor(database,connection=null){this.db=database;this.c=connection;}
  run(fn){return this.c?fn(this):this.db.use(c=>fn(new Repository(this.db,c)));}
  transaction(fn){return this.db.transaction(c=>fn(new Repository(this.db,c)));}
  query(q,v=[]){return sql(this.c,q,v);}
  async audit(actor,action,type,resource,outcome='success',metadata={}){await this.query('INSERT INTO admin_audit_logs(admin_user_id,action,resource_type,resource_id,outcome,metadata_json) VALUES(?,?,?,?,?,?)',[actor,action,type,String(resource??''),outcome,JSON.stringify(metadata)]);}
  async categories(admin=false){return this.query(`SELECT cat.*,(SELECT COUNT(*) FROM ${FROM} WHERE ${PUBLIC} AND p.category_id=cat.id) product_count,(SELECT MIN(p.sale_price_paise) FROM ${FROM} WHERE ${PUBLIC} AND p.category_id=cat.id) starting_price_paise,(SELECT storage_key FROM media_assets m WHERE m.id=cat.image_asset_id AND m.state='ready') image_storage_key FROM categories cat ${admin?'':'WHERE cat.is_active=1'} ORDER BY cat.sort_order,cat.id`);}
  async subcategories(admin=false){return this.query(`SELECT s.*,c.name category_name,m.storage_key FROM subcategories s JOIN categories c ON c.id=s.category_id JOIN media_assets m ON m.id=s.featured_asset_id ${admin?'':"WHERE s.is_active=1 AND c.is_active=1 AND m.state='ready'"} ORDER BY s.sort_order,s.name,s.id`);}
  async asset(assetId){const [a]=await this.query('SELECT * FROM media_assets WHERE id=?',[id(assetId)]);return a;}
  async mediaByKey(key){const [a]=await this.query("SELECT * FROM media_assets WHERE storage_key=? AND state='ready'",[key]);return a;}
  async mediaByHash(hash){const [a]=await this.query("SELECT * FROM media_assets WHERE sha256=? AND state='ready' LIMIT 1",[hash]);return a;}
  async insertMedia(a){const r=await this.query("INSERT INTO media_assets(storage_key,mime_type,byte_size,sha256,width_px,height_px,state) VALUES(?,?,?,?,?,?,'ready')",[a.storage_key,a.mime_type,a.byte_size,a.sha256,a.width_px,a.height_px]);return {...a,id:String(r.insertId),state:'ready'};}
  async list(options={},admin=false){
    const page=Math.max(1,Math.min(100000,Number(options.page)||1)),size=Math.max(1,Math.min(100,Number(options.pageSize)||20));
    requireThat(Number.isInteger(page)&&Number.isInteger(size),'INVALID_PAGINATION');
    const clauses=[admin?'1=1':PUBLIC],values=[];
    if(options.categoryId){clauses.push('p.category_id=?');values.push(options.categoryId);}
    if(options.subcategoryId){clauses.push('p.subcategory_id=?');values.push(id(options.subcategoryId));}
    if(options.q){requireThat(String(options.q).length<=200,'SEARCH_TOO_LONG');clauses.push("(LOCATE(LOWER(?),LOWER(CONCAT_WS(' ',p.title,p.description,p.material,p.stone,c.name)))>0)");values.push(options.q);}
    if(options.featured==='true')clauses.push('EXISTS(SELECT 1 FROM product_badges b WHERE b.product_id=p.id)');
    const sort={newest:'p.created_at DESC,p.id DESC','price-asc':'p.sale_price_paise ASC,p.id DESC','price-desc':'p.sale_price_paise DESC,p.id DESC',rating:'p.rating DESC,p.id DESC',popular:'p.reviews_count DESC,p.id DESC'}[options.sort||'newest']; requireThat(!!sort,'INVALID_SORT');
    const where=clauses.join(' AND ');const [count]=await this.query(`SELECT COUNT(*) n FROM ${FROM} WHERE ${where}`,values);
    const rows=await this.query(`SELECT p.*,c.name category,s.name subcategory,i.on_hand,i.reserved FROM ${FROM} WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`,[...values,size,(page-1)*size]);
    const products=[];for(const row of rows)products.push(await this.enrich(row));return {products,count:Number(count.n)};
  }
  async enrich(row,lock=false){
    const variants=await this.query('SELECT id,label,is_active,sort_order FROM product_variants WHERE product_id=? ORDER BY sort_order,id'+(lock?' FOR UPDATE':''),[row.id]);
    const badges=await this.query('SELECT label FROM product_badges WHERE product_id=? ORDER BY position',[row.id]);
    const images=await this.query("SELECT pi.asset_id,pi.position,pi.alt_text,m.storage_key FROM product_images pi JOIN media_assets m ON m.id=pi.asset_id AND m.state='ready' WHERE pi.product_id=? ORDER BY pi.position",[row.id]);
    return {...row,id:String(row.id),category_id:String(row.category_id),subcategory_id:row.subcategory_id?String(row.subcategory_id):null,
      title:row.title,name:row.title,price:Number(row.sale_price_paise)/100,sale_price:Number(row.sale_price_paise)/100,mrp:Number(row.mrp_paise)/100,original_price:Number(row.mrp_paise)/100,
      quantity:Number(row.on_hand),stock:Number(row.on_hand),reserved_quantity:Number(row.reserved),available_quantity:Number(row.on_hand)-Number(row.reserved),
      in_stock:!!row.is_active&&!row.archived_at&&Number(row.on_hand)>Number(row.reserved)&&variants.some(v=>!!v.is_active),
      variants:variants.filter(v=>!!v.is_active).map(v=>v.label),variant_options:variants.map(v=>({...v,id:String(v.id)})),badges:badges.map(b=>b.label),badge:badges[0]?.label,
      image_asset_id:images[0]?String(images[0].asset_id):null,image_url:images[0]?'/media/'+images[0].storage_key:'',cover_image:images[0]?'/media/'+images[0].storage_key:'',images:images.map(image=>({...image,asset_id:String(image.asset_id),url:'/media/'+image.storage_key}))};
  }
  async product(key,admin=false,lock=false){
    requireThat(typeof key==='string'&&key.length<=191,'INVALID_PRODUCT');
    const numeric=/^[1-9]\d*$/.test(key);const selector=numeric?'p.id=?':'(p.slug=? OR EXISTS(SELECT 1 FROM product_aliases a WHERE a.product_id=p.id AND a.alias=?))';
    const params=numeric?[id(key)]:[key,key];
    const rows=await this.query(`SELECT p.*,c.name category,s.name subcategory,i.on_hand,i.reserved,c.is_active category_active,s.is_active subcategory_active FROM ${FROM} WHERE ${selector} AND ${admin?'1=1':PUBLIC} ${lock?'FOR UPDATE':''}`,params);
    requireThat(rows.length<=1,'AMBIGUOUS_PRODUCT',409); return rows[0]?this.enrich(rows[0],lock):null;
  }
  async saveProduct(p,existing,actor){
    if(p.subcategory_id){const [s]=await this.query('SELECT id FROM subcategories WHERE id=? AND category_id=?',[p.subcategory_id,p.category_id]);requireThat(!!s,'SUBCATEGORY_OWNER_MISMATCH');}
    for(const assetId of p.image_asset_ids??(p.image_asset_id?[p.image_asset_id]:[]))requireThat((await this.asset(assetId))?.state==='ready','IMAGE_NOT_READY');
    requireThat(p.rating>=0&&p.rating<=5,'INVALID_RATING');
    let productId=existing?.id;
    if(existing){
      requireThat(p.quantity>=Number(existing.reserved),'STOCK_BELOW_RESERVATIONS',409);
      await this.query('UPDATE products SET title=?,slug=?,sku=?,category_id=?,subcategory_id=?,mrp_paise=?,sale_price_paise=?,description=?,subtitle=?,material=?,stone=?,rating=?,reviews_count=?,row_version=row_version+1 WHERE id=?',[p.title,p.slug,p.sku,p.category_id,p.subcategory_id,p.mrp_paise,p.sale_price_paise,p.description,p.subtitle,p.material,p.stone,p.rating,p.reviews_count,productId]);
      await this.query('UPDATE inventory SET on_hand=?,row_version=row_version+1 WHERE product_id=?',[p.quantity,productId]);
    }else{
      const r=await this.query('INSERT INTO products(slug,title,sku,category_id,subcategory_id,mrp_paise,sale_price_paise,description,subtitle,material,stone,rating,reviews_count,is_active) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,0)',[p.slug,p.title,p.sku,p.category_id,p.subcategory_id,p.mrp_paise,p.sale_price_paise,p.description,p.subtitle,p.material,p.stone,p.rating,p.reviews_count]);productId=String(r.insertId);
      await this.query('INSERT INTO inventory(product_id,on_hand) VALUES(?,?)',[productId,p.quantity]);
    }
    const delta=p.quantity-Number(existing?.on_hand??0);
    if(delta)await this.query("INSERT INTO inventory_movements(product_id,operation_key,kind,on_hand_delta,reserved_delta,reason,actor_ref) VALUES(?,UUID(),'adjust',?,0,'Admin stock adjustment',?)",[productId,delta,String(actor)]);
    await this.query('UPDATE product_variants SET is_active=0 WHERE product_id=?',[productId]);
    for(const [position,label] of p.variants.entries())await this.query('INSERT INTO product_variants(product_id,label,is_active,sort_order) VALUES(?,?,1,?) ON DUPLICATE KEY UPDATE is_active=1,sort_order=VALUES(sort_order)',[productId,label,position]);
    await this.query('DELETE FROM product_badges WHERE product_id=?',[productId]);
    for(const [position,label] of p.badges.entries())await this.query('INSERT INTO product_badges(product_id,label,position) VALUES(?,?,?)',[productId,label,position]);
    if(p.image_asset_ids!==undefined){
      await this.query('DELETE FROM product_images WHERE product_id=?',[productId]);
      for(const [position,assetId] of p.image_asset_ids.entries())await this.query('INSERT INTO product_images(product_id,position,asset_id) VALUES(?,?,?)',[productId,position,assetId]);
    }else if(p.image_asset_id){await this.query('DELETE FROM product_images WHERE product_id=? AND position=0',[productId]);await this.query('INSERT INTO product_images(product_id,position,asset_id) VALUES(?,0,?)',[productId,p.image_asset_id]);}
    await this.audit(actor,existing?'product.update':'product.create','product',productId); return this.product(productId,true);
  }
  async publication(productId,action,actor){
    const p=await this.product(id(productId),true,true);if(!p)throw new Fault(404,'PRODUCT_NOT_FOUND');
    if(action==='publish'){requireThat(!p.archived_at&&p.image_asset_id&&p.variants.length&&p.category_active&&(p.subcategory_id===null||p.subcategory_active),'PRODUCT_NOT_PUBLISHABLE');await this.query('UPDATE products SET is_active=1,row_version=row_version+1 WHERE id=?',[p.id]);}
    else if(action==='archive')await this.query('UPDATE products SET is_active=0,archived_at=UTC_TIMESTAMP(6),row_version=row_version+1 WHERE id=?',[p.id]);
    else if(action==='draft')await this.query('UPDATE products SET is_active=0,row_version=row_version+1 WHERE id=?',[p.id]);
    else throw new Fault(422,'INVALID_LIFECYCLE');
    await this.audit(actor,'product.'+action,'product',p.id);return this.product(p.id,true);
  }
  async saveSubcategory(s,existingId,actor){
    requireThat((await this.asset(s.featured_asset_id))?.state==='ready','IMAGE_NOT_READY');
    let sid=existingId;
    if(sid)await this.query('UPDATE subcategories SET category_id=?,name=?,slug=?,featured_asset_id=?,is_active=?,sort_order=? WHERE id=?',[s.category_id,s.name,s.slug,s.featured_asset_id,s.is_active,s.sort_order,id(sid)]);
    else{const r=await this.query('INSERT INTO subcategories(category_id,name,slug,featured_asset_id,is_active,sort_order) VALUES(?,?,?,?,?,?)',[s.category_id,s.name,s.slug,s.featured_asset_id,s.is_active,s.sort_order]);sid=String(r.insertId);}
    await this.audit(actor,'subcategory.save','subcategory',sid);return (await this.subcategories(true)).find(s=>String(s.id)===String(sid));
  }
  async orderCount(){const [row]=await this.query('SELECT COUNT(*) n FROM orders WHERE archived_at IS NULL');return Number(row.n);}
  async orders(options={}){
    const page=Number(options.page||1),size=Number(options.pageSize||100);requireThat(Number.isSafeInteger(page)&&page>=1&&page<=100000&&Number.isSafeInteger(size)&&size>=1&&size<=100,'INVALID_PAGINATION');
    const orders=await this.query('SELECT id,customer_name,email,phone,city,address,country,delivery_notes,admin_notes,tracking_number,status,payment_status,total_paise,subtotal_paise,shipping_paise,created_at,archived_at FROM orders WHERE archived_at IS NULL ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?',[size,(page-1)*size]);
    for(const o of orders){o.items=await this.query('SELECT product_id,variant_id,title_snapshot,variant_snapshot,category_snapshot,quantity,unit_price_paise,line_total_paise FROM order_items WHERE order_id=? ORDER BY line_number',[o.id]);o.amount=Number(o.total_paise)/100;o.total_amount=o.amount;o.quantity=o.items.reduce((n,i)=>n+Number(i.quantity),0);o.product_variant=o.items.map(i=>i.title_snapshot+' × '+i.quantity).join(', ');o.notes=o.admin_notes;o.payment_method='Online (Razorpay)';}
    return orders;
  }
}
