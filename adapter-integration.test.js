'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const ledgerPath=path.join(__dirname,'action-ledger.js');
const dir=()=>fs.mkdtempSync(path.join(os.tmpdir(),'reality-adapter-'));
function workerScript(root,mode) {
  const script=path.join(root,'worker.js');
  fs.writeFileSync(script,`
const fs=require('node:fs');
const ledger=require(${JSON.stringify(ledgerPath)});
const id='same-action';const device={id:'device-1',adapter_id:'mock'};
const ir={id,target:{device_id:'device-1'},capability:{name:'charge'},operation:'execute',input:{amount:100,currency:'USD'}};
try {
  // No adapter call is permitted before the committed claim.
  ledger.reserveIfAbsent(ir,device);
  fs.appendFileSync(process.env.EFFECT_LOG,'dispatch\\n');
  if(process.env.MODE==='crash') {process.kill(process.pid,'SIGKILL');}
  ledger.transition(id,'SUCCEEDED',{source:'mock-adapter',receipt:'local-only'});
  process.stdout.write('ADMITTED');
} catch(e) {process.stdout.write(e.code||'ERROR');process.exitCode=e.code==='ACTION_ALREADY_RECORDED'?0:2;}
`);
  return script;
}
test('50 competing executor workers dispatch the mock adapter once',()=>{
  const root=dir(),script=workerScript(root),effects=path.join(root,'effects.log');
  const shell=`for i in $(seq 1 50); do REALITY_LEDGER_DIR='${root}' EFFECT_LOG='${effects}' node '${script}' > '${root}/out.'$i 2> '${root}/err.'$i & done; wait`;
  const r=spawnSync('bash',['-c',shell],{timeout:120000});assert.equal(r.status,0);
  const statuses=Array.from({length:50},(_,i)=>fs.readFileSync(path.join(root,`out.${i+1}`),'utf8'));
  assert.equal(statuses.filter(x=>x==='ADMITTED').length,1,JSON.stringify(statuses));
  assert.equal(statuses.filter(x=>x==='ACTION_ALREADY_RECORDED').length,49,JSON.stringify(statuses));
  assert.equal(fs.readFileSync(effects,'utf8').trim().split(String.fromCharCode(10)).length,1);
});
test('SIGKILL after mock dispatch is recovered as UNKNOWN and retry does not redispatch',()=>{
  const root=dir(),script=workerScript(root),effects=path.join(root,'effects.log');
  const env={...process.env,REALITY_LEDGER_DIR:root,EFFECT_LOG:effects,MODE:'crash'};
  const killed=spawnSync(process.execPath,[script],{env,timeout:15000});
  assert.equal(killed.signal,'SIGKILL');
  assert.equal(fs.readFileSync(effects,'utf8').trim(),'dispatch');
  process.env.REALITY_LEDGER_DIR=root;
  const ledger=require('./action-ledger');
  assert.equal(ledger.recoverInterrupted().length,1);
  assert.equal(ledger.get('same-action').status,'UNKNOWN');
  const retry=spawnSync(process.execPath,[script],{env:{...env,MODE:'normal'},timeout:15000});
  assert.equal(retry.stdout.toString(),'ACTION_ALREADY_RECORDED');
  assert.equal(fs.readFileSync(effects,'utf8').trim(),'dispatch');
});
