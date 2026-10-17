# Contributing

Thanks for helping. This repository is read-only and simulation-only. Do not add an order client, a mainnet exchange URL, or a path that submits an order.

These are limits you set; losses are still possible. Simulation output stays labelled `SIMULATED`. Receipts are described as verified and reproducible.

## Wording

Docs and examples use those phrases. Do not add a grade claim, a trading-result claim, or a performance claim.

## Checks

With Node 22:

```bash
(cd sdk && npm ci && npm run typecheck && npm run build)
(cd ts/mcp-server && npm ci && npm run lint && npm run typecheck && npm test)
ts/mcp-server/node_modules/.bin/tsc -p examples/tsconfig.json
for f in examples/*.ts; do node --experimental-strip-types "$f"; done
```

`ts/mcp-server/src/sdkVendor.test.ts` checks that `sdk/src/vendor/` matches the read and simulation sources in `ts/mcp-server/src/`. Change both copies together.

## Review

A change to CI, guard code, or a dependency file waits for owner review. Do not add a dependency without confirming it on the registry. Do not weaken, delete, or skip a test. Never commit a key, a wallet, a seed phrase, or a private account address.
