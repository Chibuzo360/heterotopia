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
use internal::{accrual, bps_of, validate_media, validate_policy};
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
        }
    }

    // ---------------------------------------------------------------- startups

    /// Anyone can found a startup. The caller becomes its founder and defines its tiers.
    /// `treasury` (default: the founder) receives share-sale money; `allocation` (default
    /// 60/20/20 with a 10% role pool) decides how revenue is divided. Both are fixed for good.
    pub fn create_startup(
        &mut self,
        name: String,
        tiers: Vec<TierInput>,
        treasury: Option<AccountId>,
        allocation: Option<Allocation>,
    ) -> StartupId {
        require!(
            !name.trim().is_empty() && name.len() <= 64,
            "Name must be 1-64 characters"
        );
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
        let amount = deposit.as_yoctonear();
        let fee = bps_of(amount, self.platform_fee_bps);
        let net = amount - fee;
        let platform = self.platform_account.clone();

        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );

        let a = startup.allocation.clone();
        let agent = bps_of(net, a.agent_bps);
        let ops = bps_of(net, a.ops_bps);
        let holders = net - agent - ops;
        // With no active role, the role pool's part goes to shareholders instead.
        let role_part = if startup.total_role_weight > 0 {
            bps_of(holders, a.role_bps)
        } else {
            0
        };
        let share_part = holders - role_part;

        let total_weight: u128 = startup
            .tiers
            .iter()
            .map(|t| t.weight as u128 * t.minted as u128)
            .sum();
        require!(total_weight > 0, "No shareholders yet");

        // Each NFT of tier t earns `share_part * weight_t / total_weight`, so a tier's total is
        // proportional to (weight x NFTs minted) and the tiers add up to `share_part`. Integer
        // division can leave a few yoctoNEAR of dust in the contract, which is harmless.
        for tier in startup.tiers.iter_mut().filter(|t| t.minted > 0) {
            let increment = share_part
                .checked_mul(tier.weight as u128)
                .unwrap_or_else(|| env::panic_str("Revenue amount too large"))
                / total_weight;
            tier.acc_per_nft = tier
                .acc_per_nft
                .checked_add(NearToken::from_yoctonear(increment))
                .unwrap_or_else(|| env::panic_str("Accumulator overflow"));
        }
        if role_part > 0 {
            let increment = role_part / startup.total_role_weight as u128;
            startup.role_acc = startup
                .role_acc
                .checked_add(NearToken::from_yoctonear(increment))
                .unwrap_or_else(|| env::panic_str("Accumulator overflow"));
        }
        startup.agent_balance = startup
            .agent_balance
            .checked_add(NearToken::from_yoctonear(agent))
            .unwrap_or_else(|| env::panic_str("Agent balance overflow"));
        startup.ops_balance = startup
            .ops_balance
            .checked_add(NearToken::from_yoctonear(ops))
            .unwrap_or_else(|| env::panic_str("Operations balance overflow"));
        startup.revenue = startup
            .revenue
            .checked_add(deposit)
            .unwrap_or_else(|| env::panic_str("Revenue overflow"));

        if fee > 0 {
            let _ = Promise::new(platform).transfer(NearToken::from_yoctonear(fee));
        }
        emit_event(
            "heto",
            "1.0.0",
            "revenue_deposit",
            json!([{
                "startup_id": startup_id,
                "payer": env::predecessor_account_id(),
                "amount": amount.to_string(),
                "platform_fee": fee.to_string(),
                "shareholders": share_part.to_string(),
                "role_pool": role_part.to_string(),
                "agent_budget": agent.to_string(),
                "operations": ops.to_string(),
            }]),
        );
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

    /// The founder hires an AI agent. It can later spend from the agent budget bucket through
    /// `agent_spend`, within these limits and only to the listed payees.
    pub fn register_agent(
        &mut self,
        startup_id: StartupId,
        agent_id: AccountId,
        name: String,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        payees: Vec<AccountId>,
    ) {
        require!(
            !name.trim().is_empty() && name.len() <= 32,
            "Agent name must be 1-32 characters"
        );
        validate_policy(per_tx_cap, daily_cap, &payees);
        let startup = self.founder_startup(startup_id);
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
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
            day: 0,
            spent_today: NearToken::from_yoctonear(0),
        });
        emit_event(
            "heto",
            "1.0.0",
            "agent_registered",
            json!([{ "startup_id": startup_id, "agent": agent_id }]),
        );
    }

    /// The founder changes an agent's limits and payee list. Today's spending is kept.
    pub fn update_agent_policy(
        &mut self,
        startup_id: StartupId,
        agent_id: AccountId,
        per_tx_cap: NearToken,
        daily_cap: NearToken,
        payees: Vec<AccountId>,
    ) {
        validate_policy(per_tx_cap, daily_cap, &payees);
        let startup = self.founder_startup(startup_id);
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
            json!([{ "startup_id": startup_id, "agent": agent_id }]),
        );
    }

    /// Kill switch: the founder pauses (`false`) or resumes (`true`) an agent.
    pub fn set_agent_active(&mut self, startup_id: StartupId, agent_id: AccountId, active: bool) {
        let startup = self.founder_startup(startup_id);
        let agent = startup
            .agents
            .iter_mut()
            .find(|a| a.account_id == agent_id)
            .unwrap_or_else(|| env::panic_str("Agent not found"));
        agent.active = active;
        emit_event(
            "heto",
            "1.0.0",
            "agent_active_changed",
            json!([{ "startup_id": startup_id, "agent": agent_id, "active": active }]),
        );
    }

    /// The founder fires an agent for good.
    pub fn remove_agent(&mut self, startup_id: StartupId, agent_id: AccountId) {
        let startup = self.founder_startup(startup_id);
        let before = startup.agents.len();
        startup.agents.retain(|a| a.account_id != agent_id);
        require!(startup.agents.len() < before, "Agent not found");
        emit_event(
            "heto",
            "1.0.0",
            "agent_removed",
            json!([{ "startup_id": startup_id, "agent": agent_id }]),
        );
    }

    /// An AI agent pays someone from the agent budget bucket. Returns `true` if the payment was
    /// made, `false` if the agent's rules refused it. Either way an event records what happened
    /// and why, so the dashboard can show approvals and refusals. A refusal changes no balances.
    /// Callers who are not registered agents of this startup panic.
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

        let today = env::block_timestamp() / NANOS_PER_DAY;
        if agent.day != today {
            agent.day = today;
            agent.spent_today = NearToken::from_yoctonear(0);
        }
        let spent_after = agent
            .spent_today
            .as_yoctonear()
            .saturating_add(amount.as_yoctonear());

        let refusal = if !agent.active {
            Some("agent_paused")
        } else if amount > agent.per_tx_cap {
            Some("over_per_payment_cap")
        } else if spent_after > agent.daily_cap.as_yoctonear() {
            Some("over_daily_cap")
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
            return false;
        }

        agent.spent_today = NearToken::from_yoctonear(spent_after);
        startup.agent_balance = startup.agent_balance.saturating_sub(amount);
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