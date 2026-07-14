/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ID: string;
  readonly VITE_REGISTRY_ID: string;
  readonly VITE_NETWORK: string;
  readonly VITE_RPC_URL: string;
  readonly VITE_NETWORK_PASSPHRASE: string;
  readonly VITE_DEMO_MEMBERS: string;
  readonly VITE_BRIDGE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
