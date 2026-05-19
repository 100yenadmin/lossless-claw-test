---
"@martian-engineering/lossless-claw": patch
---

Remove a stale stable-orphan invalidation call from afterTurn placeholder-checkpoint recovery. Stable orphan stripping was removed with the cache-state-dependent assembly path, but the placeholder recovery branch still referenced the deleted method and could throw `clearStableOrphanStrippingOrdinal is not a function` during transcript reconcile.
