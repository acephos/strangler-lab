'use strict';
const assert=require('node:assert/strict');
const {checked,request}=require('./http');
const {Gatekeeper}=require('./gatekeeper');
const {runShadowAudit}=require('./shadow-auditor');
async function runLifecycle(stack,contract){
 const url=stack.url;const gatekeeper=new Gatekeeper(url,stack.token);const sku='SKU-COFFEE-01';
 const stock=async()=> (await checked(`${url}/inventory/${sku}`)).body.quantity;
 const create=async (quantity,key)=>checked(`${url}/orders`,'POST',{customerId:'controlled-fixture',items:[{sku,quantity}]},{headers:key?{'Idempotency-Key':key}:{}});
 const order=async id=>(await checked(`${url}/orders/${id}`)).body;
 const initial=await stock();const first=await create(2,"fixture-first");
 assert.deepEqual((await create(2,"fixture-first")).body,first.body);
 assert.equal(first.status,201);assert.equal(first.servedBy,'legacy-monolith');
 await gatekeeper.promoteToPhase1();assert.deepEqual(await order(first.body.id),first.body);assert.equal(await stock(),initial-2);
 const second=await create(3,"fixture-second");
 assert.deepEqual((await create(3,"fixture-second")).body,second.body);assert.equal(second.servedBy,'orders-go');assert.equal(await stock(),initial-5);
 const beforeRejected=await stock();
 const conflict=await request(`${url}/orders`,'POST',{customerId:'controlled-fixture',items:[{sku,quantity:1}]},{headers:{'Idempotency-Key':'fixture-second'}});assert.equal(conflict.status,409);assert.equal(await stock(),beforeRejected);
 for(const items of [[{sku,quantity:1},{sku:'UNKNOWN',quantity:1}],[{sku,quantity:beforeRejected},{sku,quantity:1}]]){
  const rejected=await request(`${url}/orders`,'POST',{customerId:'reject-fixture',items});assert.ok([404,409].includes(rejected.status));assert.equal(await stock(),beforeRejected);
 }
 const shadow=await runShadowAudit(url,{samples:6,token:stack.token,paths:[`/inventory/${sku}`,`/orders/${first.body.id}`,`/orders/${second.body.id}`]});
 const gate=gatekeeper.evaluateDeliveryContract(contract,shadow);assert.equal(gate.gateApproved,true,JSON.stringify(gate));
 await gatekeeper.promoteToPhase2();assert.equal(await stock(),initial-5);assert.deepEqual((await create(2,"fixture-first")).body,first.body);assert.deepEqual((await create(3,"fixture-second")).body,second.body);assert.deepEqual(await order(first.body.id),first.body);assert.deepEqual(await order(second.body.id),second.body);
 assert.equal((await checked(`${url}/inventory/${sku}`)).servedBy,'inventory-go');
 const third=await create(4);assert.equal(await stock(),initial-9);
 const rollbackStart=performance.now();await gatekeeper.rollbackToPhase0();const rollbackMs=performance.now()-rollbackStart;
 assert.equal(await stock(),initial-9);assert.deepEqual((await create(3,"fixture-second")).body,second.body);assert.equal(await stock(),initial-9);for(const prior of [first,second,third])assert.deepEqual(await order(prior.body.id),prior.body);
 const fourth=await create(1);assert.equal(fourth.servedBy,'legacy-monolith');assert.equal(await stock(),initial-10);
 await gatekeeper.promoteToPhase2();assert.equal(await stock(),initial-10);for(const prior of [first,second,third,fourth])assert.deepEqual(await order(prior.body.id),prior.body);
 return {runId:stack.runId,contract,shadow,gate,rollbackMs,verifiedOrders:4,initialQuantity:initial,finalQuantity:await stock(),checks:['prior order IDs survive promotion and rollback','stock continuity across all three routes','multi-item and duplicate-SKU rejection is atomic','idempotency replay survives cutover and rollback without consuming stock twice','completed read-only shadow sample passes gate','healthy-service rollback and re-promotion preserve state'],limitations:['in-memory lab; no process-crash durability','service-direct writes bypass the gateway barrier','no production traffic, failure-rate or decommission certification','rollback requires reachable source services to transfer state']};
}
module.exports={runLifecycle};
