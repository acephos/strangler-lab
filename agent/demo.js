'use strict';
const {startStack}=require('./stack');
const {runContractVerification}=require('./verifier');
const {runLifecycle}=require('./lifecycle');
const {MigrationLedger}=require('./ledger');
async function runDemo(){
 const ledger=new MigrationLedger();
 if(!ledger.records.events.some(event=>event.eventType==='EVIDENCE_CORRECTION')) ledger.recordEvent('EVIDENCE_CORRECTION',{summary:'Earlier shadow responses were counted as matches without comparing primary status/body. Empty/incomplete gates, fabricated domain compliance and broad zero-loss/decommission claims are superseded. Historical entries remain unchanged; new acceptance requires controlled completed evidence.'});
 const contract=await runContractVerification();if(!contract.success)throw new Error(contract.error);
 const stack=await startStack();
 try {const result=await runLifecycle(stack,contract);ledger.recordEvent('VALIDATED_LAB_RUN',result);console.log(JSON.stringify(result,null,2));return result;}
 finally{await stack.stop();}
}
if(require.main===module)runDemo().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={runDemo};
