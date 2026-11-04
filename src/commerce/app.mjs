import express from 'express';
import multer from 'multer';
import { Repository } from './repository.mjs';
import { CatalogService } from './catalog.mjs';
import { AuthService,cookieToken,csrfFor,equalHex } from './auth.mjs';
import { MediaService,resolveMediaDirectory } from './media.mjs';
import { createRazorpayWebhookHandler } from '../payment-security.mjs';
import { healthResponse } from '../runtime-config.mjs';
import { Fault,safeJSON } from './domain.mjs';

export const LOCAL_ORIGINS=['http://localhost:3000','http://127.0.0.1:3000','http://localhost:3001','http://127.0.0.1:3001'];
const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
export function createCommerceApp({database,repo=database?new Repository(database):null,catalog=repo?new CatalogService(repo):null,auth=repo?new AuthService(repo):null,
  media,env={},allowedOrigins=LOCAL_ORIGINS,checkout=null,checkoutApi=null,checkoutOrigins=allowedOrigins}={}){
  const app=express();app.disable('x-powered-by');app.set('json replacer',(_k,v)=>typeof v==='bigint'?v.toString():v);
  media??=repo?new MediaService(repo,resolveMediaDirectory(env).directory):null;
  const secure=env.NODE_ENV==='production';const cookieName=secure?'__Host-myb_admin':'myb_admin';
  const cookie=(res,name,token,maxAge)=>res.cookie(name,token,{httpOnly:true,secure,sameSite:'strict',path:'/',maxAge});
  const origin=(req,res,next)=>allowedOrigins.includes(req.get('origin'))?next():next(new Fault(403,'ORIGIN_REFUSED'));
  const checkoutOrigin=(req,res,next)=>checkoutOrigins.includes(req.get('origin'))?next():next(new Fault(403,'ORIGIN_REFUSED'));
  const checkoutEnabled=!!(checkoutApi&&checkout&&checkout.isEnabled());
  const checkoutStatus=checkoutApi&&checkout?checkout.status:(_req,res)=>res.set('Cache-Control','no-store').json({enabled:false,code:'CHECKOUT_TEMPORARILY_UNAVAILABLE'});
  const available=(_req,_res,next)=>repo||catalog?next():next(new Fault(503,'MARIADB_NOT_CONFIGURED'));
  const session=wrap(async(req,_res,next)=>{if(!auth)throw new Fault(503,'AUTH_UNAVAILABLE');req.admin=await auth.session(cookieToken(req,cookieName));next();});
  const csrf=(req,_res,next)=>equalHex(req.get('x-csrf-token'),req.admin.csrfToken)?next():next(new Fault(403,'CSRF_REFUSED'));
  app.post('/api/razorpay-webhook',express.raw({type:'application/json',limit:'64kb',inflate:false}),createRazorpayWebhookHandler({getSecret:()=>env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')&&env.RAZORPAY_ACCOUNT_ID?env.RAZORPAY_WEBHOOK_SECRET:undefined,matchesEnvelope:body=>body?.account_id===env.RAZORPAY_ACCOUNT_ID}));
  app.use(express.json({limit:'100kb',strict:true}));
  app.get('/api/health',wrap(async(_req,res)=>{
    // Readiness is additive here: database errors must not change legacy fields
    // or leak driver diagnostics. /api/v1/health remains the readiness probe.
    let ready=false;
    try{ready=(database?await database.health():{ready:!!catalog}).ready===true;}catch{}
    res.set('Cache-Control','no-store').json({...healthResponse(env),database:{ready},backend:'mariadb',checkoutEnabled});
  }));
  app.get('/api/v1/health',wrap(async(_req,res)=>{const state=database?await database.health():{ready:!!catalog};res.status(state.ready?200:503).json({ok:state.ready,backend:'mariadb',checkoutEnabled});}));
  app.get('/api/checkout/status',checkoutStatus);
  for(const prefix of ['/api/admin','/api/v1/admin']){
    app.post(prefix+'/login',origin,wrap(async(req,res)=>{if(!auth)throw new Fault(503,'AUTH_UNAVAILABLE');const result=await auth.login(req.body?.userId,req.body?.password,req.ip);cookie(res,cookieName,result.token,8*3600000);res.set('Cache-Control','no-store').json({user:result.user,csrfToken:result.csrfToken});}));
    app.get(prefix+'/session',session,(req,res)=>res.set('Cache-Control','no-store').json(req.admin));
    app.post(prefix+'/logout',origin,session,csrf,wrap(async(req,res)=>{await auth.logout(cookieToken(req,cookieName),req.admin.user.id);cookie(res,cookieName,'',0);res.json({success:true});}));
  }
  app.use('/api/v1/admin',available,session,(req,res,next)=>['GET','HEAD'].includes(req.method)?next():origin(req,res,e=>e?next(e):csrf(req,res,next)));
  app.get('/api/v1/categories',available,wrap(async(_req,res)=>res.set('Cache-Control','no-cache').json({categories:await catalog.categories()})));
  app.get('/api/v1/subcategories',available,wrap(async(_req,res)=>res.set('Cache-Control','no-cache').json({subcategories:await catalog.subcategories()})));
  app.get('/api/v1/products',available,wrap(async(req,res)=>res.set('Cache-Control','no-cache').json(await catalog.list(req.query))));
  app.get('/api/v1/products/resolve',available,wrap(async(req,res)=>{
    const ids=String(req.query.ids||'').split(',').filter(Boolean);if(ids.length>100)throw new Fault(422,'TOO_MANY_IDS');const products=[];
    for(const key of [...new Set(ids)])try{products.push(await catalog.product(key));}catch(e){if(e.status!==404)throw e;}
    res.json({products});
  }));
  app.get('/api/v1/products/:key',available,wrap(async(req,res)=>res.set('Cache-Control','no-cache').json({product:await catalog.product(req.params.key)})));
  app.get('/api/v1/admin/categories',wrap(async(_req,res)=>res.json({categories:await catalog.categories(true)})));
  app.post('/api/v1/admin/categories',wrap(async(req,res)=>res.status(201).json({category:await catalog.createCategory(req.body,req.admin.user.id)})));
  app.post('/api/v1/admin/categories/bootstrap',wrap(async(req,res)=>res.json({categories:await catalog.bootstrap(req.admin.user.id)})));
  app.patch('/api/v1/admin/categories/:id',wrap(async(req,res)=>res.json({category:await catalog.updateCategory(req.params.id,req.body,req.admin.user.id)})));
  app.get('/api/v1/admin/subcategories',wrap(async(_req,res)=>res.json({subcategories:await catalog.subcategories(true)})));
  app.post('/api/v1/admin/subcategories',wrap(async(req,res)=>res.status(201).json({subcategory:await catalog.saveSubcategory(req.body,null,req.admin.user.id)})));
  app.patch('/api/v1/admin/subcategories/:id',wrap(async(req,res)=>res.json({subcategory:await catalog.saveSubcategory(req.body,req.params.id,req.admin.user.id)})));
  app.delete('/api/v1/admin/subcategories/:id',wrap(async(req,res)=>res.json(await catalog.archiveSubcategory(req.params.id,req.admin.user.id))));
  app.get('/api/v1/admin/products',wrap(async(req,res)=>res.json(await catalog.list(req.query,true))));
  app.post('/api/v1/admin/products',wrap(async(req,res)=>res.status(201).json({product:await catalog.save(req.body,null,req.admin.user.id)})));
  app.patch('/api/v1/admin/products/:id',wrap(async(req,res)=>res.json({product:await catalog.save(req.body,req.params.id,req.admin.user.id)})));
  app.post('/api/v1/admin/products/:id/:action',wrap(async(req,res)=>res.json({product:await catalog.lifecycle(req.params.id,req.params.action,req.admin.user.id)})));
  app.delete('/api/v1/admin/products/:id',wrap(async(req,res)=>res.json(await catalog.deleteProduct(req.params.id,req.admin.user.id))));
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0}});
  app.post('/api/v1/admin/media',upload.single('image'),wrap(async(req,res)=>{if(!media)throw new Fault(503,'MEDIA_UNAVAILABLE');res.status(201).json({asset:await media.upload(req.file?.buffer,req.admin.user.id)});}));
  app.get('/media/:key',wrap(async(req,res)=>{if(!media)throw new Fault(503,'MEDIA_UNAVAILABLE');const a=await media.locate(req.params.key);res.set({'Content-Type':'image/webp','X-Content-Type-Options':'nosniff','Cache-Control':'public,max-age=31536000,immutable',ETag:'"'+a.sha256+'"'}).sendFile(a.file);}));
  app.get('/api/v1/admin/orders',wrap(async(req,res)=>res.json(await repo.run(async r=>({orders:await r.orders(req.query),count:await r.orderCount()})))));
  app.patch('/api/v1/admin/orders/:id',wrap(async(req,res)=>res.json(await catalog.updateOrder(req.params.id,req.body,req.admin.user.id))));
  app.delete('/api/v1/admin/orders/:id',wrap(async(req,res)=>res.json(await catalog.updateOrder(req.params.id,{archive:true},req.admin.user.id))));
  const paymentsUnavailable=(_req,res)=>res.set('Cache-Control','no-store').set('Retry-After','60').status(503).json({code:'CHECKOUT_TEMPORARILY_UNAVAILABLE',error:'Checkout is temporarily unavailable.'});
  app.post('/api/v1/admin/payments/reconcile',paymentsUnavailable);
  if(checkoutApi){
    const checkoutGate=checkout?checkout.guard:paymentsUnavailable;
    app.get('/api/v1/checkout/session',checkoutOrigin,checkoutGate,wrap(checkoutApi.session));
    app.post('/api/v1/checkout',checkoutOrigin,checkoutGate,wrap(checkoutApi.create));
    app.get('/api/v1/orders/:id',wrap(checkoutApi.status));
    app.post('/api/v1/orders/:id/confirm',checkoutOrigin,wrap(checkoutApi.confirm));
  }else{
    app.get('/api/v1/checkout/session',checkoutOrigin,paymentsUnavailable);
    app.post('/api/v1/checkout',checkoutOrigin,paymentsUnavailable);
    app.get('/api/v1/orders/:id',paymentsUnavailable);
    app.post('/api/v1/orders/:id/confirm',checkoutOrigin,paymentsUnavailable);
    app.post(['/api/create-order','/api/verify-payment'],paymentsUnavailable);
  }
  app.use((error,_req,res,_next)=>{
    let status=error instanceof Fault?error.status:500,code=error instanceof Fault?error.code:'INTERNAL_ERROR';
    if(error.errno===1062){status=409;code='UNIQUE_CONFLICT';}if(error.errno===1452||error.errno===1451){status=409;code='REFERENCE_CONFLICT';}
    if(error.code==='LIMIT_FILE_SIZE'){status=413;code='IMAGE_TOO_LARGE';}if(error.type==='entity.parse.failed'){status=400;code='INVALID_JSON';}
    if(error.status===413){status=413;code='REQUEST_TOO_LARGE';}if(error.code==='LIMIT_UNEXPECTED_FILE'){status=422;code='INVALID_UPLOAD';}
    res.set('Cache-Control','no-store').status(status).type('json').send(safeJSON({error:code,code}));
  });return app;
}
