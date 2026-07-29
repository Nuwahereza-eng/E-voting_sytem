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
  // Sunbird AI (translate + speech-to-text for Ugandan languages).
  // Provide either SUNBIRD_API_KEY (recommended — the long-lived key you
  // copy from the Sunbird dashboard) or a SUNBIRD_USERNAME/PASSWORD pair
  // for on-the-fly OAuth. SUNBIRD_TOKEN is accepted as an alias for
  // SUNBIRD_API_KEY for backwards compatibility. When none of these
  // is set the client falls back to a passthrough dev stub so local
  // demos still work without credentials.
  sunbird: {
    baseUrl: process.env.SUNBIRD_BASE_URL ?? "https://api.sunbird.ai",
    token: process.env.SUNBIRD_API_KEY ?? process.env.SUNBIRD_TOKEN ?? "",
    username: process.env.SUNBIRD_USERNAME ?? "",
    password: process.env.SUNBIRD_PASSWORD ?? "",
  },
  // Translations cache directory (per-election ballot translations).
  translationsPath: process.env.TRANSLATIONS_PATH ?? "./data/translations.json",
  // UI string translations cache (whole-interface auto-translation). Keyed by
  // (target-lang, source-text) and persisted so each phrase is only fetched
  // from Sunbird once, ever — turning the per-minute rate limit into a
  // one-time warm-up cost instead of a per-restart cost.
  uiTranslationsPath:
    process.env.UI_TRANSLATIONS_PATH ?? "./data/ui-translations.json",
};
