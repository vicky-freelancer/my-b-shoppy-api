import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm,writeFile,stat,unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Fault } from './domain.mjs';
import { MediaService,resolveMediaDirectory,isVersionedDeploymentDirectory } from './media.mjs';
import { MemoryTestRepository } from './memory-test-repository.mjs';
import { createCommerceApp } from './app.mjs';

const uuid='8af76d5f-d017-44ea-8575-550376400da0';
async function temporaryDirectory(t){
  const directory=await mkdtemp(path.join(tmpdir(),'myb-media-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  return directory;
}
const png=()=>sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
const captureLogger=entries=>({error(event,fields){entries.push({event,fields});}});

test('production media directory defaults outside versioned deployments',()=>{
  const home=path.join(tmpdir(),'myb-home');
  const resolved=resolveMediaDirectory({NODE_ENV:'production',HOME:home},{home,cwd:home});
  assert.equal(resolved.directory,path.join(home,'mybshoppy-media'));
  assert.equal(resolved.persistent,true);
  assert.equal(isVersionedDeploymentDirectory(path.join(home,'hbuilds','build-1')),true);
  assert.equal(isVersionedDeploymentDirectory(path.join(home,'versions','v1')),true);
  assert.equal(isVersionedDeploymentDirectory(path.join(home,'persistent','media')),false);
  assert.throws(()=>resolveMediaDirectory({NODE_ENV:'production',MEDIA_DIRECTORY:path.join(home,'hbuilds','build-1')}),/MEDIA_DIRECTORY_NOT_PERSISTENT/);
  assert.throws(()=>resolveMediaDirectory({NODE_ENV:'production',MEDIA_DIRECTORY:'relative/media'}),/MEDIA_DIRECTORY_NOT_ABSOLUTE/);
  assert.equal(resolveMediaDirectory({NODE_ENV:'development',MEDIA_DIRECTORY:'var/media'},{home,cwd:home}).directory,path.join(home,'var','media'));
});

test('upload and retrieval use the same configured directory',async t=>{
  const directory=await temporaryDirectory(t),repo=new MemoryTestRepository(true),logs=[];
  const media=new MediaService(repo,directory,{logger:captureLogger(logs)});
  const asset=await media.upload(await png(),'1');
  assert.match(asset.storage_key,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/);
  assert.equal(asset.url,'/media/'+asset.storage_key);
  assert.equal((await stat(path.join(directory,asset.storage_key))).isFile(),true);
  const located=await media.locate(asset.storage_key);
  assert.equal(located.file,path.join(directory,asset.storage_key));
  assert.equal(located.sha256,asset.sha256);
});

test('missing files return MEDIA_FILE_UNAVAILABLE with private diagnostics',async t=>{
  const directory=await temporaryDirectory(t),repo=new MemoryTestRepository(true),logs=[];
  const media=new MediaService(repo,directory,{logger:captureLogger(logs)});
  const asset=await media.upload(await png(),'1');
  await unlink(path.join(directory,asset.storage_key));
  await assert.rejects(media.locate(asset.storage_key),e=>e instanceof Fault&&e.status===503&&e.code==='MEDIA_FILE_UNAVAILABLE');
  assert.ok(logs.some(({event,fields})=>event.endsWith('file_missing')&&fields.key===asset.storage_key));
  assert.ok(!JSON.stringify(logs).includes(directory));
});

test('missing and inaccessible media directories are diagnosed separately',async t=>{
  const parent=await temporaryDirectory(t),repo=new MemoryTestRepository(true),logs=[];
  const key=uuid+'.webp';
  await repo.insertMedia({storage_key:key,mime_type:'image/webp',byte_size:10,sha256:'0'.repeat(64),width_px:1,height_px:1});
  const missing=new MediaService(repo,path.join(parent,'not-created'),{logger:captureLogger(logs)});
  await assert.rejects(missing.locate(key),e=>e instanceof Fault&&e.status===503&&e.code==='MEDIA_DIRECTORY_UNAVAILABLE');
  assert.ok(logs.some(({event,fields})=>event.endsWith('directory_unavailable')&&fields.reason==='missing'));
  const file=path.join(parent,'file'),blocked=new MediaService(repo,path.join(file,'media'),{logger:captureLogger(logs)});
  await writeFile(file,'not a directory');
  await assert.rejects(blocked.upload(await png(),'1'),e=>e instanceof Fault&&e.status===503&&e.code==='MEDIA_DIRECTORY_UNAVAILABLE');
});

test('invalid media filenames are rejected before filesystem access',async t=>{
  const directory=await temporaryDirectory(t),media=new MediaService(new MemoryTestRepository(true),directory);
  for(const key of ['../'+uuid+'.webp',uuid+'.webp/../x','..\\'+uuid+'.webp',uuid+'.WEBP','not-a-uuid.webp',uuid+'.webp\u0000']){
    await assert.rejects(media.locate(key),e=>e instanceof Fault&&e.status===404&&e.code==='INVALID_MEDIA_PATH');
  }
});

test('media endpoint reports missing files without exposing storage paths',async t=>{
  const directory=await temporaryDirectory(t),repo=new MemoryTestRepository(true),logs=[];
  const media=new MediaService(repo,directory,{logger:captureLogger(logs)});
  const asset=await media.upload(await png(),'1');
  await unlink(path.join(directory,asset.storage_key));
  const app=createCommerceApp({media,env:{NODE_ENV:'test'}}),server=app.listen(0,'127.0.0.1');
  await once(server,'listening');
  try{
    const base='http://127.0.0.1:'+server.address().port;
    const missing=await fetch(base+'/media/'+asset.storage_key);
    assert.equal(missing.status,503);
    const body=await missing.json();
    assert.deepEqual(body,{error:'MEDIA_FILE_UNAVAILABLE',code:'MEDIA_FILE_UNAVAILABLE'});
    assert.ok(!JSON.stringify(body).includes(directory));
    const invalid=await fetch(base+'/media/not-a-uuid.webp');
    assert.equal(invalid.status,404);
    assert.equal((await invalid.json()).code,'INVALID_MEDIA_PATH');
  }finally{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});
