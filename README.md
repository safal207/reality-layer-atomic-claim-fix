# Reality Layer — Atomic Action IR Claim (QA prototype)

Independent security/QA prototype for `shimjaemandu/reality-layer` at commit [`4213c479bd9333558522db1ca820d657b99effbf`](https://github.com/shimjaemandu/reality-layer/commit/4213c479bd9333558522db1ca820d657b99effbf).

## Problem

The reference runtime checks `ledger.get(id)` and calls `ledger.start()` separately. Concurrent processes can pass the check and dispatch the same external effect more than once. A ledger file containing one row is **not** evidence of one external dispatch.

## Proposed approach

- SQLite `BEGIN IMMEDIATE` reservation with unique `action_id`.
- Bind identity to a versioned canonical request fingerprint; changed parameters return `ACTION_CONFLICT`.
- Block exact retries before adapter dispatch (`ACTION_ALREADY_RECORDED`).
- Never silently evict old IDs or release unresolved effects.
- Preserve `UNKNOWN / RECONCILIATION_REQUIRED` until authoritative provider-bound reconciliation.

## Local evidence (2026-10-25)

Node.js 22.16.0: `node --test atomic-ledger.test.js` — **4/4 passed** on the local prototype; 50 independent processes produced **1 admitted reservation, 49 duplicate refusals**. These tests cover ledger reservation, **not** full executor/adapter dispatch. The prototype implementation and test sources still need to be uploaded to this repository; do not treat this README as an independently runnable test package.

## Known gaps

Legacy JSON-ledger migration; end-to-end adapter dispatch and crash tests; stored-result replay; provider-specific authoritative reconciliation; cross-language receipt canonicalization; production adoption. No universal exactly-once or generic multi-process safety claim.

Related discussion: https://github.com/crewAIInc/crewAI/issues/5802
