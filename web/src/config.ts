// Runtime configuration read from Vite env vars. Copy `.env.example` to
// `.env` and fill in `VITE_CONTRACT_ID` with your deployed contract.
//
// Fallback defaults point at the current live testnet deployment so the
// app keeps working even if the hosting provider's env vars are stale or
// unset. An explicitly set VITE_ env var always takes precedence.
const DEFAULT_CONTRACT_ID =
  "CCZUQCUDNVRKFZCUWMUXZH5GXZ3EYJ3ZW2HOPPQQ4ON3R7H3EZNFOJEN";
const DEFAULT_REGISTRY_ID =
  "CBC4TRP6KUTGUICUI27ON2N3HTRHP4DKB7HXTSTJLZOMVJKAHPZJOSF2";

export const config = {
  contractId: import.meta.env.VITE_CONTRACT_ID || DEFAULT_CONTRACT_ID,
  registryId: import.meta.env.VITE_REGISTRY_ID || DEFAULT_REGISTRY_ID,
  network: import.meta.env.VITE_NETWORK ?? "TESTNET",
  rpcUrl:
    import.meta.env.VITE_RPC_URL ?? "https://soroban-testnet.stellar.org",
  networkPassphrase:
    import.meta.env.VITE_NETWORK_PASSPHRASE ??
    "Test SDF Network ; September 2015",
  /** Base URL of the voter bridge (voter enrolment, status lookup, and phone-based voting). */
  bridgeUrl: (import.meta.env.VITE_BRIDGE_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  /** Optional: comma-separated G... keys of members (demo bootstrap). */
  demoMembers: (import.meta.env.VITE_DEMO_MEMBERS ?? "")
    .split(",")
    .map((s: string) => s.trim())
    .filter(Boolean),
};

export function assertConfigured() {
  if (!config.contractId) {
    throw new Error(
      "VITE_CONTRACT_ID is not set. Deploy the contract and put the ID in web/.env",
    );
  }
}
