#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token, vec, Address, Bytes, BytesN, Env, String, Vec,
};

// ------ helpers -----------------------------------------------------------

/// Compute leaf hash the same way the contract does:
///   sha256(xdr(ScVal::Address))
fn leaf_hash(env: &Env, addr: &Address) -> BytesN<32> {
    use soroban_sdk::xdr::ToXdr;
    let xdr = addr.clone().to_xdr(env);
    env.crypto().sha256(&xdr).to_bytes()
}

/// Sort-then-hash pair matching the contract's `hash_pair`.
fn pair_hash(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (first, second) = if a.to_array() <= b.to_array() {
        (a, b)
    } else {
        (b, a)
    };
    let mut buf = Bytes::new(env);
    buf.append(&Bytes::from(first.clone()));
    buf.append(&Bytes::from(second.clone()));
    env.crypto().sha256(&buf).to_bytes()
}

/// Build a Merkle tree from `leaves`, duplicating the last leaf when a
/// level has an odd count. Returns `(root, per_leaf_proofs)`.
fn build_tree(
    env: &Env,
    leaves: &std::vec::Vec<BytesN<32>>,
) -> (BytesN<32>, std::vec::Vec<std::vec::Vec<BytesN<32>>>) {
    assert!(!leaves.is_empty());
    let n = leaves.len();
    // levels[0] = leaves, levels[k+1] = parents of levels[k]
    let mut levels: std::vec::Vec<std::vec::Vec<BytesN<32>>> = std::vec::Vec::new();
    levels.push(leaves.clone());
    while levels.last().unwrap().len() > 1 {
        let cur = levels.last().unwrap().clone();
        let mut next: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut i = 0usize;
        while i < cur.len() {
            let a = &cur[i];
            let b = if i + 1 < cur.len() { &cur[i + 1] } else { &cur[i] };
            next.push(pair_hash(env, a, b));
            i += 2;
        }
        levels.push(next);
    }
    let root = levels.last().unwrap()[0].clone();

    // Build proof for each leaf
    let mut proofs: std::vec::Vec<std::vec::Vec<BytesN<32>>> = std::vec::Vec::new();
    for leaf_idx in 0..n {
        let mut proof: std::vec::Vec<BytesN<32>> = std::vec::Vec::new();
        let mut idx = leaf_idx;
        for level_i in 0..(levels.len() - 1) {
            let lvl = &levels[level_i];
            let sibling_idx = if idx % 2 == 0 {
                if idx + 1 < lvl.len() { idx + 1 } else { idx }
            } else {
                idx - 1
            };
            proof.push(lvl[sibling_idx].clone());
            idx /= 2;
        }
        proofs.push(proof);
    }
    (root, proofs)
}

fn to_soroban_proof(env: &Env, p: &std::vec::Vec<BytesN<32>>) -> Vec<BytesN<32>> {
    let mut out = Vec::new(env);
    for h in p {
        out.push_back(h.clone());
    }
    out
}

/// Bundle of everything a test needs: the contract, a mock SAC token,
/// the treasury address, and a client for the token so tests can mint
/// balance to the community admin.
struct Fixture {
    env: Env,
    client: EVotingContractClient<'static>,
    token_id: Address,
    token_admin: token::StellarAssetClient<'static>,
    token: token::Client<'static>,
    treasury: Address,
    contract_id: Address,
}

const FEE: i128 = 5_000_000; // 0.5 XLM
const BOND_MIN: i128 = 100_000_000; // 10 XLM
const SLASH_GRACE: u64 = 86_400; // 24 hours

fn setup() -> Fixture {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(EVotingContract, ());
    let client = EVotingContractClient::new(&env, &contract_id);

    // Mock native-asset-style SAC.
    let sac_admin = Address::generate(&env);
    let sac = env.register_stellar_asset_contract_v2(sac_admin);
    let token_id = sac.address();
    let token_admin = token::StellarAssetClient::new(&env, &token_id);
    let token = token::Client::new(&env, &token_id);

    let treasury = Address::generate(&env);

    client.initialize(&token_id, &treasury, &FEE, &BOND_MIN, &SLASH_GRACE);

    Fixture {
        env,
        client,
        token_id,
        token_admin,
        token,
        treasury,
        contract_id,
    }
}

/// Register a community with `n` members and mint the admin enough
/// tokens to cover the fee + one bond of `BOND_MIN`.
fn register_with_members(
    fx: &Fixture,
    n: usize,
) -> (Address, u32, std::vec::Vec<Address>, std::vec::Vec<std::vec::Vec<BytesN<32>>>) {
    let admin = Address::generate(&fx.env);
    // Fund the admin so they can pay fee + bond.
    fx.token_admin.mint(&admin, &(FEE + BOND_MIN + 1_000));

    let members: std::vec::Vec<Address> = (0..n).map(|_| Address::generate(&fx.env)).collect();
    let leaves: std::vec::Vec<BytesN<32>> =
        members.iter().map(|a| leaf_hash(&fx.env, a)).collect();
    let (root, proofs) = build_tree(&fx.env, &leaves);

    let cid = fx.client.register_community(
        &admin,
        &String::from_str(&fx.env, "Community"),
        &root,
        &(n as u32),
    );
    (admin, cid, members, proofs)
}

fn default_options(env: &Env) -> Vec<String> {
    vec![
        env,
        String::from_str(env, "Alice"),
        String::from_str(env, "Bob"),
    ]
}

// ------ tests -------------------------------------------------------------

#[test]
fn initialize_records_config() {
    let fx = setup();
    let cfg = fx.client.config();
    assert_eq!(cfg.token, fx.token_id);
    assert_eq!(cfg.treasury, fx.treasury);
    assert_eq!(cfg.fee, FEE);
    assert_eq!(cfg.bond_min, BOND_MIN);
    assert_eq!(cfg.slash_grace_period, SLASH_GRACE);
}

#[test]
fn double_initialize_rejected() {
    let fx = setup();
    let another_treasury = Address::generate(&fx.env);
    let res = fx.client.try_initialize(&fx.token_id, &another_treasury, &1i128, &1i128, &1u64);
    assert!(res.is_err());
}

#[test]
fn create_election_pays_fee_and_locks_bond() {
    let fx = setup();
    let (admin, cid, _members, _proofs) = register_with_members(&fx, 4);

    fx.env.ledger().with_mut(|l| l.timestamp = 1_000);
    let closes_at = 10_000u64;

    let before_admin = fx.token.balance(&admin);
    let before_treasury = fx.token.balance(&fx.treasury);
    let before_contract = fx.token.balance(&fx.contract_id);

    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &closes_at,
        &BOND_MIN,
    );
    assert_eq!(eid, 0);

    // Fee -> treasury, bond -> contract, admin down by (fee + bond).
    assert_eq!(fx.token.balance(&fx.treasury) - before_treasury, FEE);
    assert_eq!(fx.token.balance(&fx.contract_id) - before_contract, BOND_MIN);
    assert_eq!(before_admin - fx.token.balance(&admin), FEE + BOND_MIN);

    let info = fx.client.election_info(&eid);
    assert_eq!(info.bond, BOND_MIN);
    assert!(!info.bond_returned);
}

#[test]
fn create_election_rejects_low_bond() {
    let fx = setup();
    let (_admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 1_000);

    let res = fx.client.try_create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &(BOND_MIN - 1),
    );
    assert!(res.is_err());
}

#[test]
fn close_election_refunds_bond_to_admin() {
    let fx = setup();
    let (admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 100);

    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &BOND_MIN,
    );

    let mid_admin = fx.token.balance(&admin);
    let mid_contract = fx.token.balance(&fx.contract_id);

    fx.client.close_election(&eid);

    // Bond returned in full.
    assert_eq!(fx.token.balance(&admin) - mid_admin, BOND_MIN);
    assert_eq!(mid_contract - fx.token.balance(&fx.contract_id), BOND_MIN);

    let info = fx.client.election_info(&eid);
    assert!(info.closed);
    assert!(info.bond_returned);

    // Second close is a no-op for the bond (idempotent refund).
    let before = fx.token.balance(&admin);
    fx.client.close_election(&eid);
    assert_eq!(fx.token.balance(&admin), before);
}

#[test]
fn valid_member_can_vote_and_double_vote_rejected() {
    let fx = setup();
    let (_admin, cid, members, proofs) = register_with_members(&fx, 5);

    fx.env.ledger().with_mut(|l| l.timestamp = 100);
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &BOND_MIN,
    );

    let voter = members[2].clone();
    let proof = to_soroban_proof(&fx.env, &proofs[2]);
    fx.client.vote(&voter, &eid, &0u32, &proof);

    let tallies = fx.client.results(&eid);
    assert_eq!(tallies.get(0).unwrap(), 1);
    assert_eq!(tallies.get(1).unwrap(), 0);
    assert!(fx.client.has_voted(&eid, &voter));

    let res = fx.client.try_vote(&voter, &eid, &1u32, &proof);
    assert!(res.is_err());
}

#[test]
fn invalid_proof_rejected() {
    let fx = setup();
    let (_admin, cid, _members, proofs) = register_with_members(&fx, 4);

    fx.env.ledger().with_mut(|l| l.timestamp = 100);
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &BOND_MIN,
    );

    let outsider = Address::generate(&fx.env);
    let stolen_proof = to_soroban_proof(&fx.env, &proofs[0]);
    let res = fx.client.try_vote(&outsider, &eid, &0u32, &stolen_proof);
    assert!(res.is_err());
}

#[test]
fn deadline_enforced() {
    let fx = setup();
    let (_admin, cid, members, proofs) = register_with_members(&fx, 2);

    fx.env.ledger().with_mut(|l| l.timestamp = 100);
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &500u64,
        &BOND_MIN,
    );

    fx.env.ledger().with_mut(|l| l.timestamp = 1_000);

    let voter = members[0].clone();
    let proof = to_soroban_proof(&fx.env, &proofs[0]);
    let res = fx.client.try_vote(&voter, &eid, &0u32, &proof);
    assert!(res.is_err());
}

#[test]
fn invalid_option_rejected() {
    let fx = setup();
    let (_admin, cid, members, proofs) = register_with_members(&fx, 2);

    fx.env.ledger().with_mut(|l| l.timestamp = 100);
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &BOND_MIN,
    );

    let voter = members[0].clone();
    let proof = to_soroban_proof(&fx.env, &proofs[0]);
    let res = fx.client.try_vote(&voter, &eid, &42u32, &proof);
    assert!(res.is_err());
}

#[test]
fn close_election_blocks_new_votes() {
    let fx = setup();
    let (_admin, cid, members, proofs) = register_with_members(&fx, 2);

    fx.env.ledger().with_mut(|l| l.timestamp = 100);
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &10_000u64,
        &BOND_MIN,
    );

    fx.client.close_election(&eid);

    let voter = members[0].clone();
    let proof = to_soroban_proof(&fx.env, &proofs[0]);
    let res = fx.client.try_vote(&voter, &eid, &0u32, &proof);
    assert!(res.is_err());
}

// ------ slashing tests ----------------------------------------------------

#[test]
fn slash_election_pays_keeper_and_treasury_after_grace() {
    let fx = setup();
    let (admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 100);

    let closes_at = 10_000u64;
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &closes_at,
        &BOND_MIN,
    );

    // Fast-forward past the grace period.
    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = closes_at + SLASH_GRACE + 1);

    let keeper = Address::generate(&fx.env);
    let admin_before = fx.token.balance(&admin);
    let keeper_before = fx.token.balance(&keeper);
    let treasury_before = fx.token.balance(&fx.treasury);
    let contract_before = fx.token.balance(&fx.contract_id);

    fx.client.slash_election(&keeper, &eid);

    let keeper_reward = BOND_MIN / 2;
    let treasury_cut = BOND_MIN - keeper_reward;

    // Admin gets nothing.
    assert_eq!(fx.token.balance(&admin), admin_before);
    // Keeper and treasury split the bond.
    assert_eq!(fx.token.balance(&keeper) - keeper_before, keeper_reward);
    assert_eq!(
        fx.token.balance(&fx.treasury) - treasury_before,
        treasury_cut
    );
    // Contract released the full bond.
    assert_eq!(
        contract_before - fx.token.balance(&fx.contract_id),
        BOND_MIN
    );

    let info = fx.client.election_info(&eid);
    assert!(info.closed);
    assert!(info.slashed);
    assert!(!info.bond_returned);
}

#[test]
fn slash_before_grace_period_rejected() {
    let fx = setup();
    let (_admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 100);

    let closes_at = 10_000u64;
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &closes_at,
        &BOND_MIN,
    );

    // Just past deadline, but well inside the grace window.
    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = closes_at + 10);

    let keeper = Address::generate(&fx.env);
    let res = fx.client.try_slash_election(&keeper, &eid);
    assert!(res.is_err());
}

#[test]
fn slash_after_close_rejected() {
    let fx = setup();
    let (_admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 100);

    let closes_at = 10_000u64;
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &closes_at,
        &BOND_MIN,
    );

    // Admin closes normally and gets the bond.
    fx.env.ledger().with_mut(|l| l.timestamp = closes_at + 1);
    fx.client.close_election(&eid);

    // Now try to slash — should fail because bond_returned.
    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = closes_at + SLASH_GRACE + 1);
    let keeper = Address::generate(&fx.env);
    let res = fx.client.try_slash_election(&keeper, &eid);
    assert!(res.is_err());
}

#[test]
fn close_after_slash_rejected() {
    let fx = setup();
    let (_admin, cid, _, _) = register_with_members(&fx, 3);
    fx.env.ledger().with_mut(|l| l.timestamp = 100);

    let closes_at = 10_000u64;
    let eid = fx.client.create_election(
        &cid,
        &String::from_str(&fx.env, "Q?"),
        &default_options(&fx.env),
        &closes_at,
        &BOND_MIN,
    );

    fx.env
        .ledger()
        .with_mut(|l| l.timestamp = closes_at + SLASH_GRACE + 1);
    let keeper = Address::generate(&fx.env);
    fx.client.slash_election(&keeper, &eid);

    // Any further close attempt fails.
    let res = fx.client.try_close_election(&eid);
    assert!(res.is_err());

    // Double-slash also fails.
    let res = fx.client.try_slash_election(&keeper, &eid);
    assert!(res.is_err());
}
