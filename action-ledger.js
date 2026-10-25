'use strict';
// Prototype replacement for src/action-ledger.js, Node >=22.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ROOT = path.join(__dirname, '..');
const DIR = process.env.REALITY_LEDGER_DIR || path.join(ROOT, 'data');
const DBFILE = path.join(DIR, 'action-ledger.sqlite');
const LEGACY = path.join(DIR, 'action-ledger.json');
const STATES = new Set(['STARTED','SUCCEEDED','FAILED','UNKNOWN']);
const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
function fail(code, message, action) { const e = new Error(message); e.code = code; if(action) e.action=action; throw e; }
function canonical(v) {
  if(v === null) return 'null';
  if(typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if(typeof v === 'number') { if(!Number.isFinite(v)) fail('ACTION_INVALID_INPUT','Non-finite number'); return JSON.stringify(v); }
  if(Array.isArray(v)) { if(Object.keys(v).length !== v.length) fail('ACTION_INVALID_INPUT','Sparse or extended array'); return '['+v.map(canonical).join(',')+']'; }
  if(typeof v === 'object' && v && (Object.getPrototypeOf(v)===Object.prototype || Object.getPrototypeOf(v)===null)) {
    return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}';
  }
  fail('ACTION_INVALID_INPUT','Unsupported effect input type');
}
function request(ir,device) { return {target:ir.target||{}, capability:ir.capability||{}, operation:ir.operation||null,input:ir.input||{},compatibility:ir.compatibility||{},device_id:device?.id||null,adapter_id:device?.adapter_id||null}; }
function fingerprint(ir,device) { return 'sha256:canonical-json-v1:'+crypto.createHash('sha256').update(canonical(request(ir,device))).digest('hex'); }
function db() {
  fs.mkdirSync(DIR,{recursive:true});
  if(fs.existsSync(LEGACY) && !fs.existsSync(DBFILE)) fail('ACTION_LEDGER_MIGRATION_REQUIRED','Legacy ledger present: migrate before starting');
  const d=new DatabaseSync(DBFILE); d.exec('PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  d.exec(`CREATE TABLE IF NOT EXISTS actions (action_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, record_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  return d;
}
function transaction(fn) { const d=db(); try { d.exec('BEGIN IMMEDIATE'); const out=fn(d); d.exec('COMMIT'); return out; } catch(e) { try{d.exec('ROLLBACK');}catch{} throw e; } finally {d.close();} }
function row(d,id) { const r=d.prepare('SELECT record_json,fingerprint FROM actions WHERE action_id=?').get(id); return r?{record:JSON.parse(r.record_json),fingerprint:r.fingerprint}:null; }
function save(d,r,fp) { d.prepare('INSERT INTO actions(action_id,fingerprint,status,record_json) VALUES(?,?,?,?) ON CONFLICT(action_id) DO UPDATE SET status=excluded.status,record_json=excluded.record_json').run(r.action_id,fp,r.status,JSON.stringify(r)); }
function reconciliationFor(status,reason=null) {return {required:status==='UNKNOWN',state:status==='UNKNOWN'?'REQUIRED':'NOT_REQUIRED',reason:status==='UNKNOWN'?(reason||'execution_outcome_uncertain'):null};}
function reserveIfAbsent(ir,device) {
  if(typeof ir?.id!=='string'||!ir.id) fail('ACTION_INVALID_ID','Action ID required');
  const fp=fingerprint(ir,device);
  return transaction(d=>{
    const old=row(d,ir.id);
    if(old) { if(old.fingerprint!==fp) fail('ACTION_CONFLICT',`Changed parameters for ${ir.id}`,old.record); fail('ACTION_ALREADY_RECORDED',`Action ${ir.id} already recorded`,old.record); }
    const now=new Date().toISOString();
    const r={schema:'reality-action-outcome/1.1',action_id:ir.id,fingerprint:fp,status:'STARTED',attempt:1,created_at:now,updated_at:now,target_id:device?.id||ir?.target?.device_id||null,provenance:clone(ir.provenance||{}),request:clone(request(ir,device)),reconciliation:reconciliationFor('STARTED'),evidence:[]};
    save(d,r,fp);return {admitted:true,record:clone(r)};
  });
}
function get(id) {const d=db();try{return clone(row(d,id)?.record||null);}finally{d.close();}}
function transition(id,status,evidence={}) {
  if(!STATES.has(status)) fail('ACTION_INVALID_STATUS','Invalid action status');
  return transaction(d=>{const old=row(d,id);if(!old) fail('ACTION_NOT_FOUND','Action not found');const r=old.record;
    if(r.status==='SUCCEEDED'||r.status==='FAILED') {if(r.status!==status) fail('ACTION_TERMINAL','Terminal action cannot change');return clone(r);}
    if(r.status==='UNKNOWN' && status!=='UNKNOWN') fail('RECONCILIATION_REQUIRED','UNKNOWN cannot be resolved without provider authority');
    r.status=status;r.updated_at=new Date().toISOString();r.reconciliation=reconciliationFor(status,evidence?.reason);r.evidence.push({at:r.updated_at,...clone(evidence)});save(d,r,old.fingerprint);return clone(r);
  });
}
function addEvidence(id,evidence={}) {return transaction(d=>{const old=row(d,id);if(!old)fail('ACTION_NOT_FOUND','Action not found');const r=old.record;r.updated_at=new Date().toISOString();r.evidence.push({at:r.updated_at,...clone(evidence)});save(d,r,old.fingerprint);return clone(r);});}
function recoverInterrupted() {return transaction(d=>{const recovered=[];for(const x of d.prepare("SELECT action_id FROM actions WHERE status='STARTED'").all()) {const old=row(d,x.action_id);const r=old.record;r.status='UNKNOWN';r.updated_at=new Date().toISOString();r.reconciliation=reconciliationFor('UNKNOWN','runtime_interrupted_before_terminal_outcome');r.evidence.push({at:r.updated_at,source:'runtime-recovery',reason:'runtime_interrupted_before_terminal_outcome',outcome_unknown:true});save(d,r,old.fingerprint);recovered.push(clone(r));}return recovered;});}
function list(limit=50) {const d=db();try{return d.prepare('SELECT record_json FROM actions ORDER BY rowid DESC LIMIT ?').all(Math.max(1,Math.min(200,Number(limit)||50))).map(x=>JSON.parse(x.record_json));}finally{d.close();}}
function reconcileTrusted() {fail('RECONCILIATION_REQUIRED','No authoritative provider verifier is implemented');}
function start() {fail('ACTION_UNSAFE_API','Use reserveIfAbsent; start is unsafe');}
function reset() {fail('ACTION_UNSAFE_API','Destructive ledger reset disabled');}
module.exports={reserveIfAbsent,fingerprint,canonical,start,transition,recoverInterrupted,get,list,addEvidence,reconcileTrusted,reset};
