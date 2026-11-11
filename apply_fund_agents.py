#!/usr/bin/env python3
"""Adds fund_agents to contracts/src/lib.rs and its tests to contracts/src/tests.rs. Run from the repo root."""
import sys

LIB = 'contracts/src/lib.rs'
TESTS = 'contracts/src/tests.rs'

METHOD = '''    /// Anyone (an investor, a supporter, a customer) tops up a startup's agent budget directly. The whole
    /// deposit goes into the agent budget bucket: no platform fee and no split, so it is exactly what the
    /// startup's agents can use, and only inside their limits (per-payment cap, daily cap, allowed payees).
    /// It is not revenue, so it does not change what shareholders earn. Nothing here lets the funder spend it.
    #[payable]
    pub fn fund_agents(&mut self, startup_id: StartupId) {
        let deposit = env::attached_deposit();
        require!(!deposit.is_zero(), "Attach funds for the agents");
        let funder = env::predecessor_account_id();
        let startup = self
            .startups
            .get_mut(&startup_id)
            .unwrap_or_else(|| env::panic_str("Startup not found"));
        require!(
            startup.status == StartupStatus::Active,
            "Startup is migrated and frozen"
        );
        startup.agent_balance = startup
            .agent_balance
            .checked_add(deposit)
            .unwrap_or_else(|| env::panic_str("Agent budget overflow"));
        emit_event(
            "heto",
            "1.0.0",
            "agents_funded",
            json!([{
                "startup_id": startup_id,
                "from": funder,
                "amount": deposit.as_yoctonear().to_string(),
            }]),
        );
    }

'''

TEST_BLOCK = '''
// ------------------------------------------------------------------ fund_agents

fn fund(c: &mut Contract, who: AccountId, amount: NearToken) {
    set_ctx(who, amount);
    c.fund_agents(1);
}

#[test]
fn anyone_can_top_up_the_agent_budget() {
    let mut c = setup();
    fund(&mut c, investor(), near(2));
    fund(&mut c, stranger(), near(3));
    let s = c.get_startup(1).unwrap();
    assert_eq!(s.agent_balance, near(5));
    assert_eq!(s.revenue, zero(), "a top-up is not revenue");
    assert_eq!(s.ops_balance, zero());
    assert!(last_log().contains("agents_funded"));
}

#[test]
fn a_top_up_pays_no_platform_fee() {
    let mut c = setup_with(500, Some(alloc(10_000, 0, 0, 0)));
    fund(&mut c, investor(), near(10));
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(10));
    assert!(get_created_receipts().is_empty(), "nothing is sent to the platform");
}

#[test]
fn a_top_up_does_not_change_what_shareholders_earn() {
    let mut c = setup();
    buy(&mut c, investor(), 0, near(1));
    fund(&mut c, stranger(), near(4));
    assert_eq!(c.get_claimable(investor()), zero());
}

#[test]
fn topped_up_money_still_obeys_the_agent_limits() {
    let mut c = with_agent();
    fund(&mut c, payer(), near(10));
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(15));
    assert!(spend(&mut c, stranger(), near(1), 1), "within its caps");
    assert!(!spend(&mut c, stranger(), near(2), 2), "over the per-payment cap");
    assert!(!spend(&mut c, payer(), near(1), 3), "payee not on the list");
    assert_eq!(c.get_startup(1).unwrap().agent_balance, near(14));
}

#[test]
#[should_panic(expected = "Attach funds for the agents")]
fn a_top_up_needs_money() {
    let mut c = setup();
    fund(&mut c, investor(), zero());
}

#[test]
#[should_panic(expected = "Startup not found")]
fn cannot_top_up_an_unknown_startup() {
    let mut c = setup();
    set_ctx(investor(), near(1));
    c.fund_agents(9);
}

#[test]
#[should_panic(expected = "Startup is migrated and frozen")]
fn cannot_top_up_a_migrated_startup() {
    let mut c = setup();
    set_ctx(founder(), zero());
    c.mark_migrated(1, accounts(4));
    fund(&mut c, investor(), near(1));
}
'''

MARK = '    /// Pays the caller everything they have earned'

lib = open(LIB, encoding='utf-8').read()
if 'pub fn fund_agents' in lib:
    print('lib.rs already has fund_agents; skipping')
else:
    if lib.count(MARK) != 1:
        sys.exit('Could not find the place to insert in lib.rs (marker not found exactly once). Nothing changed.')
    open(LIB, 'w', encoding='utf-8').write(lib.replace(MARK, METHOD + MARK, 1))
    print('lib.rs: added fund_agents')

tests = open(TESTS, encoding='utf-8').read()
if 'fn anyone_can_top_up_the_agent_budget' in tests:
    print('tests.rs already has the fund_agents tests; skipping')
else:
    open(TESTS, 'w', encoding='utf-8').write(tests.rstrip('\n') + '\n' + TEST_BLOCK)
    print('tests.rs: added 7 tests')
