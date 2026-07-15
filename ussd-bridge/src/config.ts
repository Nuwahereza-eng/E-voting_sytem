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
  // Africa's Talking SMS credentials for OTP delivery. If username or
  // apiKey is missing the SMS module falls back to console-log-only
  // ("dev mode") so local development still works.
  at: {
    username: process.env.AT_USERNAME ?? "",
    apiKey: process.env.AT_API_KEY ?? "",
    senderId: process.env.AT_SENDER_ID ?? "",
    // "sandbox" endpoint if you only have the free sandbox creds.
    baseUrl:
      process.env.AT_BASE_URL ??
      (process.env.AT_ENV === "sandbox"
        ? "https://api.sandbox.africastalking.com/version1"
        : "https://api.africastalking.com/version1"),
  },
  otp: {
    // Length of the numeric OTP.
    length: Number(process.env.OTP_LENGTH ?? 6),
    // How long an OTP stays valid, in seconds.
    ttlSec: Number(process.env.OTP_TTL_SEC ?? 300),
    // If true, the /otp/request response includes the raw code (for
    // demos + local development). Never set this in production.
    devEcho: process.env.OTP_DEV_ECHO === "1",
  },
};
