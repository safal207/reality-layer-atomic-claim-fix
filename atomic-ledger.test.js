'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const ledger=require('./action-ledger');
const device={id:'device-1',adapter_id:'mock'};
function ir(id,input={amount:1}) {return {id,target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input};}
function temp() {return fs.mkdtempSync(path.join(os.tmpdir(),'reality-ledger-test-'));}
test('exact retry blocked; changed params conflict; unknown stays unknown',()=>{
  process.env.REALITY_LEDGER_DIR=temp();const id='case-a';ledger.reserveIfAbsent(ir(id),device);
  assert.throws(()=>ledger.reserveIfAbsent(ir(id),device),{code:'ACTION_ALREADY_RECORDED'});
  assert.throws(()=>ledger.reserveIfAbsent(ir(id,{amount:2}),device),{code:'ACTION_CONFLICT'});
  assert.equal(ledger.recoverInterrupted()[0].status,'UNKNOWN');
  assert.throws(()=>ledger.transition(id,'SUCCEEDED'),{code:'RECONCILIATION_REQUIRED'});
  assert.throws(()=>ledger.reserveIfAbsent(ir(id),device),{code:'ACTION_ALREADY_RECORDED'});
});
test('prototype-named property is bound to fingerprint',()=>{
  assert.notEqual(ledger.fingerprint(ir('x',JSON.parse('{"__proto__":{"target":"A"}}')),device),ledger.fingerprint(ir('x',JSON.parse('{"__proto__":{"target":"B"}}')),device));
});
test('50 independent processes: exactly one reservation',()=>{
  const dir=temp();const script=path.join(dir,'worker.js');
  fs.writeFileSync(script,`process.env.REALITY_LEDGER_DIR=${JSON.stringify(dir)};const l=require(${JSON.stringify(path.join(__dirname,'action-ledger.js'))});try{l.reserveIfAbsent({id:'race',target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input:{amount:1}},{id:'device-1',adapter_id:'mock'});process.stdout.write('ADMITTED')}catch(e){process.stdout.write(e.code||'ERROR')}`);
  const shell=`for i in $(seq 1 50); do node '${script}' > '${dir}/out.'$i 2> '${dir}/err.'$i & done; wait`;
  const result=spawnSync('bash',['-c',shell],{timeout:120000});assert.equal(result.status,0);
  const values=Array.from({length:50},(_,i)=>fs.readFileSync(path.join(dir,`out.${i+1}`),'utf8'));
  assert.equal(values.filter(x=>x==='ADMITTED').length,1,JSON.stringify(values));
  assert.equal(values.filter(x=>x==='ACTION_ALREADY_RECORDED').length,49,JSON.stringify(values));
});
test('old IDs are not evicted after 600 terminal records',()=>{
  process.env.REALITY_LEDGER_DIR=temp();for(let i=0;i<600;i++){ledger.reserveIfAbsent(ir('id-'+i),device);ledger.transition('id-'+i,'SUCCEEDED');}
  assert.throws(()=>ledger.reserveIfAbsent(ir('id-0'),device),{code:'ACTION_ALREADY_RECORDED'});
});
