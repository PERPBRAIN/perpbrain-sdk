# @perpbrain/sdk

TypeScript SDK for PERPBRAIN. It exports the public info-endpoint reads, the book simulator, the owner limits (`conservative`, `standard`, `pro`), the kill-switch latch, the execution-cost breakdown, and the receipt verifier. These are limits you set; losses are still possible.

It is read-only and simulation-only. Receipts are verified and reproducible. This package is `0.1.0-rc1` and `private`, so it is not on npm yet.

## Install from this repository

```bash
cd sdk
npm ci
npm run build
```

Simulation output is labelled `SIMULATED`. It is not advice and it does not place a live order.
