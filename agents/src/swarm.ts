// The swarm: a worker agent drafts, a lead agent finalizes. Each agent's model and standing
// instructions come from the contract (set by the founder or a manager), not from this file.
// DRY_RUN=true (the default) uses deterministic text: no model call, no key, no credits.
// Real mode calls NEAR AI Cloud (OpenAI-compatible). Real mode is NOT exercised by the tests.
import type { JobBrief } from './brain.js';
import type { PriceQuote } from './intents.js';

/** What the contract stores for one agent (see `set_agent_directive`). */
export interface Directive {
  model: string;
  instructions: string;
  swarm_role: string;
}

/** Keeps the final note short enough that its encrypted form fits the 1024-character result limit. */
export const MAX_RESULT_CHARS = 600;

export function clip(text: string): string {
  return text.length <= MAX_RESULT_CHARS ? text : `${text.slice(0, MAX_RESULT_CHARS - 1)}…`;
}

const r2 = (x: number) => x.toFixed(2);

export function dryWorkerDraft(quote: PriceQuote, d: Directive): string {
  const p = quote.nearInUsd;
  return [
    `Draft by worker (model ${d.model}):`,
    `NEAR/USDC reference ${r2(p)} (${quote.source}).`,
    `Entry ${r2(p * 0.98)}-${r2(p * 0.99)}, stop ${r2(p * 0.95)}, target ${r2(p * 1.05)}.`,
  ].join('\n');
}

export function dryLeadFinal(job: JobBrief, d: Directive, draft: string): string {
  return clip(
    [
      `SIMULATED SIGNAL for job #${job.jobId} (dry-run, not financial advice)`,
      `Task: ${job.description}`,
      `Lead (model ${d.model}) reviewed this worker draft:`,
      draft,
      'Bias: WATCH.',
      'Testnet simulation: nothing here moves real money.',
    ].join('\n'),
  );
}

async function chat(model: string, system: string, user: string): Promise<string> {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) throw new Error('Real mode needs NEAR_AI_API_KEY (create one in the NEAR AI Cloud dashboard).');
  const base = (process.env.NEAR_AI_BASE_URL ?? 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!res.ok) throw new Error(`AI endpoint returned HTTP ${res.status} for model ${model}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI endpoint returned no text');
  return text;
}

const SAFETY = 'Write a short, clearly labelled, simulated note. Never give real financial advice. Max 500 characters.';
const system = (d: Directive) => [d.instructions, SAFETY].filter(Boolean).join(' ');

export async function workerDraft(dryRun: boolean, job: JobBrief, quote: PriceQuote, d: Directive): Promise<string> {
  if (dryRun) return dryWorkerDraft(quote, d);
  return clip(await chat(d.model, system(d), `Job: ${job.description}. NEAR/USDC reference price: ${quote.nearInUsd}.`));
}

export async function leadFinalize(dryRun: boolean, job: JobBrief, quote: PriceQuote, d: Directive, draft: string): Promise<string> {
  if (dryRun) return dryLeadFinal(job, d, draft);
  return clip(await chat(d.model, system(d), `Job: ${job.description}. NEAR/USDC reference price: ${quote.nearInUsd}.\nWorker draft:\n${draft}\nFinalize it.`));
}
