// Heterotopia x Sputnik DAO (testnet only).
// A small DAO of the team decides, by vote, to fund a startup's agent budget through heto's `fund_agents`.
// Prints every transaction link as evidence. Nothing here can touch mainnet.
//
//   DAO_ACCOUNT=you.testnet npm run dao
//
// Optional settings (environment variables):
//   COUNCIL    comma list of voter accounts (default: just DAO_ACCOUNT)
//   THRESHOLD  approvals needed (default: Sputnik's majority rule). Custom values use a hand-built policy.
//   DAO_NAME   name under sputnikv2.testnet (default: heto-council-<random>)
//   DAO_ID     reuse an existing DAO instead of creating one
//   STARTUP_ID startup to fund (default 1)     FUND_NEAR amount (default 0.2)
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadFunderKey } from './../src/config.js';
import { actions, balanceOf, call, explorer, fmt, makeAccount, makeProvider, near, view, why } from './../src/near.js';

const FACTORY = 'sputnikv2.testnet';
const DAO_DEPOSIT = near(6);
const TOP_UP = near(1);
/** Sputnik's default proposal bond is 1 NEAR (refunded when the proposal passes). The script reads the real value later. */
const BOND = near(1);

/** Key for a voter: the funder's key for the main account, otherwise the near CLI's credentials file. */
function keyFor(account: string, payer: string): string | null {
  if (account === payer) return loadFunderKey(account);
  const file = join(homedir(), '.near-credentials', 'testnet', `${account}.json`);
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, 'utf8')) as { private_key?: string; secret_key?: string };
  return j.private_key ?? j.secret_key ?? null;
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

function policyFor(council: string[], threshold: number | undefined): unknown {
  if (threshold === undefined) return council; // Sputnik's own default policy: majority of the council
  return {
    roles: [
      { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} },
      { name: 'council', kind: { Group: council }, permissions: ['*:*'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: String(threshold) },
    proposal_bond: near('0.1').toString(),
    proposal_period: (7n * 24n * 3600n * 1_000_000_000n).toString(),
    bounty_bond: near('0.1').toString(),
    bounty_forgiveness_period: (24n * 3600n * 1_000_000_000n).toString(),
  };
}

async function main() {
  const cfg = loadConfig();
  const payer = process.env.DAO_ACCOUNT ?? process.env.FUNDER_ACCOUNT;
  if (!payer) throw new Error('Set DAO_ACCOUNT to the testnet account that pays for the DAO (name only, never its key).');
  const council = (process.env.COUNCIL ?? payer).split(',').map((s) => s.trim()).filter(Boolean);
  if (!council.includes(payer)) council.unshift(payer);
  const threshold = process.env.THRESHOLD ? Number(process.env.THRESHOLD) : undefined;
  if (threshold !== undefined && (!Number.isInteger(threshold) || threshold < 1 || threshold > council.length)) {
    throw new Error(`THRESHOLD must be a whole number from 1 to ${council.length} (the number of voters).`);
  }
  const startupId = Number(process.env.STARTUP_ID ?? '1');
  const fundAmount = near(process.env.FUND_NEAR ?? '0.2');

  const provider = makeProvider(cfg);
  const founder = makeAccount(provider, payer, loadFunderKey(payer));
  const links: string[] = [];
  const log = (label: string, hash: string) => { links.push(`${label}: ${explorer(hash)}`); console.log(`  ${label}: ${explorer(hash)}`); };

  // 1. The DAO
  let dao = process.env.DAO_ID;
  if (!dao) {
    const bal = await balanceOf(provider, payer);
    const need = DAO_DEPOSIT + TOP_UP + BOND + near('0.8');
    if (bal < need) throw new Error(`${payer} has ${fmt(bal)} NEAR; this needs about ${fmt(need)} (6 for the DAO, 1 to fund it, 1 proposal bond that comes back, and gas).`);
    const name = process.env.DAO_NAME ?? `heto-council-${Math.floor(Math.random() * 1e6)}`;
    console.log(`Creating the DAO ${name}.${FACTORY} with ${council.length} voter(s)${threshold ? `, ${threshold} approval(s) needed` : ', majority rule'}...`);
    const args = b64({ config: { name, purpose: 'Heterotopia team decisions: fund the agents of a startup', metadata: '' }, policy: policyFor(council, threshold) });
    const created = await call(founder, FACTORY, 'create', { name, args }, { deposit: DAO_DEPOSIT, gas: 150_000_000_000_000n });
    dao = `${name}.${FACTORY}`;
    log('DAO created', created.hash);
    await founder.signAndSendTransaction({ receiverId: dao, actions: [actions.transfer(TOP_UP)], waitUntil: 'EXECUTED' });
    console.log(`  Sent the DAO ${fmt(TOP_UP)} NEAR so it can attach a deposit.`);
  } else {
    console.log(`Using the existing DAO ${dao}.`);
  }

  const policy = await view<any>(provider, dao, 'get_policy');
  console.log(`DAO policy read back: proposal bond ${fmt(policy.proposal_bond)} NEAR.`);
  console.log(JSON.stringify(policy.roles?.map((r: any) => ({ name: r.name, kind: r.kind })) ?? policy));
  console.log(`  default vote policy: ${JSON.stringify(policy.default_vote_policy)}`);

  // 2. The proposal: the DAO calls fund_agents on the startup
  const before = await view<any>(provider, cfg.contractId, 'get_startup', { startup_id: startupId });
  console.log(`\nStartup ${startupId} agent budget before: ${fmt(before.agent_balance)} NEAR`);
  const description = `Fund the agents of startup ${startupId} (${before.name}) with ${fmt(fundAmount)} NEAR`;
  const proposal = {
    description,
    kind: {
      FunctionCall: {
        receiver_id: cfg.contractId,
        actions: [{
          method_name: 'fund_agents',
          args: b64({ startup_id: startupId }),
          deposit: fundAmount.toString(),
          gas: '60000000000000',
        }],
      },
    },
  };
  const added = await call<number>(founder, dao, 'add_proposal', { proposal }, { deposit: BigInt(policy.proposal_bond), gas: 100_000_000_000_000n });
  const id = Number(added.value);
  log(`Proposal ${id} added`, added.hash);

  // 3. Votes, from every council member whose key is available on this machine
  let status = 'InProgress';
  let fundedBy = '';
  for (const voter of council) {
    if (status !== 'InProgress') break;
    const key = keyFor(voter, payer);
    if (!key) { console.log(`  ${voter}: key not on this machine. They can vote with: near contract call-function as-transaction ${dao} act_proposal json-args '{"id":${id},"action":"VoteApprove"}' prepaid-gas '300 Tgas' attached-deposit '0 NEAR' sign-as ${voter} network-config testnet sign-with-keychain send`); continue; }
    const acct = voter === payer ? founder : makeAccount(provider, voter, key);
    const r = await call(acct, dao, 'act_proposal', { id, action: 'VoteApprove' }, { gas: 300_000_000_000_000n });
    log(`${voter} voted approve`, r.hash);
    const ev = r.events.find((e) => e.event === 'agents_funded');
    if (ev) fundedBy = JSON.stringify(ev.data);
    status = (await view<any>(provider, dao, 'get_proposal', { id })).status;
  }

  // 4. Evidence
  const p = await view<any>(provider, dao, 'get_proposal', { id });
  const after = await view<any>(provider, cfg.contractId, 'get_startup', { startup_id: startupId });
  console.log(`\nProposal status: ${p.status}`);
  console.log(`Startup ${startupId} agent budget after:  ${fmt(after.agent_balance)} NEAR (was ${fmt(before.agent_balance)})`);
  if (fundedBy) console.log(`heto event: agents_funded ${fundedBy}`);
  if (p.status === 'Approved' && BigInt(after.agent_balance) - BigInt(before.agent_balance) === fundAmount) {
    console.log('\nPROVEN: a DAO vote funded the agents.');
  } else if (p.status === 'InProgress') {
    console.log(`\nStill waiting for votes. Voters without a key here can approve proposal ${id} with the command above, then re-run with DAO_ID=${dao}.`);
  } else {
    console.log('\nNot proven: the proposal did not end in a funded budget. Read the status above.');
  }
  console.log(`\nDAO account: ${dao}\nEvidence links:\n${links.map((l) => `  ${l}`).join('\n')}`);
}

main().catch((e) => { console.error(`dao failed: ${why(e)}`); process.exit(1); });
