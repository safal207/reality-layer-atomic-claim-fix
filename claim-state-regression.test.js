'use strict';
// Regression contract: a durable claim is NOT proof of an external effect.
// These tests deliberately do not implement replay or provider reconciliation.
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const ledger=require('./action-ledger');
function fresh(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'claim-boundary-'));process.env.REALITY_LEDGER_DIR=d;return d;}
const device={id:'device-1',adapter_id:'mock'};
function ir(id,input={amount:100,currency:'USD'}) {
  return {id,target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input};
}
function errorCode(fn,code){
  assert.throws(fn,e=>e.code===code,'Expected '+code);
}
test('pre-claim is STARTED, not a receipt or stored replay result',()=>{
  fresh();const action=ir('order-A');
  const admitted=ledger.reserveIfAbsent(action,device);
  assert.equal(admitted.admitted,true);
  assert.equal(admitted.record.status,'STARTED');
  assert.equal(admitted.record.reconciliation.required,false);
  assert.equal(Object.hasOwn(admitted.record,'result'),false);
  let adapterDispatches=0;
  errorCode(()=>{ledger.reserveIfAbsent(action,device);adapterDispatches++;},'ACTION_ALREADY_RECORDED');
  assert.equal(adapterDispatches,0);
  const existing=ledger.get(action.id);
  assert.equal(existing.status,'STARTED');
  assert.equal(Object.hasOwn(existing,'result'),false);
});
test('SIGKILL after committed claim and BEFORE adapter dispatch stays UNKNOWN, never EXECUTED',()=>{
  const root=fresh(),worker=path.join(root,'claim-then-kill.js');
  fs.writeFileSync(worker,`
    const ledger=require(${JSON.stringify(path.join(__dirname,'action-ledger.js'))});
    const device={id:'device-1',adapter_id:'mock'};
    const action={id:'before-dispatch',target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input:{amount:100,currency:'USD'}};
    ledger.reserveIfAbsent(action,device);
    process.kill(process.pid,'SIGKILL');
  `);
  const result=spawnSync(process.execPath,[worker],{env:{...process.env,REALITY_LEDGER_DIR:root},timeout:15000});
  assert.equal(result.signal,'SIGKILL',result.stderr.toString());
  assert.equal(ledger.get('before-dispatch').status,'STARTED');
  const recovered=ledger.recoverInterrupted();
  assert.equal(recovered.length,1);
  assert.equal(recovered[0].status,'UNKNOWN');
  assert.equal(recovered[0].reconciliation.required,true);
  let dispatches=0;
  errorCode(()=>{ledger.reserveIfAbsent(ir('before-dispatch'),device);dispatches++;},'ACTION_ALREADY_RECORDED');
  assert.equal(dispatches,0);
  errorCode(()=>ledger.transition('before-dispatch','SUCCEEDED'), 'RECONCILIATION_REQUIRED');
  errorCode(()=>ledger.reconcileTrusted('before-dispatch',{outcome:'SUCCEEDED'}),'RECONCILIATION_REQUIRED');
  assert.equal(Object.hasOwn(ledger.get('before-dispatch'),'result'),false);
});
test('lost response after mock effect blocks retry without claiming stored-result replay',()=>{
  fresh();const action=ir('lost-ack');
  let dispatches=0;
  ledger.reserveIfAbsent(action,device);
  dispatches++; // mock external effect; acknowledgement does not survive
  ledger.transition(action.id,'UNKNOWN',{source:'mock-adapter',reason:'response_lost'});
  errorCode(()=>{ledger.reserveIfAbsent(action,device);dispatches++;},'ACTION_ALREADY_RECORDED');
  assert.equal(dispatches,1);
  assert.equal(ledger.get(action.id).status,'UNKNOWN');
  assert.equal(ledger.get(action.id).reconciliation.required,true);
  assert.equal(Object.hasOwn(ledger.get(action.id),'result'),false);
});
test('separate Action IR IDs with identical effect arguments represent separate operations',()=>{
  fresh();let dispatches=0;
  for(const id of ['order-1','order-2']){
    ledger.reserveIfAbsent(ir(id),device);
    dispatches++;
    ledger.transition(id,'SUCCEEDED',{source:'mock-adapter'});
  }
  assert.equal(dispatches,2);
  assert.equal(ledger.get('order-1').status,'SUCCEEDED');
  assert.equal(ledger.get('order-2').status,'SUCCEEDED');
  errorCode(()=>{ledger.reserveIfAbsent(ir('order-1'),device);dispatches++;},'ACTION_ALREADY_RECORDED');
  assert.equal(dispatches,2);
});
test('same ID with changed payload is CONFLICT, not REPLAY (including own __proto__ JSON)',()=>{
  fresh();const action=ir('order-X',JSON.parse('{"amount":100,"__proto__":{"to":"A"}}'));
  ledger.reserveIfAbsent(action,device);
  errorCode(()=>ledger.reserveIfAbsent(ir('order-X',JSON.parse('{"amount":100,"__proto__":{"to":"B"}}')),device),'ACTION_CONFLICT');
  errorCode(()=>ledger.reserveIfAbsent(ir('order-X',{amount:101}),device),'ACTION_CONFLICT');
  assert.equal(ledger.get('order-X').status,'STARTED');
});
