'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const ROOT=path.resolve(__dirname,'..');
function digest(event){return crypto.createHash('sha256').update(JSON.stringify({eventType:event.eventType,timestamp:event.timestamp,details:event.details,prevHash:event.prevHash})).digest('hex');}
function atomicWrite(file,text){const temporary=`${file}.${crypto.randomUUID()}.tmp`;try{fs.writeFileSync(temporary,text,{flag:'wx',mode:0o600});fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}}
class MigrationLedger {
 constructor(directory=ROOT){this.ledgerPath=path.join(directory,'migration-ledger.json');this.scorecardPath=path.join(directory,'MIGRATION_SCORECARD.md');this.records=this.load();}
 load(){
  if(!fs.existsSync(this.ledgerPath))return {version:'2.0.0',project:'strangler-lab',events:[]};
  const record=JSON.parse(fs.readFileSync(this.ledgerPath,'utf8'));if(!Array.isArray(record.events))throw new Error('Invalid ledger events');
  let previous='GENESIS';let id=1;
  for(const event of record.events){const hash=digest(event);if(event.id!==id++||event.prevHash!==previous||typeof event.hash!=='string'||!([16,64].includes(event.hash.length))||hash.slice(0,event.hash.length)!==event.hash)throw new Error('Ledger hash chain is invalid');previous=event.hash;}
  return record;
 }
 recordEvent(eventType,details){
  const lock=this.ledgerPath+'.lock';fs.mkdirSync(lock,{mode:0o700});
  try {
   this.records=this.load();const events=this.records.events;
   const event={id:events.length+1,eventType,timestamp:new Date().toISOString(),details,prevHash:events.length?events.at(-1).hash:'GENESIS'};event.hash=digest(event);
   events.push(event);atomicWrite(this.ledgerPath,JSON.stringify(this.records,null,2)+'\n');this.generateScorecard();return event;
  }finally{fs.rmdirSync(lock);}
 }
 generateScorecard(){
  const correction=this.records.events.findIndex(event=>event.eventType==='EVIDENCE_CORRECTION');
  const latest=this.records.events.filter(event=>event.eventType==='VALIDATED_LAB_RUN').at(-1);
  let text='# Strangler lab — observed verification\n\n';
  text+='This is a local in-memory exercise. The hash chain detects accidental edits against its existing prefix; it is not an immutable log, authenticated signature, or proof against a writer who replaces the whole file. New entries use full SHA-256; historical 16-character hashes remain unchanged. Corrupt ledgers fail closed and concurrent writers use an exclusive directory lock.\n\n';
  if(latest){const d=latest.details;text+=`Latest controlled run: ${latest.timestamp}\n\n- Contract assertions: ${d.contract.passedTests}/${d.contract.totalTests}.\n- Completed shadow reads: ${d.shadow.shadowRequestsEvaluated}; matches: ${d.shadow.shadowMatches}; divergences: ${d.shadow.divergenceCount}; transport failures: ${d.shadow.shadowFailures}.\n- Preserved order IDs: ${d.verifiedOrders}; stock: ${d.initialQuantity} → ${d.finalQuantity}.\n- Healthy-service state transfer/rollback: ${d.rollbackMs.toFixed(3)} ms in this one run.\n\n`;
   text+='Checks:\n\n'+d.checks.map(check=>'- '+check).join('\n')+'\n\nLimitations:\n\n'+d.limitations.map(limit=>'- '+limit).join('\n')+'\n\n';
  }else{text+='No validated lifecycle run is recorded yet.\n\n';}
  text+='Historical events before EVIDENCE_CORRECTION contain unsupported broad claims and do not establish current acceptance.\n\n| # | Date | Event | Evidence status | Hash |\n|---|---|---|---|---|\n';
  for(const [index,event]of this.records.events.entries()){const status=correction<0||index<correction?'historical, superseded':event.eventType==='VALIDATED_LAB_RUN'?'controlled run':'correction/process';text+=`| ${event.id} | ${event.timestamp} | ${event.eventType} | ${status} | ${event.hash} |\n`;}
  atomicWrite(this.scorecardPath,text);
 }
}
module.exports={MigrationLedger};
