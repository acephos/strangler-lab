'use strict';
const {setTimeout:sleep}=require('node:timers/promises');
const {checked}=require('./http');
async function runShadowAudit(gatewayUrl='http://127.0.0.1:8000',options={}) {
 const httpOptions={token:options.token};
 const paths=options.paths??['/inventory/SKU-COFFEE-01'];
 if(!Array.isArray(paths)||!paths.length||paths.some(path=>typeof path!=='string'||!/^\/(orders|inventory)\//.test(path)))throw new Error('Read-only domain paths are required');
 const count=options.samples??5;
 if(!Number.isSafeInteger(count)||count<1||count>100) throw new Error('Sample count must be 1..100');
 // Sync the inactive read model before mirroring; never replay order/reservation writes.
 await checked(`${gatewayUrl}/__admin/cutover`,'POST',{shadowOrders:true,shadowInventory:true},httpOptions);
 await checked(`${gatewayUrl}/__shadow/reset`,'POST',undefined,httpOptions);
 for(let index=0;index<count;index++) await checked(gatewayUrl+paths[index%paths.length]);
 const deadline=Date.now()+6000;let stats;
 do {
  stats=(await checked(`${gatewayUrl}/__shadow/stats`,'GET',undefined,httpOptions)).body;
  if(stats.shadowCompleted===count&&stats.shadowPending===0) break;
  await sleep(20);
 } while(Date.now()<deadline);
 if(stats.shadowCompleted!==count||stats.shadowPending!==0||stats.shadowRequests!==count) throw new Error('Incomplete or contaminated shadow sample');
 return {timestamp:new Date().toISOString(),totalSamplesDispatched:count,shadowRequestsDispatched:stats.shadowRequests,shadowRequestsEvaluated:stats.shadowCompleted,shadowPending:stats.shadowPending,shadowMatches:stats.shadowMatches,shadowFailures:stats.shadowFailures,divergenceCount:stats.diffCount,divergenceRate:stats.divergenceRate,averageLatencyMs:stats.averageLatencyMs,status:stats.diffCount===0&&stats.shadowFailures===0?'SAMPLED_PARITY':'DIVERGENCE_DETECTED',scope:'controlled read-only lab samples; not production drift or SLA evidence'};
}
if(require.main===module) runShadowAudit().then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={runShadowAudit};
