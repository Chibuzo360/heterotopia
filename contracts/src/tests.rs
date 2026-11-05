use super::*;
use near_sdk::test_utils::{VMContextBuilder, accounts, get_created_receipts};
use near_sdk::testing_env;

fn set_ctx(predecessor: AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit);
    testing_env!(b.build());
}

fn zero() -> NearToken {
    NearToken::from_yoctonear(0)
}
fn near(n: u128) -> NearToken {
    NearToken::from_near(n)
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
fn payer() -> AccountId {
    accounts(4)
}
fn platform() -> AccountId {
    accounts(5)
}

fn tiers() -> Vec<TierInput> {
    vec![
        TierInput {
            name: "General".into(),
            price: near(1),
            max_supply: 100,
            weight: 1,
        },
        TierInput {
            name: "Board".into(),
            price: near(5),
            max_supply: 1,
            weight: 10,
        },
    ]
}

fn alloc(holders: u32, agent: u32, ops: u32, role: u32) -> Allocation {
    Allocation {
        holders_bps: holders,
        agent_bps: agent,
        ops_bps: ops,
        role_bps: role,
    }
}

/// A contract with one startup (id 1) created by the founder.
fn setup_with(fee_bps: u32, allocation: Option<Allocation>) -> Contract {
    set_ctx(founder(), zero());
    let mut c = Contract::new(platform(), fee_bps);
    let id = c.create_startup("Heto Labs".into(), tiers(), None, allocation);
    assert_eq!(id, 1);
    c
}

/// No fee, and everything goes to share holders, so amounts are easy to read.
fn setup() -> Contract {
    setup_with(0, Some(alloc(10_000, 0, 0, 0)))
}

fn deposit(c: &mut Contract, amount: NearToken) {
    set_ctx(payer(), amount);
    c.deposit_revenue(1);
}

fn buy(c: &mut Contract, who: AccountId, tier: u32, price: NearToken) -> TokenId {
    set_ctx(who, price);
    c.buy_share(1, tier)
}

fn mint_role(c: &mut Contract, to: AccountId, role: &str, weight: u32) -> TokenId {
    set_ctx(founder(), zero());
    c.mint_role(1, to, role.into(), weight, None)
}

// ------------------------------------------------------------------- startups

#[test]
fn create_startup_stores_founder_tiers_and_defaults() {
    let mut c = Contract::new(platform(), 0);
    set_ctx(founder(), zero());
    c.create_startup("Heto Labs".into(), tiers(), None, None);
    let s = c.get_startup(1).unwrap();
    assert_eq!(s.founder, founder());
    assert_eq!(s.treasury, founder(), "treasury defaults to the founder");
    assert_eq!(s.allocation, Allocation::default_split());
    assert_eq!(s.tiers.len(), 2);
    assert_eq!(s.tiers[1].name, "Board");
    assert_eq!(s.tiers[1].weight, 10);
    assert_eq!(c.get_startups(None, None).len(), 1);
}

#[test]
fn treasury_can_be_set_at_creation() {
    set_ctx(founder(), zero());
    let mut c = Contract::new(platform(), 0);
    c.create_startup("Heto Labs".into(), tiers(), Some(stranger()), None);
    assert_eq!(c.get_startup(1).unwrap().treasury, stranger());
}

#[test]
#[should_panic(expected = "Between 1 and 8 tiers required")]
fn create_startup_needs_a_tier() {
    set_ctx(founder(), zero());
    let mut c = Contract::new(platform(), 0);
    c.create_startup("No Tiers".into(), vec![], None, None);
}

#[test]
#[should_panic(expected = "Tier weight must be above zero")]
fn create_startup_rejects_zero_weight() {
    set_ctx(founder(), zero());
    let mut c = Contract::new(platform(), 0);
    let mut t = tiers();
    t[0].weight = 0;
    c.create_startup("Bad".into(), t, None, None);
}

#[test]
#[should_panic(expected = "Allocation must add up to 100%")]
fn allocation_must_add_up() {
    setup_with(0, Some(alloc(6_000, 2_000, 1_000, 0)));
}

#[test]
#[should_panic(expected = "Shareholders must keep at least 30%")]
fn allocation_enforces_shareholder_floor() {
    // 30% to holders, but 20% of that goes to roles, leaving shareholders 24%.
    setup_with(0, Some(alloc(3_000, 3_500, 3_500, 2_000)));
}

#[test]
fn allocation_at_the_floor_is_allowed() {
    setup_with(0, Some(alloc(3_000, 3_500, 3_500, 0)));
}

#[test]
#[should_panic(expected = "Role pool is capped at 20%")]
fn role_pool_is_capped() {
    setup_with(0, Some(alloc(8_000, 1_000, 1_000, 2_500)));
}

#[test]
#[should_panic(expected = "Platform fee is capped at 5%")]
fn platform_fee_is_capped() {
    Contract::new(platform(), 600);
}

#[test]
fn platform_info_is_public() {
    let c = Contract::new(platform(), 100);
    let p = c.get_platform();
    assert_eq!(p.account_id, platform());
    assert_eq!(p.fee_bps, 100);
}

// --------------------------------------------------------------------- shares

#[test]
fn buy_share_mints_nft_with_tier() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));

    let token = c.nft_token(id.clone()).unwrap();
    assert_eq!(token.owner_id, investor());
    assert_eq!(token.kind, TokenKind::Share { tier: 0 });
    assert_eq!(token.startup_id, 1);

    let s = c.get_startup(1).unwrap();
    assert_eq!(s.tiers[0].minted, 1);
    assert_eq!(s.raised, near(1));

    let mine = c.nft_tokens_for_owner(investor(), None, None);
    assert_eq!(mine.len(), 1);
    assert_eq!(mine[0].token_id, id);
    assert_eq!(c.nft_total_supply(), U128(1));
}

#[test]
fn share_sale_goes_to_treasury_and_platform() {
    // 1% platform fee on a 1 NEAR share: 0.01 to the platform, 0.99 to the treasury.
    let mut c = setup_with(100, Some(alloc(10_000, 0, 0, 0)));
    buy(&mut c, investor(), 0, near(1));
    let receipts = get_created_receipts();
    let paid_to = |who: &AccountId| receipts.iter().any(|r| &r.receiver_id == who);
    assert!(paid_to(&platform()));
    assert!(paid_to(&founder()), "treasury defaults to the founder");
}

#[test]
#[should_panic(expected = "below the tier price")]
fn buy_share_underpaid_panics() {
    let mut c = setup();
    buy(&mut c, investor(), 0, NearToken::from_millinear(500));
}

#[test]
#[should_panic(expected = "Tier is sold out")]
fn buy_share_sold_out_panics() {
    let mut c = setup();
    buy(&mut c, investor(), 1, near(5));
    c.buy_share(1, 1); // Board tier has max_supply 1
}

#[test]
#[should_panic(expected = "Startup not found")]
fn buy_share_unknown_startup_panics() {
    let mut c = setup();
    set_ctx(investor(), near(1));
    c.buy_share(99, 0);
}

#[test]
fn share_nft_can_be_transferred() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));

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
    let id = buy(&mut c, investor(), 0, near(1));
    set_ctx(stranger(), NearToken::from_yoctonear(1));
    c.nft_transfer(founder(), id, None, None);
}

// ---------------------------------------------------------------------- roles

#[test]
fn founder_mints_role_nft() {
    let mut c = setup();
    set_ctx(founder(), zero());
    let id = c.mint_role(
        1,
        stranger(),
        "CTO".into(),
        3,
        Some("https://img.test/cto.jpg".into()),
    );
    let token = c.nft_token(id).unwrap();
    assert_eq!(token.owner_id, stranger());
    assert_eq!(
        token.kind,
        TokenKind::Role {
            role: "CTO".into(),
            weight: 3,
            media: Some("https://img.test/cto.jpg".into()),
            display_media: None,
        }
    );
    assert_eq!(c.get_startup(1).unwrap().total_role_weight, 3);
}

#[test]
#[should_panic(expected = "Only the founder can mint roles")]
fn only_founder_mints_roles() {
    let mut c = setup();
    set_ctx(investor(), zero());
    c.mint_role(1, investor(), "CEO".into(), 1, None);
}

#[test]
#[should_panic(expected = "Role weight is capped at 100")]
fn role_weight_is_capped() {
    let mut c = setup();
    set_ctx(founder(), zero());
    c.mint_role(1, stranger(), "CEO".into(), 101, None);
}

#[test]
#[should_panic(expected = "soulbound")]
fn role_nft_cannot_be_transferred() {
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CTO", 1);
    set_ctx(stranger(), NearToken::from_yoctonear(1));
    c.nft_transfer(investor(), id, None, None);
}

#[test]
#[should_panic(expected = "soulbound")]
fn internal_transfer_rejects_roles_directly() {
    // Any future transfer pathway calls internal_transfer, so it must refuse roles itself.
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CTO", 1);
    c.internal_transfer(stranger(), investor(), id);
}

#[test]
fn founder_revokes_role() {
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CEO", 2);
    assert_eq!(c.nft_total_supply(), U128(1));

    set_ctx(founder(), zero());
    c.revoke_role(id.clone());
    assert!(c.nft_token(id).is_none());
    assert!(c.nft_tokens_for_owner(stranger(), None, None).is_empty());
    assert_eq!(c.nft_total_supply(), U128(0));
    assert_eq!(c.get_startup(1).unwrap().total_role_weight, 0);
}

#[test]
#[should_panic(expected = "Only the founder can revoke roles")]
fn only_founder_revokes_roles() {
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CEO", 1);
    set_ctx(stranger(), zero());
    c.revoke_role(id);
}

#[test]
#[should_panic(expected = "Only role NFTs can be revoked")]
fn founder_cannot_revoke_a_share() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));
    set_ctx(founder(), zero());
    c.revoke_role(id);
}

// ------------------------------------------------------------- role display

#[test]
fn owner_sets_display_image_and_original_stays() {
    let mut c = setup();
    set_ctx(founder(), zero());
    let id = c.mint_role(
        1,
        stranger(),
        "CEO".into(),
        1,
        Some("https://img.test/original.jpg".into()),
    );

    set_ctx(stranger(), zero());
    c.set_display_media(id.clone(), Some("ipfs://my-own-pfp".into()));
    match c.nft_token(id.clone()).unwrap().kind {
        TokenKind::Role {
            media,
            display_media,
            ..
        } => {
            assert_eq!(media.as_deref(), Some("https://img.test/original.jpg"));
            assert_eq!(display_media.as_deref(), Some("ipfs://my-own-pfp"));
        }
        _ => panic!("expected a role"),
    }

    c.set_display_media(id.clone(), None);
    match c.nft_token(id).unwrap().kind {
        TokenKind::Role { display_media, .. } => assert!(display_media.is_none()),
        _ => panic!("expected a role"),
    }
}

#[test]
#[should_panic(expected = "Only the owner can change the display image")]
fn only_owner_changes_display_image() {
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CEO", 1);
    set_ctx(founder(), zero());
    c.set_display_media(id, Some("https://img.test/x.jpg".into()));
}

#[test]
#[should_panic(expected = "Image must be an https:// or ipfs:// link")]
fn display_image_must_be_a_safe_link() {
    let mut c = setup();
    let id = mint_role(&mut c, stranger(), "CEO", 1);
    set_ctx(stranger(), zero());
    c.set_display_media(id, Some("javascript:alert(1)".into()));
}

#[test]
#[should_panic(expected = "Only role NFTs have a display image")]
fn shares_have_no_display_image() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));
    set_ctx(investor(), zero());
    c.set_display_media(id, Some("https://img.test/x.jpg".into()));
}

// ------------------------------------------------------------------ migration

#[test]
fn migration_marks_startup_and_freezes_new_activity() {
    let mut c = setup();
    set_ctx(founder(), zero());
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
    set_ctx(founder(), zero());
    c.mark_migrated(1, accounts(4));
    set_ctx(investor(), near(1));
    c.buy_share(1, 0);
}

#[test]
#[should_panic(expected = "migrated and frozen")]
fn migrated_startup_rejects_new_revenue() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1));
    set_ctx(founder(), zero());
    c.mark_migrated(1, accounts(4));
    deposit(&mut c, near(1));
}

#[test]
#[should_panic(expected = "Only the founder can migrate the startup")]
fn only_founder_migrates() {
    let mut c = setup();
    set_ctx(investor(), zero());
    c.mark_migrated(1, accounts(4));
}

#[test]
fn holders_can_still_transfer_and_claim_after_migration() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(2));

    set_ctx(founder(), zero());
    c.mark_migrated(1, accounts(4));

    // Holders are never trapped: they can still sell and still collect what they earned.
    set_ctx(investor(), NearToken::from_yoctonear(1));
    c.nft_transfer(stranger(), id, None, None);
    assert_eq!(c.get_claimable(investor()), near(2));
    set_ctx(investor(), zero());
    let _ = c.claim();
    assert_eq!(c.get_claimable(investor()), zero());
}

// -------------------------------------------------------------------- revenue

#[test]
fn revenue_splits_by_tier_weight() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1)); // General, weight 1
    buy(&mut c, stranger(), 1, near(5)); // Board, weight 10
    deposit(&mut c, near(11));

    // total weight = 1 + 10 = 11, so 11 NEAR splits 1 : 10.
    assert_eq!(c.get_claimable(investor()), near(1));
    assert_eq!(c.get_claimable(stranger()), near(10));
    assert_eq!(c.get_startup(1).unwrap().revenue, near(11));
}

#[test]
fn late_buyer_gets_nothing_from_past_revenue() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(2));

    buy(&mut c, stranger(), 0, near(1));
    assert_eq!(c.get_claimable(stranger()), zero());
    assert_eq!(c.get_claimable(investor()), near(2));

    deposit(&mut c, near(2)); // now two equal holders: 1 NEAR each
    assert_eq!(c.get_claimable(stranger()), near(1));
    assert_eq!(c.get_claimable(investor()), near(3));
}

#[test]
fn seller_keeps_revenue_accrued_before_the_sale() {
    let mut c = setup();
    let id = buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(3));

    set_ctx(investor(), NearToken::from_yoctonear(1));
    c.nft_transfer(stranger(), id, None, None);

    // Seller keeps the 3 NEAR; buyer starts fresh.
    assert_eq!(c.get_claimable(investor()), near(3));
    assert_eq!(c.get_claimable(stranger()), zero());

    // Revenue after the sale belongs to the buyer.
    deposit(&mut c, near(2));
    assert_eq!(c.get_claimable(investor()), near(3));
    assert_eq!(c.get_claimable(stranger()), near(2));
}

#[test]
fn claim_pays_once_then_nothing_is_left() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(2));

    set_ctx(investor(), zero());
    let _ = c.claim();
    assert_eq!(c.get_claimable(investor()), zero());

    deposit(&mut c, near(1)); // new revenue after the claim is claimable again
    assert_eq!(c.get_claimable(investor()), near(1));
}

#[test]
#[should_panic(expected = "Nothing to claim")]
fn second_claim_with_nothing_new_panics() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(2));
    set_ctx(investor(), zero());
    let _ = c.claim();
    let _ = c.claim();
}

#[test]
#[should_panic(expected = "No shareholders yet")]
fn revenue_needs_at_least_one_share() {
    let mut c = setup();
    deposit(&mut c, near(1));
}

#[test]
#[should_panic(expected = "Attach revenue to deposit")]
fn revenue_must_be_above_zero() {
    let mut c = setup();
    deposit(&mut c, zero());
}

// -------------------------------------------------------------------- buckets

#[test]
fn deposit_fills_the_buckets() {
    let mut c = setup_with(0, Some(alloc(6_000, 2_000, 2_000, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));

    let s = c.get_startup(1).unwrap();
    assert_eq!(s.agent_balance, near(2));
    assert_eq!(s.ops_balance, near(2));
    assert_eq!(c.get_claimable(investor()), near(6));
    assert_eq!(s.revenue, near(10));
}

#[test]
fn platform_fee_comes_off_the_top() {
    let mut c = setup_with(100, Some(alloc(10_000, 0, 0, 0))); // 1% fee
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(100));

    assert_eq!(c.get_claimable(investor()), near(99));
    assert_eq!(c.get_startup(1).unwrap().revenue, near(100));
    let receipts = get_created_receipts();
    assert!(receipts.iter().any(|r| r.receiver_id == platform()));
}

#[test]
fn fee_applies_before_the_buckets_split() {
    let mut c = setup_with(100, Some(alloc(5_000, 2_500, 2_500, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(100)); // 99 after the fee

    let s = c.get_startup(1).unwrap();
    assert_eq!(s.agent_balance, NearToken::from_millinear(24_750));
    assert_eq!(s.ops_balance, NearToken::from_millinear(24_750));
    assert_eq!(
        c.get_claimable(investor()),
        NearToken::from_millinear(49_500)
    );
}

// ------------------------------------------------------------------ role pool

#[test]
fn role_pool_pays_active_roles_by_weight() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000))); // 10% role pool
    buy(&mut c, investor(), 0, near(1));
    mint_role(&mut c, stranger(), "CEO", 2);
    mint_role(&mut c, payer(), "Advisor", 3);

    deposit(&mut c, near(10)); // 1 NEAR to the role pool, split 2 : 3

    assert_eq!(c.get_claimable(investor()), near(9));
    assert_eq!(c.get_claimable(stranger()), NearToken::from_millinear(400));
    assert_eq!(c.get_claimable(payer()), NearToken::from_millinear(600));
}

#[test]
fn external_ceo_with_no_shares_still_earns_from_the_role_pool() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, investor(), 0, near(1));
    mint_role(&mut c, stranger(), "CEO", 1);
    deposit(&mut c, near(10));
    assert_eq!(c.get_claimable(stranger()), near(1));
}

#[test]
fn role_with_zero_weight_earns_nothing() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, investor(), 0, near(1));
    mint_role(&mut c, stranger(), "Advisor", 0);
    deposit(&mut c, near(10));
    assert_eq!(c.get_claimable(stranger()), zero());
    assert_eq!(c.get_claimable(investor()), near(10));
}

#[test]
fn role_pool_goes_to_shareholders_when_no_role_is_active() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    assert_eq!(c.get_claimable(investor()), near(10));
}

#[test]
fn no_role_pool_means_roles_earn_nothing() {
    let mut c = setup(); // role_bps = 0
    buy(&mut c, investor(), 0, near(1));
    mint_role(&mut c, stranger(), "CEO", 5);
    deposit(&mut c, near(4));
    assert_eq!(c.get_claimable(stranger()), zero());
    assert_eq!(c.get_claimable(investor()), near(4));
}

#[test]
fn revoked_role_keeps_what_it_earned_then_stops() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, investor(), 0, near(1));
    let role = mint_role(&mut c, stranger(), "CEO", 2);
    deposit(&mut c, near(10));
    assert_eq!(c.get_claimable(stranger()), near(1));

    set_ctx(founder(), zero());
    c.revoke_role(role);
    assert_eq!(
        c.get_claimable(stranger()),
        near(1),
        "earned revenue is settled to the former role holder"
    );

    deposit(&mut c, near(10)); // no active role now, so shareholders get it all
    assert_eq!(c.get_claimable(stranger()), near(1));
    assert_eq!(c.get_claimable(investor()), near(19));

    set_ctx(stranger(), zero());
    let _ = c.claim(); // the former role holder can still collect
    assert_eq!(c.get_claimable(stranger()), zero());
}

#[test]
fn late_role_gets_nothing_from_past_revenue() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    mint_role(&mut c, stranger(), "CEO", 2);
    assert_eq!(c.get_claimable(stranger()), zero());

    deposit(&mut c, near(10));
    assert_eq!(c.get_claimable(stranger()), near(1));
    assert_eq!(c.get_claimable(investor()), near(19));
}

#[test]
fn role_holder_who_also_owns_shares_earns_both() {
    let mut c = setup_with(0, Some(alloc(10_000, 0, 0, 1_000)));
    buy(&mut c, stranger(), 0, near(1));
    mint_role(&mut c, stranger(), "CEO", 1);
    deposit(&mut c, near(10)); // 9 to the share, 1 to the role
    assert_eq!(c.get_claimable(stranger()), near(10));
}

// --------------------------------------------------------- operations spending

#[test]
fn founder_spends_operations_with_a_memo() {
    let mut c = setup_with(0, Some(alloc(5_000, 0, 5_000, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    assert_eq!(c.get_startup(1).unwrap().ops_balance, near(5));

    set_ctx(founder(), zero());
    let _ = c.spend_operations(1, stranger(), near(2), "Hosting for November".into());
    assert_eq!(c.get_startup(1).unwrap().ops_balance, near(3));
}

#[test]
#[should_panic(expected = "Only the founder can spend operations funds")]
fn only_founder_spends_operations() {
    let mut c = setup_with(0, Some(alloc(5_000, 0, 5_000, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    set_ctx(stranger(), zero());
    let _ = c.spend_operations(1, stranger(), near(1), "Gimme".into());
}

#[test]
#[should_panic(expected = "Not enough operations balance")]
fn cannot_spend_more_than_the_operations_balance() {
    let mut c = setup_with(0, Some(alloc(5_000, 0, 5_000, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    set_ctx(founder(), zero());
    let _ = c.spend_operations(1, stranger(), near(6), "Too much".into());
}

#[test]
#[should_panic(expected = "Memo must be 1-140 characters")]
fn operations_spending_needs_a_memo() {
    let mut c = setup_with(0, Some(alloc(5_000, 0, 5_000, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    set_ctx(founder(), zero());
    let _ = c.spend_operations(1, stranger(), near(1), "  ".into());
}

// --------------------------------------------------------------------- agents

fn agent() -> AccountId {
    "agent.testnet".parse().unwrap()
}

const DAY: u64 = NANOS_PER_DAY;

fn ctx_at(predecessor: AccountId, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(accounts(0))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .block_timestamp(ts);
    testing_env!(b.build());
}

/// Startup 1 with 5 NEAR in the agent bucket and one NEW agent (on probation): max 1 NEAR a
/// payment, 3 NEAR a day, allowed to pay only `stranger()`.
fn with_new_agent() -> Contract {
    let mut c = setup_with(0, Some(alloc(5_000, 5_000, 0, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10));
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(5));
    set_ctx(founder(), zero());
    c.register_agent(
        1,
        agent(),
        "Ops bot".into(),
        near(1),
        near(3),
        vec![stranger()],
    );
    c
}

/// The same agent, already promoted (full limits).
fn with_agent() -> Contract {
    let mut c = with_new_agent();
    set_ctx(founder(), zero());
    c.promote_agent(1, agent());
    c
}

fn spend(c: &mut Contract, to: AccountId, amount: NearToken, ts: u64) -> bool {
    ctx_at(agent(), ts);
    c.agent_spend(1, to, amount, "Cloud credits".into())
}

fn last_log() -> String {
    near_sdk::test_utils::get_logs()
        .last()
        .cloned()
        .unwrap_or_default()
}

#[test]
fn founder_registers_an_agent() {
    let c = with_agent();
    let a = c.get_agent(1, agent()).unwrap();
    assert!(a.active);
    assert_eq!(a.per_tx_cap, near(1));
    assert_eq!(a.payees, vec![stranger()]);
    assert_eq!(c.get_startup(1).unwrap().agents.len(), 1);
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn only_founder_registers_agents() {
    let mut c = with_agent();
    set_ctx(stranger(), zero());
    c.register_agent(1, stranger(), "Evil".into(), near(1), near(1), vec![]);
}

#[test]
#[should_panic(expected = "Agent already registered")]
fn cannot_register_an_agent_twice() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.register_agent(1, agent(), "Dup".into(), near(1), near(1), vec![]);
}

#[test]
#[should_panic(expected = "Daily cap cannot be below")]
fn daily_cap_must_cover_one_payment() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.register_agent(1, stranger(), "Bot".into(), near(2), near(1), vec![]);
}

#[test]
#[should_panic(expected = "At most 5 agents")]
fn agent_count_is_capped() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    for i in 0..5 {
        let id: AccountId = format!("bot{i}.testnet").parse().unwrap();
        c.register_agent(1, id, "Bot".into(), near(1), near(1), vec![]);
    }
}

#[test]
#[should_panic(expected = "Duplicate payee")]
fn duplicate_payees_are_rejected() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.register_agent(
        1,
        stranger(),
        "Bot".into(),
        near(1),
        near(1),
        vec![payer(), payer()],
    );
}

#[test]
fn agent_pays_an_allowed_payee_from_its_bucket() {
    let mut c = with_agent();
    assert!(spend(&mut c, stranger(), near(1), 1));
    assert_eq!(get_created_receipts().len(), 1);
    let s = c.get_startup(1).unwrap();
    assert_eq!(s.agent_balance, near(4));
    assert_eq!(s.ops_balance, zero(), "other buckets are untouched");
    assert_eq!(c.get_agent(1, agent()).unwrap().spent_today, near(1));
    assert!(last_log().contains("agent_spend"));
}

#[test]
#[should_panic(expected = "Not a registered agent")]
fn strangers_cannot_call_agent_spend() {
    let mut c = with_agent();
    ctx_at(stranger(), 1);
    c.agent_spend(1, stranger(), near(1), "Hi".into());
}

#[test]
#[should_panic(expected = "Not a registered agent")]
fn founder_is_not_an_agent() {
    let mut c = with_agent();
    ctx_at(founder(), 1);
    c.agent_spend(1, stranger(), near(1), "Hi".into());
}

#[test]
fn payment_over_the_cap_is_refused_and_logged() {
    let mut c = with_agent();
    assert!(!spend(&mut c, stranger(), near(2), 1));
    assert!(get_created_receipts().is_empty());
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(5));
    assert!(last_log().contains("agent_spend_refused"));
    assert!(last_log().contains("over_per_payment_cap"));
}

#[test]
fn unlisted_payee_is_refused() {
    let mut c = with_agent();
    assert!(!spend(&mut c, investor(), near(1), 1));
    assert!(get_created_receipts().is_empty());
    assert!(last_log().contains("payee_not_allowed"));
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(5));
}

#[test]
fn daily_cap_stops_the_agent_and_resets_next_day() {
    let mut c = with_agent();
    assert!(spend(&mut c, stranger(), near(1), 10));
    assert!(spend(&mut c, stranger(), near(1), 20));
    assert!(spend(&mut c, stranger(), near(1), 30));
    assert!(
        !spend(&mut c, stranger(), near(1), 40),
        "fourth payment is over 3 NEAR a day"
    );
    assert!(last_log().contains("over_daily_cap"));
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(2));
    assert!(
        spend(&mut c, stranger(), near(1), DAY + 1),
        "a new day resets the limit"
    );
    assert_eq!(c.get_agent(1, agent()).unwrap().spent_today, near(1));
}

#[test]
fn agent_cannot_spend_more_than_its_bucket_holds() {
    let mut c = setup_with(0, Some(alloc(9_000, 1_000, 0, 0)));
    buy(&mut c, investor(), 0, near(1));
    deposit(&mut c, near(10)); // agent bucket: 1 NEAR
    set_ctx(founder(), zero());
    c.register_agent(1, agent(), "Bot".into(), near(5), near(5), vec![stranger()]);
    c.promote_agent(1, agent());
    assert!(spend(&mut c, stranger(), near(1), 1));
    assert!(!spend(&mut c, stranger(), near(1), 2));
    assert!(last_log().contains("not_enough_agent_budget"));
}

#[test]
fn kill_switch_pauses_and_resumes_an_agent() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.set_agent_active(1, agent(), false);
    assert!(!spend(&mut c, stranger(), near(1), 1));
    assert!(last_log().contains("agent_paused"));
    set_ctx(founder(), zero());
    c.set_agent_active(1, agent(), true);
    assert!(spend(&mut c, stranger(), near(1), 2));
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn agent_cannot_unpause_itself() {
    let mut c = with_agent();
    ctx_at(agent(), 1);
    c.set_agent_active(1, agent(), true);
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn agent_cannot_raise_its_own_limits() {
    let mut c = with_agent();
    ctx_at(agent(), 1);
    c.update_agent_policy(1, agent(), near(100), near(100), vec![agent()]);
}

#[test]
fn founder_can_tighten_limits_and_todays_spend_is_kept() {
    let mut c = with_agent();
    assert!(spend(&mut c, stranger(), near(1), 1));
    set_ctx(founder(), zero());
    c.update_agent_policy(1, agent(), near(1), near(1), vec![stranger()]);
    assert!(
        !spend(&mut c, stranger(), near(1), 2),
        "already spent the new daily cap"
    );
    assert!(last_log().contains("over_daily_cap"));
}

#[test]
#[should_panic(expected = "Not a registered agent")]
fn removed_agent_cannot_spend() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.remove_agent(1, agent());
    spend(&mut c, stranger(), near(1), 1);
}

#[test]
#[should_panic(expected = "Startup is migrated and frozen")]
fn migrated_startup_blocks_agent_spending() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.mark_migrated(1, accounts(4));
    spend(&mut c, stranger(), near(1), 1);
}

// ------------------------------------------------------ probation, managers, reputation

fn cto() -> AccountId {
    investor()
}

/// Startup 1 with an agent bucket, "CTO" allowed to manage agents (up to 2 NEAR a payment and
/// 4 NEAR a day), and `cto()` holding a CTO role NFT. Returns the role's token id too.
fn with_manager() -> (Contract, TokenId) {
    let mut c = setup_with(0, Some(alloc(5_000, 5_000, 0, 0)));
    buy(&mut c, payer(), 0, near(1));
    deposit(&mut c, near(10));
    let role = mint_role(&mut c, cto(), "CTO", 0);
    set_ctx(founder(), zero());
    c.set_agent_managers(1, vec!["CTO".into()], near(2), near(4));
    (c, role)
}

fn hire(c: &mut Contract, by: AccountId, per_tx: u128, daily: u128) {
    set_ctx(by, zero());
    c.register_agent(
        1,
        agent(),
        "Bot".into(),
        near(per_tx),
        near(daily),
        vec![stranger()],
    );
}

#[test]
fn new_agent_is_on_probation_with_a_tenth_of_its_limits() {
    let mut c = with_new_agent();
    assert!(
        !spend(&mut c, stranger(), near(1), 1),
        "1 NEAR is within its cap but not within probation"
    );
    assert!(last_log().contains("probation_per_payment_cap"));
    // probation allows 0.1 NEAR a payment and 0.3 NEAR a day
    let tenth = NearToken::from_millinear(100);
    assert!(spend(&mut c, stranger(), tenth, 2));
    assert!(spend(&mut c, stranger(), tenth, 3));
    assert!(spend(&mut c, stranger(), tenth, 4));
    assert!(!spend(&mut c, stranger(), tenth, 5));
    assert!(last_log().contains("probation_daily_cap"));
}

#[test]
fn probation_over_the_real_cap_is_a_plain_refusal() {
    let mut c = with_new_agent();
    assert!(!spend(&mut c, stranger(), near(2), 1));
    assert!(last_log().contains("over_per_payment_cap"));
}

#[test]
fn probation_ends_by_itself_after_three_days() {
    let mut c = with_new_agent();
    assert!(!spend(&mut c, stranger(), near(1), 3 * DAY - 1));
    assert!(spend(&mut c, stranger(), near(1), 3 * DAY + 1));
}

#[test]
fn founder_can_promote_an_agent_early() {
    let c = with_agent();
    assert_eq!(c.get_agent(1, agent()).unwrap().probation_until, 0);
    assert!(last_log().contains("agent_promoted"));
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn agent_cannot_promote_itself() {
    let mut c = with_new_agent();
    ctx_at(agent(), 1);
    c.promote_agent(1, agent());
}

#[test]
fn founder_names_manager_roles() {
    let (c, _) = with_manager();
    let s = c.get_startup(1).unwrap();
    assert_eq!(s.manager_roles, vec!["CTO".to_string()]);
    assert_eq!(s.manager_max_per_tx, near(2));
    assert_eq!(s.manager_max_daily, near(4));
}

#[test]
#[should_panic(expected = "Only the founder can do this")]
fn only_founder_names_manager_roles() {
    let (mut c, _) = with_manager();
    set_ctx(cto(), zero());
    c.set_agent_managers(1, vec!["CTO".into()], near(100), near(100));
}

#[test]
#[should_panic(expected = "Duplicate role")]
fn manager_roles_cannot_repeat() {
    let mut c = setup_with(0, None);
    set_ctx(founder(), zero());
    c.set_agent_managers(1, vec!["CTO".into(), "CTO".into()], near(1), near(1));
}

#[test]
#[should_panic(expected = "At most 5 manager roles")]
fn manager_roles_are_capped() {
    let mut c = setup_with(0, None);
    set_ctx(founder(), zero());
    let roles = (0..6).map(|i| format!("R{i}")).collect();
    c.set_agent_managers(1, roles, near(1), near(1));
}

#[test]
fn manager_hires_within_the_ceiling_and_is_recorded() {
    let (mut c, _) = with_manager();
    hire(&mut c, cto(), 2, 4);
    let a = c.get_agent(1, agent()).unwrap();
    assert_eq!(a.hired_by, cto());
    assert!(
        a.probation_until > 0,
        "managers' hires start on probation too"
    );
}

#[test]
#[should_panic(expected = "Above the limits set for managers")]
fn manager_cannot_hire_above_the_ceiling() {
    let (mut c, _) = with_manager();
    hire(&mut c, cto(), 3, 4);
}

#[test]
#[should_panic(expected = "Above the limits set for managers")]
fn manager_cannot_raise_limits_above_the_ceiling() {
    let (mut c, _) = with_manager();
    hire(&mut c, cto(), 1, 2);
    set_ctx(cto(), zero());
    c.update_agent_policy(1, agent(), near(1), near(5), vec![stranger()]);
}

#[test]
fn founder_is_not_bound_by_the_manager_ceiling() {
    let (mut c, _) = with_manager();
    hire(&mut c, founder(), 50, 100);
    assert_eq!(c.get_agent(1, agent()).unwrap().per_tx_cap, near(50));
}

#[test]
fn manager_can_pause_promote_and_fire() {
    let (mut c, _) = with_manager();
    hire(&mut c, cto(), 1, 2);
    set_ctx(cto(), zero());
    c.set_agent_active(1, agent(), false);
    assert!(!c.get_agent(1, agent()).unwrap().active);
    c.set_agent_active(1, agent(), true);
    c.promote_agent(1, agent());
    assert_eq!(c.get_agent(1, agent()).unwrap().probation_until, 0);
    c.remove_agent(1, agent());
    assert!(c.get_agent(1, agent()).is_none());
}

#[test]
#[should_panic(expected = "Only the founder can do this")]
fn manager_cannot_change_who_the_managers_are() {
    let (mut c, _) = with_manager();
    set_ctx(cto(), zero());
    c.set_agent_managers(1, vec!["CTO".into(), "Intern".into()], near(2), near(4));
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn role_not_on_the_manager_list_has_no_power() {
    let (mut c, _) = with_manager();
    mint_role(&mut c, stranger(), "Designer", 0);
    hire(&mut c, stranger(), 1, 1);
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn share_holders_are_not_managers() {
    let (mut c, _) = with_manager();
    hire(&mut c, payer(), 1, 1);
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn revoked_manager_loses_the_power_at_once() {
    let (mut c, role) = with_manager();
    set_ctx(founder(), zero());
    c.revoke_role(role);
    hire(&mut c, cto(), 1, 1);
}

#[test]
#[should_panic(expected = "Only the founder or an agent manager can do this")]
fn manager_role_of_another_startup_is_useless_here() {
    let (mut c, _) = with_manager();
    set_ctx(founder(), zero());
    let id = c.create_startup("Other".into(), tiers(), None, None);
    c.set_agent_managers(id, vec!["CTO".into()], near(2), near(4));
    c.mint_role(id, stranger(), "CTO".into(), 0, None);
    hire(&mut c, stranger(), 1, 1); // startup 1, not 2
}

#[test]
fn unknown_account_has_an_empty_record() {
    let c = with_agent();
    assert_eq!(c.get_agent_reputation(stranger()), AgentStats::default());
}

#[test]
fn reputation_counts_what_the_agent_did() {
    let mut c = with_agent();
    assert!(spend(&mut c, stranger(), near(1), 1));
    assert!(!spend(&mut c, investor(), near(1), 2));
    set_ctx(founder(), zero());
    c.set_agent_active(1, agent(), false);
    c.remove_agent(1, agent());
    let r = c.get_agent_reputation(agent());
    assert_eq!(r.startups_served, 1);
    assert_eq!(r.spends_ok, 1);
    assert_eq!(r.spends_refused, 1);
    assert_eq!(r.total_spent, near(1));
    assert_eq!(r.times_paused, 1);
    assert_eq!(r.times_removed, 1);
}

#[test]
fn pausing_an_already_paused_agent_is_counted_once() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.set_agent_active(1, agent(), false);
    c.set_agent_active(1, agent(), false);
    assert_eq!(c.get_agent_reputation(agent()).times_paused, 1);
}

#[test]
fn reputation_follows_the_agent_across_startups() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    let id = c.create_startup("Other".into(), tiers(), None, None);
    c.register_agent(
        id,
        agent(),
        "Bot".into(),
        near(1),
        near(1),
        vec![stranger()],
    );
    assert_eq!(c.get_agent_reputation(agent()).startups_served, 2);
}

#[test]
fn refusals_by_a_paused_agent_still_count() {
    let mut c = with_agent();
    set_ctx(founder(), zero());
    c.set_agent_active(1, agent(), false);
    assert!(!spend(&mut c, stranger(), near(1), 1));
    assert_eq!(c.get_agent_reputation(agent()).spends_refused, 1);
}