#![no_std]

//! Sauti — Soroban Community Governance Contract
//!
//! A community registry + election engine with Merkle-root eligibility.
//! Multiple channels (web wallet + USSD/SMS bridge) submit `vote`
//! transactions against the same contract state.
//!
//! ## Economic security
//!
//! Opening an election costs the organiser two on-chain payments in the
//! configured token (typically wrapped XLM via the native SAC):
//!
//!   1. A fixed `fee` paid to the protocol `treasury`. Non-refundable.
//!   2. A `bond` locked in the contract itself, refunded to the
//!      community's admin when they properly `close_election`. The bond
//!      must be at least `bond_min` — a lazy or malicious admin who
//!      never closes the ballot forfeits their bond.
//!
//! This discourages spam elections and gives the community a small
//! financial handle on their organiser's diligence.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype,
    token,
    xdr::ToXdr,
    Address, Bytes, BytesN, Env, String, Vec,
};

// ---------- Errors ---------------------------------------------------------

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum Error {
    NotAuthorized = 1,
    CommunityNotFound = 2,
    ElectionNotFound = 3,
    ElectionClosed = 4,
    AlreadyVoted = 5,
    InvalidOption = 6,
    InvalidProof = 7,
    DeadlinePassed = 8,
    NoOptions = 9,
    DeadlineInPast = 10,
    NotInitialized = 11,
    AlreadyInitialized = 12,
    BondTooLow = 13,
    BondAlreadyReturned = 14,
    NegativeAmount = 15,
    /// Slash was attempted before `closes_at + slash_grace_period`.
    NotOverdue = 16,
    /// Election was already slashed — bond is gone.
    AlreadySlashed = 17,
}

// ---------- Types ----------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct Config {
    /// SAC token contract used to pay fees and post bonds.
    pub token: Address,
    /// Address that receives non-refundable fees.
    pub treasury: Address,
    /// Fixed fee charged per election (in the token's smallest unit,
    /// e.g. stroops for XLM: 1 XLM = 10_000_000).
    pub fee: i128,
    /// Minimum bond an organiser must lock to open an election.
    pub bond_min: i128,
    /// Seconds after `closes_at` before an election becomes slashable.
    /// A well-behaved admin closes within this window and recovers the
    /// bond. A negligent one leaves the bond up for grabs by any
    /// slash-caller (who takes half; the other half goes to treasury).
    pub slash_grace_period: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct Community {
    pub admin: Address,
    pub name: String,
    pub merkle_root: BytesN<32>,
    pub member_count: u32,
}

#[contracttype]
#[derive(Clone)]
pub struct Election {
    pub community_id: u32,
    pub question: String,
    pub options: Vec<String>,
    pub opens_at: u64,
    pub closes_at: u64,
    pub closed: bool,
    pub tallies: Vec<u32>,
    pub total_votes: u32,
    /// Amount of `Config.token` locked when this election was created.
    /// Refunded to the community admin on `close_election`.
    pub bond: i128,
    /// True once the bond has been returned. Prevents double-refund.
    pub bond_returned: bool,
    /// True if `slash_election` was successfully called. Once slashed,
    /// the election is permanently marked as such, the bond is gone,
    /// and neither refund nor re-slash is possible.
    pub slashed: bool,
}

#[contracttype]
pub enum DataKey {
    NextCommunityId,
    NextElectionId,
    Community(u32),
    Election(u32),
    Voted(u32, Address),
    Config,
}

// ---------- Contract -------------------------------------------------------

#[contract]
pub struct EVotingContract;

#[contractimpl]
impl EVotingContract {
    /// One-time initialization. Sets the token + fee + treasury.
    /// Idempotent-safe: re-calling with a different config is rejected.
    pub fn initialize(
        env: Env,
        token: Address,
        treasury: Address,
        fee: i128,
        bond_min: i128,
        slash_grace_period: u64,
    ) -> Result<(), Error> {
        if env.storage().instance().has(&DataKey::Config) {
            return Err(Error::AlreadyInitialized);
        }
        if fee < 0 || bond_min < 0 {
            return Err(Error::NegativeAmount);
        }
        env.storage().instance().set(
            &DataKey::Config,
            &Config {
                token,
                treasury,
                fee,
                bond_min,
                slash_grace_period,
            },
        );
        Ok(())
    }

    /// Read-only view of the fee schedule / token config.
    pub fn config(env: Env) -> Result<Config, Error> {
        env.storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)
    }

    /// Register a new community. `merkle_root` commits to the ordered
    /// list of member addresses. The admin can later replace it via
    /// `update_members` as membership changes.
    pub fn register_community(
        env: Env,
        admin: Address,
        name: String,
        merkle_root: BytesN<32>,
        member_count: u32,
    ) -> u32 {
        admin.require_auth();

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextCommunityId)
            .unwrap_or(0u32);

        let community = Community {
            admin,
            name,
            merkle_root,
            member_count,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Community(id), &community);
        env.storage()
            .instance()
            .set(&DataKey::NextCommunityId, &(id + 1));
        id
    }

    /// Replace the Merkle root and count for an existing community.
    /// Admin-only.
    pub fn update_members(
        env: Env,
        community_id: u32,
        new_root: BytesN<32>,
        new_count: u32,
    ) -> Result<(), Error> {
        let mut c: Community = env
            .storage()
            .persistent()
            .get(&DataKey::Community(community_id))
            .ok_or(Error::CommunityNotFound)?;
        c.admin.require_auth();

        c.merkle_root = new_root;
        c.member_count = new_count;
        env.storage()
            .persistent()
            .set(&DataKey::Community(community_id), &c);
        Ok(())
    }

    /// Open a new election owned by `community_id`.
    ///
    /// Charges the community admin the protocol fee (sent to treasury)
    /// and locks the supplied `bond` in the contract. The bond is
    /// released back to the admin when `close_election` is called.
    pub fn create_election(
        env: Env,
        community_id: u32,
        question: String,
        options: Vec<String>,
        closes_at: u64,
        bond: i128,
    ) -> Result<u32, Error> {
        let cfg: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let c: Community = env
            .storage()
            .persistent()
            .get(&DataKey::Community(community_id))
            .ok_or(Error::CommunityNotFound)?;
        c.admin.require_auth();

        if options.len() < 2 {
            return Err(Error::NoOptions);
        }
        let now = env.ledger().timestamp();
        if closes_at <= now {
            return Err(Error::DeadlineInPast);
        }
        if bond < cfg.bond_min {
            return Err(Error::BondTooLow);
        }

        // Charge the fee and lock the bond. Both are pulled from the
        // community admin. The token client emits its own `require_auth`
        // on `from`, so the admin's signature covers both transfers.
        let token_client = token::Client::new(&env, &cfg.token);
        if cfg.fee > 0 {
            token_client.transfer(&c.admin, &cfg.treasury, &cfg.fee);
        }
        if bond > 0 {
            token_client.transfer(&c.admin, &env.current_contract_address(), &bond);
        }

        let id: u32 = env
            .storage()
            .instance()
            .get(&DataKey::NextElectionId)
            .unwrap_or(0u32);

        let mut tallies = Vec::new(&env);
        for _ in 0..options.len() {
            tallies.push_back(0u32);
        }

        let election = Election {
            community_id,
            question,
            options,
            opens_at: now,
            closes_at,
            closed: false,
            tallies,
            total_votes: 0,
            bond,
            bond_returned: false,
            slashed: false,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Election(id), &election);
        env.storage()
            .instance()
            .set(&DataKey::NextElectionId, &(id + 1));
        Ok(id)
    }

    /// Cast a vote. Requires:
    ///   - `voter.require_auth()` (Freighter wallet, or USSD-bridge custodial key)
    ///   - a Merkle proof that `voter` is in the community's member set
    ///   - election is open and deadline not passed
    ///   - voter has not already voted in this election
    pub fn vote(
        env: Env,
        voter: Address,
        election_id: u32,
        option_index: u32,
        proof: Vec<BytesN<32>>,
    ) -> Result<(), Error> {
        voter.require_auth();

        let mut election: Election = env
            .storage()
            .persistent()
            .get(&DataKey::Election(election_id))
            .ok_or(Error::ElectionNotFound)?;

        if election.closed {
            return Err(Error::ElectionClosed);
        }
        if env.ledger().timestamp() >= election.closes_at {
            return Err(Error::DeadlinePassed);
        }
        if option_index >= election.options.len() {
            return Err(Error::InvalidOption);
        }

        let voted_key = DataKey::Voted(election_id, voter.clone());
        if env.storage().persistent().has(&voted_key) {
            return Err(Error::AlreadyVoted);
        }

        let community: Community = env
            .storage()
            .persistent()
            .get(&DataKey::Community(election.community_id))
            .ok_or(Error::CommunityNotFound)?;

        // Leaf = sha256(xdr(voter address as ScVal))
        let voter_xdr = voter.clone().to_xdr(&env);
        let leaf = env.crypto().sha256(&voter_xdr).to_bytes();

        if !verify_proof(&env, &leaf, &proof, &community.merkle_root) {
            return Err(Error::InvalidProof);
        }

        // Record vote
        env.storage().persistent().set(&voted_key, &true);
        let cur = election.tallies.get(option_index).unwrap_or(0);
        election.tallies.set(option_index, cur + 1);
        election.total_votes += 1;
        env.storage()
            .persistent()
            .set(&DataKey::Election(election_id), &election);

        Ok(())
    }

    /// Close an election and refund the organiser's bond.
    ///
    /// Anyone can call this after the deadline (permissionless refund
    /// keeper), but only the community admin can close it early. The
    /// bond always returns to the community admin.
    ///
    /// If the election has already been slashed via `slash_election`,
    /// the bond is gone and this call fails.
    pub fn close_election(env: Env, election_id: u32) -> Result<(), Error> {
        let mut election: Election = env
            .storage()
            .persistent()
            .get(&DataKey::Election(election_id))
            .ok_or(Error::ElectionNotFound)?;
        if election.slashed {
            return Err(Error::AlreadySlashed);
        }
        let community: Community = env
            .storage()
            .persistent()
            .get(&DataKey::Community(election.community_id))
            .ok_or(Error::CommunityNotFound)?;

        let now = env.ledger().timestamp();
        if now < election.closes_at {
            // Early close is admin-only; after the deadline anyone
            // (a bot, another member) can trigger the refund.
            community.admin.require_auth();
        }

        election.closed = true;

        // Refund the bond exactly once.
        if election.bond > 0 && !election.bond_returned {
            let cfg: Config = env
                .storage()
                .instance()
                .get(&DataKey::Config)
                .ok_or(Error::NotInitialized)?;
            let token_client = token::Client::new(&env, &cfg.token);
            token_client.transfer(
                &env.current_contract_address(),
                &community.admin,
                &election.bond,
            );
            election.bond_returned = true;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Election(election_id), &election);
        Ok(())
    }

    /// Slash an overdue election. Callable by ANYONE after
    /// `closes_at + slash_grace_period`. The bond is split 50/50
    /// between the caller (as a "keeper reward") and the protocol
    /// treasury. The election is marked closed and slashed; the
    /// tally remains queryable, but the bond can never be refunded.
    ///
    /// Economic rationale: the bond exists to give an organiser skin
    /// in the game. If they never close the ballot the results are
    /// stuck in a "provisional" state — voters can't be sure the
    /// election is really done. Making the bond claimable by keepers
    /// after a grace period creates a market for closing overdue
    /// elections and turns the bond into a real cost for negligence.
    pub fn slash_election(env: Env, caller: Address, election_id: u32) -> Result<(), Error> {
        caller.require_auth();

        let mut election: Election = env
            .storage()
            .persistent()
            .get(&DataKey::Election(election_id))
            .ok_or(Error::ElectionNotFound)?;
        if election.slashed {
            return Err(Error::AlreadySlashed);
        }
        if election.bond_returned {
            return Err(Error::BondAlreadyReturned);
        }
        let cfg: Config = env
            .storage()
            .instance()
            .get(&DataKey::Config)
            .ok_or(Error::NotInitialized)?;

        let now = env.ledger().timestamp();
        let slashable_at = election.closes_at.saturating_add(cfg.slash_grace_period);
        if now < slashable_at {
            return Err(Error::NotOverdue);
        }

        // Split the bond 50/50. On odd amounts the treasury takes the
        // extra stroop (arbitrary tie-break; matters ~never for real amounts).
        if election.bond > 0 {
            let token_client = token::Client::new(&env, &cfg.token);
            let keeper_reward = election.bond / 2;
            let treasury_cut = election.bond - keeper_reward;
            if keeper_reward > 0 {
                token_client.transfer(
                    &env.current_contract_address(),
                    &caller,
                    &keeper_reward,
                );
            }
            if treasury_cut > 0 {
                token_client.transfer(
                    &env.current_contract_address(),
                    &cfg.treasury,
                    &treasury_cut,
                );
            }
        }

        election.closed = true;
        election.slashed = true;
        // Do NOT set bond_returned — it wasn't returned, it was slashed.
        env.storage()
            .persistent()
            .set(&DataKey::Election(election_id), &election);
        Ok(())
    }

    // ---------- Read-only views ---------------------------------------

    pub fn results(env: Env, election_id: u32) -> Result<Vec<u32>, Error> {
        let e: Election = env
            .storage()
            .persistent()
            .get(&DataKey::Election(election_id))
            .ok_or(Error::ElectionNotFound)?;
        Ok(e.tallies)
    }

    pub fn election_info(env: Env, election_id: u32) -> Result<Election, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Election(election_id))
            .ok_or(Error::ElectionNotFound)
    }

    pub fn community(env: Env, community_id: u32) -> Result<Community, Error> {
        env.storage()
            .persistent()
            .get(&DataKey::Community(community_id))
            .ok_or(Error::CommunityNotFound)
    }

    pub fn has_voted(env: Env, election_id: u32, voter: Address) -> bool {
        env.storage()
            .persistent()
            .has(&DataKey::Voted(election_id, voter))
    }

    pub fn next_community_id(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NextCommunityId)
            .unwrap_or(0u32)
    }

    pub fn next_election_id(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::NextElectionId)
            .unwrap_or(0u32)
    }
}

// ---------- Merkle helpers -------------------------------------------------

/// Verify a Merkle proof. Uses lexicographic ordering of sibling pairs,
/// so the proof does not need to encode direction — every internal node
/// is `sha256(min(a,b) || max(a,b))`.
fn verify_proof(env: &Env, leaf: &BytesN<32>, proof: &Vec<BytesN<32>>, root: &BytesN<32>) -> bool {
    let mut current = leaf.clone();
    for sibling in proof.iter() {
        current = hash_pair(env, &current, &sibling);
    }
    &current == root
}

fn hash_pair(env: &Env, a: &BytesN<32>, b: &BytesN<32>) -> BytesN<32> {
    let (first, second) = if bytes_le(a, b) { (a, b) } else { (b, a) };
    let mut buf = Bytes::new(env);
    buf.append(&Bytes::from(first.clone()));
    buf.append(&Bytes::from(second.clone()));
    env.crypto().sha256(&buf).to_bytes()
}

fn bytes_le(a: &BytesN<32>, b: &BytesN<32>) -> bool {
    let a_arr = a.to_array();
    let b_arr = b.to_array();
    for i in 0..32 {
        if a_arr[i] < b_arr[i] {
            return true;
        }
        if a_arr[i] > b_arr[i] {
            return false;
        }
    }
    true // equal => treat as "a<=b"
}

#[cfg(test)]
mod test;
