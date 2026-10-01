'use strict';
const {checked}=require('./http');
class Gatekeeper {
 constructor(gatewayUrl='http://127.0.0.1:8000',token){this.token=token;this.gatewayUrl=gatewayUrl.replace(/\/$/,'');}
 evaluateDeliveryContract(contract={},shadow={}) {
  const integer=value=>Number.isSafeInteger(value)&&value>=0;
  const finite=value=>Number.isFinite(value)&&value>=0;
  const complete=integer(shadow.totalSamplesDispatched)&&shadow.totalSamplesDispatched>0&&shadow.shadowRequestsEvaluated===shadow.totalSamplesDispatched&&shadow.shadowRequestsDispatched===shadow.totalSamplesDispatched&&shadow.shadowPending===0;
  const checks=[
   {name:'Observed contract tests all pass',passed:contract.success===true&&integer(contract.totalTests)&&contract.totalTests>0&&contract.passedTests===contract.totalTests&&contract.failedTests===0&&contract.skippedTests===0&&contract.passRate===100,actual:contract.totalTests??'unknown'},
   {name:'All dispatched shadow samples completed',passed:complete,actual:shadow.shadowRequestsEvaluated??'unknown'},
   {name:'No response divergence or transport failures',passed:complete&&shadow.divergenceCount===0&&shadow.shadowFailures===0&&shadow.shadowMatches===shadow.totalSamplesDispatched&&shadow.divergenceRate===0,actual:shadow.divergenceCount??'unknown'},
   {name:'Observed candidate mean latency below 50 ms',passed:complete&&finite(shadow.averageLatencyMs)&&shadow.averageLatencyMs<50,actual:shadow.averageLatencyMs??'unknown'}
  ];
  const approved=checks.every(x=>x.passed);
  return {timestamp:new Date().toISOString(),gateApproved:approved,checks,verdict:approved?'GATE_APPROVED_FOR_LAB_PROMOTION':'GATE_REJECTED_INCOMPLETE_OR_FAILED_EVIDENCE'};
 }
 async cutover(body){return (await checked(`${this.gatewayUrl}/__admin/cutover`,'POST',body,{token:this.token})).body;}
 promoteToPhase1(){return this.cutover({ordersNew:true,inventoryNew:false,shadowOrders:false,shadowInventory:false});}
 promoteToPhase2(){return this.cutover({ordersNew:true,inventoryNew:true,shadowOrders:false,shadowInventory:false});}
 rollbackToPhase0(){return this.cutover({ordersNew:false,inventoryNew:false,shadowOrders:false,shadowInventory:false});}
}
module.exports={Gatekeeper};
