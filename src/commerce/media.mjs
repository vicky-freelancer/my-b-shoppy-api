import sharp from 'sharp';
import { randomUUID,createHash } from 'node:crypto';
import { mkdir,open,stat,readFile } from 'node:fs/promises';
import path from 'node:path';
import { Fault,requireThat } from './domain.mjs';
export class MediaService {
  constructor(repo,directory){this.repo=repo;this.directory=path.resolve(directory);}
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
    const key=randomUUID()+'.webp';await mkdir(this.directory,{recursive:true});
    const file=await open(path.join(this.directory,key),'wx');try{await file.writeFile(output.data);await file.sync();}finally{await file.close();}
    const asset=await this.repo.transaction(async r=>{const a=await r.insertMedia({storage_key:key,mime_type:'image/webp',byte_size:output.data.length,sha256:createHash('sha256').update(output.data).digest('hex'),width_px:output.info.width,height_px:output.info.height});await r.audit(actor,'media.upload','media',a.id);return a;});
    // Unknown commits may leave an unreferenced file; preserve for approved recovery.
    return {...asset,url:'/media/'+key};
  }
  async locate(key){
    requireThat(/^[0-9a-f-]{36}\.webp$/.test(key),'INVALID_MEDIA_PATH',404);
    const a=await this.repo.run(r=>r.mediaByKey(key));if(!a)throw new Fault(404,'MEDIA_NOT_FOUND');
    const file=path.join(this.directory,key);const info=await stat(file).catch(()=>null);if(!info||info.size!==Number(a.byte_size))throw new Fault(503,'MEDIA_FILE_UNAVAILABLE');
    if(createHash('sha256').update(await readFile(file)).digest('hex')!==a.sha256)throw new Fault(503,'MEDIA_INTEGRITY_FAILED');return {file,sha256:a.sha256};
  }
}
