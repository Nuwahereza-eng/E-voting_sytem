import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  // Lazy: only throws when actually read (so provision.ts can run
  // without a deployed contract).
  get contractId(): string {
    return required("CONTRACT_ID");
  },
  networkPassphrase:
    process.env.NETWORK_PASSPHRASE ?? "Test SDF Network ; September 2015",
  rpcUrl: process.env.RPC_URL ?? "https://soroban-testnet.stellar.org",
  registryPath: process.env.REGISTRY_PATH ?? "./data/registry.json",
  membersPath: process.env.MEMBERS_PATH ?? "./data/members.json",
  at: {
    username: process.env.AT_USERNAME ?? "",
    apiKey: process.env.AT_API_KEY ?? "",
    senderId: process.env.AT_SENDER_ID ?? "",
  },
};
