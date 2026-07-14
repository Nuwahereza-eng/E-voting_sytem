import { useEffect, useState } from "react";
import { getAddress, isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

export interface WalletState {
  address: string | null;
  connect: () => Promise<void>;
  connecting: boolean;
  error: string | null;
}

/**
 * Wraps Freighter. `signTransaction` from this hook has the network
 * passphrase already applied, and matches the SignFn shape in soroban.ts.
 */
export function useWallet(): WalletState & {
  sign: (xdr: string, opts: { networkPassphrase: string }) => Promise<{ signedTxXdr: string }>;
} {
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const c = await isConnected().catch(() => ({ isConnected: false }));
      if (c && "isConnected" in c && c.isConnected) {
        const a = await getAddress().catch(() => ({ address: "" }));
        if (a && "address" in a && a.address) setAddress(a.address);
      }
    })();
  }, []);

  async function connect() {
    setConnecting(true);
    setError(null);
    try {
      const access = await requestAccess();
      if ("error" in access && access.error) throw new Error(String(access.error));
      if ("address" in access) setAddress(access.address);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`Freighter: ${msg}. Install/enable the Freighter extension.`);
    } finally {
      setConnecting(false);
    }
  }

  async function sign(xdrStr: string, opts: { networkPassphrase: string }) {
    const res = await signTransaction(xdrStr, {
      networkPassphrase: opts.networkPassphrase,
      address: address ?? undefined,
    });
    if ("error" in res && res.error) throw new Error(String(res.error));
    if (!("signedTxXdr" in res)) throw new Error("Freighter returned no signed XDR");
    return { signedTxXdr: res.signedTxXdr };
  }

  return { address, connecting, connect, error, sign };
}
