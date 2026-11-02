import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AuthService } from './auth.mjs';
function adapter({limit=0,active=1,session=true,changed=false}={}){
  const writes=[],audits=[];
  const repo={run:fn=>fn(repo),transaction:fn=>fn(repo),async audit(...a){audits.push(a);},async query(q,args){
    if(q.includes('singleton_slot=1'))return [{id:'1',login_id:'test-only',password_hash:'opaque-test-hash',is_active:active,credential_version:1}];
    if(q.includes('SUM(resource_id'))return [{per_ip:limit,total:limit}];
    if(q.startsWith('SELECT id,is_active'))return [{id:'1',is_active:active,credential_version:changed?2:1}];
    if(q.includes('JOIN admin_users')){assert.match(q,/revoked_at IS NULL/);assert.match(q,/expires_at>UTC_TIMESTAMP/);assert.match(q,/s.credential_version=u.credential_version/);return session?[{id:'1',login_id:'test-only'}]:[];}
    writes.push({q,args});return {affectedRows:1};
  }};return {repo,writes,audits};
}
test('auth login persists hashed session only and audits success',async()=>{const a=adapter();const auth=new AuthService(a.repo,{verifyPassword:async()=>true});const result=await auth.login('test-only',randomBytes(20).toString('hex'),'test-network');const row=a.writes.find(x=>x.q.startsWith('INSERT INTO admin_sessions'));assert.ok(Buffer.isBuffer(row.args[1]));assert.equal(row.args[1].length,32);assert.notEqual(row.args[1].toString('hex'),result.token);assert.ok(a.audits.some(x=>x[1]==='auth.login'));});
test('durable rate limit rejects before password hashing',async()=>{const a=adapter({limit:5});let hashes=0;const auth=new AuthService(a.repo,{verifyPassword:async()=>{hashes++;return true;}});await assert.rejects(auth.login('test-only','test-value','network'),/LOGIN_RATE_LIMITED/);assert.equal(hashes,0);assert.deepEqual(a.writes,[]);});
test('credential change between verification and session creation fails closed',async()=>{const a=adapter({changed:true});const auth=new AuthService(a.repo,{verifyPassword:async()=>true});await assert.rejects(auth.login('test-only','test-value','network'),/CREDENTIALS_CHANGED/);assert.deepEqual(a.writes,[]);});
test('expired/revoked or version-mismatched session cannot authorize',async()=>{const a=adapter({session:false});await assert.rejects(new AuthService(a.repo).session(randomBytes(32).toString('hex')),/SESSION_EXPIRED/);});
test('logout revokes persisted token hash and audits without raw session',async()=>{const a=adapter();const token=randomBytes(32).toString('hex');await new AuthService(a.repo).logout(token,'1');assert.ok(a.writes[0].q.includes('revoked_at=UTC_TIMESTAMP'));assert.notEqual(a.writes[0].args[0].toString('hex'),token);assert.ok(a.audits.some(x=>x[1]==='auth.logout'));});
