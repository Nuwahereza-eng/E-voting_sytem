#![cfg(test)]

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, Address, Env, String};

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
