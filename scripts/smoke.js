'use strict';
// An owned disposable stack prevents accidental changes to an unrelated :8000 service.
const {startStack}=require('../agent/stack');
const {runContractVerification}=require('../agent/verifier');
const {runLifecycle}=require('../agent/lifecycle');
(async()=>{
 const contract=await runContractVerification();if(!contract.success)throw new Error(contract.error);
 const stack=await startStack();try{const result=await runLifecycle(stack,contract);console.log(JSON.stringify(result,null,2));}finally{await stack.stop();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
