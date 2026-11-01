# Reality Layer — Atomic Action IR Claim (bounded QA prototype)

Independent, testable security/QA prototype for `shimjaemandu/reality-layer` at the **pinned** commit [`4213c479bd9333558522db1ca820d657b99effbf`](https://github.com/shimjaemandu/reality-layer/commit/4213c479bd9333558522db1ca820d657b99effbf).

## Defect and fix boundary

The original `src/executor.js` checks `ledger.get(id)` and then separately calls `ledger.start()`. Two independent processes can both pass this check before calling the adapter. The published `executor-integration.patch` replaces those calls with a single committed SQLite `reserveIfAbsent(actionIR, device)` reservation.

This repository contains the **proposed** ledger and a pinned executor fixture, **not a merge into the upstream runtime**. A single durable claim is admission to attempt dispatch, **not proof of an external effect or a completed receipt**.

The local ledger uses:
- `BEGIN IMMEDIATE` and a primary key on `action_id` to admit at most one reservation on the tested SQLite setup;
- a versioned canonical effect-request fingerprint, with `ACTION_CONFLICT` on changed effect-bearing parameters (including own `__proto__` JSON properties);
- `ACTION_ALREADY_RECORDED` on same-ID retry, without another adapter dispatch;
- a fail-closed `UNKNOWN` state after crashes/uncertain outcomes; no automatic retries, resetting, or terminal overwrite;
- retained identity rows, without count-based tombstone eviction.

**Different Action IR IDs** are treated as different authorized operations even when their arguments are identical. The caller is responsible for assigning stable IDs for retries and distinct IDs for independent effects.

## Verified test evidence — 2026-11-01

[GitHub Actions run #41289965464](https://github.com/safal207/reality-layer-atomic-claim-fix/actions/runs/41289965464) on Node.js 22: **16 passed, 0 failed**. [PR #1](https://github.com/safal207/reality-layer-atomic-claim-fix/pull/1) was merged after this successful PR-run.

Run the same suite locally (Node.js 22+, Linux/bash for the 50-process workers):

```bash
node --test atomic-ledger.test.js adapter-integration.test.js claim-state-regression.test.js pinned-executor.test.js
```

Coverage includes **50 separate processes** with exactly one admitted reservation and one mock adapter dispatch; both **SIGKILL before dispatch** and **SIGKILL after mock dispatch**; `UNKNOWN` preserved and non-replayable; changed input `ACTION_CONFLICT`; two different Action IR IDs producing two legitimate dispatches; and the adapted **pinned upstream executor** exercised with mock imports.

The pinned executor test applies the same targeted code replacement in memory; it does not install the patch into upstream or exercise a real payment/email/trading provider. The current SQLite implementation uses the experimental Node.js `node:sqlite` API.

## Explicit non-guarantees

| Property | Status |
| --- | --- |
| Same Action IR ID, same request, zero extra adapter calls in tested mock scenarios | **Verified** |
| Same Action IR ID, changed effect-bearing request => `ACTION_CONFLICT` | **Verified** |
| `STARTED`/pre-claim is evidence of execution | **No** |
| Crash/unknown outcome can be authoritatively reconciled with a provider | **Not implemented** |
| Successful original result can be safely replayed from durable storage | **Not implemented** |
| Production integration of the replacement ledger into upstream Reality Layer/CrewAI | **Not established** |
| Universal exactly-once or cross-host/multi-filesystem safety | **Not established** |

A safe stored-result replay would require a **durable original result bound to the exact action identity and fingerprint**. `UNKNOWN` cannot be promoted to success merely because a pre-claim exists; provider-specific, action-bound, authoritative evidence is needed. This prototype deliberately does not provide such a verifier.

## Remaining engineering work

Legacy JSON-ledger migration with preserved tombstones, formal transition/state-machine proof, actual runtime adapter integration, provider-specific reconciliation, stored-result replay contract and verified end-to-end receipts, cross-language canonicalization vectors, supported SQLite runtime and deployment constraints.

Related discussions: [CrewAI #5802](https://github.com/crewAIInc/crewAI/issues/5802), [PR #6048](https://github.com/crewAIInc/crewAI/pull/6048), [PR #5822](https://github.com/crewAIInc/crewAI/pull/5822).
