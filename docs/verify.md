# Receipt verification

A simulation receipt is a directory of three files:

```text
receipt.json
manifest.json
inputs.json
```

`inputs.json` is the raw simulator input. The receipt records hashes of that file, of the limits payload, of the market-snapshot rows, and of the simulator result. The check is verified and reproducible from those files.

`verifyReceipt` re-derives each hash, checks the manifest, and reruns the simulator on `inputs.json`. A match returns `VERIFIED`. A difference returns one precise mismatch per entry. It does not read the network and does not submit an order.

```bash
node --experimental-strip-types examples/verify-receipt.ts fixtures/receipts/good
```

To check every bundled fixture at once (`good` must be `VERIFIED`, each `tampered-*` must be `MISMATCH`):

```bash
node --experimental-strip-types examples/verify-all-fixtures.ts
```

## What is checked

| Check | Mismatch |
| --- | --- |
| Receipt version `1` or `2`, kind, label, and the statement `verified and reproducible` | `version mismatch`, `kind mismatch`, `label mismatch`, `statement mismatch` |
| SHA-256 of the limits payload | `limits_hash mismatch` |
| SHA-256 of the market-snapshot rows | `market_snapshot_id mismatch` |
| SHA-256 of `inputs.json` | `data_snapshot_id mismatch` |
| SHA-256 of `manifest.json` | `manifest_sha256 mismatch` |
| SHA-256 of the stored simulator result | `result_sha256 mismatch` |
| Simulator run on the raw inputs | `result.<path> mismatch` |
| Frozen limits on that same run | `guard mismatch: <code>` |

The limits payload is the same object the owner limits hash. The market-snapshot id is the hash of the coin rows. The data snapshot id is the hash of the raw input bytes.

Receipt version `2` stores the execution-cost breakdown on the simulator result. `result_sha256` is the hash of that result, so the breakdown is inside the hashed receipt. Version `1` receipts stay verifiable. The checker drops the breakdown from the rerun before it compares a version `1` result.

## TypeScript

```typescript
import { verifyReceipt } from "@perpbrain/sdk";

const report = verifyReceipt(receipt, manifestBytes, inputsBytes);
report.status; // "VERIFIED" or "MISMATCH"
```

## Browser

`verify/web/index.html` is a static page. Drop `receipt.json` and `manifest.json` on it. The page hashes them with WebCrypto SHA-256 and compares the snapshot ids. It has no backend and does not upload the files. The simulator rerun stays in `verifyReceipt`.

## Card

`renderReceiptCard` in the SDK draws a static SVG from a verified receipt. It shows the `SIMULATED` label, the receipt hash, the limits preset and the loosened flag, `NOT_MODELLED` items, and the execution-cost section. There is no profit headline. The footer is `Simulated. Limits you set; losses are still possible.`

## Fixtures

| Directory | Expected |
| --- | --- |
| `fixtures/receipts/good` | `VERIFIED` |
| `fixtures/receipts/tampered-limits-hash` | `limits_hash mismatch` |
| `fixtures/receipts/tampered-snapshot-id` | `market_snapshot_id mismatch` |
| `fixtures/receipts/tampered-result` | `result_sha256 mismatch` |
| `fixtures/receipts/tampered-data` | `data_snapshot_id mismatch` |
| `fixtures/receipts/tampered-manifest` | `manifest_sha256 mismatch` |
