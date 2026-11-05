//! On-chain data types and platform-wide constants.

use near_sdk::{AccountId, NearToken, near, require};

pub type StartupId = u64;
pub type TokenId = String;

pub const MAX_TIERS: usize = 8;
/// Basis points: 10_000 = 100%.
pub const BPS: u128 = 10_000;
/// Platform rule: after the role pool is carved out, share holders still receive at least this
/// part of every deposit (30%).
pub const MIN_SHAREHOLDER_BPS: u32 = 3_000;
/// The role pool can take at most this part of the holders' side of a deposit (20%).
pub const MAX_ROLE_POOL_BPS: u32 = 2_000;
/// The platform fee can never be set above this (5%).
pub const MAX_PLATFORM_FEE_BPS: u32 = 500;
pub const MAX_ROLE_WEIGHT: u32 = 100;
pub const MAX_AGENTS: usize = 5;
pub const MAX_PAYEES: usize = 10;
/// Agent spending limits reset every UTC day.
pub const NANOS_PER_DAY: u64 = 86_400_000_000_000;

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

/// How each revenue deposit is divided (basis points, fixed when the startup is created).
///
/// `holders_bps + agent_bps + ops_bps` must equal 10_000. `role_bps` is carved out of the holders'
/// part for active role NFTs; if no role is active, it goes to share holders instead.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Allocation {
    pub holders_bps: u32,
    pub agent_bps: u32,
    pub ops_bps: u32,
    pub role_bps: u32,
}

impl Allocation {
    /// 60% holders, 20% agent budget, 20% operations, 10% of the holders' part to the role pool.
    pub fn default_split() -> Self {
        Self {
            holders_bps: 6_000,
            agent_bps: 2_000,
            ops_bps: 2_000,
            role_bps: 1_000,
        }
    }

    pub fn validate(&self) {
        let total = self.holders_bps as u64 + self.agent_bps as u64 + self.ops_bps as u64;
        require!(total == 10_000, "Allocation must add up to 100%");
        require!(
            self.role_bps <= MAX_ROLE_POOL_BPS,
            "Role pool is capped at 20%"
        );
        let shareholders = self.holders_bps as u64 * (10_000 - self.role_bps as u64) / 10_000;
        require!(
            shareholders >= MIN_SHAREHOLDER_BPS as u64,
            "Shareholders must keep at least 30%"
        );
    }
}

/// Lifecycle of a startup. `Migrated` freezes it here so it can move to a contract of its own
/// later without anyone minting shares or roles against the old copy.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum StartupStatus {
    Active,
    Migrated { to: AccountId },
}

/// An AI agent that works for the startup and can spend from the agent budget bucket, but only
/// inside the limits the founder set. The agent signs with its own key (in production a
/// function-call access key restricted to `agent_spend`), so it can never do anything else.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Agent {
    pub account_id: AccountId,
    pub name: String,
    /// The most one payment may be.
    pub per_tx_cap: NearToken,
    /// The most the agent may spend in one UTC day.
    pub daily_cap: NearToken,
    /// The agent can only pay these accounts.
    pub payees: Vec<AccountId>,
    /// Kill switch: the founder can pause an agent at any time.
    pub active: bool,
    /// The UTC day number `spent_today` refers to.
    pub day: u64,
    pub spent_today: NearToken,
}

#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Startup {
    pub id: StartupId,
    pub name: String,
    pub founder: AccountId,
    /// Where share-sale money goes. Fixed at creation and visible to buyers.
    pub treasury: AccountId,
    pub tiers: Vec<Tier>,
    pub allocation: Allocation,
    /// Total paid in by investors for shares.
    pub raised: NearToken,
    /// Total revenue ever paid into this startup (for the dashboard).
    pub revenue: NearToken,
    /// Agent budget bucket: revenue reserved for the startup's AI agents.
    pub agent_balance: NearToken,
    /// Operations bucket: revenue the founder spends on running the business, with a public memo.
    pub ops_balance: NearToken,
    /// Role pool: revenue earned so far by ONE unit of role weight.
    pub role_acc: NearToken,
    /// Sum of the weights of all active role NFTs.
    pub total_role_weight: u64,
    pub agents: Vec<Agent>,
    pub status: StartupStatus,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub enum TokenKind {
    /// A tiered share NFT. `tier` is an index into the startup's `tiers`.
    Share { tier: u32 },
    /// A non-transferable team role NFT. It earns from the role pool in proportion to `weight`
    /// while it exists (revoking it ends the earning). `media` is the original image set at mint;
    /// `display_media` is the picture its owner chooses to show.
    Role {
        role: String,
        weight: u32,
        media: Option<String>,
        display_media: Option<String>,
    },
}

/// NEP-171 token view (`token_id` and `owner_id` are the required fields), plus our own.
#[near(serializers = [borsh, json])]
#[derive(Clone)]
pub struct Token {
    pub token_id: TokenId,
    pub owner_id: AccountId,
    pub startup_id: StartupId,
    pub kind: TokenKind,
    /// The accumulator value (tier counter for shares, role-pool counter for roles) at mint or at
    /// the last settlement, so an NFT never collects revenue from before it held it.
    pub reward_debt: NearToken,
}

#[near(serializers = [json])]
pub struct PlatformInfo {
    pub account_id: AccountId,
    pub fee_bps: u32,
}