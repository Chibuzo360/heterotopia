// A READ-ONLY price lookup through NEAR Intents (1Click API, `dry: true`). A dry quote returns a
// price and no deposit address, so no funds can move. We never swap. The quote prices real
// mainnet assets; it is only used to put a market price in the demo's dry-run result. If the call
// fails for any reason we fall back to a labelled stub price, so the demo never breaks.

export interface PriceQuote {
  source: string;
  nearInUsd: number;
}

const FALLBACK: PriceQuote = { source: 'stub', nearInUsd: 3.68 };

export async function nearUsdQuote(): Promise<PriceQuote> {
  try {
    const res = await fetch('https://1click.chaindefuser.com/v0/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        dry: true,
        swapType: 'EXACT_INPUT',
        slippageTolerance: 100,
        originAsset: 'nep141:wrap.near',
        depositType: 'ORIGIN_CHAIN',
        destinationAsset: 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1',
        amount: '1000000000000000000000000', // 1 NEAR
        refundTo: 'example.near',
        refundType: 'ORIGIN_CHAIN',
        recipient: 'example.near',
        recipientType: 'DESTINATION_CHAIN',
        deadline: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    });
    if (!res.ok) return FALLBACK;
    const json: any = await res.json();
    const usd = Number(json?.quote?.amountOutFormatted);
    return Number.isFinite(usd) && usd > 0 ? { source: 'near-intents-dry-quote', nearInUsd: usd } : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
