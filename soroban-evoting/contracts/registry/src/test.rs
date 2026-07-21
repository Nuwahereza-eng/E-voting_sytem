#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::{Address as _, Ledger}, Address, BytesN, Env, String};

#[test]
fn initialize_and_attest() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);

    let curator = Address::generate(&env);
    client.initialize(&curator);

    let evoting = Address::generate(&env);
    let admin = Address::generate(&env);
    client.attest(
        &evoting,
        &7u32,
        &String::from_str(&env, "Makerere University Guild Electoral Commission"),
        &admin,
        &String::from_str(&env, "https://mak.ac.ug/guild-2026"),
    );

    assert!(client.is_verified(&evoting, &7u32));
    let a = client.get(&evoting, &7u32);
    assert_eq!(a.admin, admin);
    assert!(!a.revoked);
}

#[test]
fn attest_records_curator_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);

    let curator = Address::generate(&env);
    client.initialize(&curator);

    let evoting = Address::generate(&env);
    let admin = Address::generate(&env);
    client.attest(
        &evoting,
        &1u32,
        &String::from_str(&env, "org"),
        &admin,
        &String::from_str(&env, "https://x"),
    );

    let auths = env.auths();
    assert!(
        auths.iter().any(|(a, _)| a == &curator),
        "expected curator's require_auth to be recorded",
    );
}

#[test]
fn revoke_flips_is_verified() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);

    let curator = Address::generate(&env);
    client.initialize(&curator);

    let evoting = Address::generate(&env);
    let admin = Address::generate(&env);
    client.attest(
        &evoting,
        &3u32,
        &String::from_str(&env, "org"),
        &admin,
        &String::from_str(&env, "https://x"),
    );
    assert!(client.is_verified(&evoting, &3u32));

    client.revoke(&evoting, &3u32);
    assert!(!client.is_verified(&evoting, &3u32));

    // Record still readable (audit trail).
    let a = client.get(&evoting, &3u32);
    assert!(a.revoked);
}

#[test]
fn unattested_lookups_return_false() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);

    let curator = Address::generate(&env);
    client.initialize(&curator);
    let evoting = Address::generate(&env);
    assert!(!client.is_verified(&evoting, &99u32));
}

#[test]
fn double_initialize_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);

    let curator = Address::generate(&env);
    client.initialize(&curator);
    let res = client.try_initialize(&curator);
    assert!(res.is_err());
}

// ---------- Proof-of-personhood tests --------------------------------------

fn setup_with_attester(env: &Env) -> (RegistryContractClient<'_>, Address, Address) {
    env.mock_all_auths();
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(env, &contract_id);
    let curator = Address::generate(env);
    client.initialize(&curator);
    let attester = Address::generate(env);
    client.authorize_attester(
        &attester,
        &String::from_str(env, "Uganda NIRA gateway"),
        &String::from_str(env, "https://nira.go.ug/verify"),
    );
    (client, curator, attester)
}

fn nullifier(env: &Env, n: u8) -> BytesN<32> {
    let mut a = [0u8; 32];
    a[0] = n;
    BytesN::from_array(env, &a)
}

#[test]
fn authorize_and_attest_person_happy_path() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _curator, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    let n = nullifier(&env, 1);
    client.attest_person(
        &attester,
        &alice,
        &n,
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 365 * 86_400),
    );

    assert!(client.is_person(&alice));
    let info = client.person_info(&alice);
    assert_eq!(info.subject, alice);
    assert_eq!(info.attester, attester);
    assert!(!info.revoked);
}

#[test]
fn nullifier_prevents_sybil_across_addresses() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    let mallory = Address::generate(&env);
    let n = nullifier(&env, 42);

    client.attest_person(
        &attester, &alice, &n,
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    // Same nullifier, different subject -> rejected.
    let res = client.try_attest_person(
        &attester, &mallory, &n,
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    assert!(res.is_err());
    assert!(client.is_person(&alice));
    assert!(!client.is_person(&mallory));
}

#[test]
fn attester_can_renew_own_attestation() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    let n = nullifier(&env, 7);
    // Short expiry.
    client.attest_person(
        &attester, &alice, &n,
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 60),
    );
    // Same subject + same nullifier + fresh expiry = renewal (allowed).
    client.attest_person(
        &attester, &alice, &n,
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    let info = client.person_info(&alice);
    assert_eq!(info.expires_at, 1_000 + 86_400);
    assert!(client.is_person(&alice));
}

#[test]
fn expired_attestation_is_not_a_person() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    client.attest_person(
        &attester, &alice, &nullifier(&env, 3),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 60),
    );
    assert!(client.is_person(&alice));

    env.ledger().with_mut(|l| l.timestamp = 1_000 + 61);
    assert!(!client.is_person(&alice));
}

#[test]
fn revoked_attestation_is_not_a_person() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    client.attest_person(
        &attester, &alice, &nullifier(&env, 4),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    client.revoke_person(&attester, &alice);
    assert!(!client.is_person(&alice));
}

#[test]
fn deauthorized_attester_invalidates_their_attestations() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    client.attest_person(
        &attester, &alice, &nullifier(&env, 5),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    assert!(client.is_person(&alice));

    client.deauthorize_attester(&attester);
    assert!(!client.is_attester(&attester));
    // Existing attestation is now not trusted.
    assert!(!client.is_person(&alice));
    // But the entry remains queryable for audit.
    let info = client.person_info(&alice);
    assert_eq!(info.attester, attester);

    // Deauthorized attester can no longer issue new attestations.
    let bob = Address::generate(&env);
    let res = client.try_attest_person(
        &attester, &bob, &nullifier(&env, 6),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    assert!(res.is_err());
}

#[test]
fn unauthorized_attester_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let contract_id = env.register(RegistryContract, ());
    let client = RegistryContractClient::new(&env, &contract_id);
    let curator = Address::generate(&env);
    client.initialize(&curator);

    let stranger = Address::generate(&env);
    let alice = Address::generate(&env);
    let res = client.try_attest_person(
        &stranger, &alice, &nullifier(&env, 8),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    assert!(res.is_err());
}

#[test]
fn curator_can_revoke_person() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let (client, curator, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    client.attest_person(
        &attester, &alice, &nullifier(&env, 9),
        &String::from_str(&env, "nin-v1"),
        &(1_000 + 86_400),
    );
    // Curator (not the attester) revokes.
    client.revoke_person(&curator, &alice);
    assert!(!client.is_person(&alice));
}

#[test]
fn expiry_in_past_rejected() {
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 10_000);
    let (client, _c, attester) = setup_with_attester(&env);

    let alice = Address::generate(&env);
    let res = client.try_attest_person(
        &attester, &alice, &nullifier(&env, 10),
        &String::from_str(&env, "nin-v1"),
        &5_000u64,
    );
    assert!(res.is_err());
}
