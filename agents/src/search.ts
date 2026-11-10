// Optional web search for real mode. It runs only when TAVILY_API_KEY is set in the environment
// (never in the repo). The runner searches first and hands the snippets to the model, so the model
// itself never browses and never holds a key. A page cannot make the runner pay anyone: payments
// are decided by runner code and checked by the contract, not by model text.
export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

/** Top results for a query, or an empty list when search is off or fails (the job still gets answered). */
export async function searchWeb(query: string, fetchImpl: FetchLike = fetch as unknown as FetchLike, max = 3): Promise<SearchHit[]> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return [];
  try {
    const res = await fetchImpl('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: query.slice(0, 300), max_results: max, search_depth: 'basic' }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
    return (body.results ?? [])
      .filter((r) => typeof r.url === 'string' && /^https?:\/\//.test(r.url))
      .slice(0, max)
      .map((r) => ({ title: (r.title ?? '').slice(0, 120), url: r.url as string, snippet: (r.content ?? '').slice(0, 300) }));
  } catch {
    return [];
  }
}

/** Text block for the model's prompt. */
export function formatSources(hits: SearchHit[]): string {
  return hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n');
}
