//! Internal helpers. Nothing here is callable from outside the contract.

use crate::Contract;
use crate::events::{emit, emit_event};
use crate::models::*;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, NearToken, Promise, env, require};

/// `amount * bps / 10_000`, rounded down.
pub(crate) fn bps_of(amount: u128, bps: u32) -> u128 {
    amount
        .checked_mul(bps as u128)
        .unwrap_or_else(|| env::panic_str("Amount too large"))
        / BPS
}

/// Revenue an NFT has accrued since `debt`, and the accumulator value to record as its new debt.
/// Shares read their tier counter; roles read the startup's role-pool counter times their weight.
pub(crate) fn accrual(startup: &Startup, kind: &TokenKind, debt: NearToken) -> (u128, NearToken) {
    match kind {
        TokenKind::Share { tier } => {
            let acc = startup.tiers[*tier as usize].acc_per_nft;
            (acc.as_yoctonear().saturating_sub(debt.as_yoctonear()), acc)
        }
        TokenKind::Role { weight, .. } => {
            let acc = startup.role_acc;
            let per_unit = acc.as_yoctonear().saturating_sub(debt.as_yoctonear());
            (
                per_unit
                    .checked_mul(*weight as u128)
                    .unwrap_or_else(|| env::panic_str("Accrual overflow")),
                acc,
            )
        }
    }
}

/// Spending limits must make sense and the payee list must stay small and duplicate-free.
pub(crate) fn validate_policy(per_tx_cap: NearToken, daily_cap: NearToken, payees: &[AccountId]) {
    require!(!per_tx_cap.is_zero(), "Per-payment cap must be above zero");
    require!(
        daily_cap >= per_tx_cap,
        "Daily cap cannot be below the per-payment cap"
    );
    require!(payees.len() <= MAX_PAYEES, "At most 10 allowed payees");
    for (i, p) in payees.iter().enumerate() {
        require!(!payees[..i].contains(p), "Duplicate payee");
    }
}

/// Image links must be short and use https or ipfs.
pub(crate) fn validate_media(media: &Option<String>) {
    if let Some(url) = media {
        require!(
            url.len() <= 200 && (url.starts_with("https://") || url.starts_with("ipfs://")),
            "Image must be an https:// or ipfs:// link of at most 200 characters"
        );
    }
}

impl Contract {
    /// The startup, but only if the caller is its founder.
    pub(crate) fn founder_startup(&mut self, startup_id: StartupId) -> &mut Startup {
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can do this"
        );
        startup
    }

    /// Panics unless the caller may manage this startup's agents: the founder, or someone holding
    /// an existing role NFT of this startup whose role name is in `manager_roles`. Returns `true`
    /// when the caller is the founder (who is not bound by the manager limits).
    pub(crate) fn require_agent_admin(&self, startup_id: StartupId) -> bool {
        let startup = self
            .startups
            .get(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let caller = env::predecessor_account_id();
        if caller == startup.founder {
            return true;
        }
        let is_manager = self
            .tokens_per_owner
            .get(&caller)
            .map(|ids| {
                ids.iter().any(|id| {
                    self.tokens.get(id).is_some_and(|t| {
                        t.startup_id == startup_id
                            && matches!(&t.kind, TokenKind::Role { role, .. }
                                if startup.manager_roles.contains(role))
                    })
                })
            })
            .unwrap_or(false);
        require!(
            is_manager,
            "Only the founder or an agent manager can do this"
        );
        false
    }

    /// Update an agent account's global record.
    pub(crate) fn update_stats(&mut self, agent_id: &AccountId, f: impl FnOnce(&mut AgentStats)) {
        let mut stats = self.agent_stats.get(agent_id).cloned().unwrap_or_default();
        f(&mut stats);
        self.agent_stats.insert(agent_id.clone(), stats);
    }

    /// The ONLY place a token changes owner. Every transfer entry point (today `nft_transfer`,
    /// later `nft_transfer_call` and any rollback path) must go through here, so the soulbound
    /// rule and the revenue settlement can never be bypassed.
    pub(crate) fn internal_transfer(
        &mut self,
        sender: AccountId,
        receiver: AccountId,
        token_id: TokenId,
    ) {
        require!(sender != receiver, "Sender and receiver must differ");
        let token = self
            .tokens
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("Token not found"));
        require!(
            token.owner_id == sender,
            "Only the owner can transfer this token"
        );
        require!(
            matches!(token.kind, TokenKind::Share { .. }),
            "Role NFTs are soulbound and cannot be transferred"
        );

        // The seller keeps revenue accrued so far. Settle it, then reset the debt so the buyer
        // starts from zero.
        let startup = self
            .startups
            .get(&token.startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let (accrued, new_debt) = accrual(startup, &token.kind, token.reward_debt);
        token.reward_debt = new_debt;
        token.owner_id = receiver.clone();

        if accrued > 0 {
            self.credit(&sender, accrued);
        }
        self.remove_from_owner(&sender, &token_id);
        self.add_to_owner(receiver.clone(), token_id.clone());
        emit(
            "nft_transfer",
            json!([{
                "old_owner_id": sender,
                "new_owner_id": receiver,
                "token_ids": [token_id],
            }]),
        );
    }

    pub(crate) fn internal_mint(
        &mut self,
        startup_id: StartupId,
        owner_id: AccountId,
        kind: TokenKind,
        reward_debt: NearToken,
    ) -> TokenId {
        self.next_token_num += 1;
        self.live_tokens += 1;
        let token_id = format!("{}:{}", startup_id, self.next_token_num);
        self.tokens.insert(
            token_id.clone(),
            Token {
                token_id: token_id.clone(),
                owner_id: owner_id.clone(),
                startup_id,
                kind,
                reward_debt,
            },
        );
        self.add_to_owner(owner_id.clone(), token_id.clone());
        emit(
            "nft_mint",
            json!([{ "owner_id": owner_id, "token_ids": [token_id] }]),
        );
        token_id
    }

    /// Revenue a single token has accrued but not yet settled.
    pub(crate) fn pending_of(&self, token: &Token) -> u128 {
        self.startups
            .get(&token.startup_id)
            .map(|s| accrual(s, &token.kind, token.reward_debt).0)
            .unwrap_or(0)
    }

    /// Adds settled revenue to an account's claimable balance.
    pub(crate) fn credit(&mut self, account: &AccountId, amount: u128) {
        let current = self
            .balances
            .get(account)
            .map(|b| b.as_yoctonear())
            .unwrap_or(0);
        let total = current
            .checked_add(amount)
            .unwrap_or_else(|| env::panic_str("Balance overflow"));
        self.balances
            .insert(account.clone(), NearToken::from_yoctonear(total));
    }

    pub(crate) fn add_to_owner(&mut self, owner_id: AccountId, token_id: TokenId) {
        let mut ids = self
            .tokens_per_owner
            .get(&owner_id)
            .cloned()
            .unwrap_or_default();
        ids.push(token_id);
        self.tokens_per_owner.insert(owner_id, ids);
    }

    pub(crate) fn remove_from_owner(&mut self, owner_id: &AccountId, token_id: &TokenId) {
        let mut ids = self
            .tokens_per_owner
            .get(owner_id)
            .cloned()
            .unwrap_or_default();
        ids.retain(|id| id != token_id);
        self.tokens_per_owner.insert(owner_id.clone(), ids);
    }
}

/// A startup can only earn revenue if someone holds a share to receive it.
pub(crate) fn has_shareholders(startup: &Startup) -> bool {
    startup.tiers.iter().any(|t| t.minted > 0)
}

impl Contract {
    pub(crate) fn job_or_panic(&self, job_id: JobId) -> Job {
        self.jobs
            .get(&job_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Job not found"))
    }

    /// Turns a delivered job's held payment into revenue. If the startup was migrated in the
    /// meantime it can no longer take revenue, so the customer is refunded instead.
    pub(crate) fn pay_out_job(&mut self, mut job: Job) {
        let active = self
            .startups
            .get(&job.startup_id)
            .is_some_and(|s| s.status == StartupStatus::Active);
        if !active {
            self.refund_job_internal(job, "startup_migrated");
            return;
        }
        job.status = JobStatus::Paid;
        let (id, startup_id, customer, amount) =
            (job.id, job.startup_id, job.customer.clone(), job.amount);
        self.jobs.insert(id, job);
        self.internal_revenue(startup_id, customer, amount);
        emit_event("heto", "1.0.0", "job_paid", json!([{ "job_id": id }]));
    }

    pub(crate) fn refund_job_internal(&mut self, mut job: Job, reason: &str) {
        job.status = JobStatus::Refunded;
        let (id, customer, amount) = (job.id, job.customer.clone(), job.amount);
        self.jobs.insert(id, job);
        emit_event(
            "heto",
            "1.0.0",
            "job_refunded",
            json!([{ "job_id": id, "customer": customer,
                     "amount": amount.as_yoctonear().to_string(), "reason": reason }]),
        );
        let _ = Promise::new(customer).transfer(amount);
    }

    /// Divides a payment into the startup's buckets and pays the platform fee. Used by
    /// `deposit_revenue` and by job settlement, so both always follow the same rules.
    pub(crate) fn internal_revenue(
        &mut self,
        startup_id: StartupId,
        payer: AccountId,
        deposit: NearToken,
    ) {
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
                "payer": payer,
                "amount": amount.to_string(),
                "platform_fee": fee.to_string(),
                "shareholders": share_part.to_string(),
                "role_pool": role_part.to_string(),
                "agent_budget": agent.to_string(),
                "operations": ops.to_string(),
            }]),
        );
    }
}