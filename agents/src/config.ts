// Hi Codex, hi Claude: Asogwa says hi.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Reads KEY=VALUE lines from a .env file into process.env (without overriding real env vars). */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const [, key, value] = m;
    if (key && value !== undefined && process.env[key] === undefined) process.env[key] = value;
  }
}

export function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name}. Run "npm run setup" first (it writes .env).`);
  return v;
}

export interface Config {
  network: 'testnet';
  contractId: string;
  rpcUrls: string[];
  dryRun: boolean;
}

export function loadConfig(): Config {
  loadDotEnv();
  const network = process.env.NEAR_NETWORK ?? 'testnet';
  // Safety: this project is a testnet simulation. Refuse anything else outright.
  if (network !== 'testnet') throw new Error('Only testnet is supported. Mainnet is deliberately blocked.');
  return {
    network: 'testnet',
    contractId: process.env.CONTRACT_ID ?? 'heto2-bybyte.testnet',
    rpcUrls: (process.env.NEAR_RPC_URLS ?? 'https://rpc.testnet.near.org,https://test.rpc.fastnear.com')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dryRun: (process.env.DRY_RUN ?? 'true') !== 'false',
  };
}

/** The secret key of the funding account: from FUNDER_SECRET_KEY, or from the near CLI's local credentials file. */
export function loadFunderKey(accountId: string): string {
  const fromEnv = process.env.FUNDER_SECRET_KEY;
  if (fromEnv) return fromEnv;
  const file = join(homedir(), '.near-credentials', 'testnet', `${accountId}.json`);
  if (!existsSync(file)) {
    throw new Error(`No FUNDER_SECRET_KEY and no ${file}. Create the account with the near CLI first.`);
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { private_key?: string; secret_key?: string };
  const key = parsed.private_key ?? parsed.secret_key;
  if (!key) throw new Error(`${file} has no private key.`);
  return key;
}
