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
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, String,
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
    /// Caller is not on the authorised-attesters list.
    NotAnAttester = 5,
    /// The supplied `nullifier` is already bound to a different
    /// subject address. Sybil resistance: one human, one attestation.
    NullifierBound = 6,
    /// No personhood attestation on file for the given subject.
    NotAPerson = 7,
    /// Attester has been deauthorised.
    AttesterInactive = 8,
    /// `expires_at` is not in the future.
    ExpiryInPast = 9,
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

// ---------- Proof-of-personhood types --------------------------------------

/// A curator-approved issuer that can bind Stellar addresses to real
/// humans. Examples: a KYC/NIN gateway, an in-person enrolment agent,
/// a biometric booth at a partner NGO, another chain's world-ID oracle.
#[contracttype]
#[derive(Clone)]
pub struct AttesterInfo {
    /// Human-readable name — e.g. "Uganda NIRA gateway".
    pub name: String,
    /// URL of the attester's public methodology / trust page.
    pub url: String,
    pub added_at: u64,
    /// If true, the attester was revoked. Existing personhood entries
    /// they issued are still queryable but `is_person` returns false.
    pub deauthorized: bool,
}

/// A personhood attestation binding a Stellar `subject` address to a
/// unique off-chain identity (represented as an opaque `nullifier`
/// hash so no PII touches the chain).
#[contracttype]
#[derive(Clone)]
pub struct PersonEntry {
    pub subject: Address,
    pub attester: Address,
    /// Opaque 32-byte hash of the underlying identity — e.g.
    /// `sha256(nira_number || attester_salt)`. Same human always maps
    /// to the same nullifier (per attester), letting us reject a
    /// second address trying to double-register.
    pub nullifier: BytesN<32>,
    /// Free-form label for the verification method — e.g. "nin-v1",
    /// "biometric-in-person", "world-id-orb".
    pub scheme: String,
    pub issued_at: u64,
    /// Unix seconds. `is_person` returns false once this passes.
    /// Attesters MUST set a real expiry so stale identities age out.
    pub expires_at: u64,
    pub revoked: bool,
}

#[contracttype]
pub enum DataKey {
    Curator,
    Entry(Key),
    /// Attester(address) -> AttesterInfo. Set of authorised issuers.
    Attester(Address),
    /// Person(subject) -> PersonEntry. One per attested address.
    Person(Address),
    /// Nullifier(hash) -> subject Address. Sybil-resistance: locks
    /// an off-chain identity to a single Stellar address forever.
    Nullifier(BytesN<32>),
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

    // ---------- Proof-of-personhood ----------------------------------
    //
    // The registry doubles as a proof-of-personhood layer: authorised
    // attesters (e.g. an NGO running biometric enrolment, a NIN
    // gateway, a partner chain's world-ID oracle) can bind a Stellar
    // address to a real, unique human.
    //
    // No PII touches the chain. Attesters submit a 32-byte
    // `nullifier` \u2014 the hash of some off-chain identifier plus their
    // own salt \u2014 which prevents the same human from claiming two
    // different Stellar addresses. Everything else lives in the
    // attester's own systems.
    //
    // The evoting contract can then require personhood on
    // sensitive elections ("one human, one vote") by calling
    // `is_person(voter)` cross-contract.

    /// Curator authorises a new attester. Idempotent-safe: re-adding
    /// resets the `deauthorized` flag and updates the display fields.
    pub fn authorize_attester(
        env: Env,
        attester: Address,
        name: String,
        url: String,
    ) -> Result<(), Error> {
        let cur: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;
        cur.require_auth();

        let info = AttesterInfo {
            name,
            url,
            added_at: env.ledger().timestamp(),
            deauthorized: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Attester(attester), &info);
        Ok(())
    }

    /// Curator revokes an attester. Personhood entries the attester
    /// previously issued stay on-chain for auditability, but
    /// `is_person` will start returning false for all of them.
    pub fn deauthorize_attester(env: Env, attester: Address) -> Result<(), Error> {
        let cur: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;
        cur.require_auth();

        let mut info: AttesterInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Attester(attester.clone()))
            .ok_or(Error::NotAnAttester)?;
        info.deauthorized = true;
        env.storage()
            .persistent()
            .set(&DataKey::Attester(attester), &info);
        Ok(())
    }

    pub fn is_attester(env: Env, attester: Address) -> bool {
        match env
            .storage()
            .persistent()
            .get::<_, AttesterInfo>(&DataKey::Attester(attester))
        {
            Some(i) => !i.deauthorized,
            None => false,
        }
    }

    pub fn attester_info(env: Env, attester: Address) -> Result<AttesterInfo, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Attester(attester))
            .ok_or(Error::NotAnAttester)
    }

    /// Attest that `subject` is a real, unique human.
    ///
    /// - Caller (the `attester`) must be an authorised, non-revoked attester.
    /// - `nullifier` is a 32-byte opaque hash of the underlying
    ///   identity (e.g. `sha256(nira_number || attester_salt)`).
    /// - Sybil check: if the nullifier is already bound to a
    ///   different subject, this call is rejected. If it's bound to
    ///   the same subject, this is treated as a renewal \u2014 the
    ///   attester can extend the expiry / clear the `revoked` flag.
    /// - `expires_at` must be strictly greater than `now`.
    pub fn attest_person(
        env: Env,
        attester: Address,
        subject: Address,
        nullifier: BytesN<32>,
        scheme: String,
        expires_at: u64,
    ) -> Result<(), Error> {
        attester.require_auth();

        // Attester must be currently authorised.
        let info: AttesterInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Attester(attester.clone()))
            .ok_or(Error::NotAnAttester)?;
        if info.deauthorized {
            return Err(Error::AttesterInactive);
        }

        let now = env.ledger().timestamp();
        if expires_at <= now {
            return Err(Error::ExpiryInPast);
        }

        // Sybil check on the nullifier.
        let nullifier_key = DataKey::Nullifier(nullifier.clone());
        if let Some(existing) = env
            .storage()
            .persistent()
            .get::<_, Address>(&nullifier_key)
        {
            if existing != subject {
                return Err(Error::NullifierBound);
            }
        } else {
            env.storage()
                .persistent()
                .set(&nullifier_key, &subject);
        }

        let entry = PersonEntry {
            subject: subject.clone(),
            attester,
            nullifier,
            scheme,
            issued_at: now,
            expires_at,
            revoked: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Person(subject), &entry);
        Ok(())
    }

    /// Revoke a personhood attestation. Callable by either the
    /// original issuing attester OR the curator (in case the
    /// attester itself has gone rogue / dark).
    pub fn revoke_person(env: Env, caller: Address, subject: Address) -> Result<(), Error> {
        caller.require_auth();

        let mut entry: PersonEntry = env
            .storage()
            .persistent()
            .get(&DataKey::Person(subject.clone()))
            .ok_or(Error::NotAPerson)?;

        let curator: Address = env
            .storage()
            .instance()
            .get(&DataKey::Curator)
            .ok_or(Error::NotInitialized)?;

        if caller != entry.attester && caller != curator {
            return Err(Error::NotAnAttester);
        }

        entry.revoked = true;
        env.storage()
            .persistent()
            .set(&DataKey::Person(subject), &entry);
        Ok(())
    }

    /// Read-only: is this address verified as a real, unique human?
    ///
    /// Returns true only if all of the following hold:
    ///   1. A personhood entry exists for `subject`.
    ///   2. The entry is not revoked.
    ///   3. The entry has not expired.
    ///   4. The issuing attester is still authorised.
    ///
    /// This is the function the e-voting contract calls
    /// cross-contract to gate one-human-one-vote elections.
    pub fn is_person(env: Env, subject: Address) -> bool {
        let entry: PersonEntry = match env
            .storage()
            .persistent()
            .get(&DataKey::Person(subject))
        {
            Some(e) => e,
            None => return false,
        };
        if entry.revoked {
            return false;
        }
        if env.ledger().timestamp() >= entry.expires_at {
            return false;
        }
        match env
            .storage()
            .persistent()
            .get::<_, AttesterInfo>(&DataKey::Attester(entry.attester))
        {
            Some(i) => !i.deauthorized,
            None => false,
        }
    }

    /// Read-only detail lookup. Fails if there's no entry at all.
    pub fn person_info(env: Env, subject: Address) -> Result<PersonEntry, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Person(subject))
            .ok_or(Error::NotAPerson)
    }
}

#[cfg(test)]
mod test;
