//! Heterotopia (heto): a startup that runs itself, on NEAR testnet.
//!
//! One contract holds many startups. Each startup has founder-defined tiers, tiered share NFTs,
//! soulbound role NFTs, and a revenue pool that is split across share tiers by weight.
//!
//! Revenue rule: whoever held a share NFT while revenue accrued keeps that revenue. When a share
//! is sold, its pending revenue is settled into the seller's balance and the buyer starts fresh.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, assert_one_yocto, env, near,
    require,
};

pub type StartupId = u64;
pub type TokenId = String;

const MAX_TIERS: usize = 8;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Startups,
    Tokens,
    OwnerTokens,
    Balances,
}

/// What the founder passes in for each tier when creating a startup.
#[near(serializers = [json])]
pub struct TierInput {
    pub name: String,
    /// Price of one NFT in this tier (JSON: yoctoNEAR as a string).
    pub price: NearToken,
    pub max_supply: u32,
    /// Revenue weight of ONE NFT in this tier (a Board NFT with weight 10 earns 10x a General NFT
    /// with weight 1).
    pub weight: u32,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Tier {
    pub name: String,
    pub price: NearToken,
    pub max_supply: u32,
    pub minted: u32,
    pub weight: u32,
    /// Revenue earned so far by ONE NFT of this tier, in yoctoNEAR. It only ever grows. Each
    /// share NFT records it as its `reward_debt` at mint (and at every sale), so an NFT can claim
    /// exactly `acc_per_nft - reward_debt`.
    pub acc_per_nft: NearToken,
}

/// Lifecycle of a startup. `Migrated` freezes it here so it can move to a contract of its own
/// later without anyone minting shares or roles against the old copy.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum StartupStatus {
    Active,
    Migrated { to: AccountId },
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Startup {
    pub id: StartupId,
    pub name: String,
    pub founder: AccountId,
    pub tiers: Vec<Tier>,
    /// Total paid in by investors for shares.
    pub raised: NearToken,
    /// Total revenue ever paid into this startup (for the dashboard).
    pub revenue: NearToken,
    pub status: StartupStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind {
    /// A tiered share NFT. `tier` is an index into the startup's `tiers`.
    Share { tier: u32 },
    /// A non-transferable team role NFT.
    Role { role: String },
}

/// NEP-171 token view (`token_id` and `owner_id` are the required fields), plus our own.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub startup_id: StartupId,
    pub kind: TokenKind,
    /// The tier accumulator value at mint time, so new buyers never collect past revenue.
    pub reward_debt: NearToken,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    next_startup_id: StartupId,
    /// Only ever grows; used to make unique token ids.
    next_token_num: u64,
    /// Tokens that currently exist (minted minus revoked).
    live_tokens: u64,
    startups: IterableMap<StartupId, Startup>,
    tokens: LookupMap<TokenId, Token>,
    tokens_per_owner: LookupMap<AccountId, Vec<TokenId>>,
    /// Revenue already settled to an account (from shares it sold), waiting for `claim`.
    balances: LookupMap<AccountId, NearToken>,
}

#[near]
impl Contract {
    #[init]
    pub fn new() -> Self {
        Self {
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
    pub fn create_startup(&mut self, name: String, tiers: Vec<TierInput>) -> StartupId {
        require!(
            !name.trim().is_empty() && name.len() <= 64,
            "Name must be 1-64 characters"
        );
        require!(
            !tiers.is_empty() && tiers.len() <= MAX_TIERS,
            "Between 1 and 8 tiers required"
        );

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

        let id = self.next_startup_id;
        self.next_startup_id += 1;
        self.startups.insert(
            id,
            Startup {
                id,
                name,
                founder: env::predecessor_account_id(),
                tiers,
                raised: NearToken::from_yoctonear(0),
                revenue: NearToken::from_yoctonear(0),
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

    // ------------------------------------------------------------------ revenue

    /// Anyone (a customer, or our labeled mock customer in dry-run mode) pays revenue into a
    /// startup. It is split across share tiers by weight. Role NFTs earn nothing, so an external
    /// CEO is paid only if they separately own shares.
    #[payable]
    pub fn deposit_revenue(&mut self, startup_id: StartupId) {
        let deposit = env::attached_deposit();
        require!(!deposit.is_zero(), "Attach revenue to deposit");

        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );

        let total_weight: u128 = startup
            .tiers
            .iter()
            .map(|t| t.weight as u128 * t.minted as u128)
            .sum();
        require!(total_weight > 0, "No shareholders yet");

        // Each NFT of tier t earns `amount * weight_t / total_weight`, so a tier's total is
        // proportional to (weight x NFTs minted) and the tiers add up to `amount`. Integer
        // division can leave a few yoctoNEAR of dust in the contract, which is harmless.
        let amount = deposit.as_yoctonear();
        for tier in startup.tiers.iter_mut().filter(|t| t.minted > 0) {
            let increment = amount
                .checked_mul(tier.weight as u128)
                .unwrap_or_else(|| env::panic_str("Revenue amount too large"))
                / total_weight;
            tier.acc_per_nft = tier
                .acc_per_nft
                .checked_add(NearToken::from_yoctonear(increment))
                .unwrap_or_else(|| env::panic_str("Accumulator overflow"));
        }
        startup.revenue = startup
            .revenue
            .checked_add(deposit)
            .unwrap_or_else(|| env::panic_str("Revenue overflow"));

        emit_event(
            "heto",
            "1.0.0",
            "revenue_deposit",
            json!([{ "startup_id": startup_id, "amount": amount.to_string() }]),
        );
    }

    /// Pays the caller everything they have earned: revenue settled from shares they sold, plus
    /// what their current share NFTs have accrued. Pays across all startups in one go.
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
            if let TokenKind::Share { tier } = &token.kind {
                let startup = self
                    .startups
                    .get(&token.startup_id)
                    .unwrap_or_else(|| env::panic_str("Startup not found"));
                let acc = startup.tiers[*tier as usize].acc_per_nft;
                total = total
                    .checked_add(
                        acc.as_yoctonear()
                            .saturating_sub(token.reward_debt.as_yoctonear()),
                    )
                    .unwrap_or_else(|| env::panic_str("Claim overflow"));
                token.reward_debt = acc;
            }
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

    // ------------------------------------------------------------------ minting

    /// Investors buy one share NFT of a tier. Any extra deposit is refunded.
    #[payable]
    pub fn buy_share(&mut self, startup_id: StartupId, tier_index: u32) -> TokenId {
        let buyer = env::predecessor_account_id();
        let deposit = env::attached_deposit();

        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
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

        if let Some(excess) = deposit.checked_sub(price)
            && !excess.is_zero()
        {
            let _ = Promise::new(buyer).transfer(excess);
        }
        token_id
    }

    /// The founder gives a team member a non-transferable role NFT.
    pub fn mint_role(&mut self, startup_id: StartupId, to: AccountId, role: String) -> TokenId {
        let startup = self
            .startups
            .get(&startup_id)
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
        self.internal_mint(
            startup_id,
            to,
            TokenKind::Role { role },
            NearToken::from_yoctonear(0),
        )
    }

    /// The founder removes a role (resignation or dismissal). Only role NFTs can be revoked;
    /// shares belong to their holders and the founder can never take them back.
    pub fn revoke_role(&mut self, token_id: TokenId) {
        let token = self
            .tokens
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Token not found"));
        require!(
            matches!(token.kind, TokenKind::Role { .. }),
            "Only role NFTs can be revoked"
        );
        let startup = self
            .startups
            .get(&token.startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            env::predecessor_account_id() == startup.founder,
            "Only the founder can revoke roles"
        );

        self.tokens.remove(&token_id);
        self.remove_from_owner(&token.owner_id, &token_id);
        self.live_tokens -= 1;
        emit(
            "nft_burn",
            json!([{ "owner_id": token.owner_id, "token_ids": [token_id] }]),
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
}

// Internal helpers (not exposed as contract methods).
impl Contract {
    /// The ONLY place a token changes owner. Every transfer entry point (today `nft_transfer`,
    /// later `nft_transfer_call` and any rollback path) must go through here, so the soulbound
    /// rule and the revenue settlement can never be bypassed.
    fn internal_transfer(&mut self, sender: AccountId, receiver: AccountId, token_id: TokenId) {
        require!(sender != receiver, "Sender and receiver must differ");
        let token = self
            .tokens
            .get_mut(&token_id)
            .unwrap_or_else(|| env::panic_str("Token not found"));
        require!(
            token.owner_id == sender,
            "Only the owner can transfer this token"
        );
        let tier = match &token.kind {
            TokenKind::Share { tier } => *tier,
            TokenKind::Role { .. } => {
                env::panic_str("Role NFTs are soulbound and cannot be transferred")
            }
        };

        // The seller keeps revenue accrued so far. Settle it, then reset the debt so the buyer
        // starts from zero.
        let startup = self
            .startups
            .get(&token.startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        let acc = startup.tiers[tier as usize].acc_per_nft;
        let accrued = acc
            .as_yoctonear()
            .saturating_sub(token.reward_debt.as_yoctonear());
        token.reward_debt = acc;
        token.owner_id = receiver.clone();

        if accrued > 0 {
            let current = self
                .balances
                .get(&sender)
                .map(|b| b.as_yoctonear())
                .unwrap_or(0);
            self.balances.insert(
                sender.clone(),
                NearToken::from_yoctonear(
                    current
                        .checked_add(accrued)
                        .unwrap_or_else(|| env::panic_str("Balance overflow")),
                ),
            );
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

    /// Revenue a single token has accrued but not yet settled. Roles never accrue anything.
    fn pending_of(&self, token: &Token) -> u128 {
        match &token.kind {
            TokenKind::Share { tier } => self
                .startups
                .get(&token.startup_id)
                .map(|s| {
                    s.tiers[*tier as usize]
                        .acc_per_nft
                        .as_yoctonear()
                        .saturating_sub(token.reward_debt.as_yoctonear())
                })
                .unwrap_or(0),
            TokenKind::Role { .. } => 0,
        }
    }

    fn internal_mint(
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

    fn add_to_owner(&mut self, owner_id: AccountId, token_id: TokenId) {
        let mut ids = self
            .tokens_per_owner
            .get(&owner_id)
            .cloned()
            .unwrap_or_default();
        ids.push(token_id);
        self.tokens_per_owner.insert(owner_id, ids);
    }

    fn remove_from_owner(&mut self, owner_id: &AccountId, token_id: &TokenId) {
        let mut ids = self
            .tokens_per_owner
            .get(owner_id)
            .cloned()
            .unwrap_or_default();
        ids.retain(|id| id != token_id);
        self.tokens_per_owner.insert(owner_id.clone(), ids);
    }
}

/// NEP-297 event log line, which indexers and our dashboard can read.
fn emit_event(standard: &str, version: &str, event: &str, data: serde_json::Value) {
    let payload = json!({
        "standard": standard,
        "version": version,
        "event": event,
        "data": data,
    });
    env::log_str(&format!("EVENT_JSON:{}", payload));
}

/// NEP-171 (NFT) event.
fn emit(event: &str, data: serde_json::Value) {
    emit_event("nep171", "1.2.0", event, data);
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{VMContextBuilder, accounts};
    use near_sdk::testing_env;

    fn set_ctx(predecessor: AccountId, deposit: NearToken) {
        let mut b = VMContextBuilder::new();
        b.current_account_id(accounts(0))
            .predecessor_account_id(predecessor.clone())
            .signer_account_id(predecessor)
            .attached_deposit(deposit);
        testing_env!(b.build());
    }

    fn founder() -> AccountId {
        accounts(1)
    }
    fn investor() -> AccountId {
        accounts(2)
    }
    fn stranger() -> AccountId {
        accounts(3)
    }

    fn tiers() -> Vec<TierInput> {
        vec![
            TierInput {
                name: "General".into(),
                price: NearToken::from_near(1),
                max_supply: 100,
                weight: 1,
            },
            TierInput {
                name: "Board".into(),
                price: NearToken::from_near(5),
                max_supply: 1,
                weight: 10,
            },
        ]
    }

    /// A contract with one startup (id 1) created by the founder.
    fn setup() -> Contract {
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let mut c = Contract::new();
        let id = c.create_startup("Heto Labs".into(), tiers());
        assert_eq!(id, 1);
        c
    }

    #[test]
    fn create_startup_stores_founder_and_tiers() {
        let c = setup();
        let s = c.get_startup(1).unwrap();
        assert_eq!(s.founder, founder());
        assert_eq!(s.tiers.len(), 2);
        assert_eq!(s.tiers[1].name, "Board");
        assert_eq!(s.tiers[1].weight, 10);
        assert_eq!(c.get_startups(None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Between 1 and 8 tiers required")]
    fn create_startup_needs_a_tier() {
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let mut c = Contract::new();
        c.create_startup("No Tiers".into(), vec![]);
    }

    #[test]
    #[should_panic(expected = "Tier weight must be above zero")]
    fn create_startup_rejects_zero_weight() {
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let mut c = Contract::new();
        let mut t = tiers();
        t[0].weight = 0;
        c.create_startup("Bad".into(), t);
    }

    #[test]
    fn buy_share_mints_nft_with_tier() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);

        let token = c.nft_token(id.clone()).unwrap();
        assert_eq!(token.owner_id, investor());
        assert_eq!(token.kind, TokenKind::Share { tier: 0 });
        assert_eq!(token.startup_id, 1);

        let s = c.get_startup(1).unwrap();
        assert_eq!(s.tiers[0].minted, 1);
        assert_eq!(s.raised, NearToken::from_near(1));

        let mine = c.nft_tokens_for_owner(investor(), None, None);
        assert_eq!(mine.len(), 1);
        assert_eq!(mine[0].token_id, id);
        assert_eq!(c.nft_total_supply(), U128(1));
    }

    #[test]
    #[should_panic(expected = "below the tier price")]
    fn buy_share_underpaid_panics() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_millinear(500));
        c.buy_share(1, 0);
    }

    #[test]
    #[should_panic(expected = "Tier is sold out")]
    fn buy_share_sold_out_panics() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(5));
        c.buy_share(1, 1);
        c.buy_share(1, 1); // Board tier has max_supply 1
    }

    #[test]
    #[should_panic(expected = "Startup not found")]
    fn buy_share_unknown_startup_panics() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(99, 0);
    }

    #[test]
    fn founder_mints_role_nft() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let id = c.mint_role(1, stranger(), "CTO".into());
        let token = c.nft_token(id).unwrap();
        assert_eq!(token.owner_id, stranger());
        assert_eq!(token.kind, TokenKind::Role { role: "CTO".into() });
    }

    #[test]
    #[should_panic(expected = "Only the founder can mint roles")]
    fn only_founder_mints_roles() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_yoctonear(0));
        c.mint_role(1, investor(), "CEO".into());
    }

    #[test]
    #[should_panic(expected = "soulbound")]
    fn role_nft_cannot_be_transferred() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let id = c.mint_role(1, stranger(), "CTO".into());
        set_ctx(stranger(), NearToken::from_yoctonear(1));
        c.nft_transfer(investor(), id, None, None);
    }

    #[test]
    fn share_nft_can_be_transferred() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);

        set_ctx(investor(), NearToken::from_yoctonear(1));
        c.nft_transfer(stranger(), id.clone(), None, None);

        assert_eq!(c.nft_token(id).unwrap().owner_id, stranger());
        assert!(c.nft_tokens_for_owner(investor(), None, None).is_empty());
        assert_eq!(c.nft_tokens_for_owner(stranger(), None, None).len(), 1);
    }

    #[test]
    #[should_panic(expected = "Only the owner can transfer this token")]
    fn only_owner_can_transfer() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);

        set_ctx(stranger(), NearToken::from_yoctonear(1));
        c.nft_transfer(founder(), id, None, None);
    }

    // ----------------------------------------------------------- roles and gates

    #[test]
    #[should_panic(expected = "soulbound")]
    fn internal_transfer_rejects_roles_directly() {
        // Any future transfer pathway calls internal_transfer, so it must refuse roles itself.
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let id = c.mint_role(1, stranger(), "CTO".into());
        c.internal_transfer(stranger(), investor(), id);
    }

    #[test]
    fn founder_revokes_role() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let id = c.mint_role(1, stranger(), "CEO".into());
        assert_eq!(c.nft_total_supply(), U128(1));

        c.revoke_role(id.clone());
        assert!(c.nft_token(id).is_none());
        assert!(c.nft_tokens_for_owner(stranger(), None, None).is_empty());
        assert_eq!(c.nft_total_supply(), U128(0));
    }

    #[test]
    #[should_panic(expected = "Only the founder can revoke roles")]
    fn only_founder_revokes_roles() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        let id = c.mint_role(1, stranger(), "CEO".into());
        set_ctx(stranger(), NearToken::from_yoctonear(0));
        c.revoke_role(id);
    }

    #[test]
    #[should_panic(expected = "Only role NFTs can be revoked")]
    fn founder_cannot_revoke_a_share() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);
        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.revoke_role(id);
    }

    // ---------------------------------------------------------------- migration

    #[test]
    fn migration_marks_startup_and_freezes_new_activity() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.mark_migrated(1, accounts(4));
        assert_eq!(
            c.get_startup(1).unwrap().status,
            StartupStatus::Migrated { to: accounts(4) }
        );
    }

    #[test]
    #[should_panic(expected = "migrated and frozen")]
    fn migrated_startup_rejects_new_shares() {
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.mark_migrated(1, accounts(4));
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);
    }

    #[test]
    #[should_panic(expected = "migrated and frozen")]
    fn migrated_startup_rejects_new_revenue() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);
        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.mark_migrated(1, accounts(4));
        set_ctx(accounts(4), NearToken::from_near(1));
        c.deposit_revenue(1);
    }

    #[test]
    #[should_panic(expected = "Only the founder can migrate the startup")]
    fn only_founder_migrates() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_yoctonear(0));
        c.mark_migrated(1, accounts(4));
    }

    #[test]
    fn holders_can_still_transfer_and_claim_after_migration() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);
        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1);

        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.mark_migrated(1, accounts(4));

        // Holders are never trapped: they can still sell and still collect what they earned.
        set_ctx(investor(), NearToken::from_yoctonear(1));
        c.nft_transfer(stranger(), id, None, None);
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(2));
        set_ctx(investor(), NearToken::from_yoctonear(0));
        let _ = c.claim();
        assert_eq!(c.get_claimable(investor()), NearToken::from_yoctonear(0));
    }

    // ------------------------------------------------------------------ revenue

    #[test]
    fn revenue_splits_by_tier_weight() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0); // General, weight 1
        set_ctx(stranger(), NearToken::from_near(5));
        c.buy_share(1, 1); // Board, weight 10

        set_ctx(accounts(4), NearToken::from_near(11));
        c.deposit_revenue(1);

        // total weight = 1 + 10 = 11, so 11 NEAR splits 1 : 10.
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(1));
        assert_eq!(c.get_claimable(stranger()), NearToken::from_near(10));
        assert_eq!(c.get_startup(1).unwrap().revenue, NearToken::from_near(11));
    }

    #[test]
    fn late_buyer_gets_nothing_from_past_revenue() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);
        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1);

        set_ctx(stranger(), NearToken::from_near(1));
        c.buy_share(1, 0);
        assert_eq!(c.get_claimable(stranger()), NearToken::from_yoctonear(0));
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(2));

        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1); // now two equal holders: 1 NEAR each
        assert_eq!(c.get_claimable(stranger()), NearToken::from_near(1));
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(3));
    }

    #[test]
    fn seller_keeps_revenue_accrued_before_the_sale() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        let id = c.buy_share(1, 0);
        set_ctx(accounts(4), NearToken::from_near(3));
        c.deposit_revenue(1);

        set_ctx(investor(), NearToken::from_yoctonear(1));
        c.nft_transfer(stranger(), id, None, None);

        // Seller keeps the 3 NEAR; buyer starts fresh.
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(3));
        assert_eq!(c.get_claimable(stranger()), NearToken::from_yoctonear(0));

        // Revenue after the sale belongs to the buyer.
        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1);
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(3));
        assert_eq!(c.get_claimable(stranger()), NearToken::from_near(2));
    }

    #[test]
    fn claim_pays_once_then_nothing_is_left() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);
        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1);

        set_ctx(investor(), NearToken::from_yoctonear(0));
        let _ = c.claim();
        assert_eq!(c.get_claimable(investor()), NearToken::from_yoctonear(0));

        // New revenue after the claim is claimable again.
        set_ctx(accounts(4), NearToken::from_near(1));
        c.deposit_revenue(1);
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(1));
    }

    #[test]
    #[should_panic(expected = "Nothing to claim")]
    fn second_claim_with_nothing_new_panics() {
        let mut c = setup();
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);
        set_ctx(accounts(4), NearToken::from_near(2));
        c.deposit_revenue(1);
        set_ctx(investor(), NearToken::from_yoctonear(0));
        let _ = c.claim();
        let _ = c.claim();
    }

    #[test]
    fn role_holder_without_shares_earns_nothing() {
        // An external CEO is appointed without buying shares, and is not paid shareholder revenue.
        let mut c = setup();
        set_ctx(founder(), NearToken::from_yoctonear(0));
        c.mint_role(1, stranger(), "CEO".into());
        set_ctx(investor(), NearToken::from_near(1));
        c.buy_share(1, 0);

        set_ctx(accounts(4), NearToken::from_near(4));
        c.deposit_revenue(1);
        assert_eq!(c.get_claimable(stranger()), NearToken::from_yoctonear(0));
        assert_eq!(c.get_claimable(investor()), NearToken::from_near(4));
    }

    #[test]
    #[should_panic(expected = "No shareholders yet")]
    fn revenue_needs_at_least_one_share() {
        let mut c = setup();
        set_ctx(accounts(4), NearToken::from_near(1));
        c.deposit_revenue(1);
    }

    #[test]
    #[should_panic(expected = "Attach revenue to deposit")]
    fn revenue_must_be_above_zero() {
        let mut c = setup();
        set_ctx(accounts(4), NearToken::from_yoctonear(0));
        c.deposit_revenue(1);
    }
}