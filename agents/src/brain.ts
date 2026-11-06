// The swarm's "thinking" step. DRY_RUN=true (the default) uses a deterministic stub: no LLM, no
// credits, same output every time, so a judge can reproduce it. Real mode calls an
// OpenAI-compatible endpoint (NEAR AI Cloud) that you configure through env vars. Real mode is
// NOT exercised by our tests.
import type { PriceQuote } from './intents.js';

export interface JobBrief {
  jobId: number;
  description: string;
}

export function dryRunSignal(job: JobBrief, quote: PriceQuote): string {
  const p = quote.nearInUsd;
  const r = (x: number) => x.toFixed(2);
  return [
    `SIMULATED SIGNAL for job #${job.jobId} (dry-run, not financial advice)`,
    `Task: ${job.description}`,
    `Pair: NEAR/USDC, reference price ${r(p)} (${quote.source})`,
    `Bias: WATCH. Entry ${r(p * 0.98)}-${r(p * 0.99)}, stop ${r(p * 0.95)}, target ${r(p * 1.05)}`,
    'Testnet simulation: nothing here moves real money.',
  ].join('\n');
}

export async function realSignal(job: JobBrief, quote: PriceQuote): Promise<string> {
  const base = process.env.NEAR_AI_BASE_URL;
  const key = process.env.NEAR_AI_API_KEY;
  const model = process.env.NEAR_AI_MODEL;
  if (!base || !key || !model) {
    throw new Error('Real mode needs NEAR_AI_BASE_URL, NEAR_AI_API_KEY and NEAR_AI_MODEL (see NEAR AI Cloud docs).');
  }
  const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You write short, clearly labelled, simulated trading notes. Never give real financial advice.' },
        { role: 'user', content: `Job: ${job.description}. NEAR/USDC reference price: ${quote.nearInUsd}. Max 600 characters.` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`AI endpoint returned HTTP ${res.status}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('AI endpoint returned no text');
  return text;
}

export async function produceResult(dryRun: boolean, job: JobBrief, quote: PriceQuote): Promise<string> {
  return dryRun ? dryRunSignal(job, quote) : realSignal(job, quote);
}
