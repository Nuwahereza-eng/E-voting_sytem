#![no_std]

//! Sauti — Trust Registry
//!
//! A tiny curated allowlist that answers the question every verifier
//! actually cares about: "is this (evoting_contract, community_id) pair
//! really Makerere University's Guild Electoral Commission, or is it
//! someone's roommate pretending?"
//!
//! The registry does NOT gate voting or election-creation on the main
//! e-voting contract. It is a **read-only lookup layer**: the
//! `/verify` page consults it to show a green "verified organiser"
//! badge and a link to the off-chain announcement (e.g.
//! https://mak.ac.ug/guild-2026). If an organiser is not attested,
//! votes still work — the badge just doesn't appear, and verifiers can
//! decide what to do with that.
//!
//! Curator model: a single `curator` address in the MVP; upgrade path
//! is to make the curator a Stellar multi-sig without any contract
//! change (the account itself becomes multi-sig, `require_auth`
//! enforces the threshold).

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, Env, String,
};

// ---------- Errors ---------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    AlreadyInitialized = 1,
    NotInitialized = 2,
    NotAttested = 3,
    Revoked = 4,
}

// ---------- Types ----------------------------------------------------------

/// Key identifying an attested community. A registry entry commits to
/// (which e-voting contract) + (which community inside that contract).
#[contracttype]
#[derive(Clone)]
pub struct Key {
    pub evoting_contract: Address,
    pub community_id: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct Attestation {
    /// Human-readable organiser name, e.g.
    /// "Makerere University Guild Electoral Commission".
    pub org_name: String,
    /// The admin address that will (or did) call `register_community`
    /// on the e-voting contract. Verifiers can cross-check this
    /// matches the on-chain `Community.admin`.
    pub admin: Address,
    /// URL of the off-chain announcement — the organiser's own
    /// authoritative page. This is what turns "trust the curator"
    /// into "trust the organiser's own domain."
    pub metadata_url: String,
    pub attested_at: u64,
    pub revoked: bool,
}

#[contracttype]
pub enum DataKey {
    Curator,
    Entry(Key),
}

// ---------- Contract -------------------------------------------------------

#[contract]
pub struct RegistryContract;

#[contractimpl]
impl RegistryContract {
    /// One-time initialization: set the curator address.
    pub fn initialize(env: Env, curator: Address) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Curator) {
            return Err(Error::AlreadyInitialized);
        }
        curator.require_auth();
        env.storage().instance().set(&DataKey::Curator, &curator);
        Ok(())
    }

    /// Rotate the curator. Requires current curator auth.
    pub fn set_curator(env: Env, new_curator: Address) -> Result<(), Error> {
        let cur: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;
        cur.require_auth();
        env.storage().instance().set(&DataKey::Curator, &new_curator);
        Ok(())
    }

    /// Curator attests to a (contract, community) pair.
    pub fn attest(
        env: Env,
        evoting_contract: Address,
        community_id: u32,
        org_name: String,
        admin: Address,
        metadata_url: String,
    ) -> Result<(), Error> {
        let cur: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;
        cur.require_auth();

        let key = Key {
            evoting_contract,
            community_id,
        };
        let entry = Attestation {
            org_name,
            admin,
            metadata_url,
            attested_at: env.ledger().timestamp(),
            revoked: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Entry(key), &entry);
        Ok(())
    }

    /// Curator revokes a previous attestation (e.g. keys compromised,
    /// wrong data submitted). We keep the record around with `revoked
    /// = true` so history is auditable rather than silently deleted.
    pub fn revoke(
        env: Env,
        evoting_contract: Address,
        community_id: u32,
    ) -> Result<(), Error> {
        let cur: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;
        cur.require_auth();

        let key = DataKey::Entry(Key {
            evoting_contract,
            community_id,
        });
        let mut e: Attestation = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(Error::NotAttested)?;
        e.revoked = true;
        env.storage().persistent().set(&key, &e);
        Ok(())
    }

    // ---------- read-only views ---------------------------------------

    pub fn get(
        env: Env,
        evoting_contract: Address,
        community_id: u32,
    ) -> Result<Attestation, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Entry(Key {
                evoting_contract,
                community_id,
            }))
            .ok_or(Error::NotAttested)
    }

    /// Convenience: returns true only if the attestation exists AND is
    /// not revoked. This is what the /verify page should call.
    pub fn is_verified(env: Env, evoting_contract: Address, community_id: u32) -> bool {
        match env.storage().persistent().get::<_, Attestation>(&DataKey::Entry(Key {
            evoting_contract,
            community_id,
        })) {
            Some(e) => !e.revoked,
            None => false,
        }
    }

    pub fn curator(env: Env) -> Result<Address, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)
    }
}

#[cfg(test)]
mod test;
