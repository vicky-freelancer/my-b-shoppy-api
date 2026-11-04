import sharp from 'sharp';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,open,stat,readFile,access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Fault,requireThat } from './domain.mjs';

const MEDIA_KEY=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.webp$/;
const VERSIONED_SEGMENTS=new Set(['hbuild','hbuilds','version','versions','release','releases']);
const PRODUCTION_MEDIA_DIRECTORY='mybshoppy-media';

export function isVersionedDeploymentDirectory(directory){
  return path.resolve(directory).split(path.sep).filter(Boolean)
    .some(segment=>VERSIONED_SEGMENTS.has(segment.toLowerCase()));
}

export function resolveMediaDirectory(env=process.env,{cwd=process.cwd(),home=os.homedir()}={}){
  const configured=typeof env.MEDIA_DIRECTORY==='string'?env.MEDIA_DIRECTORY.trim():'';
  const production=env.NODE_ENV==='production';
  let directory,source;
  if(configured){
    if(production&&!path.isAbsolute(configured))throw new Fault(503,'MEDIA_DIRECTORY_NOT_ABSOLUTE');
    directory=path.resolve(cwd,configured);source='MEDIA_DIRECTORY';
  }else if(production){
    // Hostinger replaces versioned build directories on release. Keep the default
    // under the account home so uploaded files survive redeployments.
    directory=path.resolve(env.HOME||env.USERPROFILE||home,PRODUCTION_MEDIA_DIRECTORY);
    source='hostinger-persistent-default';
  }else{
    directory=path.resolve(cwd,'var/media');source='development-default';
  }
  if(production&&isVersionedDeploymentDirectory(directory))throw new Fault(503,'MEDIA_DIRECTORY_NOT_PERSISTENT');
  return {directory,source,persistent:!isVersionedDeploymentDirectory(directory)};
}

export class MediaService {
  constructor(repo,directory,{logger=console}={}){
    this.repo=repo;this.directory=path.resolve(directory);this.logger=logger;
    this.storage={persistent:!isVersionedDeploymentDirectory(this.directory)};
  }
  diagnose(event,fields={}){
    try{this.logger?.error?.(`[media] ${event}`,{...fields,directoryPersistent:this.storage.persistent});}catch{}
  }
  keyPath(key){
    requireThat(typeof key==='string'&&MEDIA_KEY.test(key)&&path.basename(key)===key,'INVALID_MEDIA_PATH',404);
    const file=path.resolve(this.directory,key);
    requireThat(path.dirname(file)===this.directory,'INVALID_MEDIA_PATH',404);
    return file;
  }
  async directoryState(){
    try{
      const info=await stat(this.directory);
      if(!info.isDirectory())return 'not_a_directory';
      await access(this.directory,fsConstants.R_OK);return 'readable';
    }catch(e){return e.code==='ENOENT'?'missing':'inaccessible';}
  }
  async upload(buffer,actor){
    requireThat(Buffer.isBuffer(buffer)&&buffer.length>0&&buffer.length<=5*1024*1024,'INVALID_IMAGE_SIZE');
    const jpeg=buffer[0]===255&&buffer[1]===216&&buffer[2]===255;
    const png=buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const webp=buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP';
    requireThat(jpeg||png||webp,'INVALID_IMAGE_SIGNATURE');
    const image=sharp(buffer,{limitInputPixels:16777216,failOn:'warning'});let metadata,output;
    try{metadata=await image.metadata();requireThat(['jpeg','png','webp'].includes(metadata.format)&&(!metadata.pages||metadata.pages===1)&&metadata.width<=8192&&metadata.height<=8192,'INVALID_IMAGE_FORMAT');output=await image.rotate().resize(1600,1600,{fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer({resolveWithObject:true});}
    catch(e){if(e instanceof Fault)throw e;throw new Fault(422,'IMAGE_DECODE_FAILED');}
    requireThat(output.data.length<=5*1024*1024,'INVALID_IMAGE_SIZE');
    const key=randomUUID()+'.webp';
    try{await mkdir(this.directory,{recursive:true});}
    catch(e){this.diagnose('directory_unavailable',{reason:e.code||'UNKNOWN'});throw new Fault(503,'MEDIA_DIRECTORY_UNAVAILABLE');}
    let file;
    try{file=await open(path.join(this.directory,key),'wx');await file.writeFile(output.data);await file.sync();}
    catch(e){
      const reason=e.code||'UNKNOWN';
      if(['EACCES','EPERM','ENOENT','ENOTDIR','EROFS'].includes(reason)){this.diagnose('directory_unavailable',{key,reason});throw new Fault(503,'MEDIA_DIRECTORY_UNAVAILABLE');}
      this.diagnose('upload_write_failed',{key,reason});throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');
    }
    finally{if(file)await file.close().catch(()=>{});}
    const asset=await this.repo.transaction(async r=>{const a=await r.insertMedia({storage_key:key,mime_type:'image/webp',byte_size:output.data.length,sha256:createHash('sha256').update(output.data).digest('hex'),width_px:output.info.width,height_px:output.info.height});await r.audit(actor,'media.upload','media',a.id);return a;});
    // Unknown commits may leave an unreferenced file; preserve for approved recovery.
    return {...asset,url:'/media/'+key};
  }
  async locate(key){
    const file=this.keyPath(key);
    const a=await this.repo.run(r=>r.mediaByKey(key));if(!a)throw new Fault(404,'MEDIA_NOT_FOUND');
    let info;
    try{info=await stat(file);}
    catch(e){
      const state=await this.directoryState();
      if(state!=='readable'){this.diagnose('directory_unavailable',{key,reason:state});throw new Fault(503,'MEDIA_DIRECTORY_UNAVAILABLE');}
      this.diagnose(e.code==='ENOENT'?'file_missing':'file_inaccessible',{key,reason:e.code||'UNKNOWN'});
      throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');
    }
    if(!info.isFile()){this.diagnose('file_unreadable',{key,reason:'not_a_file'});throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');}
    if(info.size!==Number(a.byte_size)){
      this.diagnose('file_size_mismatch',{key,expected:Number(a.byte_size),actual:info.size});
      throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');
    }
    let bytes;
    try{bytes=await readFile(file);}
    catch(e){this.diagnose('file_read_failed',{key,reason:e.code||'UNKNOWN'});throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');}
    if(createHash('sha256').update(bytes).digest('hex')!==a.sha256){this.diagnose('file_integrity_mismatch',{key});throw new Fault(503,'MEDIA_INTEGRITY_FAILED');}
    return {file,sha256:a.sha256};
  }
}
