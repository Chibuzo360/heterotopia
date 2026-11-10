import test from 'node:test';
import assert from 'node:assert/strict';
import { FALLBACK_NOTE, MAX_RESULT_CHARS, dryGenericDraft, dryGenericFinal, isTradingJob, leadFinalize, workerDraft, type Directive } from '../src/swarm.js';

const quote = { nearInUsd: 5, source: 'test' } as never;
const d: Directive = { model: 'z-ai/glm-5.3-flash', instructions: 'Summarize the text in three bullets.', swarm_role: 'worker' };

test('only trading or price jobs get the trading format', () => {
  assert.equal(isTradingJob('Daily NEAR/USDC signal'), true);
  assert.equal(isTradingJob('What is the price of NEAR today'), true);
  assert.equal(isTradingJob('Summarize this article about solar panels'), false);
  assert.equal(isTradingJob('Rewrite my cover letter'), false);
});

test('dry-run for a non-trading job echoes the task and is not a trading note', async () => {
  const job = { jobId: 7, description: 'Summarize this article about solar panels' };
  const draft = await workerDraft(true, job, quote, d);
  const final = await leadFinalize(true, job, quote, d, draft);
  assert.match(draft, /solar panels/);
  assert.match(final, /DRY-RUN RESULT for job #7/);
  assert.doesNotMatch(final, /SIGNAL|NEAR\/USDC|Entry|stop/i);
  assert.ok(final.length <= MAX_RESULT_CHARS);
});

test('dry-run for a trading job keeps the original signal format', async () => {
  const job = { jobId: 8, description: 'Daily NEAR/USDC signal' };
  const draft = await workerDraft(true, job, quote, d);
  const final = await leadFinalize(true, job, quote, d, draft);
  assert.match(final, /SIMULATED SIGNAL for job #8/);
});

test('a very long job text and long instructions still fit the result limit', () => {
  const job = { jobId: 9, description: 'x'.repeat(280) };
  const long: Directive = { ...d, instructions: 'y'.repeat(500) };
  const final = dryGenericFinal(job, long, dryGenericDraft(job, long));
  assert.ok(final.length <= MAX_RESULT_CHARS);
});

test('real mode without a working model falls back to a labelled placeholder instead of failing the job', async () => {
  const saved = process.env.NEAR_AI_API_KEY;
  delete process.env.NEAR_AI_API_KEY;
  try {
    const job = { jobId: 10, description: 'Summarize this article about solar panels' };
    const draft = await workerDraft(false, job, quote, d);
    const final = await leadFinalize(false, job, quote, d, draft);
    assert.match(draft, new RegExp(FALLBACK_NOTE.replace(/[[\]]/g, '\\$&')));
    assert.match(final, /model unavailable/);
    assert.ok(final.length <= MAX_RESULT_CHARS);
  } finally {
    if (saved !== undefined) process.env.NEAR_AI_API_KEY = saved;
  }
});
