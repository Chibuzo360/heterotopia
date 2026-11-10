// The lead agent as a running program:  npm run agent   (add "-- --once" for a single pass)
// Every few seconds it looks for Open jobs in the startups that hired this agent, has the worker draft
// and the lead finalize (models and instructions read from the chain), delivers the result, and after
// the customer accepts it pays the worker through agent_spend.
// It signs with the agent's restricted key only: that key can call agent_spend and submit_result.
// DRY_RUN=true (default) needs no AI credits. Keys come from the git-ignored .env, never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { loadConfig, need } from '../src/config.js';
import { nearUsdQuote } from '../src/intents.js';
import { encryptTo } from '../src/crypto.js';
import { leadFinalize, workerDraft } from '../src/swarm.js';
import { call, explorer, makeAccount, makeProvider, near, view, why } from '../src/near.js';
import { runPass, type Deps, type JobLite, type RunnerState, type StartupLite } from '../src/runner.js';

const cfg = loadConfig();
const provider = makeProvider(cfg);
const C = cfg.contractId;
const leadId = need('AGENT_ID');
const agent = makeAccount(provider, leadId, need('AGENT_SECRET_KEY'));

const pollMs = Math.max(3, Number(process.env.POLL_SECS ?? 10)) * 1000;
const once = process.argv.includes('--once');
const feeNear = process.env.WORKER_FEE_NEAR ?? '0.005';
// Hosting: when PORT is set (Render and similar), answer HTTP so the host sees a live web service.
// An uptime pinger hitting this URL also keeps a free instance awake.
const port = process.env.PORT ? Number(process.env.PORT) : null;
let lastPass = 'not yet';
const STATE_FILE = new URL('../.agent-state.json', import.meta.url);

function loadState(): RunnerState {
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunnerState;
    return { paid: s.paid ?? {}, delivered: s.delivered ?? {} };
  } catch {
    return { paid: {}, delivered: {} };
  }
}

async function pages<T>(method: string, args: Record<string, unknown>): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += 100) {
    const batch = await view<T[]>(provider, C, method, { ...args, from_index: from, limit: 100 });
    all.push(...batch);
    if (batch.length < 100) return all;
  }
}

const deps: Deps = {
  now: () => Date.now(),
  listStartups: () => pages<StartupLite>('get_startups', {}),
  listJobs: (startupId) => pages<JobLite>('get_jobs', { startup_id: startupId }),
  quote: nearUsdQuote,
  draft: (job, quote, d) => workerDraft(cfg.dryRun, job, quote, d),
  finalize: (job, quote, d, draft) => leadFinalize(cfg.dryRun, job, quote, d, draft),
  seal: encryptTo,
  submit: async (jobId, result) => explorer((await call(agent, C, 'submit_result', { job_id: jobId, result })).hash),
  pay: async (startupId, to, yocto, memo) => {
    const r = await call<boolean>(agent, C, 'agent_spend', { startup_id: startupId, to, amount: yocto, memo });
    return { ok: r.value === true, hash: explorer(r.hash) };
  },
  log: (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`),
};

async function main() {
  console.log(`Heterotopia agent runner on ${cfg.network}. Contract: ${C}. Agent: ${leadId}. DRY_RUN=${cfg.dryRun}`);
  console.log('This is a labeled testnet simulation. No real funds are involved.');
  if (port) {
    createServer((req, res) => {
      // /ping answers with two bytes, for uptime pingers that cap the response size.
      if ((req.url ?? '').startsWith('/ping')) {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('ok');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, agent: leadId, contract: C, dryRun: cfg.dryRun, lastPass }));
    }).listen(port, () => console.log(`Health endpoint on port ${port}`));
  }
  const state = loadState();
  const rc = { leadId, workerFeeYocto: near(feeNear).toString(), deadlineMarginMs: 30_000 };
  do {
    try {
      const out = await runPass(rc, deps, state);
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      lastPass = new Date().toISOString();
      for (const k of out.skipped) console.log(`job ${k.jobId}: skipped: ${k.reason}`);
      if (once) console.log(`pass done: delivered ${out.delivered.length}, worker paid ${out.paidWorker.length}, skipped ${out.skipped.length}`);
    } catch (e) {
      console.log(`pass failed, will retry: ${why(e)}`);
    }
    if (!once) await new Promise((r) => setTimeout(r, pollMs));
  } while (!once);
}

main().catch((e) => {
  console.error(why(e));
  process.exit(1);
});
