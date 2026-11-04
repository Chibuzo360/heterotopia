//! Internal helpers. Nothing here is callable from outside the contract.

use crate::Contract;
use crate::events::emit;
use crate::models::*;
use near_sdk::serde_json::json;
use near_sdk::{AccountId, NearToken, env, require};

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