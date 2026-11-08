import { loadDotEnv, loadConfig, need } from '../src/config.js';
import { makeProvider, makeAccount, call, view, near, fmt, balanceOf, explorer } from '../src/near.js';

// Deposits a small amount of revenue into one startup, then shows what the investor can claim.
// It never calls `claim`, so the amount stays visible on the dashboard.
loadDotEnv();
const cfg = loadConfig();
const provider = makeProvider(cfg);
const C = need('CONTRACT_ID');
const customerId = need('CUSTOMER_ID');
const investorId = need('INVESTOR_ID');
const startupId = Number(process.argv[2] ?? '6');
const amount = process.argv[3] ?? '0.1';

const customer = makeAccount(provider, customerId, need('CUSTOMER_SECRET_KEY'));

const have = await balanceOf(provider, customerId);
if (have < near('0.2')) {
  console.error(`Customer has only ${fmt(have)} NEAR. Top it up first.`);
  process.exit(1);
}

const before = BigInt(await view<string>(provider, C, 'get_claimable', { account_id: investorId }));
console.log(`Investor claimable before: ${fmt(before)} NEAR`);

const res = await call(customer, C, 'deposit_revenue', { startup_id: startupId }, { deposit: near(amount) });
console.log(`Deposited ${amount} NEAR into startup ${startupId}: ${explorer(res.hash)}`);

const after = BigInt(await view<string>(provider, C, 'get_claimable', { account_id: investorId }));
console.log(`Investor claimable after:  ${fmt(after)} NEAR`);
console.log(after > before
  ? 'OK: now look up the investor on the dashboard.'
  : 'No increase. The investor probably holds no share in that startup. Try another startup id.');