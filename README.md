# Heterotopia ("heto")

**Give an AI an allowance, not the safe.**

Heterotopia is a company you can own a piece of, run by AI agents that can spend money but cannot steal it. Founders create startups, investors buy share NFTs, customers pay agents through escrow, revenue splits itself, and every rule that protects the money is enforced by one NEAR smart contract, not by trusting the agent.

Built at NEAR HACKATHON 2026. Licence: MIT. **Testnet only: no real funds are involved.**

## In 30 seconds

1. A founder creates a startup. Investors buy **share NFTs**. The team holds **soulbound role NFTs**.
2. The startup hires **AI agents**. Each agent is its own NEAR account with a key that can call exactly two methods on one contract. It cannot move the treasury, cannot claim for anyone, cannot call anything else. Everything else is a rule in the contract: a cap per payment, a daily cap, an allowed-payee list, a probation period, a kill switch.
3. A customer pays for a job. The money sits in **escrow**. The agents do the work (a lead and a worker, each running the model the founder stored on chain), **encrypt the result so only the customer can open it**, and deliver.
4. The customer accepts. The payment becomes revenue and splits automatically. The lead agent pays its worker out of its own budget. Shareholders claim their share.
5. Anyone, including a supporter who just likes the startup, can **top up the agent budget** directly. A group can do it by vote through a **Sputnik DAO**.

Everything above has run on NEAR testnet. Transaction links are in [Evidence](#evidence).

## The problem

An AI agent that works for a business creates three problems at once. Most agent-wallet projects solve one.

1. **Ownership.** The people who fund an agent have no claim on what it earns. Public AI bots cost money to run every day, usually paid by one person, with nothing flowing back to the people who value them. Here, funders hold share NFTs and revenue reaches them through a split they can `claim` from.
2. **Spending.** An agent either holds a key that can drain everything, or a human approves every payment. Here the agent holds a restricted key, and the contract enforces limits no matter what the agent's code, or a prompt injected into it, tries to do.
3. **The customer.** Paying an agent up front gives the customer no recourse, and a result posted on a public chain is readable by everyone. Here the payment is held in escrow until the customer accepts, and the result is sealed to the customer's key.

The three live in one contract, so money from investors, the agents' spending and the customer's payment follow one set of rules from start to finish.

## The vision

Heterotopia is meant to be a business world that runs on NEAR: a place where a startup behaves like a real company. It owns a treasury, hires staff (human or AI), sells services, pays its suppliers, and lets its team and shareholders take part in decisions. Different startups could one day run on different contracts, as different companies run on different business models, and hire agents from an open agent market.

Today the core economy exists and is proven on testnet. The multi-contract and marketplace parts do not. The table says which is which.

| Part of the vision | Status |
| --- | --- |
| Share NFTs, soulbound roles, automatic revenue split, claim | Built, live on testnet |
| Agents with enforced spending limits, probation, kill switch, reputation counters | Built, live |
| Customer escrow, private results, refunds, disputes | Built, live (the dispute arbiter is a single account, see Known limits) |
| A lead agent and a worker agent that each run the model stored on chain | Built, live |
| Agents that pay each other for work | Built, live |
| Anyone can fund a startup's agent budget | Built, live (`fund_agents`) |
| A DAO vote executes an action on a startup | Proven once, with a one-member DAO (see Evidence) |
| Different startups on different contracts ("frameworks") | Not built. Roadmap. |
| Hiring agents from a NEAR agent marketplace | Not built. Roadmap. |
| Thousands of agents per startup | Not tested. The contract caps agents per startup today. |
| Founder-set service prices enforced by the contract | Not built. Roadmap. |

## Try it

### Path A: no wallet, no keys (about 3 minutes)

Each step is "do X, see Y". Replace `RPC` with `https://rpc.testnet.near.org`.

1. **Do:** `cd contracts && RUSTUP_TOOLCHAIN=stable cargo test`
   **See:** all 184 tests pass (money split, escrow, refunds, agent limits, directives, private results, agent-budget funding).
2. **Do:** `cd agents && npm install && npm test`
   **See:** all tests pass (look-alike payee guard, encryption round trip, swarm, search, runner).
3. **Do:** read the lead agent's record from the live contract:
   ```
   curl -sS RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"heto3-bybyte.testnet","method_name":"get_agent_reputation","args_base64":"eyJhY2NvdW50X2lkIjoiYWdlbnQxLmhldG8zLWJ5Ynl0ZS50ZXN0bmV0In0K"}}'
   ```
   **See:** a `result` byte array that decodes to JSON with `spends_ok`, `spends_refused`, `total_spent`. Refused spends are counted, not hidden.
4. **Do:** read job 2 the same way (`method_name` `get_job`, `args_base64` `eyJqb2JfaWQiOjJ9Cg==`).
   **See:** status `Paid`, and a result that starts with `v1:`. That is ciphertext on a public chain. Only the customer's key opens it.
5. **Do:** open any transaction from [Evidence](#evidence) in the NEAR testnet explorer.
   **See:** the real call, its deposit and its logs, including refusals.

### Path B: use the live app (needs a testnet wallet with about 1 NEAR)

Web app: `WEB_URL`

1. **Do:** connect a testnet wallet. Open **Create**, make a startup with one share tier, and check "private results".
   **See:** your startup in Explore.
2. **Do:** open your startup. Under **Manage**, press **Platform lead (agent1)** under "Hire an agent", then hire. Press **End probation**. Press **Platform worker (agent2)** and hire. Then on each agent press **Edit directive** and save a model such as `z-ai/glm-5.3-flash`, with the role `lead` for agent1 and `worker` for agent2.
   **See:** both agents on the page, with their limits, model and role.
3. **Do:** buy a share first (a job needs at least one shareholder). Then place an order: describe a task, choose a one-day deadline, generate a key and tick "I saved my key".
   **See:** your payment held in escrow, status Open.
4. **Do:** open **My account**. Wait about a minute.
   **See:** the order moves to Delivered. The result opens in your browser with the key you saved.
5. **Do:** press **Accept**.
   **See:** revenue split into shareholder, agent budget and operations parts. Within one runner pass (about 20 seconds) the lead agent pays the worker 0.005 NEAR from the agent budget.
6. **Do:** on the startup page, use **Fund the agents** with 0.1 NEAR.
   **See:** "Agent budget left" rises by exactly 0.1 NEAR. There is no platform fee and no change to shareholder earnings.

The platform agents are served by one hosted runner. It can be asleep, rate-limited or out of model credit. If no result arrives, the order's deadline passes and **Refund me** returns the full payment. The contract guarantees the refund. It does not guarantee the runner is awake.

### Run everything yourself (needs your own testnet funds)

The end-to-end script creates demo accounts, so it needs a funder account with about 10 testnet NEAR whose key is in `~/.near-credentials/testnet/`. Build and deploy your own copy of the contract (`cd contracts && RUSTUP_TOOLCHAIN=stable cargo near build non-reproducible-wasm`, then deploy and call `new`), set `FUNDER_ID` and `CONTRACT_ID`, then:

```
cd agents
npm install
npm run setup   # creates the demo sub-accounts and writes .env (git-ignored)
npm run e2e     # 25 checks; add -- --refund-demo for the refund path (+65 s)
npm run agent   # the runner: serves orders for agent1
```

The Sputnik DAO demo needs about 9 testnet NEAR in one account (6 to create the DAO, 1 to fund it, a 1 NEAR proposal bond that is refunded, and gas):

```
cd agents
DAO_ACCOUNT=your-account.testnet npm run dao
# optional: COUNCIL=a.testnet,b.testnet THRESHOLD=2 chooses the voters and how many approvals are needed
```

Keys are only ever read from environment variables or the git-ignored `.env`. They are never printed or committed. The scripts refuse to run against anything but testnet.

## Evidence

All on NEAR testnet. Contract: `heto3-bybyte.testnet`.

### Worker payment, live, through the hosted runner (job 12)

| Step | Transaction |
| --- | --- |
| The agents deliver a sealed result | https://explorer.testnet.near.org/transactions/ExCRvnPjAQA2W294dMyRqKvqXgqwbajKdKfy9t2smgdw |
| After the customer accepts, the lead pays the worker | https://explorer.testnet.near.org/transactions/5g9vVxcxmBp4mfDE2VjMuRHH3Ur4nUJQvj8UKpynW1DK |

### A supporter funds the agent budget (`fund_agents`)

| Step | Transaction |
| --- | --- |
| Agent budget topped up by a wallet | https://explorer.testnet.near.org/transactions/3UpLY9aveudeKoAgU7fKkqfC15VwKJEYFL9WiVFJjjRg |

### A Sputnik DAO vote funds the agents

DAO: `heto-council-498701.sputnikv2.testnet`. One council member (`byte3.testnet`), majority rule. The DAO's proposal 0 calls `fund_agents` on startup 1 for 0.2 NEAR. After the vote, the startup's agent budget rose from 0.0394 to 0.2394 NEAR, and the contract logged `agents_funded` with the DAO account as the funder.

| Step | Transaction |
| --- | --- |
| Proposal 0 added | https://explorer.testnet.near.org/transactions/5c15CbfGkyAU2FFB8w2bZg4y7vAMu6JZXMSLRbdGdaB7 |
| Council member votes approve, the DAO executes | https://explorer.testnet.near.org/transactions/8dBCg6Bkaux6u2BXzaphnhHwkx761J8eaiK9JcZ3WWSF |

This run used a one-member council. That proves a DAO can execute a heto action through Sputnik's own proposal and vote flow. It is not evidence of a team deciding together. `npm run dao` accepts a council list and a threshold for that.

**How voting works today.** Heterotopia has no voting screen. A vote is a call to the DAO contract itself, so it works with any NEAR tool. A council member votes from their own terminal:

```
near contract call-function as-transaction heto-council-498701.sputnikv2.testnet act_proposal json-args '{"id":0,"action":"VoteApprove"}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as VOTER.testnet network-config testnet sign-with-keychain send
```

`npm run dao` does the same for every council member whose key is on the machine running it. With a larger council it leaves the proposal open when a voter's key is missing, and you re-run it with `DAO_ID=<the dao account>` after they vote. Who may vote and how many approvals pass a proposal are settings of the DAO (`COUNCIL` and `THRESHOLD`), and Sputnik lets the DAO change them later by proposal, so no code change is needed. An in-app proposal and voting screen is on the roadmap.

### One full run, step by step (startup 2, job 2; 25 checks)

The full terminal output is in `docs/evidence/e2e-run.log`.

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

What the run checks:

- The customer pays 0.3 NEAR. It sits in escrow, not revenue. After acceptance it splits: fee 0.003, shareholders 0.1782, agent budget 0.0594, operations 0.0594.
- A wrong key cannot open the result. The customer's key can.
- The lead agent's payment to an allowed vendor succeeds. A payment over the cap is refused (`over_per_payment_cap`). A look-alike payee (`vend0r...`) is flagged by the agent's own guard, and with that guard bypassed on purpose the contract still refuses it (`payee_not_allowed`).
- Attacks made with the agent's own key are rejected by the network or the contract: calling `create_startup`, calling `claim`, transferring NEAR, calling another contract, and a non-agent calling `agent_spend`.
- The agent's reputation moves by exactly +2 approved, +2 refused, +0.015 NEAR spent.
- With `--refund-demo`, a job nobody delivers is refunded in full after the deadline, with no fee.

An earlier run (startup 3, `DRY_RUN=false`) called real models through NEAR AI Cloud. Its log is `docs/evidence/e2e-real.log`.

## How it works

- **Share NFTs** (NEP-171). Tiers are chosen by the founder: price, supply, weight. Holders earn in proportion to weight. When a share is sold, the seller keeps what it earned so far and the buyer starts fresh.
- **Role NFTs.** Soulbound (cannot be transferred), revocable by the founder, paid from a role pool. A founder can name roles whose holders may manage agents within founder-set ceilings.
- **Money flow.** A 1% platform fee (capped at 5%) comes off first. The rest splits by the startup's allocation (default 60% shareholders, 20% agent budget, 20% operations). Buckets are one way. Holders `claim`.
- **Agents.** `agent_spend` enforces a per-payment cap, a daily cap, an allowed-payee list (at most 10), a kill switch, and a three-day probation at 10% of the caps. A refused payment is logged with its reason and counted.
- **Funding the agents.** `fund_agents` is payable by anyone. The full deposit goes into the agent budget bucket: no platform fee, not revenue, and the funder cannot spend or withdraw it. Only that startup's agents can use it, inside their limits.
- **Agent directive and swarm.** The hosted runner runs in real mode: it calls the models stored on chain through NEAR AI Cloud, and does a web search for the worker when a search key is configured. The founder stores each agent's model, instructions and swarm role (`lead`, `worker`) on chain. The runner reads them before it works. The worker drafts. The lead finalizes. When a search key is configured, the worker first looks up sources on the web. The result is sealed to the customer and delivered. The lead pays the worker from the agent budget after the customer accepts.
- **Reputation.** Each agent account has global raw counters (startups served, spends ok, spends refused, total spent, times paused, times removed), so a hiring party can look an agent up before trusting it. These are counts, not a score.
- **Job escrow.** `create_job` holds the money. After delivery the customer accepts or rejects. If the review window passes, anyone can settle. If nothing is delivered by the deadline, anyone can refund in full. A rejection becomes a dispute that the arbiter resolves.
- **Private results.** The customer supplies an X25519 public key. The agent encrypts with a NaCl sealed box. The chain stores only ciphertext, at most 1024 characters (roughly 600 characters of plain text). The web app decrypts in the browser, and the key stays in the customer's own browser if they choose to save it.
- **Web app.** React and Vite. Explore, Create, and **My account** (shares as cards with claimable revenue, orders grouped Pending, Delivered, In dispute and Finished, accept, reject and refund buttons, and a notification dot when an order needs attention).

## Why NEAR

- **Function-call access keys.** The agent's account has no full-access key. The protocol itself lets it call only `agent_spend` and `submit_result` on one contract, with no deposit. This is what makes "an allowance, not the safe" true, and it is shown live by the attack checks above.
- **Named accounts and sub-accounts.** Agents are readable names (`agent1.heto3-bybyte.testnet`). Anyone can look an agent up, see its record and check what it can do.
- **Low, predictable fees.** Per-spend, per-job and per-claim transactions are practical. Job 12's worker payment landed about a minute after delivery.
- **Sputnik DAO.** A group's decision can run a heto action through NEAR's own DAO standard instead of one we invented.
- **NEAR AI Cloud.** The swarm calls the models stored on chain through an OpenAI-compatible endpoint.
- **NEAR Intents.** Only as a read-only (`dry: true`) price quote for the trading-signal demo. No swap is executed.

## Tracks

Lead: **Autonomous Business** (`business`). Also claimed: `security`, `swarms`, `agents`, `nfts`, `social`. Each is claimed only for what the evidence above shows.

- **Autonomous Business.** Treasury buckets, sales through escrow, procurement (the agent pays its allowed vendor), revenue sharing. Humans set the constraints: tiers, split, caps and payees. Agents do the work inside them.
- **AI Security & Defense.** Spending limits, a policy engine in the contract, function-call keys, a payee allowlist with a look-alike guard, probation, a kill switch, and reputation counters. Attacks with the agent's key are shown failing.
- **AI Swarms.** A lead and a worker, each on its own on-chain model and instructions, coordinate on a job, and the lead pays the worker. The swarm is two agents, and we claim no more than that.
- **Agent Economy.** Agents earn through jobs, spend under limits, and hire another agent (the lead pays the worker).
- **NFTs That Do Something.** Share NFTs carry earning rights that settle on transfer. Role NFTs carry soulbound access and a revenue weight, and can be revoked.
- **Social Money.** A Sputnik DAO executed a startup action by vote (one-member council, stated above). The script supports multi-member councils and thresholds.

## Known limits

These are the things we know do not hold yet.

- **The directive is a request, not a leash.** The agent's model, instructions and role are stored on chain, but the contract cannot force the off-chain program to follow them. The contract enforces the spending rules. Following the directive is the runner's job.
- **One hosted runner serves the platform agents.** It can sleep, restart (which wipes its local state) or run out of model credit. The agent program is open source and anyone can run their own for their own agents.
- **Model cost is not paid by the contract.** NEAR AI Cloud credits are billed in USD and cannot be paid from the contract. The agent budget pays agents and suppliers on chain. The model bill is paid by whoever runs the runner.
- **Models do not browse by default.** Web lookup works only when a search key is configured on the runner.
- **Results are short.** On-chain results are capped at 1024 characters, about 600 when sealed.
- **The dispute arbiter is one account.** On testnet it is the platform account, which is not decentralised, and it cannot read sealed results. A customer can open a result and then reject it. Disputes today are decided without the result as evidence.
- **Prices are not enforced.** A customer chooses what to pay. A founder can state a price in the startup description, but the contract does not hold anyone to it.
- **The Sputnik run is a one-member DAO.** It proves the mechanism, not a team vote.
- **Founders and managers can collude.** A founder can put themselves on an agent's payee list, a colluding manager and agent can pay each other up to the manager ceiling, and a manager can promote an agent past probation.
- **Reputation is raw.** A new account has a clean record, and there is no sybil resistance.
- **`claim` pays out first.** If the transfer fails (say the account was deleted), the amount is not restored. A production version needs a callback.
- **Job descriptions and ciphertext are public.** Only the result text is private.
- **Testnet only.** No mainnet deployment, no real funds.

## Roadmap

What we would build next, in the order it unlocks the vision:

1. **Founder-set service prices**, enforced by the contract and later changeable by a DAO vote.
2. **Startups on different contracts**, so different business models can run side by side, with the contract ID as the framework.
3. **An agent marketplace**: hire agents by their on-chain record, with discovery and reviews.
4. **Real group governance** through Sputnik, inside the app: propose and vote from the page, ask shareholders questions, put operating decisions to a vote, change who can vote through proposals.
5. **Delivery commitments**, so disputes are decided on evidence even when the result is sealed, and a dispute process that does not depend on one account.
6. **Notifications**, such as a Telegram message when a job is done.
7. **Private payouts** through NEAR Intents' confidential transfers.
8. Bring-your-own model key and hidden agent instructions for founders; image uploads for startups; a runner heartbeat so a startup shows whether its agent is online.

## Repository layout

```
contracts/   Rust smart contract (near-sdk 5), 184 tests
agents/      TypeScript: runner, swarm, encryption, search, setup, end-to-end and DAO scripts
web/         React app (Explore, Create, My account)
docs/        Evidence logs and the earlier read-only dashboard
```

## Security notes

Keys live only in environment variables or the git-ignored `.env`. The scripts refuse to run against anything but testnet. Nothing here should be pointed at mainnet funds.