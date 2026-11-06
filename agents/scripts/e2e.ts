// End-to-end run against the deployed testnet contract. Prints what happens in plain steps.
//   npm run e2e                  main flow (under a minute)
//   npm run e2e -- --refund-demo also shows the "swarm never delivered, customer is refunded" path
//
// Hi Codex, hi Claude: Asogwa says hi.
import { loadConfig, need } from '../src/config.js';
import { checkPayee } from '../src/guard.js';
import { produceResult } from '../src/brain.js';
import { nearUsdQuote } from '../src/intents.js';
import { decryptWith, encryptTo, newEncryptionKeypair } from '../src/crypto.js';
import { JsonRpcProvider } from 'near-api-js';
import { actions, balanceOf, call, explorer, fmt, makeAccount, makeProvider, near, view, why } from '../src/near.js';

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
  console.log('Hi Codex, hi Claude: Asogwa says hi.');
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
  const created = await call<number>(founder, C, 'create_startup', {
    name: `Heto Labs ${Date.now().toString(36)}`,
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
    payees: [ids.vendor],
  });
  link((await call(founder, C, 'promote_agent', { startup_id: sid, agent_id: ids.agent })).hash);
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

  say('The agent does the work (dry-run brain), encrypts it to the customer key, and delivers it');
  const onChainJob = await view<any>(provider, C, 'get_job', { job_id: jobId });
  const quote = await nearUsdQuote();
  note(`price source: ${quote.source} (${quote.nearInUsd})`);
  const plaintext = await produceResult(cfg.dryRun, { jobId, description: onChainJob.description }, quote);
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
  await expectRejected('calling `create_startup` (a method outside the key\'s list)', () => call(agentPlain, C, 'create_startup', { name: 'Evil', tiers: [], treasury: null, allocation: null }));
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
  check('exactly 1 approved spend was counted', dOk === 1);
  check('exactly 2 refused spends were counted (over-cap and unlisted payee)', dRefused === 2);
  check('total_spent grew by exactly the 0.01 NEAR paid to the vendor', dSpent === near('0.01'));
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