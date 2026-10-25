'use strict';
const { executeThroughAdapter } = require('./adapters');
const { validateActionIR, actionIRToLegacy } = require('./action-ir');
const { syncDeviceState } = require('./state-store');
const { appendEvent } = require('./event-store');
const ledger = require('./action-ledger');

function execute(device, capabilityOrIR, args = {}) {
  let capability=capabilityOrIR, actualArgs=args, actionIR=null;
  if (capabilityOrIR && typeof capabilityOrIR === 'object' && capabilityOrIR.schema) {
    actionIR=capabilityOrIR;
    validateActionIR(actionIR,device);
    const legacy=actionIRToLegacy(actionIR,device);
    capability=legacy.capability; actualArgs=legacy.args;
  }
  if (actionIR) {
    const existing=ledger.get(actionIR.id);
    if(existing){
      const error=new Error(`Action ${actionIR.id} already exists with outcome ${existing.status}; refusing redispatch`);
      error.code='ACTION_ALREADY_RECORDED';error.action=existing;throw error;
    }
    ledger.start(actionIR, device);
  }
  let dispatchStarted=false;
  try {
    // Once the adapter boundary is crossed, a thrown error is ambiguous unless the adapter explicitly proves no dispatch occurred.
    dispatchStarted=true;
    const result = executeThroughAdapter(device, capability, actualArgs);
    if (result && typeof result.then === 'function') {
      return result.then(value => trace(device, capability, actualArgs, value, actionIR)).catch(error => { recordFailure(actionIR,error,{dispatchStarted}); throw error; });
    }
    return trace(device, capability, actualArgs, result, actionIR);
  } catch (error) { recordFailure(actionIR,error,{dispatchStarted}); throw error; }
}

function recordFailure(actionIR,error,{dispatchStarted=false}={}) {
  if (!actionIR) return;
  const definitelyNotExecuted = error?.executionNotStarted === true;
  const unknown = error?.executionOutcomeUnknown === true || (dispatchStarted && !definitelyNotExecuted);
  const reason=unknown?'post_dispatch_outcome_uncertain':'execution_failed_before_dispatch';
  ledger.transition(actionIR.id, unknown ? 'UNKNOWN' : 'FAILED', { source:'executor', error:String(error?.message || error), dispatch_started:dispatchStarted, outcome_unknown:unknown, reason });
  appendEvent({ type:unknown?'action.outcome.unknown':'action.outcome.failed', source:'executor', actor_id:actionIR?.provenance?.actor_id || null, target_id:actionIR.id, payload:{ action_id:actionIR.id, error:String(error?.message || error), dispatch_started:dispatchStarted, outcome_unknown:unknown } });
}

function trace(device, capability, args, result, actionIR=null) {
  const currentState = result?.state || device.state || {};
  syncDeviceState(device.id, currentState, 'adapter');
  if (actionIR) ledger.transition(actionIR.id, result?.outcome === 'unknown' ? 'UNKNOWN' : 'SUCCEEDED', { source:'adapter', adapter_id:device.adapter_id, native_trace:result?.native_trace || null, reason:result?.outcome === 'unknown' ? 'adapter_reported_unknown' : null });
  appendEvent({
    type:'device.action.executed',
    source:'executor',
    actor_id:actionIR?.provenance?.actor_id || null,
    target_id:device.id,
    payload:{ capability, args, action_ir:actionIR, state:currentState, adapter_id:device.adapter_id },
  });
  return {
    ...currentState,
    gateway_trace: {
      action_id: actionIR?.id || null,
      outcome: actionIR ? ledger.get(actionIR.id)?.status : 'SUCCEEDED',
      action_ir: actionIR,
      compatibility_bridge: actionIR ? { legacy_capability:capability, legacy_args:args } : null,
      unified_action: { device: device.id, capability, args },
      adapter_id: device.adapter_id,
      native_trace: result?.native_trace,
      state_store_synced:true,
      event_recorded:true,
    },
  };
}

module.exports = { execute };
