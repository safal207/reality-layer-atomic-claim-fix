'use strict';
// Test the pinned upstream executor code, replacing only its ledger and adapter imports.
// Source: shimjaemandu/reality-layer @ 4213c479bd9333558522db1ca820d657b99effbf
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const vm=require('node:vm');
const ledger=require('./action-ledger');
const pinned='4213c479bd9333558522db1ca820d657b99effbf';
const upstream=path.join(__dirname,'fixtures','executor-'+pinned+'.js');
const source=fs.readFileSync(upstream,'utf8');
const old=`    const existing=ledger.get(actionIR.id);
    if(existing){
      const error=new Error(\`Action \${actionIR.id} already exists with outcome \${existing.status}; refusing redispatch\`);
      error.code='ACTION_ALREADY_RECORDED';error.action=existing;throw error;
    }
    ledger.start(actionIR, device);`;
assert.ok(source.includes(old),'Pinned upstream executor changed: patch must be reviewed');
const patched=source.replace(old,'    ledger.reserveIfAbsent(actionIR, device);');
function makeExecutor(dispatch) {
  const exports={};
  const requireMock=(id)=>{
    if(id==='./adapters')return {executeThroughAdapter:dispatch};
    if(id==='./action-ir')return {validateActionIR:()=>{},actionIRToLegacy:()=>({capability:'charge',args:{amount:100}})};
    if(id==='./state-store')return {syncDeviceState:()=>{}};
    if(id==='./event-store')return {appendEvent:()=>{}};
    if(id==='./action-ledger')return ledger;
    throw new Error('Unexpected import '+id);
  };
  vm.runInNewContext('(function(require,module){'+patched+'})',{},{filename:upstream})(requireMock,{exports});
  // vm wrapper returns a new module; use it explicitly below.
}
function executor(dispatch){
 const module={exports:{}};
 const requireMock=(id)=>{
  if(id==='./adapters')return {executeThroughAdapter:dispatch};
  if(id==='./action-ir')return {validateActionIR:()=>{},actionIRToLegacy:()=>({capability:'charge',args:{amount:100}})};
  if(id==='./state-store')return {syncDeviceState:()=>{}};
  if(id==='./event-store')return {appendEvent:()=>{}};
  if(id==='./action-ledger')return ledger;
  throw Error('Unexpected import '+id);
 };
 vm.runInNewContext('(function(require,module){'+patched+'})',{}, {filename:upstream})(requireMock,module);
 return module.exports.execute;
}
test('pinned upstream executor calls adapter once across repeated Action ID',()=>{
 process.env.REALITY_LEDGER_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'pinned-executor-'));
 let calls=0;
 const execute=executor(()=>{calls++;return {state:{ok:true},native_trace:'mock-only'};});
 const device={id:'device-1',adapter_id:'mock',state:{}};
 const ir={schema:'test',id:'same-action',target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input:{amount:100}};
 execute(device,ir);
 assert.throws(()=>execute(device,ir),{code:'ACTION_ALREADY_RECORDED'});
 assert.equal(calls,1);
 assert.equal(ledger.get(ir.id).status,'SUCCEEDED');
});

function freshPinned(){process.env.REALITY_LEDGER_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'pinned-boundary-'));}
function pinnedDevice(){return {id:'device-1',adapter_id:'mock',state:{}};}
function pinnedIR(id,input={amount:100}){return {schema:'test',id,target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input};}

test('pinned executor: pre-claim without dispatch is not reported as executed or replayable',()=>{
  freshPinned();
  let dispatches=0;
  const action=pinnedIR('preclaim-only');
  ledger.reserveIfAbsent(action,pinnedDevice());
  const execute=executor(()=>{dispatches++;return {state:{ok:true}};});
  assert.throws(()=>execute(pinnedDevice(),action),{code:'ACTION_ALREADY_RECORDED'});
  assert.equal(dispatches,0);
  assert.equal(ledger.get(action.id).status,'STARTED');
  assert.equal(Object.hasOwn(ledger.get(action.id),'result'),false);
  assert.equal(ledger.recoverInterrupted()[0].status,'UNKNOWN');
  assert.throws(()=>execute(pinnedDevice(),action),{code:'ACTION_ALREADY_RECORDED'});
  assert.equal(dispatches,0);
});

test('pinned executor: lost adapter acknowledgement becomes UNKNOWN and retry never redispatches',()=>{
  freshPinned();
  let dispatches=0;
  const action=pinnedIR('lost-ack');
  const execute=executor(()=>{dispatches++;throw new Error('response lost after possible external effect');});
  assert.throws(()=>execute(pinnedDevice(),action),/response lost/);
  assert.equal(dispatches,1);
  assert.equal(ledger.get(action.id).status,'UNKNOWN');
  assert.equal(ledger.get(action.id).reconciliation.required,true);
  assert.throws(()=>execute(pinnedDevice(),action),{code:'ACTION_ALREADY_RECORDED'});
  assert.equal(dispatches,1);
});

test('pinned executor: independent Action IDs with identical arguments dispatch independently',()=>{
  freshPinned();
  let dispatches=0;
  const execute=executor(()=>{dispatches++;return {state:{ok:true}};});
  execute(pinnedDevice(),pinnedIR('business-A'));
  execute(pinnedDevice(),pinnedIR('business-B'));
  assert.equal(dispatches,2);
  assert.equal(ledger.get('business-A').status,'SUCCEEDED');
  assert.equal(ledger.get('business-B').status,'SUCCEEDED');
});

test('pinned executor: changed effect parameters for same Action ID cause CONFLICT',()=>{
  freshPinned();
  let dispatches=0;
  const execute=executor(()=>{dispatches++;return {state:{ok:true}};});
  execute(pinnedDevice(),pinnedIR('same-id',{amount:100}));
  assert.throws(()=>execute(pinnedDevice(),pinnedIR('same-id',{amount:101})),{code:'ACTION_CONFLICT'});
  assert.equal(dispatches,1);
});
