// A local, fail-closed check the agent runs BEFORE it asks the contract to pay someone.
// The contract's allowlist is the real wall; this catches look-alike accounts early and says why.

const CONFUSABLE: Record<string, string> = { '0': 'o', '1': 'l', i: 'l', '5': 's', '3': 'e', '4': 'a' };

function normalize(id: string): string {
  let s = id.toLowerCase();
  s = s.replace(/rn/g, 'm').replace(/vv/g, 'w');
  return [...s].map((c) => CONFUSABLE[c] ?? c).join('');
}

export function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[a.length]![b.length]!;
}

export type PayeeVerdict =
  | { ok: true }
  | { ok: false; reason: 'not_on_allowlist' | 'look_alike'; lookAlikeOf?: string };

export function checkPayee(candidate: string, allowlist: string[]): PayeeVerdict {
  if (allowlist.includes(candidate)) return { ok: true };
  for (const allowed of allowlist) {
    const near = levenshtein(normalize(candidate), normalize(allowed)) <= 2;
    if (near) return { ok: false, reason: 'look_alike', lookAlikeOf: allowed };
  }
  return { ok: false, reason: 'not_on_allowlist' };
}
