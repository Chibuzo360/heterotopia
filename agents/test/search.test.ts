import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSources, searchWeb } from '../src/search.js';

const okFetch = (results: unknown[]) => async () => ({ ok: true, status: 200, json: async () => ({ results }) });

test('search is off without a key', async () => {
  delete process.env.TAVILY_API_KEY;
  assert.deepEqual(await searchWeb('anything', okFetch([{ url: 'https://a.test', title: 't', content: 'c' }])), []);
});

test('with a key it returns clean hits and drops non-http links', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  const hits = await searchWeb('q', okFetch([
    { title: 'A', url: 'https://a.test/x', content: 'alpha' },
    { title: 'B', url: 'javascript:alert(1)', content: 'bad' },
  ]));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'https://a.test/x');
  assert.match(formatSources(hits), /\[1\] A\nhttps:\/\/a\.test\/x\nalpha/);
  delete process.env.TAVILY_API_KEY;
});

test('a failing search never throws, the job is still answered', async () => {
  process.env.TAVILY_API_KEY = 'test-key';
  assert.deepEqual(await searchWeb('q', async () => { throw new Error('network down'); }), []);
  assert.deepEqual(await searchWeb('q', async () => ({ ok: false, status: 429, json: async () => ({}) })), []);
  delete process.env.TAVILY_API_KEY;
});
