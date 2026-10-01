'use strict';
const {startStack}=require('../agent/stack');
(async()=>{
 const stack=await startStack();console.log(`Owned local lab is healthy at ${stack.url}. Cutover token remains private to this process; use npm run demo for the authenticated lifecycle.`);
 let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await stack.stop();process.exitCode=0;};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
})().catch(error=>{console.error(error.message);process.exitCode=1;});
