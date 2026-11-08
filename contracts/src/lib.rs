//! Heterotopia (heto): a startup that runs itself, on NEAR testnet.
//!
//! One contract holds many startups. Each startup has founder-defined tiers, tiered share NFTs,
//! soulbound role NFTs, and a revenue pool that is divided into buckets on every deposit.
//!
//! Layout: `models` (types and constants), `events` (log lines), `internal` (private helpers),
//! `tests`. This file holds the contract state and its public methods.
//!
//! Money rules:
//! - Every revenue deposit pays the platform fee first, then splits by the startup's allocation
//!   into: shareholders (split again by tier weight), a role pool (active roles, by weight), the
//!   agent budget bucket, and the operations bucket. No method moves money between buckets.
//! - Whoever held a share NFT while revenue accrued keeps that revenue. When a share is sold, its
//!   pending revenue is settled into the seller's balance and the buyer starts fresh.
//! - Share-sale money goes straight to the startup's treasury, so the contract only ever holds
//!   unclaimed revenue.

mod events;
mod internal;
mod models;
#[cfg(test)]
mod tests;

pub use models::*;

use events::{emit, emit_event};
use internal::{accrual, bps_of, has_shareholders, validate_media, validate_policy};
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near,
    require,
};

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Startups,
    Tokens,
    OwnerTokens,
    Balances,
    AgentStats,
    Jobs,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    /// Receives the platform fee. Fixed at deployment.
    platform_account: AccountId,
    platform_fee_bps: u32,
    next_startup_id: StartupId,
    /// Only ever grows; used to make unique token ids.
    next_token_num: u64,
    /// Tokens that currently exist (minted minus revoked).
    live_tokens: u64,
    startups: IterableMap<StartupId, Startup>,
    tokens: LookupMap<TokenId, Token>,
    tokens_per_owner: LookupMap<AccountId, Vec<TokenId>>,
    /// Revenue already settled to an account (from shares it sold or roles it lost), waiting for
    /// `claim`.
    balances: LookupMap<AccountId, NearToken>,
    /// Every agent account's record across all startups.
    agent_stats: LookupMap<AccountId, AgentStats>,
    next_job_id: JobId,
    /// Paid jobs held in escrow (and finished ones, kept as a record).
    jobs: IterableMap<JobId, Job>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(platform_account: AccountId, platform_fee_bps: u32) -> Self {
        require!(
            platform_fee_bps <= MAX_PLATFORM_FEE_BPS,
            "Platform fee is capped at 5%"
        );
        Self {
            platform_account,
            platform_fee_bps,
            next_startup_id: 1,
            next_token_num: 0,
            live_tokens: 0,
            startups: IterableMap::new(StorageKey::Startups),
            tokens: LookupMap::new(StorageKey::Tokens),
            tokens_per_owner: LookupMap::new(StorageKey::OwnerTokens),
            balances: LookupMap::new(StorageKey::Balances),
            agent_stats: LookupMap::new(StorageKey::AgentStats),
            next_job_id: 1,
            jobs: IterableMap::new(StorageKey::Jobs),
        }
    }

    // ---------------------------------------------------------------- startups

    /// Anyone can found a startup. The caller becomes its founder and defines its tiers.
    /// `description` says what the startup is for (1-280 characters).
    /// `treasury` (default: the founder) receives share-sale money; `allocation` (default
    /// 60/20/20 with a 10% role pool) decides how revenue is divided. Both are fixed for good.
    pub fn create_startup(
        &mut self,
        name: String,
        description: String,
        tiers: Vec<TierInput>,
        treasury: Option<AccountId>,
        allocation: Option<Allocation>,
    ) -> StartupId {
        require!(
            !name.trim().is_empty() && name.len() <= 64,
            "Name must be 1-64 characters"
        );
        check_description(&description);
        require!(
            !tiers.is_empty() && tiers.len() <= MAX_TIERS,
            "Between 1 and 8 tiers required"
        );
        let allocation = allocation.unwrap_or_else(Allocation::default_split);
        allocation.validate();

        let tiers: Vec<Tier> = tiers
            .into_iter()
            .map(|t| {
                require!(
                    !t.name.trim().is_empty() && t.name.len() <= 32,
                    "Tier name must be 1-32 characters"
                );
                require!(!t.price.is_zero(), "Tier price must be above zero");
                require!(t.max_supply > 0, "Tier supply must be above zero");
                require!(t.weight > 0, "Tier weight must be above zero");
                Tier {
                    name: t.name,
                    price: t.price,
                    max_supply: t.max_supply,
                    minted: 0,
                    weight: t.weight,
                    acc_per_nft: NearToken::from_yoctonear(0),
                }
            })
            .collect();

        let founder = env::predecessor_account_id();
        let id = self.next_startup_id;
        self.next_startup_id += 1;
        self.startups.insert(
            id,
            Startup {
                id,
                name,
                description,
                treasury: treasury.unwrap_or_else(|| founder.clone()),
                founder,
                tiers,
                allocation,
                raised: NearToken::from_yoctonear(0),
                revenue: NearToken::from_yoctonear(0),
                agent_balance: NearToken::from_yoctonear(0),
                ops_balance: NearToken::from_yoctonear(0),
                role_acc: NearToken::from_yoctonear(0),
                total_role_weight: 0,
                agents: vec![],
                manager_roles: vec![],
                manager_max_per_tx: NearToken::from_yoctonear(0),
                manager_max_daily: NearToken::from_yoctonear(0),
                results_private: false,
                status: StartupStatus::Active,
            },
        );
        id
    }

    /// Founder freezes the startup here and records the contract it moved to. This is only the
    /// freeze marker: actually re-creating shares on the new contract is a roadmap item.
    pub fn mark_migrated(&mut self, startup_id: StartupId, new_contract: AccountId) {
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can migrate the startup"
        );
        require!(
            startup.status == StartupStatus::Active,
            "Startup is already migrated"
        );
        startup.status = StartupStatus::Migrated { to: new_contract };
    }

    /// The founder rewords what the startup is for. This never touches money or shares.
    pub fn set_description(&mut self, startup_id: StartupId, description: String) {
        check_description(&description);
        let startup = self.founder_startup(startup_id);
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        startup.description = description;
        emit_event(
            "heto",
            "1.0.0",
            "startup_description_set",
            json!([{ "startup_id": startup_id }]),
        );
    }

    // ------------------------------------------------------------------ minting

    /// Investors buy one share NFT of a tier. The platform fee goes to the platform, the rest to
    /// the startup's treasury, and any extra deposit is refunded.
    #[payable]
    pub fn buy_share(&mut self, startup_id: StartupId, tier_index: u32) -> TokenId {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit();
        let fee_bps = self.platform_fee_bps;
        let platform = self.platform_account.clone();

        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        let treasury = startup.treasury.clone();
        let tier = startup
            .tiers
            .get_mut(tier_index as usize)
            .unwrap_or_else(|| env::panic_str("Tier not found"));
        require!(tier.minted < tier.max_supply, "Tier is sold out");
        require!(
            deposit >= tier.price,
            "Attached deposit is below the tier price"
        );

        let price = tier.price;
        let reward_debt = tier.acc_per_nft;
        tier.minted += 1;
        startup.raised = startup
            .raised
            .checked_add(price)
            .unwrap_or_else(|| env::panic_str("Raised amount overflow"));

        let token_id = self.internal_mint(
            startup_id,
            buyer.clone(),
            TokenKind::Share { tier: tier_index },
            reward_debt,
        );

        let fee = bps_of(price.as_yoctonear(), fee_bps);
        if fee > 0 {
            let _ = Promise::new(platform).transfer(NearToken::from_yoctonear(fee));
        }
        let _ =
            Promise::new(treasury).transfer(NearToken::from_yoctonear(price.as_yoctonear() - fee));

        if let Some(excess) = deposit.checked_sub(price)
            && !excess.is_zero()
        {
            let _ = Promise::new(buyer).transfer(excess);
        }
        token_id
    }

    /// The founder gives someone (a team member, or an outside CEO who owns no shares) a
    /// non-transferable role NFT. `weight` is its share of the startup's role pool (0 = title
    /// only, no earnings). `media` is the original image and can never be changed.
    pub fn mint_role(
        &mut self,
        startup_id: StartupId,
        to: AccountId,
        role: String,
        weight: u32,
        media: Option<String>,
    ) -> TokenId {
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can mint roles"
        );
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        require!(
            !role.trim().is_empty() && role.len() <= 32,
            "Role must be 1-32 characters"
        );
        require!(weight <= MAX_ROLE_WEIGHT, "Role weight is capped at 100");
        validate_media(&media);

        // A new role starts at the current role-pool counter, so it collects nothing from the
        // past.
        let debt = startup.role_acc;
        startup.total_role_weight += weight as u64;
        self.internal_mint(
            startup_id,
            to,
            TokenKind::Role {
                role,
                weight,
                media,
                display_media: None,
            },
            debt,
        )
    }

    /// The founder removes a role (resignation or dismissal). Only role NFTs can be revoked;
    /// shares belong to their holders and the founder can never take them back. What the role
    /// earned so far is settled to its holder, and it stops earning from now on.
    pub fn revoke_role(&mut self, token_id: TokenId) {
        let token = self
            .tokens
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Token not found"));
        let TokenKind::Role { weight, .. } = &token.kind else {
            env::panic_str("Only role NFTs can be revoked")
        };
        let startup = self
            .startups
            .get_mut(&token.startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can revoke roles"
        );

        let (pending, _) = accrual(startup, &token.kind, token.reward_debt);
        startup.total_role_weight -= *weight as u64;

        self.tokens.remove(&token_id);
        self.remove_from_owner(&token.owner_id, &token_id);
        self.live_tokens -= 1;
        if pending > 0 {
            self.credit(&token.owner_id, pending);
        }
        emit(
            "nft_burn",
            json!([{ "owner_id": token.owner_id, "token_ids": [token_id] }]),
        );
    }

    /// A role's owner picks the picture it displays (for example as a profile picture). The
    /// original `media` set at mint is never touched. Pass `None` to go back to the original.
    pub fn set_display_media(&mut self, token_id: TokenId, display_media: Option<String>) {
        validate_media(&display_media);
        let token = self
            .tokens
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("Token not found"));
        require!(
            token.owner_id == env::predecessor_account_id(),
            "Only the owner can change the display image"
        );
        match &mut token.kind {
            TokenKind::Role {
                display_media: slot,
                ..
            } => *slot = display_media,
            TokenKind::Share { .. } => env::panic_str("Only role NFTs have a display image"),
        }
        emit_event(
            "heto",
            "1.0.0",
            "role_display_changed",
            json!([{ "token_id": token_id }]),
        );
    }

    // ------------------------------------------------------------ NEP-171 core

    /// NEP-171 transfer. Share NFTs move freely; role NFTs are soulbound and always panic.
    #[payable]
    pub fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        require!(approval_id.is_none(), "Approvals are not supported");
        let _ = memo;

        self.internal_transfer(env::predecessor_account_id(), receiver_id, token_id);
    }

    pub fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.get(&token_id).cloned()
    }

    // ------------------------------------------------ NEP-181 style enumeration

    pub fn nft_total_supply(&self) -> U128 {
        U128(self.live_tokens as u128)
    }

    pub fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        let ids = self
            .tokens_per_owner
            .get(&account_id)
            .cloned()
            .unwrap_or_default();
        let start = from_index.map(|i| i.0 as usize).unwrap_or(0);
        let limit = limit.unwrap_or(50) as usize;
        ids.iter()
            .skip(start)
            .take(limit)
            .filter_map(|id| self.tokens.get(id).cloned())
            .collect()
    }

    // ------------------------------------------------------------------ revenue

    /// Anyone (a customer, or our labeled mock customer in dry-run mode) pays revenue into a
    /// startup. The platform fee comes off the top; the rest is divided by the startup's
    /// allocation. Role NFTs earn only from the role pool, so an external CEO is paid from it and
    /// not from the shareholders' part.
    #[payable]
    pub fn deposit_revenue(&mut self, startup_id: StartupId) {
        let deposit = env::attached_deposit();
        require!(!deposit.is_zero(), "Attach revenue to deposit");
        self.internal_revenue(startup_id, env::predecessor_account_id(), deposit);
    }

    /// Pays the caller everything they have earned: revenue settled from shares they sold or
    /// roles they lost, plus what their current share and role NFTs have accrued. Pays across all
    /// startups in one go.
    ///
    /// Known limit: if the payout transfer itself fails (for example the account was deleted),
    /// the amount is not restored. Acceptable for a testnet demo; production needs a callback.
    pub fn claim(&mut self) -> Promise {
        let account = env::predecessor_account_id();
        let mut total = self
            .balances
            .get(&account)
            .map(|b| b.as_yoctonear())
            .unwrap_or(0);

        let ids = self
            .tokens_per_owner
            .get(&account)
            .cloned()
            .unwrap_or_default();
        for id in ids {
            let Some(token) = self.tokens.get_mut(&id) else {
                continue;
            };
            let startup = self
                .startups
                .get(&token.startup_id)
                .unwrap_or_else(|| env::panic_str("Startup not found"));
            let (pending, new_debt) = accrual(startup, &token.kind, token.reward_debt);
            total = total
                .checked_add(pending)
                .unwrap_or_else(|| env::panic_str("Claim overflow"));
            token.reward_debt = new_debt;
        }
        require!(total > 0, "Nothing to claim");

        self.balances.remove(&account);
        emit_event(
            "heto",
            "1.0.0",
            "revenue_claim",
            json!([{ "account_id": account, "amount": total.to_string() }]),
        );
        Promise::new(account).transfer(NearToken::from_yoctonear(total))
    }

    /// The founder spends from the operations bucket (hosting, credits, marketing). Every spend
    /// needs a public memo and is logged as an event.
    pub fn spend_operations(
        &mut self,
        startup_id: StartupId,
        to: AccountId,
        amount: NearToken,
        memo: String,
    ) -> Promise {
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can spend operations funds"
        );
        require!(
            !memo.trim().is_empty() && memo.len() <= 140,
            "Memo must be 1-140 characters"
        );
        require!(!amount.is_zero(), "Amount must be above zero");
        startup.ops_balance = startup
            .ops_balance
            .checked_sub(amount)
            .unwrap_or_else(|| env::panic_str("Not enough operations balance"));

        emit_event(
            "heto",
            "1.0.0",
            "operations_spend",
            json!([{
                "startup_id": startup_id,
                "to": to,
                "amount": amount.as_yoctonear().to_string(),
                "memo": memo,
            }]),
        );
        Promise::new(to).transfer(amount)
    }

    // ------------------------------------------------------------------- agents

    /// The founder names the roles (for example `["CTO"]`) whose active holders may manage
    /// agents, and the most a manager may allow any one agent. Founder only. Pass an empty list
    /// to turn delegation off.
    pub fn set_agent_managers(
        &mut self,
        startup_id: StartupId,
        roles: Vec<String>,
        max_per_tx: NearToken,
        max_daily: NearToken,
    ) {
        require!(roles.len() <= MAX_MANAGER_ROLES, "At most 5 manager roles");
        for (i, r) in roles.iter().enumerate() {
            require!(
                !r.trim().is_empty() && r.len() <= 32,
                "Role must be 1-32 characters"
            );
            require!(!roles[..i].contains(r), "Duplicate role");
        }
        require!(
            max_daily >= max_per_tx,
            "Daily limit cannot be below the per-payment limit"
        );
        let startup = self.founder_startup(startup_id);
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        startup.manager_roles = roles.clone();
        startup.manager_max_per_tx = max_per_tx;
        startup.manager_max_daily = max_daily;
        emit_event(
            "heto",
            "1.0.0",
            "agent_managers_set",
            json!([{ "startup_id": startup_id, "roles": roles }]),
        );
    }

    /// Hire an AI agent. Callable by the founder or a manager. It can later spend from the agent
    /// budget bucket through `agent_spend`, within these limits and only to the listed payees. A
    /// new agent starts on probation (see `PROBATION_DAYS`).
    pub fn register_agent(
        &mut self,
        startup_id: StartupId,
        agent_id: AccountId,
        name: String,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        payees: Vec<AccountId>,
    ) {
        let by_founder = self.require_agent_admin(startup_id);
        require!(
            !name.trim().is_empty() && name.len() <= 32,
            "Agent name must be 1-32 characters"
        );
        validate_policy(per_tx_cap, daily_cap, &payees);
        let caller = env::predecessor_account_id();
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        require!(
            by_founder
                || (per_tx_cap <= startup.manager_max_per_tx
                    && daily_cap <= startup.manager_max_daily),
            "Above the limits set for managers"
        );
        require!(startup.agents.len() < MAX_AGENTS, "At most 5 agents");
        require!(
            !startup.agents.iter().any(|a| a.account_id == agent_id),
            "Agent already registered"
        );
        startup.agents.push(Agent {
            account_id: agent_id.clone(),
            name,
            per_tx_cap,
            daily_cap,
            payees,
            active: true,
            hired_by: caller.clone(),
            probation_until: env::block_timestamp() + PROBATION_DAYS * NANOS_PER_DAY,
            day: 0,
            spent_today: NearToken::from_yoctonear(0),
            model: String::new(),
            instructions: String::new(),
            swarm_role: String::new(),
        });
        self.update_stats(&agent_id, |s| s.startups_served += 1);
        emit_event(
            "heto",
            "1.0.0",
            "agent_registered",
            json!([{ "startup_id": startup_id, "agent": agent_id, "by": caller }]),
        );
    }

    /// Change an agent's limits and payee list (founder or manager). Today's spending is kept.
    pub fn update_agent_policy(
        &mut self,
        startup_id: StartupId,
        agent_id: AccountId,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        payees: Vec<AccountId>,
    ) {
        let by_founder = self.require_agent_admin(startup_id);
        validate_policy(per_tx_cap, daily_cap, &payees);
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            by_founder
                || (per_tx_cap <= startup.manager_max_per_tx
                    && daily_cap <= startup.manager_max_daily),
            "Above the limits set for managers"
        );
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"));
        agent.per_tx_cap = per_tx_cap;
        agent.daily_cap = daily_cap;
        agent.payees = payees;
        emit_event(
            "heto",
            "1.0.0",
            "agent_policy_updated",
            json!([{ "startup_id": startup_id, "agent": agent_id,
                     "by": env::predecessor_account_id() }]),
        );
    }

    /// Kill switch: pause (`false`) or resume (`true`) an agent (founder or manager).
    pub fn set_agent_active(&mut self, startup_id: StartupId, agent_id: AccountId, active: bool) {
        self.require_agent_admin(startup_id);
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"));
        let newly_paused = agent.active && !active;
        agent.active = active;
        if newly_paused {
            self.update_stats(&agent_id, |s| s.times_paused += 1);
        }
        emit_event(
            "heto",
            "1.0.0",
            "agent_active_changed",
            json!([{ "startup_id": startup_id, "agent": agent_id, "active": active,
                     "by": env::predecessor_account_id() }]),
        );
    }

    /// End an agent's probation early, so it can use its full limits (founder or manager).
    pub fn promote_agent(&mut self, startup_id: StartupId, agent_id: AccountId) {
        self.require_agent_admin(startup_id);
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"));
        agent.probation_until = 0;
        emit_event(
            "heto",
            "1.0.0",
            "agent_promoted",
            json!([{ "startup_id": startup_id, "agent": agent_id,
                     "by": env::predecessor_account_id() }]),
        );
    }

    /// Choose which AI model an agent uses, give it standing instructions, and set its place in the
    /// swarm (for example "lead" or "worker"). Founder or manager. The contract stores and shows
    /// these, and the agent's program reads them from here. The contract cannot force an off-chain
    /// program to obey them, but every spending rule is still enforced on-chain.
    pub fn set_agent_directive(
        &mut self,
        startup_id: StartupId,
        agent_id: AccountId,
        model: String,
        instructions: String,
        swarm_role: String,
    ) {
        self.require_agent_admin(startup_id);
        require!(
            !model.trim().is_empty() && model.len() <= MAX_MODEL_LEN,
            "Model must be 1-64 characters"
        );
        require!(
            instructions.len() <= MAX_INSTRUCTIONS,
            "Instructions are at most 500 characters"
        );
        require!(
            !swarm_role.trim().is_empty() && swarm_role.len() <= MAX_SWARM_ROLE,
            "Swarm role must be 1-32 characters"
        );
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"));
        agent.model = model.clone();
        agent.instructions = instructions;
        agent.swarm_role = swarm_role.clone();
        emit_event(
            "heto",
            "1.0.0",
            "agent_directive_set",
            json!([{ "startup_id": startup_id, "agent": agent_id, "model": model,
                     "swarm_role": swarm_role, "by": env::predecessor_account_id() }]),
        );
    }

    /// Fire an agent for good (founder or manager). It stays on the agent's record.
    pub fn remove_agent(&mut self, startup_id: StartupId, agent_id: AccountId) {
        self.require_agent_admin(startup_id);
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let before = startup.agents.len();
        startup.agents.retain(|a| a.account_id != agent_id);
        require!(startup.agents.len() < before, "Agent not found");
        self.update_stats(&agent_id, |s| s.times_removed += 1);
        emit_event(
            "heto",
            "1.0.0",
            "agent_removed",
            json!([{ "startup_id": startup_id, "agent": agent_id,
                     "by": env::predecessor_account_id() }]),
        );
    }

    /// An AI agent pays someone from the agent budget bucket. Returns `true` if the payment was
    /// made, `false` if the agent's rules refused it. Either way an event records what happened
    /// and why, so the dashboard can show approvals and refusals. A refusal changes no balances.
    /// Callers who are not registered agents of this startup panic. While on probation an agent
    /// may use only `PROBATION_BPS` of its limits.
    pub fn agent_spend(
        &mut self,
        startup_id: StartupId,
        to: AccountId,
        amount: NearToken,
        memo: String,
    ) -> bool {
        let caller = env::predecessor_account_id();
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == caller)
            .unwrap_or_else(|| env::panic_str("Not a registered agent of this startup"));
        require!(
            !memo.trim().is_empty() && memo.len() <= 140,
            "Memo must be 1-140 characters"
        );
        require!(!amount.is_zero(), "Amount must be above zero");

        let now = env::block_timestamp();
        let today = now / NANOS_PER_DAY;
        if agent.day != today {
            agent.day = today;
            agent.spent_today = NearToken::from_yoctonear(0);
        }
        let spent_after = agent
            .spent_today
            .as_yoctonear()
            .saturating_add(amount.as_yoctonear());

        let on_probation = now < agent.probation_until;
        let (per_tx_limit, daily_limit) = if on_probation {
            (
                bps_of(agent.per_tx_cap.as_yoctonear(), PROBATION_BPS),
                bps_of(agent.daily_cap.as_yoctonear(), PROBATION_BPS),
            )
        } else {
            (
                agent.per_tx_cap.as_yoctonear(),
                agent.daily_cap.as_yoctonear(),
            )
        };

        let refusal = if !agent.active {
            Some("agent_paused")
        } else if amount.as_yoctonear() > per_tx_limit {
            Some(if on_probation && amount <= agent.per_tx_cap {
                "probation_per_payment_cap"
            } else {
                "over_per_payment_cap"
            })
        } else if spent_after > daily_limit {
            Some(
                if on_probation && spent_after <= agent.daily_cap.as_yoctonear() {
                    "probation_daily_cap"
                } else {
                    "over_daily_cap"
                },
            )
        } else if !agent.payees.contains(&to) {
            Some("payee_not_allowed")
        } else if amount > startup.agent_balance {
            Some("not_enough_agent_budget")
        } else {
            None
        };

        if let Some(reason) = refusal {
            emit_event(
                "heto",
                "1.0.0",
                "agent_spend_refused",
                json!([{
                    "startup_id": startup_id,
                    "agent": caller,
                    "to": to,
                    "amount": amount.as_yoctonear().to_string(),
                    "memo": memo,
                    "reason": reason,
                }]),
            );
            self.update_stats(&caller, |s| s.spends_refused += 1);
            return false;
        }

        agent.spent_today = NearToken::from_yoctonear(spent_after);
        startup.agent_balance = startup.agent_balance.saturating_sub(amount);
        self.update_stats(&caller, |s| {
            s.spends_ok += 1;
            s.total_spent = s.total_spent.saturating_add(amount);
        });
        emit_event(
            "heto",
            "1.0.0",
            "agent_spend",
            json!([{
                "startup_id": startup_id,
                "agent": caller,
                "to": to,
                "amount": amount.as_yoctonear().to_string(),
                "memo": memo,
            }]),
        );
        let _ = Promise::new(to).transfer(amount);
        true
    }

    // ------------------------------------------------------------- jobs (escrow)

    /// A customer pays a startup to do a piece of work. The money is HELD by the contract, in none
    /// of the startup's buckets, until the work is delivered and accepted (or settles by itself).
    /// `work_secs`: how long the swarm has to deliver (1 minute to 30 days). `review_secs`: how
    /// long the customer has to look at a delivery before it settles by itself (1 minute to 7
    /// days, default 24 hours).
    #[payable]
    pub fn create_job(
        &mut self,
        startup_id: StartupId,
        description: String,
        work_secs: u64,
        review_secs: Option<u64>,
        customer_key: Option<String>,
    ) -> JobId {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "Attach payment for the job");
        require!(
            !description.trim().is_empty() && description.len() <= MAX_JOB_TEXT,
            "Description must be 1-280 characters"
        );
        require!(
            (MIN_WORK_SECS..=MAX_WORK_SECS).contains(&work_secs),
            "Work time must be 1 minute to 30 days"
        );
        let review_secs = review_secs.unwrap_or(DEFAULT_REVIEW_SECS);
        require!(
            (MIN_REVIEW_SECS..=MAX_REVIEW_SECS).contains(&review_secs),
            "Review window must be 1 minute to 7 days"
        );
        let startup = self
            .startups
            .get(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        require!(has_shareholders(startup), "Startup has no shareholders yet");
        // A private startup needs the customer's key so the swarm can encrypt the result. A
        // public startup ignores any key it is given.
        let private = startup.results_private;
        let customer_key = if private {
            let key = customer_key.unwrap_or_else(|| {
                env::panic_str("This startup's results are private: send your key")
            });
            require!(
                key.len() == CUSTOMER_KEY_HEX_LEN && key.chars().all(|c| c.is_ascii_hexdigit()),
                "Customer key must be 64 hex characters"
            );
            Some(key.to_lowercase())
        } else {
            None
        };

        let now = env::block_timestamp_ms();
        let id = self.next_job_id;
        self.next_job_id += 1;
        let customer = env::predecessor_account_id();
        let deadline_ms = now + work_secs * 1_000;
        self.jobs.insert(
            id,
            Job {
                id,
                startup_id,
                customer: customer.clone(),
                description,
                amount,
                created_at_ms: now,
                deadline_ms,
                review_ms: review_secs * 1_000,
                status: JobStatus::Open,
                agent: None,
                result: None,
                delivered_at_ms: 0,
                dispute_reason: None,
                private,
                customer_key,
            },
        );
        emit_event(
            "heto",
            "1.0.0",
            "job_created",
            json!([{ "job_id": id, "startup_id": startup_id, "customer": customer,
                     "amount": amount.as_yoctonear().to_string(), "deadline_ms": deadline_ms,
                     "private": private }]),
        );
        id
    }

    /// A registered, active agent of the job's startup delivers the work: `result` is a short
    /// text or a link to the output. Only possible before the deadline.
    pub fn submit_result(&mut self, job_id: JobId, result: String) {
        let caller = env::predecessor_account_id();
        let mut job = self.job_or_panic(job_id);
        require!(job.status == JobStatus::Open, "Job is not open for work");
        let now = env::block_timestamp_ms();
        require!(now <= job.deadline_ms, "The deadline has passed");
        let startup = self
            .startups
            .get(&job.startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let agent = startup
            .agents
            .iter()
            .find(|a| a.account_id == caller)
            .unwrap_or_else(|| env::panic_str("Not a registered agent of this startup"));
        require!(agent.active, "Agent is paused");
        require!(
            !result.trim().is_empty() && result.len() <= MAX_RESULT_TEXT,
            "Result must be 1-1024 characters"
        );
        let private = job.private;
        job.status = JobStatus::Delivered;
        job.agent = Some(caller.clone());
        job.result = Some(result);
        job.delivered_at_ms = now;
        self.jobs.insert(job_id, job);
        emit_event(
            "heto",
            "1.0.0",
            "job_delivered",
            json!([{ "job_id": job_id, "agent": caller, "private": private }]),
        );
    }

    /// The customer is happy: the payment becomes revenue and is split as usual.
    pub fn accept_job(&mut self, job_id: JobId) {
        let job = self.job_or_panic(job_id);
        require!(
            env::predecessor_account_id() == job.customer,
            "Only the customer can accept"
        );
        require!(job.status == JobStatus::Delivered, "Nothing delivered yet");
        self.pay_out_job(job);
    }

    /// The customer is not happy. Allowed only inside the review window. The money stays locked
    /// until the platform account (the testnet arbiter) rules on it.
    pub fn reject_job(&mut self, job_id: JobId, reason: String) {
        let mut job = self.job_or_panic(job_id);
        require!(
            env::predecessor_account_id() == job.customer,
            "Only the customer can reject"
        );
        require!(job.status == JobStatus::Delivered, "Nothing delivered yet");
        require!(
            env::block_timestamp_ms() <= job.delivered_at_ms + job.review_ms,
            "The review window has closed"
        );
        require!(
            !reason.trim().is_empty() && reason.len() <= MAX_JOB_TEXT,
            "Reason must be 1-280 characters"
        );
        job.status = JobStatus::Disputed;
        job.dispute_reason = Some(reason);
        self.jobs.insert(job_id, job);
        emit_event(
            "heto",
            "1.0.0",
            "job_disputed",
            json!([{ "job_id": job_id }]),
        );
    }

    /// Anyone may call this once the review window has passed with no answer from the customer:
    /// the delivery is treated as accepted. This is what lets a customer go to sleep.
    pub fn settle_job(&mut self, job_id: JobId) {
        let job = self.job_or_panic(job_id);
        require!(job.status == JobStatus::Delivered, "Nothing delivered yet");
        require!(
            env::block_timestamp_ms() > job.delivered_at_ms + job.review_ms,
            "The review window is still open"
        );
        self.pay_out_job(job);
    }

    /// Anyone may call this once the deadline has passed with nothing delivered. The whole
    /// payment goes back to the customer, with no platform fee.
    pub fn refund_job(&mut self, job_id: JobId) {
        let job = self.job_or_panic(job_id);
        require!(job.status == JobStatus::Open, "Job is not waiting for work");
        require!(
            env::block_timestamp_ms() > job.deadline_ms,
            "The deadline has not passed"
        );
        self.refund_job_internal(job, "no_delivery");
    }

    /// The platform account decides a disputed job: `pay_startup = true` treats the work as
    /// accepted, `false` refunds the customer. A testnet stand-in for a real reviewer.
    pub fn resolve_dispute(&mut self, job_id: JobId, pay_startup: bool) {
        require!(
            env::predecessor_account_id() == self.platform_account,
            "Only the platform account can resolve disputes"
        );
        let job = self.job_or_panic(job_id);
        require!(job.status == JobStatus::Disputed, "Job is not disputed");
        if pay_startup {
            self.pay_out_job(job);
        } else {
            self.refund_job_internal(job, "dispute_for_customer");
        }
    }

    /// The founder chooses whether this startup's job results are private. Only jobs created
    /// after the change are affected.
    pub fn set_results_private(&mut self, startup_id: StartupId, private: bool) {
        let startup = self.founder_startup(startup_id);
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        startup.results_private = private;
        emit_event(
            "heto",
            "1.0.0",
            "results_privacy_set",
            json!([{ "startup_id": startup_id, "private": private }]),
        );
    }

    // ------------------------------------------------------------------- views

    pub fn get_startup(&self, startup_id: StartupId) -> Option<Startup> {
        self.startups.get(&startup_id).cloned()
    }

    pub fn get_startups(&self, from_index: Option<u64>, limit: Option<u64>) -> Vec<Startup> {
        self.startups
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20) as usize)
            .map(|(_, s)| s.clone())
            .collect()
    }

    pub fn get_agent(&self, startup_id: StartupId, agent_id: AccountId) -> Option<Agent> {
        self.startups
            .get(&startup_id)?
            .agents
            .iter()
            .find(|a| a.account_id == agent_id)
            .cloned()
    }

    pub fn get_job(&self, job_id: JobId) -> Option<Job> {
        self.jobs.get(&job_id).cloned()
    }

    /// Jobs, oldest first; pass `startup_id` to see only one startup's jobs.
    pub fn get_jobs(
        &self,
        startup_id: Option<StartupId>,
        from_index: Option<u64>,
        limit: Option<u64>,
    ) -> Vec<Job> {
        self.jobs
            .iter()
            .map(|(_, j)| j)
            .filter(|j| startup_id.is_none_or(|id| j.startup_id == id))
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(20) as usize)
            .cloned()
            .collect()
    }

    /// What this contract has seen the account do as an agent, across all startups. Read it
    /// before hiring: no history, many refusals, or past firings are all worth a look.
    pub fn get_agent_reputation(&self, account_id: AccountId) -> AgentStats {
        self.agent_stats
            .get(&account_id)
            .cloned()
            .unwrap_or_default()
    }

    /// What `claim` would pay this account right now.
    pub fn get_claimable(&self, account_id: AccountId) -> NearToken {
        let mut total = self
            .balances
            .get(&account_id)
            .map(|b| b.as_yoctonear())
            .unwrap_or(0);
        if let Some(ids) = self.tokens_per_owner.get(&account_id) {
            for id in ids {
                if let Some(token) = self.tokens.get(id) {
                    total += self.pending_of(token);
                }
            }
        }
        NearToken::from_yoctonear(total)
    }

    pub fn get_platform(&self) -> PlatformInfo {
        PlatformInfo {
            account_id: self.platform_account.clone(),
            fee_bps: self.platform_fee_bps,
        }
    }
}

/// A startup's description must say something and fit in `MAX_DESCRIPTION` bytes.
fn check_description(text: &str) {
    require!(
        !text.trim().is_empty() && text.len() <= MAX_DESCRIPTION,
        "Description must be 1-280 characters"
    );
}
