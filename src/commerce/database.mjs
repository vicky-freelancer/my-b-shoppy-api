import { Fault } from './domain.mjs';
export const MODES='STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ZERO_DATE,NO_ZERO_IN_DATE,NO_ENGINE_SUBSTITUTION,NO_BACKSLASH_ESCAPES';
// Required columns for the simplified catalog, not a Phase 6 installation ledger.
export const REQUIRED_COLUMNS = Object.freeze({
  media_assets: 'id storage_key mime_type byte_size sha256 width_px height_px state created_at',
  categories: 'id name slug image_asset_id is_active sort_order created_at updated_at',
  subcategories: 'id category_id name slug featured_asset_id is_active sort_order created_at updated_at',
  products: 'id slug title sku category_id subcategory_id mrp_paise sale_price_paise subtitle description material stone rating reviews_count is_active archived_at row_version created_at updated_at',
  product_aliases: 'alias product_id',
  product_variants: 'id product_id label is_active sort_order',
  product_images: 'product_id position asset_id alt_text',
  product_badges: 'product_id label position',
  inventory: 'product_id on_hand reserved row_version updated_at',
  inventory_movements: 'id product_id operation_key kind on_hand_delta reserved_delta reason actor_ref created_at',
  admin_users: 'id singleton_slot login_id password_hash is_active credential_version created_at updated_at last_login_at',
  admin_sessions: 'id admin_user_id token_hash credential_version created_at expires_at revoked_at last_seen_at',
  admin_audit_logs: 'id admin_user_id action resource_type resource_id outcome occurred_at metadata_json',
  orders: 'id customer_name email phone city address country delivery_notes admin_notes tracking_number status payment_status payment_method currency subtotal_paise shipping_paise total_paise access_token_hash paid_at archived_at created_at updated_at',
  order_items: 'id order_id line_number product_id variant_id title_snapshot sku_snapshot category_snapshot variant_snapshot quantity unit_price_paise mrp_paise line_total_paise',
});
const TEST_DATABASE='u839831098_phase6btest';
const PRODUCTION_DATABASE='u839831098_mybshoppyDB';
const PRODUCTION_LOCAL_USER='u839831098_adminmybshoppy';
export function databaseConfig(env) {
  if(env.MARIADB_ENABLED!=='true')return null;
  const profile=env.MARIADB_PROFILE||'isolated-test';
  const transport=env.MARIADB_PRODUCTION_TRANSPORT||'remote';
  if(profile==='isolated-test'){
    if(env.MARIADB_LOCAL_EXECUTION_APPROVED!=='true')throw new Fault(503,'LOCAL_DATABASE_NOT_APPROVED');
    if(!['127.0.0.1','localhost','::1'].includes(env.MARIADB_HOST)||env.MARIADB_DATABASE!==TEST_DATABASE||env.MARIADB_USER!==TEST_DATABASE)throw new Fault(503,'DATABASE_TARGET_REFUSED');
  }else if(profile==='production'){
    if(env.NODE_ENV!=='production'||env.MARIADB_PRODUCTION_APPROVED!=='true')throw new Fault(503,'PRODUCTION_DATABASE_NOT_APPROVED');
    // The deployment-owned allowlist admits one explicit production account.
    if(env.MARIADB_DATABASE!==PRODUCTION_DATABASE||!env.MARIADB_PRODUCTION_ACCOUNT||env.MARIADB_USER!==env.MARIADB_PRODUCTION_ACCOUNT||env.MARIADB_USER===TEST_DATABASE||!/^[A-Za-z0-9_]{1,80}$/.test(env.MARIADB_USER)||!env.MARIADB_HOST||/[\s\/]/.test(env.MARIADB_HOST))throw new Fault(503,'DATABASE_TARGET_REFUSED');
    if(!['local','remote'].includes(transport))throw new Fault(503,'DATABASE_TRANSPORT_REFUSED');
    if(transport==='local'&&(env.MARIADB_HOST!=='127.0.0.1'||Number(env.MARIADB_PORT||3306)!==3306||env.MARIADB_USER!==PRODUCTION_LOCAL_USER))throw new Fault(503,'DATABASE_TARGET_REFUSED');
  }else throw new Fault(503,'DATABASE_PROFILE_REFUSED');
  if(!env.MARIADB_PASSWORD)throw new Fault(503,'DATABASE_CONFIGURATION_INCOMPLETE');
  if(!Number.isInteger(Number(env.MARIADB_PORT||3306))||Number(env.MARIADB_PORT||3306)<1||Number(env.MARIADB_PORT||3306)>65535)throw new Fault(503,'DATABASE_PORT_REFUSED');
  return {host:env.MARIADB_HOST,port:Number(env.MARIADB_PORT||3306),database:env.MARIADB_DATABASE,user:env.MARIADB_USER,password:env.MARIADB_PASSWORD,
    ...(profile==='production'&&transport==='remote'?{ssl:{rejectUnauthorized:true}}:{}),
    connectionLimit:4,minimumIdle:0,connectTimeout:3000,acquireTimeout:5000,multipleStatements:false,bigIntAsNumber:false,insertIdAsNumber:false,dateStrings:true,timezone:'Z',charset:'utf8mb4'};
}
export async function createDatabase(env) {
  const config=databaseConfig(env); if(!config)return null;
  const {default:mariadb}=await import('mariadb'); const pool=mariadb.createPool(config);
  return new Database(pool,{database:config.database,user:config.user,profile:env.MARIADB_PROFILE||'isolated-test'});
}
export class Database {
  constructor(pool,target={database:TEST_DATABASE,user:TEST_DATABASE,profile:'isolated-test'}){this.pool=pool;this.target=target;}
  async connection(){
    const c=await this.pool.getConnection();
    try{
      await sql(c,"SET SESSION time_zone='+00:00'"); await sql(c,'SET SESSION sql_mode=?',[MODES]);
      await sql(c,'SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
      await sql(c,'SET SESSION innodb_lock_wait_timeout=5');
      const [s]=await sql(c,'SELECT DATABASE() db,CURRENT_USER() account,VERSION() version,@@session.foreign_key_checks fk,@@session.check_constraint_checks ck,@@session.in_transaction active,@@session.autocommit autocommit,@@session.tx_read_only read_only');
      if(s.db!==this.target.database||s.account.split('@')[0]!==this.target.user||!/^\d+\.\d+\.\d+.*MariaDB/i.test(s.version)||Number(s.fk)!==1||Number(s.ck)!==1||Number(s.active)!==0||Number(s.autocommit)!==1||Number(s.read_only)!==0)throw new Fault(503,'DATABASE_SESSION_REFUSED');
      const columns=await sql(c,'SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=?',[s.db]);
      const present=new Set(columns.map(r=>r.table_name+'.'+r.column_name));
      for(const [table,names] of Object.entries(REQUIRED_COLUMNS)){
        if(names.split(' ').some(name=>!present.has(table+'.'+name)))throw new Fault(503,'DATABASE_SCHEMA_NOT_READY');
      }
      return c;
    }catch(e){c.destroy();throw e;}
  }
  async use(fn){const c=await this.connection();try{return await fn(c);}finally{c.release();}}
  async transaction(fn){
    const c=await this.connection();let committed=false,committing=false,destroyed=false;
    try{await c.beginTransaction();const value=await fn(c);committing=true;await c.commit();committed=true;return value;}
    catch(e){
      if(committing){destroyed=true;c.destroy();throw new Fault(503,'COMMIT_OUTCOME_UNKNOWN');}
      try{await c.rollback();const [r]=await c.query('SELECT @@session.in_transaction active');if(Number(r.active)!==0)throw Error();}
      catch{destroyed=true;c.destroy();throw new Fault(503,'ROLLBACK_UNVERIFIED');}
      throw e;
    }finally{if(!destroyed)c.release();void committed;}
  }
  async health(){return this.use(async c=>{await c.query('SELECT 1');return {ready:true,database:this.target.profile};});}
  close(){return this.pool.end();}
}
export async function sql(c,statement,values=[]){
  const result=await c.query(statement,values); const warnings=await c.query('SHOW WARNINGS LIMIT 1');
  if(warnings.length)throw new Fault(503,'DATABASE_WARNING'); return result;
}
