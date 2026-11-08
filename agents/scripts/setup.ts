// Creates the demo accounts as sub-accounts of the funder (the contract account), and writes
// .env with their keys. Keys are generated here, saved ONLY to .env (mode 600), and never printed.
//
// The agent account gets a FUNCTION-CALL access key and NO full-access key: the protocol itself
// only lets it call `agent_spend` and `submit_result` on the contract. Nobody can ever make that
// account do anything else (including move its own funds).
import { chmodSync, existsSync, writeFileSync } from 'node:fs';
import { KeyPair } from 'near-api-js';
import { loadConfig, loadDotEnv, loadFunderKey } from '../src/config.js';
import { newEncryptionKeypair } from '../src/crypto.js';
import { accountExists, actions, fmt, makeAccount, makeProvider, near, why } from '../src/near.js';

const FUNDER = process.env.FUNDER_ID ?? 'heto3-bybyte.testnet';

async function main() {
  loadDotEnv();
  const cfg = loadConfig();
  if (existsSync('.env') && process.env.FOUNDER_SECRET_KEY && process.env.AGENT_SECRET_KEY) {
    console.log('.env already has the demo accounts. Delete it to start fresh. Nothing changed.');
    return;
  }
  const provider = makeProvider(cfg);
  const funder = makeAccount(provider, FUNDER, loadFunderKey(FUNDER));
  console.log(`Funder ${FUNDER} balance: ${fmt((await provider.viewAccount({ accountId: FUNDER })).amount as unknown as string)} NEAR`);

  const plan = [
    { prefix: 'founder', fund: '0.5' },
    { prefix: 'investor', fund: '1' },
    { prefix: 'customer', fund: '1.5' },
    { prefix: 'vendor', fund: '0.1' },
  ];
  const env: Record<string, string> = {
    NEAR_NETWORK: 'testnet',
    CONTRACT_ID: cfg.contractId,
    NEAR_RPC_URLS: cfg.rpcUrls.join(','),
    DRY_RUN: 'true',
    FUNDER_ID: FUNDER,
  };

  for (const { prefix, fund } of plan) {
    const id = `${prefix}.${FUNDER}`;
    const kp = KeyPair.fromRandom('ed25519');
    if (await accountExists(provider, id)) {
      throw new Error(`${id} already exists but .env has no key for it. Use a new FUNDER_ID or recover its key.`);
    }
    await funder.createSubAccount({ accountOrPrefix: prefix, publicKey: kp.getPublicKey(), nearToTransfer: near(fund) });
    env[`${prefix.toUpperCase()}_ID`] = id;
    env[`${prefix.toUpperCase()}_SECRET_KEY`] = kp.toString();
    console.log(`created ${id} with ${fund} NEAR`);
  }

  // The agent: created with a function-call key only.
  const agentId = `agent1.${FUNDER}`;
  const agentKey = KeyPair.fromRandom('ed25519');
  if (await accountExists(provider, agentId)) throw new Error(`${agentId} already exists.`);
  await funder.signAndSendTransaction({
    receiverId: agentId,
    actions: [
      actions.createAccount(),
      actions.transfer(near('0.4')),
      actions.addFunctionCallAccessKey(agentKey.getPublicKey(), cfg.contractId, ['agent_spend', 'submit_result'], near('0.25')),
    ],
  });
  env.AGENT_ID = agentId;
  env.AGENT_SECRET_KEY = agentKey.toString();
  console.log(`created ${agentId} with a function-call key only (agent_spend, submit_result; gas allowance 0.25 NEAR)`);

  // The worker agent: the same kind of restricted key. The lead agent pays it for its drafts.
  const workerId = `agent2.${FUNDER}`;
  const workerKey = KeyPair.fromRandom('ed25519');
  if (await accountExists(provider, workerId)) throw new Error(`${workerId} already exists.`);
  await funder.signAndSendTransaction({
    receiverId: workerId,
    actions: [
      actions.createAccount(),
      actions.transfer(near('0.2')),
      actions.addFunctionCallAccessKey(workerKey.getPublicKey(), cfg.contractId, ['agent_spend', 'submit_result'], near('0.1')),
    ],
  });
  env.AGENT2_ID = workerId;
  env.AGENT2_SECRET_KEY = workerKey.toString();
  console.log(`created ${workerId} (worker) with a function-call key only`);

  // The customer's private-results keypair (separate from the NEAR key).
  const enc = newEncryptionKeypair();
  env.CUSTOMER_ENC_PUBLIC = enc.publicKeyHex;
  env.CUSTOMER_ENC_SECRET = enc.secretKeyHex;

  writeFileSync('.env', Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  chmodSync('.env', 0o600);
  console.log('\nWrote .env (git-ignored, mode 600). Keys were not printed. Next: npm run e2e');
}

main().catch((e) => {
  console.error('Setup failed:', why(e));
  process.exit(1);
});
