// Runtime configuration read from Vite env vars. Copy `.env.example` to
// `.env` and fill in `VITE_CONTRACT_ID` with your deployed contract.
export const config = {
  contractId: import.meta.env.VITE_CONTRACT_ID ?? "",
  registryId: import.meta.env.VITE_REGISTRY_ID ?? "",
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
