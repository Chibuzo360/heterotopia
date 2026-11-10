// The swarm: a worker agent drafts, a lead agent finalizes. Each agent's model and standing
// instructions come from the contract (set by the founder or a manager), not from this file.
// DRY_RUN=true (the default) uses deterministic text: no model call, no key, no credits.
// Real mode calls NEAR AI Cloud (OpenAI-compatible). Real mode is NOT exercised by the tests.
//
// The swarm is general purpose. Only a job that is clearly about a trading signal or a price gets
// the trading format (and the NEAR/USDC reference price); every other job is answered from its own
// text and the founder's instructions.
import type { JobBrief } from './brain.js';
import type { PriceQuote } from './intents.js';
import { formatSources, searchWeb } from './search.js';

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

const short = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`);

/** True when the job is about a trading signal or a price, so the trading format fits. */
export function isTradingJob(description: string): boolean {
  return /\b(signal|trading|trade|price|near\/usdc|entry|stop[- ]loss|take[- ]profit)\b/i.test(description);
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

/** Dry-run draft for any non-trading job: echoes the task so the pipeline is visibly working. */
export function dryGenericDraft(job: JobBrief, d: Directive): string {
  const lines = [`Draft by worker (model ${d.model}):`, `Task: ${short(job.description, 200)}`];
  if (d.instructions.trim()) lines.push(`Following the founder's instructions: ${short(d.instructions.trim(), 120)}`);
  return lines.join('\n');
}

export function dryGenericFinal(job: JobBrief, d: Directive, draft: string): string {
  return clip(
    [
      `DRY-RUN RESULT for job #${job.jobId} (placeholder: no model was called)`,
      `Lead (model ${d.model}) reviewed this worker draft:`,
      draft,
      'Turn on real mode (DRY_RUN=false with a NEAR AI key on the runner) to get a model-written answer to this task.',
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

const SAFETY_TRADING = 'Write a short, clearly labelled, simulated note. Never give real financial advice. Max 500 characters.';
const SAFETY_GENERAL =
  'Answer the job directly from its text. You cannot browse the internet, so do not invent links or live facts. ' +
  'Be concise and easy to scan: short "Label: value" lines or bullet points. Max 500 characters. This is a testnet simulation.';

const system = (d: Directive, trading: boolean) => [d.instructions, trading ? SAFETY_TRADING : SAFETY_GENERAL].filter(Boolean).join(' ');

/** Shown when real mode cannot reach a model (no credits, bad key, outage): the job still gets an answer. */
export const FALLBACK_NOTE = '[model unavailable, placeholder shown]';

export async function workerDraft(dryRun: boolean, job: JobBrief, quote: PriceQuote, d: Directive): Promise<string> {
  const trading = isTradingJob(job.description);
  const dry = () => (trading ? dryWorkerDraft(quote, d) : dryGenericDraft(job, d));
  if (dryRun) return dry();
  try {
    if (trading) return clip(await chat(d.model, system(d, true), `Job: ${job.description}. NEAR/USDC reference price: ${quote.nearInUsd}.`));
    // Other jobs: search first when a search key is configured, then answer from the sources only.
    const hits = await searchWeb(job.description);
    if (hits.length === 0) return clip(await chat(d.model, system(d, false), `Job: ${job.description}`));
    const sys = `${system(d, false)} Sources from a web search are provided: use only them for facts, cite as [1], [2], and include at most two of their links. Never invent a link.`;
    return clip(await chat(d.model, sys, `Job: ${job.description}\n\nSources:\n${formatSources(hits)}`));
  } catch {
    return `${FALLBACK_NOTE}\n${dry()}`;
  }
}

export async function leadFinalize(dryRun: boolean, job: JobBrief, quote: PriceQuote, d: Directive, draft: string): Promise<string> {
  const trading = isTradingJob(job.description);
  const dry = () => (trading ? dryLeadFinal(job, d, draft) : dryGenericFinal(job, d, draft));
  if (dryRun) return dry();
  const price = trading ? ` NEAR/USDC reference price: ${quote.nearInUsd}.` : '';
  try {
    return clip(await chat(d.model, system(d, trading), `Job: ${job.description}.${price}\nWorker draft:\n${draft}\nReview it, fix anything wrong, and finalize it.`));
  } catch {
    return clip(`${FALLBACK_NOTE}\n${dry()}`);
  }
}
