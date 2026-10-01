'use strict';
const http=require('node:http');
function request(url,method='GET',body,options={}) {
 return new Promise((resolve,reject)=>{
  const u=new URL(url);if(u.protocol!=='http:') return reject(new Error('Lab HTTP endpoint required'));
  const data=body===undefined?null:JSON.stringify(body);
  const headers={...(data?{'content-type':'application/json','content-length':Buffer.byteLength(data)}:{}),...options.headers};
  if(u.pathname.startsWith('/__')) headers.authorization=`Bearer ${options.token||process.env.LAB_ADMIN_TOKEN||''}`;
  const start=performance.now();const req=http.request(u,{method,headers,timeout:5000},res=>{
   const chunks=[];let size=0;
   res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy(new Error('Response exceeds limit'));return;}chunks.push(chunk);});
   res.on('error',reject);res.on('end',()=>{
    try {const raw=Buffer.concat(chunks).toString();resolve({status:res.statusCode,body:raw?JSON.parse(raw):null,headers:res.headers,servedBy:res.headers['x-served-by'],target:res.headers['x-gateway-target'],durationMs:performance.now()-start});} catch {reject(new Error('Invalid JSON response'));}
   });
  });
  req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('HTTP deadline exceeded')));
  if(data) req.write(data);req.end();
 });
}
async function checked(url,method='GET',body,options={}) {const result=await request(url,method,body,options);if(result.status<200||result.status>=300) throw new Error(`Lab request failed with HTTP ${result.status}`);return result;}
module.exports={request,checked};
