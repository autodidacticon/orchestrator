## Why

state-backend "Storable ids" lists the entry points that refuse an id holding a NUL character or a lone UTF-16 surrogate before anything is written: graph load, `POST /v1/claims` and `POST /v1/attachments`. #30 added `POST /v1/verify/claims`, which refuses its `verifierId` the same way (`assertStorableId('verifierId', verifierId)` in `src/verify/claims.ts`, and verifier-pool "Verify claim: refusals"), but "Storable ids" was not updated, so its list is incomplete (#181).

## What Changes

- state-backend "Storable ids" adds `POST /v1/verify/claims` (`verifierId`) to its entry points. Nothing else in the requirement changes; both scenarios are restated word for word.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `state-backend`: MODIFIED "Storable ids" (one added entry point).

## Impact

- Spec only. The code already refuses such a `verifierId` before anything is written; no code or test changes.
