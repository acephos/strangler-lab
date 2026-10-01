'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {Gatekeeper}=require('../agent/gatekeeper');const {parseReport}=require('../agent/verifier');const {MigrationLedger}=require('../agent/ledger');
const contract={success:true,totalTests:24,passedTests:24,failedTests:0,skippedTests:0,passRate:100};
const shadow={totalSamplesDispatched:5,shadowRequestsDispatched:5,shadowRequestsEvaluated:5,shadowPending:0,shadowMatches:5,shadowFailures:0,divergenceCount:0,divergenceRate:0,averageLatencyMs:2};
test('gate refuses empty, missing, incomplete, failed and divergent evidence',()=>{
 const gate=new Gatekeeper();assert.equal(gate.evaluateDeliveryContract(contract,shadow).gateApproved,true);
 for(const c of [{},{...contract,totalTests:0,passedTests:0},{...contract,skippedTests:1},{...contract,success:false}])assert.equal(gate.evaluateDeliveryContract(c,shadow).gateApproved,false);
 for(const s of [{},{...shadow,totalSamplesDispatched:0},{...shadow,shadowPending:1},{...shadow,shadowRequestsEvaluated:4},{...shadow,shadowFailures:1},{...shadow,divergenceCount:1},{...shadow,averageLatencyMs:NaN}])assert.equal(gate.evaluateDeliveryContract(contract,s).gateApproved,false);
});
test('verifier requires complete nonzero TAP counts and a successful process',()=>{
 const tap='# tests 2\n# pass 2\n# fail 0\n# skipped 0\n# cancelled 0\n';
 assert.equal(parseReport(tap,0).success,true);assert.equal(parseReport(tap,1).success,false);
 assert.equal(parseReport('',0).success,false);assert.equal(parseReport(tap.replace('tests 2','tests 0'),0).success,false);assert.equal(parseReport(tap.replace('skipped 0','skipped 1'),0).success,false);
});
test('ledger detects corruption, preserves history and rejects competing writer locks',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ledger-fixture-'));
 try {
  const ledger=new MigrationLedger(root);const first=ledger.recordEvent('FIXTURE',{summary:'synthetic fixture'});
  assert.equal(first.hash.length,64);const prefix=JSON.stringify(first);
  ledger.recordEvent('EVIDENCE_CORRECTION',{summary:'fixture correction'});
  assert.equal(JSON.stringify(new MigrationLedger(root).records.events[0]),prefix);
  fs.mkdirSync(path.join(root,'migration-ledger.json.lock'));assert.throws(()=>ledger.recordEvent('FIXTURE',{}),/EEXIST/);fs.rmdirSync(path.join(root,'migration-ledger.json.lock'));
  const record=JSON.parse(fs.readFileSync(path.join(root,'migration-ledger.json')));record.events[0].details.summary='tampered';fs.writeFileSync(path.join(root,'migration-ledger.json'),JSON.stringify(record));assert.throws(()=>new MigrationLedger(root),/hash chain/);
  fs.writeFileSync(path.join(root,'migration-ledger.json'),'{invalid');assert.throws(()=>new MigrationLedger(root));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
