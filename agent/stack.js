'use strict';
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const crypto=require('node:crypto');
const {setTimeout:sleep}=require('node:timers/promises');
const {checked}=require('./http');
const ROOT=path.resolve(__dirname,'..');
async function freePort(){return new Promise((resolve,reject)=>{const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});}
async function startStack(){
 const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'strangler-lab-'));
 const children=[];const token=process.env.LAB_ADMIN_TOKEN||crypto.randomBytes(32).toString('hex');const runId=crypto.randomUUID();
 const ports={};for(const name of ['gateway','legacy','orders','inventory'])ports[name]=await freePort();
 const url=name=>`http://127.0.0.1:${ports[name]}`;
 async function stop(){
  await Promise.all(children.map(child=>new Promise(resolve=>{if(child.exitCode!==null||child.signalCode!==null)return resolve();child.once('exit',resolve);child.kill('SIGTERM');setTimeout(()=>{child.kill('SIGKILL');resolve();},2000).unref();})));
  await fs.rm(temporary,{recursive:true,force:true});
 }
 function launch(command,args,environment,cwd){const child=spawn(command,args,{cwd,env:{...process.env,HOST:'127.0.0.1',LAB_ADMIN_TOKEN:token,LAB_RUN_ID:runId,...environment},stdio:['ignore','pipe','pipe'],windowsHide:true});child.on('error',()=>{});children.push(child);return child;}
 try {
  for(const [name,dir] of [['orders','services/orders-go'],['inventory','services/inventory-go'],['gateway','gateway']]){
   const out=path.join(temporary,name+(process.platform==='win32'?'.exe':''));
   await new Promise((resolve,reject)=>{const build=spawn('go',['build','-o',out,'.'],{cwd:path.join(ROOT,dir),stdio:['ignore','ignore','pipe']});let errors='';build.stderr.on('data',data=>errors+=data);build.on('error',reject);build.on('exit',code=>code===0?resolve():reject(new Error(`Go build failed: ${errors}`)));});
  }
  launch(process.execPath,[path.join(ROOT,'legacy/server.js')],{PORT:String(ports.legacy)},ROOT);
  launch(path.join(temporary,'inventory'+(process.platform==='win32'?'.exe':'')),[],{PORT:String(ports.inventory)},ROOT);
  launch(path.join(temporary,'orders'+(process.platform==='win32'?'.exe':'')),[],{PORT:String(ports.orders),INVENTORY_URL:url('gateway')},ROOT);
  launch(path.join(temporary,'gateway'+(process.platform==='win32'?'.exe':'')),[],{PORT:String(ports.gateway),LEGACY_URL:url('legacy'),ORDERS_URL:url('orders'),INVENTORY_URL:url('inventory'),ROUTE_ORDERS_NEW:'false',ROUTE_INVENTORY_NEW:'false',SHADOW_ORDERS:'false',SHADOW_INVENTORY:'false'},ROOT);
  for(const name of Object.keys(ports)){
   let ready=false;
   for(let attempt=0;attempt<100;attempt++){
    if(children.some(child=>child.exitCode!==null||child.signalCode!==null))throw new Error('Owned service exited during startup');
    try {const health=await checked(url(name)+'/health');if(health.body.runId===runId){ready=true;break;}}catch{}
    await sleep(50);
   }
   if(!ready)throw new Error('Owned stack did not become healthy');
  }
  return {url:url('gateway'),token,runId,stop};
 }catch(error){await stop();throw error;}
}
module.exports={startStack};
