// End-to-end run against the deployed testnet contract. Prints what happens in plain steps.
//   npm run e2e                  main flow (under a minute)
//   npm run e2e -- --refund-demo also shows the "swarm never delivered, customer is refunded" path
import { loadConfig, need } from '../src/config.js';
import { checkPayee } from '../src/guard.js';
import { leadFinalize, workerDraft, type Directive } from '../src/swarm.js';
import { nearUsdQuote } from '../src/intents.js';
import { decryptWith, encryptTo, newEncryptionKeypair } from '../src/crypto.js';
import { JsonRpcProvider } from 'near-api-js';
import { actions, balanceOf, call, explorer, fmt, makeAccount, makeProvider, near, view, why } from '../src/near.js';

// Readable demo startups, so the marketplace shows real names and purposes, not random ids.
const DEMO_STARTUPS = [
  { name: 'Signal Desk', description: 'AI agents write a daily NEAR/USDC market signal. Shareholders fund the agents and share the subscription revenue.' },
  { name: 'Daily Brief', description: 'A one-page morning briefing on NEAR ecosystem news, written by agents and owned by its shareholders.' },
  { name: 'Grant Scout', description: 'Agents watch open grants and hackathons and send founders a weekly shortlist. Revenue goes back to shareholders.' },
  { name: 'Audit Buddy', description: 'Agents run a first-pass review of small smart contracts and return a plain-language report for a flat fee.' },
  { name: 'Pulse Analytics', description: 'Agents turn on-chain activity into a daily dashboard summary that teams pay for and shareholders earn from.' },
];

// Which model each agent uses. These are written to the contract; in real mode they must be
// ids that NEAR AI Cloud lists at GET https://cloud-api.near.ai/v1/models. In dry-run they are labels.
const LEAD_MODEL = process.env.LEAD_MODEL ?? 'zai-org/GLM-5.1-FP8';
const WORKER_MODEL = process.env.WORKER_MODEL ?? 'z-ai/glm-5.2';

const cfg = loadConfig();
const provider = makeProvider(cfg);
const C = cfg.contractId;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const wantRefundDemo = process.argv.includes('--refund-demo');

const ids = {
  founder: need('FOUNDER_ID'),
  investor: need('INVESTOR_ID'),
  customer: need('CUSTOMER_ID'),
  vendor: need('VENDOR_ID'),
  agent: need('AGENT_ID'),
  worker: need('AGENT2_ID'),
};
const founder = makeAccount(provider, ids.founder, need('FOUNDER_SECRET_KEY'));
const investor = makeAccount(provider, ids.investor, need('INVESTOR_SECRET_KEY'));
const customer = makeAccount(provider, ids.customer, need('CUSTOMER_SECRET_KEY'));
const agent = makeAccount(provider, ids.agent, need('AGENT_SECRET_KEY'));
// Attack calls use one plain provider so the real network error is shown (the failover provider hides it).
const agentPlain = makeAccount(new JsonRpcProvider({ url: cfg.rpcUrls[0]! }), ids.agent, need('AGENT_SECRET_KEY'));
const customerEnc = { pub: need('CUSTOMER_ENC_PUBLIC'), secret: need('CUSTOMER_ENC_SECRET') };

let step = 0;
const say = (msg: string) => console.log(`\n[${++step}] ${msg}`);
const note = (msg: string) => console.log(`    ${msg}`);
const link = (hash: string) => note(`tx: ${explorer(hash)}`);
const results: { check: string; pass: boolean }[] = [];
const check = (name: string, pass: boolean) => {
  results.push({ check: name, pass });
  note(`${pass ? 'PASS' : 'FAIL'}: ${name}`);
};

async function expectRejected(label: string, run: () => Promise<unknown>) {
  try {
    await run();
    check(`${label} was blocked`, false);
  } catch (e) {
    note(`network said: ${why(e)}`);
    check(`${label} was blocked`, true);
  }
}

async function main() {
  console.log(`Heterotopia end-to-end run on ${cfg.network}. Contract: ${C}. DRY_RUN=${cfg.dryRun}`);
  console.log('This is a labeled testnet simulation. No real funds are involved.');

  // Preflight: each run spends about 0.3 NEAR (accepted job) plus gas, so check the balances first.
  const need_ = { customer: near('0.8'), investor: near('0.3'), founder: near('0.3') } as const;
  const short: string[] = [];
  for (const [who, min] of Object.entries(need_)) {
    const bal = await balanceOf(provider, (ids as any)[who]);
    if (bal < min) short.push(`${(ids as any)[who]} has ${fmt(bal)} NEAR, needs ${fmt(min)}`);
  }
  if (short.length) {
    console.log('\nNot enough testnet NEAR to run. Top up these accounts and run again:');
    for (const m of short) console.log(`  - ${m}`);
    process.exit(2);
  }

  say('Founder creates a startup with two tiers and switches results to private');
  const existing = await view<unknown[]>(provider, C, 'get_startups', { from_index: 0, limit: 100 });
  const demo = DEMO_STARTUPS[existing.length % DEMO_STARTUPS.length]!;
  const round = Math.floor(existing.length / DEMO_STARTUPS.length);
  const created = await call<number>(founder, C, 'create_startup', {
    name: round === 0 ? demo.name : `${demo.name} ${round + 1}`,
    description: demo.description,
    tiers: [
      { name: 'General', price: near('0.1').toString(), max_supply: 100, weight: 1 },
      { name: 'Board', price: near('0.5').toString(), max_supply: 1, weight: 10 },
    ],
    treasury: null,
    allocation: null,
  });
  const sid = created.value;
  note(`startup id ${sid}`);
  link(created.hash);
  link((await call(founder, C, 'set_results_private', { startup_id: sid, private: true })).hash);

  say('Investor buys a General share NFT (the money goes to the treasury, minus the 1% platform fee)');
  const bought = await call<string>(investor, C, 'buy_share', { startup_id: sid, tier_index: 0 }, { deposit: near('0.1') });
  note(`token ${bought.value}`);
  link(bought.hash);

  say('Founder hires the agent (caps and one allowed payee) and promotes it past probation');
  await call(founder, C, 'register_agent', {
    startup_id: sid,
    agent_id: ids.agent,
    name: 'Signal bot',
    per_tx_cap: near('0.02').toString(),
    daily_cap: near('0.05').toString(),
    payees: [ids.vendor, ids.worker],
  });
  link((await call(founder, C, 'promote_agent', { startup_id: sid, agent_id: ids.agent })).hash);

  say('Founder hires a worker agent and sets each agent\'s model, instructions and swarm role ON-CHAIN');
  await call(founder, C, 'register_agent', {
    startup_id: sid,
    agent_id: ids.worker,
    name: 'Research worker',
    per_tx_cap: near('0.01').toString(),
    daily_cap: near('0.02').toString(),
    payees: [ids.vendor],
  });
  link((await call(founder, C, 'set_agent_directive', {
    startup_id: sid, agent_id: ids.agent, model: LEAD_MODEL,
    instructions: 'You are the lead. Review the worker draft, tighten it, and deliver a short labelled note.', swarm_role: 'lead',
  })).hash);
  link((await call(founder, C, 'set_agent_directive', {
    startup_id: sid, agent_id: ids.worker, model: WORKER_MODEL,
    instructions: 'You are the worker. Draft the raw numbers for the lead. Be short and factual.', swarm_role: 'worker',
  })).hash);
  const crew = (await view<any>(provider, C, 'get_startup', { startup_id: sid })).agents as any[];
  const leadOnChain = crew.find((a) => a.account_id === ids.agent);
  const workerOnChain = crew.find((a) => a.account_id === ids.worker);
  check('the lead agent\'s model and role are stored on-chain', leadOnChain?.model === LEAD_MODEL && leadOnChain?.swarm_role === 'lead');
  check('the worker agent\'s model and role are stored on-chain', workerOnChain?.model === WORKER_MODEL && workerOnChain?.swarm_role === 'worker');
  const rep0 = await view<any>(provider, C, 'get_agent_reputation', { account_id: ids.agent });
  note(`reputation before work: spends_ok=${rep0.spends_ok}, spends_refused=${rep0.spends_refused}`);

  say('Customer pays 0.3 NEAR for a job. The money is held in escrow, not yet revenue. Results are private, so the customer sends an encryption key');
  const job = await call<number>(
    customer,
    C,
    'create_job',
    { startup_id: sid, description: 'Daily NEAR/USDC trading signal', work_secs: 300, review_secs: 60, customer_key: customerEnc.pub },
    { deposit: near('0.3') },
  );
  const jobId = job.value;
  note(`job id ${jobId}`);
  link(job.hash);
  const held = await view<any>(provider, C, 'get_startup', { startup_id: sid });
  check('escrow: job money is not revenue yet', BigInt(held.revenue) === 0n);

  say('The swarm does the work: the worker drafts, the lead finalizes using the models and instructions it READ FROM THE CHAIN, encrypts to the customer key, and delivers');
  const onChainJob = await view<any>(provider, C, 'get_job', { job_id: jobId });
  const quote = await nearUsdQuote();
  note(`price source: ${quote.source} (${quote.nearInUsd})`);
  const brief = { jobId, description: onChainJob.description };
  const leadD: Directive = { model: leadOnChain.model, instructions: leadOnChain.instructions, swarm_role: leadOnChain.swarm_role };
  const workerD: Directive = { model: workerOnChain.model, instructions: workerOnChain.instructions, swarm_role: workerOnChain.swarm_role };
  note(`worker (${workerD.model}) drafts, then lead (${leadD.model}) finalizes. DRY_RUN=${cfg.dryRun}`);
  const draft = await workerDraft(cfg.dryRun, brief, quote, workerD);
  const plaintext = await leadFinalize(cfg.dryRun, brief, quote, leadD, draft);
  const sealed = encryptTo(onChainJob.customer_key, plaintext);
  check('encrypted result fits the 1024-character limit', sealed.length <= 1024);
  const delivered = await call(agent, C, 'submit_result', { job_id: jobId, result: sealed });
  link(delivered.hash);

  say('Anyone can read the result on-chain, but only the customer can open it');
  const fetched = await view<any>(provider, C, 'get_job', { job_id: jobId });
  note(`on-chain text starts: ${String(fetched.result).slice(0, 40)}...`);
  const other = newEncryptionKeypair();
  check('a different key cannot open it', decryptWith(other.secretKeyHex, fetched.result) === null);
  const opened = decryptWith(customerEnc.secret, fetched.result);
  check('the customer key opens it', opened === plaintext);
  console.log('\n' + (opened ?? '(could not decrypt)').split('\n').map((l) => `    | ${l}`).join('\n'));

  say('Customer accepts. The payment becomes revenue and is split into buckets');
  const accepted = await call(customer, C, 'accept_job', { job_id: jobId });
  link(accepted.hash);
  const dep = accepted.events.find((e) => e.event === 'revenue_deposit')?.data?.[0];
  if (dep) note(`split: fee ${fmt(dep.platform_fee)}, shareholders ${fmt(dep.shareholders)}, role pool ${fmt(dep.role_pool)}, agent budget ${fmt(dep.agent_budget)}, operations ${fmt(dep.operations)} (NEAR)`);
  const after = await view<any>(provider, C, 'get_startup', { startup_id: sid });
  check('revenue now equals the job payment', BigInt(after.revenue) === near('0.3'));
  const agentBudget = BigInt(after.agent_balance);
  check('the agent budget bucket was filled', agentBudget > 0n);

  say('The agent pays its allowed vendor, from the agent budget bucket only');
  const vendorBefore = await balanceOf(provider, ids.vendor);
  const paid = await call<boolean>(agent, C, 'agent_spend', { startup_id: sid, to: ids.vendor, amount: near('0.01').toString(), memo: 'Data feed' });
  link(paid.hash);
  check('payment inside the limits was approved', paid.value === true);
  check('the vendor really received 0.01 NEAR', (await balanceOf(provider, ids.vendor)) - vendorBefore === near('0.01'));

  say('The lead agent pays the worker agent out of the job revenue (agent budget bucket, same limits, same contract)');
  const workerBefore = await balanceOf(provider, ids.worker);
  const paidWorker = await call<boolean>(agent, C, 'agent_spend', { startup_id: sid, to: ids.worker, amount: near('0.005').toString(), memo: `Draft for job ${jobId}` });
  link(paidWorker.hash);
  check('the lead\'s payment to the worker was approved', paidWorker.value === true);
  check('the worker really received 0.005 NEAR', (await balanceOf(provider, ids.worker)) - workerBefore === near('0.005'));

  say('The agent tries to pay more than its per-payment cap. The contract refuses and logs why');
  const over = await call<boolean>(agent, C, 'agent_spend', { startup_id: sid, to: ids.vendor, amount: near('0.03').toString(), memo: 'Too much' });
  const overWhy = over.events.find((e) => e.event === 'agent_spend_refused')?.data?.[0]?.reason;
  check(`over-cap payment refused (${overWhy})`, over.value === false && overWhy === 'over_per_payment_cap');

  say('A look-alike payee: the agent\'s own guard flags it first (fail-closed)');
  const fake = `vend0r.${ids.vendor.split('.').slice(1).join('.')}`;
  const verdict = checkPayee(fake, [ids.vendor]);
  note(`guard verdict for ${fake}: ${JSON.stringify(verdict)}`);
  check('the local guard flags the look-alike', !verdict.ok && verdict.reason === 'look_alike');
  note('Now we bypass the guard on purpose to show the contract is the real wall');
  const spoof = await call<boolean>(agent, C, 'agent_spend', { startup_id: sid, to: fake, amount: near('0.01').toString(), memo: 'Invoice' });
  const spoofWhy = spoof.events.find((e) => e.event === 'agent_spend_refused')?.data?.[0]?.reason;
  check(`contract refused the unlisted payee (${spoofWhy})`, spoof.value === false && spoofWhy === 'payee_not_allowed');

  say('Attacks. The network (restricted key) or the contract (rules) must reject every one of these');
  await expectRejected('calling `create_startup` (a method outside the key\'s list)', () => call(agentPlain, C, 'create_startup', { name: 'Evil', description: 'x', tiers: [], treasury: null, allocation: null }));
  await expectRejected('calling `claim` (a method outside the key\'s list)', () => call(agentPlain, C, 'claim', {}));
  await expectRejected('transferring NEAR out of the agent account', () =>
    agentPlain.signAndSendTransaction({ receiverId: ids.founder, actions: [actions.transfer(near('0.01'))] }),
  );
  await expectRejected('calling a different contract', () => call(agentPlain, ids.vendor, 'anything', {}));
  await expectRejected('a non-agent calling agent_spend', () =>
    call(investor, C, 'agent_spend', { startup_id: sid, to: ids.vendor, amount: near('0.01').toString(), memo: 'x' }),
  );

  say('Investor claims the revenue earned by the share');
  const claimable = await view<string>(provider, C, 'get_claimable', { account_id: ids.investor });
  note(`claimable: ${fmt(claimable)} NEAR`);
  const claimed = await call(investor, C, 'claim', {});
  link(claimed.hash);
  const left = await view<string>(provider, C, 'get_claimable', { account_id: ids.investor });
  check('claim paid out everything', BigInt(left) === 0n && BigInt(claimable) > 0n);

  say('Reputation record for the agent (raw facts, not a score)');
  const rep = await view<any>(provider, C, 'get_agent_reputation', { account_id: ids.agent });
  note(JSON.stringify(rep));
  const dOk = rep.spends_ok - rep0.spends_ok;
  const dRefused = rep.spends_refused - rep0.spends_refused;
  const dSpent = BigInt(rep.total_spent) - BigInt(rep0.total_spent);
  note(`changes since the agent was hired here: ok +${dOk}, refused +${dRefused}, spent +${fmt(dSpent)} NEAR`);
  check('exactly 2 approved spends were counted (vendor and worker)', dOk === 2);
  check('exactly 2 refused spends were counted (over-cap and unlisted payee)', dRefused === 2);
  check('total_spent grew by exactly the 0.015 NEAR paid to the vendor and the worker', dSpent === near('0.015'));
  check('the agent was never paused or removed', rep.times_paused === 0 && rep.times_removed === 0);

  if (wantRefundDemo) {
    say('Refund path: a job the swarm never delivers (waits about 65 seconds)');
    const j2 = await call<number>(customer, C, 'create_job', { startup_id: sid, description: 'A job nobody will do', work_secs: 60, review_secs: 60, customer_key: customerEnc.pub }, { deposit: near('0.2') });
    const before = await balanceOf(provider, ids.customer);
    await sleep(65_000);
    const refunded = await call(customer, C, 'refund_job', { job_id: j2.value });
    link(refunded.hash);
    await sleep(3000);
    const back = (await balanceOf(provider, ids.customer)) - before;
    check(`customer got the full 0.2 NEAR back (net of gas: ${fmt(back)})`, back > near('0.19'));
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== ${results.length - failed.length}/${results.length} checks passed ===`);
  for (const f of failed) console.log(`FAILED: ${f.check}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('\nRun stopped:', why(e));
  process.exit(1);
});