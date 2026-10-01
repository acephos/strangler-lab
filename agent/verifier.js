'use strict';
const {spawn}=require('node:child_process');
const path=require('node:path');
function parseReport(stdout,code) {
 const count=name=>{const match=stdout.match(new RegExp(`^# ${name} (\\d+)\\s*$`,'m'));return match?Number(match[1]):null;};
 const total=count('tests'),passed=count('pass'),failed=count('fail'),skipped=count('skipped'),cancelled=count('cancelled');
 const complete=[total,passed,failed,skipped,cancelled].every(Number.isSafeInteger)&&total>0&&passed+failed+skipped+cancelled===total;
 const success=complete&&code===0&&passed===total&&failed===0&&skipped===0&&cancelled===0;
 return {timestamp:new Date().toISOString(),success,totalTests:total,passedTests:passed,failedTests:failed,skippedTests:skipped,cancelledTests:cancelled,passRate:complete?passed/total*100:null,scope:'observed assertions; no invented per-domain coverage',...(success?{}:{error:'Missing, empty, skipped, cancelled or failed contract evidence'})};
}
async function runContractVerification() {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--test','--test-reporter=tap','contract.test.js'],{cwd:path.resolve(__dirname,'../contracts'),env:process.env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let stdout='';let stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
  child.on('error',error=>{clearTimeout(timer);reject(error)});
  child.on('close',code=>{clearTimeout(timer);resolve({...parseReport(stdout,code),...(code===0?{}:{error:stderr||'Contract process failed'})});});
 });
}
module.exports={runContractVerification,parseReport};
