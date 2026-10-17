# Security

Report a vulnerability to [info@perpbrain.com](mailto:info@perpbrain.com). Please include the version or commit, the command you ran, and what you observed. Do not include exchange keys, wallets, or seed phrases.

There is no mainnet order path in this repository. Do not send a key so that someone can reproduce a report.

## Scope

In scope: the read client, the simulator, the owner limits and kill switch, the MCP handler, the receipt verifier, and the browser checker in `verify/web/`.

These are limits you set; losses are still possible. A limit is not a promise that a simulation matches a live fill.

Out of scope: a live exchange account, a wallet, and any service this repository does not run.

## Disclosure

We will acknowledge a report sent to that address. Please give us time to fix a confirmed issue before describing it in public. Simulation output is labelled `SIMULATED`. It is not advice.
