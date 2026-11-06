// Thin wrapper over near-api-js: one place for connecting, calling, viewing and reading events.
import {
  Account,
  FailoverRpcProvider,
  JsonRpcProvider,
  KeyPairSigner,
  actions,
  type Provider,
} from 'near-api-js';
import type { Config } from './config.js';

export const YOCTO = 10n ** 24n;
/** Whole or fractional NEAR to yoctoNEAR, exactly (no floating point). */
export function near(amount: string | number): bigint {
  const [whole = '0', frac = ''] = String(amount).split('.');
  return BigInt(whole) * YOCTO + BigInt((frac + '0'.repeat(24)).slice(0, 24));
}
export function fmt(yocto: bigint | string): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, '0').slice(0, 6).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function makeProvider(cfg: Config): Provider {
  const providers = cfg.rpcUrls.map((url) => new JsonRpcProvider({ url }));
  return providers.length === 1 ? providers[0]! : new FailoverRpcProvider(providers);
}

export function makeAccount(provider: Provider, accountId: string, secretKey: string): Account {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as `ed25519:${string}`));
}

export interface HetoEvent {
  standard: string;
  version: string;
  event: string;
  data: any;
}

/** Pulls NEP-297 `EVENT_JSON:` lines out of a transaction's logs. */
export function parseEvents(logs: string[]): HetoEvent[] {
  const out: HetoEvent[] = [];
  for (const line of logs) {
    if (!line.startsWith('EVENT_JSON:')) continue;
    try {
      out.push(JSON.parse(line.slice('EVENT_JSON:'.length)) as HetoEvent);
    } catch {
      /* ignore a malformed line */
    }
  }
  return out;
}

export interface CallResult<T> {
  value: T;
  events: HetoEvent[];
  hash: string;
}

export async function view<T>(provider: Provider, contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  const v = await provider.callFunction<any>({ contractId, method, args });
  return v as T;
}

/** Sends a change call, waits for it to finish, and returns the decoded return value and events. */
export async function call<T = unknown>(
  account: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown> = {},
  opts: { deposit?: bigint; gas?: bigint } = {},
): Promise<CallResult<T>> {
  const res: any = await account.callFunctionRaw({
    contractId,
    methodName,
    args,
    deposit: opts.deposit ?? 0n,
    gas: opts.gas ?? 30_000_000_000_000n,
    waitUntil: 'EXECUTED',
  });
  const status = res.status;
  if (status && typeof status === 'object' && 'Failure' in status) {
    throw new Error(`${methodName} failed: ${JSON.stringify(status.Failure).slice(0, 400)}`);
  }
  const logs: string[] = (res.receipts_outcome ?? []).flatMap((r: any) => r.outcome?.logs ?? []);
  let value: unknown = undefined;
  const b64: string | undefined = status?.SuccessValue;
  if (b64) {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    try {
      value = JSON.parse(text);
    } catch {
      value = text;
    }
  }
  return { value: value as T, events: parseEvents(logs), hash: res.transaction?.hash ?? '' };
}

export function explorer(hash: string): string {
  return `https://explorer.testnet.near.org/transactions/${hash}`;
}

/** A short, safe description of an error, never including keys. */
export function why(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/ed25519:[A-Za-z0-9]{40,}/g, 'ed25519:<hidden>').slice(0, 300);
}

export async function accountExists(provider: Provider, accountId: string): Promise<boolean> {
  try {
    await provider.viewAccount({ accountId });
    return true;
  } catch {
    return false;
  }
}

export async function balanceOf(provider: Provider, accountId: string): Promise<bigint> {
  const a = await provider.viewAccount({ accountId });
  return BigInt((a as any).amount);
}

export { actions };
