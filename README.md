# Heterotopia ("heto")

A startup that runs itself on NEAR testnet. A founder creates a startup, investors buy tiered share NFTs, the team holds soulbound role NFTs, AI agents work for the holders under hard spending limits, customers pay for jobs through escrow, and revenue is split automatically into buckets that holders claim. A startup created on Heterotopia is called a **heto-startup**.

**This is a labeled testnet simulation.** No real funds are involved. `DRY_RUN=true` is the default: the agent's "work" (a trading-signal text) is generated locally and is not real advice. Only the reference price comes from a live source (NEAR Intents 1Click `dry: true` quote, read-only).

Built at NEAR HACKATHON 2026. Licence: MIT.

## The problem

An AI agent that earns money for a business raises three problems at once, and most agent-wallet projects solve only one of them.

1. **Ownership.** The people who funded the agent have no claim on what it earns. Heterotopia gives them share NFTs, and revenue reaches them automatically through a split they can `claim` from.
2. **Spending.** The agent either holds a key that can drain everything, or a human approves every payment. Heterotopia gives it a key that can only call two methods on one contract. Every other rule (caps, allowed payees, probation, kill switch) lives in that contract, and the agent can only spend from its own slice of the revenue.
3. **The customer.** Paying an agent up front gives the customer no recourse, and a result posted on a public chain is readable by everyone. Heterotopia holds the payment in escrow until the customer accepts, and the result is encrypted so only the customer can open it.

The three live in one contract, so the money that investors fund, the agents spend and the customer pays follows one set of rules end to end.

## Live deployment (testnet)

| Item | Value |
| --- | --- |
| Contract | `heto3-bybyte.testnet` |
| Platform fee account | `heto-fee-account.testnet` |
| Demo agents | `agent1.heto3-bybyte.testnet` (lead) and `agent2.heto3-bybyte.testnet` (worker), function-call keys only |
| Live dashboard (read-only) | https://chibuzo360.github.io/heterotopia/ |
| Network | NEAR testnet |

## Try it (no keys needed)

Each step is "do X, see Y". Replace `RPC` with `https://rpc.testnet.near.org`. Arguments are base64 JSON.

1. **Do:** run the contract's tests. `cd contracts && RUSTUP_TOOLCHAIN=stable cargo test`. **See:** 177 tests pass (money split, escrow, refunds, agent limits, agent directives, startup descriptions, private results).
2. **Do:** run the agent library's tests. `cd agents && npm install && npm test`. **See:** 25 tests pass (look-alike payee guard, encryption round trip, quote parsing).
3. **Do:** read the lead agent's track record from the live contract:
   ```
   curl -sS RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"heto3-bybyte.testnet","method_name":"get_agent_reputation","args_base64":"eyJhY2NvdW50X2lkIjoiYWdlbnQxLmhldG8zLWJ5Ynl0ZS50ZXN0bmV0In0K"}}'
   ```
   **See:** a `result` byte array. It decodes to JSON with `spends_ok`, `spends_refused`, `total_spent`, `times_paused`, `times_removed`. Refused spends are counted, not hidden.
4. **Do:** read a finished job (id 2) the same way, `method_name` `get_job`, `args_base64` `eyJqb2JfaWQiOjJ9Cg==`. **See:** status `Paid`, and a result that starts with `v1:`. That is ciphertext. Anyone can read it on chain; only the customer's key opens it.
5. **Do:** read startup 2, `method_name` `get_startup`, `args_base64` `eyJzdGFydHVwX2lkIjoyfQo=`. **See:** the startup's `description`, the revenue buckets (shareholders, agent budget, operations) matching the split below, and each agent's `model`, `instructions` and `swarm_role` stored on chain.
6. **Do:** open the transactions listed under "Evidence" below in the NEAR testnet explorer. **See:** the real calls on chain.

### Run the full flow yourself (needs your own testnet funds)

The end-to-end script creates demo accounts, so it needs a funder account with about 10 testnet NEAR whose key is in `~/.near-credentials/testnet/`. Deploy your own copy of the contract first (`cd contracts && RUSTUP_TOOLCHAIN=stable cargo near build non-reproducible-wasm`, then deploy and call `new`), set `FUNDER_ID` and `CONTRACT_ID`, then:

```
cd agents
npm install
npm run setup   # creates founder/investor/customer/vendor/agent/worker sub-accounts, writes .env (git-ignored)
npm run e2e     # 25 checks; add -- --refund-demo for the refund path (+65 s)
```

Keys are only ever written to `.env` (mode 600) and are never printed or committed.

## What the end-to-end run proves (live testnet, 25/25 checks)

1. Founder creates a startup with a description (what it is for), founder-defined tiers, and turns results private.
2. Investor buys a share NFT. The money goes to the treasury minus the 1% platform fee.
3. Founder hires a lead agent with a per-payment cap, a daily cap and allowed payees, then promotes it past probation.
4. Founder hires a worker agent and sets each agent's model, instructions and swarm role **on chain**. The run reads them back.
5. Customer pays 0.3 NEAR for a job. It sits in **escrow**, not revenue.
6. The swarm does the work: the worker drafts, then the lead finalizes it using the model and instructions it **read from the chain**, encrypts the result to the customer's key, and delivers it.
7. A wrong key cannot open the result; the customer's key can.
8. Customer accepts. Revenue is split: fee 0.003, shareholders 0.1782, agent budget 0.0594, operations 0.0594 (NEAR). The role pool is 0 because that run minted no role NFTs.
9. The lead agent pays its allowed vendor from the agent-budget bucket only. The vendor really receives it.
10. The lead agent pays the worker agent 0.005 NEAR from the same bucket, under the same limits. The worker really receives it.
11. Over-cap payment: refused by the contract, reason logged (`over_per_payment_cap`).
12. Look-alike payee (`vend0r...`): the agent's own guard flags it, and with the guard bypassed on purpose the contract still refuses it (`payee_not_allowed`).
13. Attacks with the agent's key, each rejected by the network or the contract: calling `create_startup`, calling `claim`, transferring NEAR, calling another contract, and a non-agent calling `agent_spend`.
14. Investor claims 0.1782 NEAR.
15. The agent's reputation changes by exactly +2 approved, +2 refused, +0.015 NEAR spent.
16. (`--refund-demo`) A job nobody delivers is refunded in full after the deadline, with no fee.

## Evidence: transactions from one live run (startup 2, job 2)

| Step | Transaction |
| --- | --- |
| Create startup | https://explorer.testnet.near.org/transactions/7xLohVWGMhb1pKYANM7EV3pUkNoUEwNUUP9UEMwALBUG |
| Switch results to private | https://explorer.testnet.near.org/transactions/C4HyQ8pJiR2GpffeWZhY5ZXvuUaVLe5DEvrcR7iJQDZX |
| Buy share NFT | https://explorer.testnet.near.org/transactions/2di9HBGCxNVvzPT8P4HKpPoBTKUnpzzbLeNgGa8peQjA |
| Hire lead agent and promote | https://explorer.testnet.near.org/transactions/7E8T1MmuKA4CDjnhfHsMi9LHiXVjgRmQtFHsc3niZCfx |
| Hire worker agent | https://explorer.testnet.near.org/transactions/DxQYSNizYJJZRBaypyqUmjHG8SBUZErh7snPuN98e8wV |
| Set agent directives (model, instructions, role) | https://explorer.testnet.near.org/transactions/5Q3Xp4wWLVKrfmmicJDJyZMpsqEqWM2GGUAmDJYDge3e |
| Customer pays into escrow | https://explorer.testnet.near.org/transactions/8Hd6jGk7wEs7jV1Myznv8HZmGiLWnEkRBq7CCBX1aZxM |
| Swarm delivers encrypted result | https://explorer.testnet.near.org/transactions/9q31u9dmXfm1VunZJfaBU89QNTDehnAR8TqVXcqABxnk |
| Customer accepts, revenue split | https://explorer.testnet.near.org/transactions/27VJuKa5boz6nwoLRKuSMQJe7htWwzKYfJLZVi8wUivS |
| Lead agent pays allowed vendor | https://explorer.testnet.near.org/transactions/Hu9S8AN1cQGEF15rmenYz5STpCRk3JLs7eZPZDrXPu6d |
| Lead agent pays worker agent | https://explorer.testnet.near.org/transactions/DE9BoDNACJL4a2wdfN71ut8gUvGS8v5mG5PJaACXvnex |
| Investor claims | https://explorer.testnet.near.org/transactions/2XXDcrcJHR2haWJC9XbSC3hW15xgSb73NRQBeJ9Rsesi |
| Refund of an undelivered job (earlier run, on the previous contract `heto2-bybyte.testnet`, since retired) | https://explorer.testnet.near.org/transactions/8wctbKxxNGzGXL2aFAa6bdGCvcpAdr5p2kEYd9VcaJgR |

The full terminal output of this run is in `docs/evidence/e2e-run.log`.

### One run with real models (startup 3, job 3)

The same 25 checks also passed with `DRY_RUN=false`. The founder stored `z-ai/glm-5.3-flash` (worker) and `z-ai/glm-5.3` (lead) on chain; the swarm read those ids from the contract and called them through NEAR AI Cloud. The text the models wrote is still a labeled simulation, not advice. Log: `docs/evidence/e2e-real.log`.

| Step | Transaction |
| --- | --- |
| Set agent directives (real model ids) | https://explorer.testnet.near.org/transactions/2jra9n7dTcziCfDrXZSwmQiKWMZZ5sToYJzRGSPgbHf7 |
| Customer pays into escrow | https://explorer.testnet.near.org/transactions/2XEsHUfSTTenBNM4ooPAdUiKyBbtBXR7bQPYHWzRbcN9 |
| Swarm delivers encrypted result (written by the models) | https://explorer.testnet.near.org/transactions/6Kv7FTsyJtgkPFVSrVS2TRon437e1m2Up2A73wNoLzpo |
| Customer accepts, revenue split | https://explorer.testnet.near.org/transactions/72RELBAAbNHexZkspmEtuyGHKsikmGuFWYyJ4sfhRJDL |
| Lead agent pays worker agent | https://explorer.testnet.near.org/transactions/DLiWWj88ui79BZrYvYNLXYQ8RahdeNfLk2Wp95M1vS2A |

To repeat it you need your own NEAR AI Cloud key in `agents/.env` as `NEAR_AI_API_KEY`, then `DRY_RUN=false LEAD_MODEL=z-ai/glm-5.3 WORKER_MODEL=z-ai/glm-5.3-flash npm run e2e`. Check the model ids against `https://cloud-api.near.ai/v1/models` first, since the list changes. The default stays `DRY_RUN=true` so nobody needs a key.

## How it works

- **Share NFTs** (NEP-171): tiers are chosen by the founder (price, supply, weight). Holders earn from revenue in proportion to weight.
- **Role NFTs**: soulbound (non-transferable), revocable by the founder. They earn from a role pool.
- **Startup description**: each heto-startup carries a short description (1-280 characters) saying what it is for. The founder can reword it while the startup is active.
- **Money flow**: platform fee 1% (capped at 5%) off the top; the rest is split by the startup's allocation (default 60% shareholders, 20% agent budget, 20% operations). Buckets are one way. Holders `claim`.
- **Agents**: `agent_spend` enforces a per-payment cap, a daily cap (UTC midnight reset), a payee allowlist (max 10), a kill switch, and a 3-day probation at 10% of the caps. Managers (roles the founder names) can hire and promote within founder-set ceilings.
- **Agent directive and swarm**: the founder (or a manager) stores each agent's model, instructions and swarm role (for example `lead` or `worker`) on chain. The agent program reads them from the contract before it works. In the demo the worker drafts, the lead finalizes and delivers, and the lead pays the worker from the agent budget after the customer accepts.
- **Reputation**: each account has global raw counters (startups served, spends ok, spends refused, total spent, times paused, times removed) so a hiring party can check an agent before trusting it. These are counts, not a score.
- **Job escrow**: `create_job` holds the customer's money. After delivery the customer accepts or rejects; if the review window passes, anyone can settle it. If nothing is delivered by the deadline, anyone can refund it in full. Disputes go to an arbiter (the platform account on testnet).
- **Private results**: the founder can make results private. The customer supplies an X25519 public key; the agent encrypts with a NaCl sealed box; the chain stores only ciphertext (up to 1024 characters).

## Why NEAR

- **Function-call access keys** are the core of the security story. The agent's account has no full-access key. The protocol itself only lets it call `agent_spend` and `submit_result` on one contract, with no deposit. Demonstrated live in step 13.
- **Named accounts and sub-accounts** make the demo readable (`agent1.heto3-bybyte.testnet`) and let one funder create the whole cast.
- **Low fees** make per-spend, per-job and per-claim transactions practical.
- **NEAR Intents (1Click)**: the agent's reference price comes from a read-only `dry: true` quote. No swap is executed.
- **NEAR AI Cloud** (optional real mode, off by default): the swarm calls the models stored on chain through an OpenAI-compatible endpoint. One recorded run did this (see "One run with real models"). It is not used by the tests or the default dry-run.

## Tracks

Lead: **AI Security & Defense** (`security`). Also **Autonomous Business** (`business`) and **NFTs That Do Something** (`nfts`). Agent Economy, AI Swarms and Privacy are claimed only to the extent the run above shows them. No Social Money claim: the Sputnik DAO treasury is not built.

## Known limits (stated plainly)

- Founders can put themselves on an agent's payee list. A colluding manager and agent can pay each other up to the manager ceiling, and a manager can promote an agent past probation.
- An agent's model, instructions and role are stored on chain, but the contract cannot force the agent program to obey them. The spending rules are enforced by the contract; following the directive is done by the off-chain agent code.
- Reputation counts are raw. There is no scoring or sybil resistance: a new account has a clean record.
- The dispute arbiter is the platform account on testnet. That is not decentralised.
- `claim` pays out first; if the payout transfer fails (for example the account was deleted), the amount is not restored. A production version needs a callback.
- Job descriptions and ciphertext are public. Only the result text is private.
- The agent's "work" in dry-run is generated text, not real analysis or advice. The models named in the directives are not called in dry-run; one recorded run (startup 3) did call them.
- Testnet only. No mainnet deployment, no real funds.

## Cut for time

Wallet connect and write actions in the web UI (the dashboard is read-only), Sputnik DAO treasury, a shared agent registry contract, investor-funded agent compute.

## Repository layout

```
contracts/   Rust smart contract (near-sdk 5), 177 tests
agents/      TypeScript agent code, swarm, encryption, Intents quote, setup and end-to-end scripts
docs/        Read-only dashboard served by GitHub Pages, and the e2e run log
web/         React dashboard (in progress)
```

## Security notes

Keys live only in environment variables or the git-ignored `.env`. The scripts refuse to run against anything but testnet. Nothing here should be pointed at mainnet funds.