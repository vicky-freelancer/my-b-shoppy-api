import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { Fault,digest,requireThat } from './domain.mjs';
const scrypt=promisify(scryptCallback);
export async function hashPassword(password){
  requireThat(typeof password==='string'&&password.length>=12&&password.length<=256,'PASSWORD_POLICY');
  const salt=randomBytes(16).toString('hex');const key=await scrypt(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
  return `scrypt:32768:8:1:${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password,encoded){
  if(typeof password!=='string'||password.length>256||typeof encoded!=='string'||!/^scrypt:32768:8:1:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded))return false;
  const fields=encoded.split(':');const key=await scrypt(password,fields[4],64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return timingSafeEqual(key,Buffer.from(fields[5],'hex'));
}
export const csrfFor=token=>createHmac('sha256',token).update('mybshoppy-admin-csrf-v1').digest('hex');
export function equalHex(a,b){return typeof a==='string'&&typeof b==='string'&&/^[a-f0-9]{64}$/.test(a)&&/^[a-f0-9]{64}$/.test(b)&&timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));}
export function cookieToken(req,name){const raw=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='))?.slice(name.length+1);return raw&&/^[a-f0-9]{64}$/.test(raw)?raw:null;}
export class AuthService {
  constructor(repo,{verifyPassword=checkPassword}={}){this.repo=repo;this.verifyPassword=verifyPassword;}
  async login(login,password,networkKey){
    requireThat(typeof login==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(login)&&typeof password==='string'&&password.length<=256,'INVALID_LOGIN',400);
    const user=await this.repo.transaction(async r=>{
      const [u]=await r.query('SELECT id,login_id,password_hash,is_active,credential_version FROM admin_users WHERE singleton_slot=1 FOR UPDATE');
      if(!u)throw new Fault(503,'ADMIN_NOT_PROVISIONED');
      const [limit]=await r.query("SELECT SUM(resource_id=?) per_ip,COUNT(*) total FROM admin_audit_logs WHERE action='auth.attempt' AND occurred_at>UTC_TIMESTAMP(6)-INTERVAL 15 MINUTE",[digest(networkKey)]);
      if(Number(limit.per_ip)>=5||Number(limit.total)>=50)throw new Fault(429,'LOGIN_RATE_LIMITED');
      await r.audit(null,'auth.attempt','auth_ip',digest(networkKey),'failure');return u;
    });
    // Verify even a wrong login against the sole account hash; generic rejection.
    const correct=await this.verifyPassword(password,user.password_hash);
    if(!correct||login!==user.login_id||!user.is_active)throw new Fault(401,'INVALID_CREDENTIALS');
    const token=randomBytes(32).toString('hex');
    await this.repo.transaction(async r=>{
      const [u]=await r.query('SELECT id,is_active,credential_version FROM admin_users WHERE id=? FOR UPDATE',[user.id]);
      requireThat(u?.is_active&&String(u.credential_version)===String(user.credential_version),'CREDENTIALS_CHANGED',401);
      await r.query('INSERT INTO admin_sessions(admin_user_id,token_hash,credential_version,expires_at) VALUES(?,?,?,UTC_TIMESTAMP(6)+INTERVAL 8 HOUR)',[user.id,Buffer.from(digest(token),'hex'),user.credential_version]);
      await r.query('UPDATE admin_users SET last_login_at=UTC_TIMESTAMP(6) WHERE id=?',[user.id]);await r.audit(user.id,'auth.login','admin',user.id);
    });return {token,user:{id:String(user.id),name:user.login_id,email:'',role:'Super Admin'},csrfToken:csrfFor(token)};
  }
  async session(token){
    if(!token)throw new Fault(401,'AUTH_REQUIRED');
    const user=await this.repo.run(async r=>{
      const [u]=await r.query('SELECT u.id,u.login_id FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>UTC_TIMESTAMP(6) AND u.is_active=1 AND s.credential_version=u.credential_version',[Buffer.from(digest(token),'hex')]);return u;
    });
    if(!user)throw new Fault(401,'SESSION_EXPIRED');return {user:{id:String(user.id),name:user.login_id,email:'',role:'Super Admin'},csrfToken:csrfFor(token)};
  }
  async logout(token,actor){await this.repo.transaction(async r=>{await r.query('UPDATE admin_sessions SET revoked_at=UTC_TIMESTAMP(6) WHERE token_hash=? AND revoked_at IS NULL',[Buffer.from(digest(token),'hex')]);await r.audit(actor,'auth.logout','admin',actor);});}
}
