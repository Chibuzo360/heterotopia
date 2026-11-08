# Heterotopia ("heto")

A startup that runs itself on NEAR testnet. A founder creates a startup, investors buy tiered share NFTs, the team holds soulbound role NFTs, AI agents work for the holders under hard spending limits, customers pay for jobs through escrow, and revenue is split automatically into buckets that holders claim.

**This is a labeled testnet simulation.** No real funds are involved. `DRY_RUN=true` is the default: the agent's "work" (a trading-signal text) is generated locally and is not real advice. Only the reference price comes from a live source (NEAR Intents 1Click `dry: true` quote, read-only).

Built at NEAR HACKATHON 2026. Licence: MIT.

## The problem

Giving an AI agent money normally means giving it a key that can do anything. Heterotopia gives agents a key that can only call two methods on one contract, and puts every other rule (caps, allowed payees, probation, kill switch) inside that contract, where the agent cannot argue with it.

## Live deployment (testnet)

| Item | Value |
| --- | --- |
| Contract | `heto2-bybyte.testnet` |
| Platform fee account | `heto-fee-account.testnet` |
| Demo agent | `agent1.heto2-bybyte.testnet` (function-call key only) |
| Network | NEAR testnet |

## Try it (no keys needed)

Each step is "do X, see Y". Replace `RPC` with `https://rpc.testnet.near.org`. Arguments are base64 JSON.

1. **Do:** run the contract's tests. `cd contracts && cargo test`. **See:** 159 tests pass (money split, escrow, refunds, agent limits, private results).
2. **Do:** run the agent library's tests. `cd agents && npm install && npm test`. **See:** 25 tests pass (look-alike payee guard, encryption round trip, quote parsing).
3. **Do:** read the agent's track record from the live contract:
   ```
   curl -sS RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"heto2-bybyte.testnet","method_name":"get_agent_reputation","args_base64":"eyJhY2NvdW50X2lkIjoiYWdlbnQxLmhldG8yLWJ5Ynl0ZS50ZXN0bmV0In0K"}}'
   ```
   **See:** a `result` byte array. It decodes to JSON with `spends_ok`, `spends_refused`, `total_spent`, `times_paused`, `times_removed`. Refused spends are counted, not hidden.
4. **Do:** read a finished job (id 7) the same way, `method_name` `get_job`, `args_base64` `eyJqb2JfaWQiOjd9Cg==`. **See:** status `Paid`, and a result that starts with `v1:`. That is ciphertext. Anyone can read it on chain; only the customer's key opens it.
5. **Do:** read startup 6, `method_name` `get_startup`, `args_base64` `eyJzdGFydHVwX2lkIjo2fQo=`. **See:** the revenue buckets (shareholders, agent budget, operations) matching the split below.
6. **Do:** open the transactions listed under "Evidence" below in the NEAR testnet explorer. **See:** the real calls on chain.

### Run the full flow yourself (needs your own testnet funds)

The end-to-end script creates demo accounts, so it needs a funder account with about 10 testnet NEAR whose key is in `~/.near-credentials/testnet/`. Deploy your own copy of the contract first (`cd contracts && RUSTUP_TOOLCHAIN=stable cargo near build non-reproducible-wasm`, then deploy and call `new`), set `FUNDER_ID` and `CONTRACT_ID`, then:

```
cd agents
npm install
npm run setup   # creates founder/investor/customer/vendor/agent sub-accounts, writes .env (git-ignored)
npm run e2e     # 21 checks; add -- --refund-demo for the refund path (+65 s)
```

Keys are only ever written to `.env` (mode 600) and are never printed or committed.

## What the end-to-end run proves (live testnet, 21/21 checks)

1. Founder creates a startup with founder-defined tiers and turns results private.
2. Investor buys a share NFT. The money goes to the treasury minus the 1% platform fee.
3. Founder hires an agent with a per-payment cap, a daily cap and one allowed payee, then promotes it past probation.
4. Customer pays 0.3 NEAR for a job. It sits in **escrow**, not revenue.
5. The agent does the work, encrypts the result to the customer's key, and delivers it.
6. A wrong key cannot open the result; the customer's key can.
7. Customer accepts. Revenue is split: fee 0.003, shareholders 0.1782, agent budget 0.0594, operations 0.0594 (NEAR). The role pool is 0 because that run minted no role NFTs.
8. The agent pays its allowed vendor from the agent-budget bucket only. The vendor really receives it.
9. Over-cap payment: refused by the contract, reason logged (`over_per_payment_cap`).
10. Look-alike payee (`vend0r...`): the agent's own guard flags it, and with the guard bypassed on purpose the contract still refuses it (`payee_not_allowed`).
11. Attacks with the agent's key, each rejected by the network or the contract: calling `create_startup`, calling `claim`, transferring NEAR, calling another contract, and a non-agent calling `agent_spend`.
12. Investor claims 0.1782 NEAR.
13. The agent's reputation changes by exactly +1 approved, +2 refused, +0.01 NEAR spent.
14. (`--refund-demo`) A job nobody delivers is refunded in full after the deadline, with no fee.

## Evidence: transactions from one live run (startup 6, job 7)

| Step | Transaction |
| --- | --- |
| Create startup | https://explorer.testnet.near.org/transactions/7ZcUskEkcq69JhdToMWJcs2Ktcbmp4XjJx3yCk6sKRxt |
| Buy share NFT | https://explorer.testnet.near.org/transactions/Hn4swoiRZTUstDdJeUptiXpv7j4ih27zMfmvJqYXeRSk |
| Customer pays into escrow | https://explorer.testnet.near.org/transactions/F12Va8ateoEUP7HcabrCt8NGMzQtmpXquafn6ikL1gm6 |
| Agent delivers encrypted result | https://explorer.testnet.near.org/transactions/ATTnWkZbPw3WNGPJ9R4eDJUGnv7v1W8nv5fb76kHt73Q |
| Customer accepts, revenue split | https://explorer.testnet.near.org/transactions/HYbLWP47GmLmuhww6oYFfH17ZPTgbhQxHr5JC5ayq1f6 |
| Agent pays allowed vendor | https://explorer.testnet.near.org/transactions/mGXUDDEtZmSFbT4wBLtZyRZ81JEsUmCFtQQjndkND67 |
| Investor claims | https://explorer.testnet.near.org/transactions/4X1CbkCd6ddxZP79aS7rUPdFFktEE2jodvHF9DJFxLRR |
| Refund of an undelivered job (earlier run) | https://explorer.testnet.near.org/transactions/8wctbKxxNGzGXL2aFAa6bdGCvcpAdr5p2kEYd9VcaJgR |

## How it works

- **Share NFTs** (NEP-171): tiers are chosen by the founder (price, supply, weight). Holders earn from revenue in proportion to weight.
- **Role NFTs**: soulbound (non-transferable), revocable by the founder. They earn from a role pool.
- **Money flow**: platform fee 1% (capped at 5%) off the top; the rest is split by the startup's allocation (default 60% shareholders, 20% agent budget, 20% operations). Buckets are one way. Holders `claim`.
- **Agents**: `agent_spend` enforces a per-payment cap, a daily cap (UTC midnight reset), a payee allowlist (max 10), a kill switch, and a 3-day probation at 10% of the caps. Managers (roles the founder names) can hire and promote within founder-set ceilings.
- **Reputation**: each account has global raw counters (startups served, spends ok, spends refused, total spent, times paused, times removed) so a hiring party can check an agent before trusting it. These are counts, not a score.
- **Job escrow**: `create_job` holds the customer's money. After delivery the customer accepts or rejects; if the review window passes, anyone can settle it. If nothing is delivered by the deadline, anyone can refund it in full. Disputes go to an arbiter (the platform account on testnet).
- **Private results**: the founder can make results private. The customer supplies an X25519 public key; the agent encrypts with a NaCl sealed box; the chain stores only ciphertext (up to 1024 characters).

## Why NEAR

- **Function-call access keys** are the core of the security story. The agent's account has no full-access key. The protocol itself only lets it call `agent_spend` and `submit_result` on one contract, with no deposit. Demonstrated live in step 11.
- **Named accounts and sub-accounts** make the demo readable (`agent1.heto2-bybyte.testnet`) and let one funder create the whole cast.
- **Low fees** make per-spend, per-job and per-claim transactions practical.
- **NEAR Intents (1Click)**: the agent's reference price comes from a read-only `dry: true` quote. No swap is executed.
- **NEAR AI Cloud** (optional real mode, off by default): the agent brain can call an OpenAI-compatible private-inference endpoint. It is not used by the tests or the dry-run.

## Tracks

Lead: **AI Security & Defense** (`security`). Also **Autonomous Business** (`business`) and **NFTs That Do Something** (`nfts`). Agent Economy, AI Swarms and Privacy are claimed only to the extent the run above shows them. No Social Money claim: the Sputnik DAO treasury is not built.

## Known limits (stated plainly)

- Founders can put themselves on an agent's payee list. A colluding manager and agent can pay each other up to the manager ceiling, and a manager can promote an agent past probation.
- Reputation counts are raw. There is no scoring or sybil resistance: a new account has a clean record.
- The dispute arbiter is the platform account on testnet. That is not decentralised.
- `claim` pays out first; if the payout transfer fails (for example the account was deleted), the amount is not restored. A production version needs a callback.
- Job descriptions and ciphertext are public. Only the result text is private.
- The agent's "work" in dry-run is generated text, not real analysis or advice.
- Testnet only. No mainnet deployment, no real funds.

## Cut for time

Web dashboard (not built yet), Sputnik DAO treasury, a shared agent registry contract, a real-mode run against NEAR AI Cloud.

## Repository layout

```
contracts/   Rust smart contract (near-sdk 5), 159 tests
agents/      TypeScript agent code, encryption, Intents quote, setup and end-to-end scripts
```

## Security notes

Keys live only in environment variables or the git-ignored `.env`. The scripts refuse to run against anything but testnet. Nothing here should be pointed at mainnet funds.