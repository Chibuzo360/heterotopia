// The agent runner's decisions, kept apart from the network so they can be tested with fakes.
// What it does on each pass, for every startup where this agent is an active lead:
//   1. Open jobs: ask the worker for a draft, finalize it with the lead's own model and instructions
//      (both read from the chain), seal it for the customer if the job is private, and deliver it.
//   2. Paid jobs this agent delivered: pay the worker a fixed fee through agent_spend, once.
// A model only ever writes text. It never decides whether, whom or how much to pay: that is fixed
// code here, and the contract's limits sit behind it.
import type { Directive } from './swarm.js';
import type { PriceQuote } from './intents.js';
import type { JobBrief } from './brain.js';

export interface AgentLite {
  account_id: string;
  active: boolean;
  model: string;
  instructions: string;
  swarm_role: string;
}
export interface StartupLite {
  id: number;
  status: string;
  agents: AgentLite[];
}
export interface JobLite {
  id: number;
  startup_id: number;
  status: string;
  description: string;
  deadline_ms: number;
  private: boolean;
  customer_key: string | null;
  agent: string | null;
}

export interface Deps {
  now(): number;
  listStartups(): Promise<StartupLite[]>;
  listJobs(startupId: number): Promise<JobLite[]>;
  quote(): Promise<PriceQuote>;
  draft(job: JobBrief, quote: PriceQuote, d: Directive): Promise<string>;
  finalize(job: JobBrief, quote: PriceQuote, d: Directive, draft: string): Promise<string>;
  seal(customerKey: string, text: string): string;
  submit(jobId: number, result: string): Promise<string>;
  pay(startupId: number, to: string, yocto: string, memo: string): Promise<{ ok: boolean; hash: string }>;
  log(message: string): void;
}

export interface RunnerConfig {
  leadId: string;
  workerFeeYocto: string;
  /** Do not start a job that expires within this many milliseconds. */
  deadlineMarginMs: number;
}

/** Remembered between passes (and restarts) so a worker is never paid twice for one job. */
export interface RunnerState {
  paid: Record<string, string>;
  /** Jobs this runner delivered itself. Only these earn the worker a fee, so old jobs are never paid twice. */
  delivered: Record<string, boolean>;
}

const directive = (a: AgentLite): Directive => ({ model: a.model, instructions: a.instructions, swarm_role: a.swarm_role });

export interface PassSummary {
  delivered: number[];
  paidWorker: number[];
  skipped: { jobId: number; reason: string }[];
}

export async function runPass(cfg: RunnerConfig, deps: Deps, state: RunnerState): Promise<PassSummary> {
  const out: PassSummary = { delivered: [], paidWorker: [], skipped: [] };
  for (const s of await deps.listStartups()) {
    if (s.status !== 'Active') continue;
    const lead = s.agents.find((a) => a.account_id === cfg.leadId);
    if (!lead || !lead.active) continue;
    const worker = s.agents.find((a) => a.swarm_role === 'worker' && a.active && a.account_id !== cfg.leadId);
    const jobs = await deps.listJobs(s.id);

    for (const j of jobs) {
      if (j.status === 'Open') {
        if (deps.now() > j.deadline_ms - cfg.deadlineMarginMs) {
          const over = deps.now() > j.deadline_ms
          out.skipped.push({ jobId: j.id, reason: over ? 'the deadline has already passed; the customer can refund it, it cannot be delivered' : 'less than the safety margin left before the deadline' });
          continue;
        }
        if (j.private && !j.customer_key) {
          out.skipped.push({ jobId: j.id, reason: 'private job without a customer key' });
          continue;
        }
        try {
          const brief: JobBrief = { jobId: j.id, description: j.description };
          const quote = await deps.quote();
          const draft = await deps.draft(brief, quote, directive(worker ?? lead));
          const finalText = await deps.finalize(brief, quote, directive(lead), draft);
          const result = j.private && j.customer_key ? deps.seal(j.customer_key, finalText) : finalText;
          const hash = await deps.submit(j.id, result);
          out.delivered.push(j.id);
          state.delivered[String(j.id)] = true;
          deps.log(`job ${j.id}: delivered${j.private ? ' (sealed for the customer)' : ''} tx ${hash}`);
        } catch (e) {
          out.skipped.push({ jobId: j.id, reason: e instanceof Error ? e.message : String(e) });
          deps.log(`job ${j.id}: not delivered: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if (j.status === 'Paid' && j.agent === cfg.leadId && worker && state.delivered[String(j.id)] && !state.paid[String(j.id)]) {
        try {
          const r = await deps.pay(s.id, worker.account_id, cfg.workerFeeYocto, `worker fee for job ${j.id}`);
          state.paid[String(j.id)] = r.ok ? r.hash : 'refused';
          if (r.ok) {
            out.paidWorker.push(j.id);
            deps.log(`job ${j.id}: paid the worker ${worker.account_id} tx ${r.hash}`);
          } else {
            deps.log(`job ${j.id}: the contract refused the worker payment (limits). Not retrying.`);
          }
        } catch (e) {
          deps.log(`job ${j.id}: worker payment failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  }
  return out;
}
