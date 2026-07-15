// Africa's Talking SMS client, tiny + dependency-free.
//
// If `AT_USERNAME` and `AT_API_KEY` are unset we fall back to a
// console-log stub so local development doesn't blow up when a demo
// user requests an OTP. Every call still resolves with `{ ok: true,
// devMode }` so the caller can decide whether to echo the code back to
// the response.

import { config } from "./config.js";

export interface SmsResult {
  ok: boolean;
  devMode: boolean;
  provider: "africastalking" | "console";
  status?: string;
  cost?: string;
  messageId?: string;
  error?: string;
}

/**
 * Send an SMS to one recipient. `to` should be E.164 (`+2567…`).
 *
 * When credentials are missing this logs the message to stdout and
 * returns `{ ok: true, devMode: true }`. When credentials are present
 * it POSTs to the Africa's Talking REST endpoint and surfaces the
 * per-recipient status. Non-2xx HTTP responses resolve with
 * `{ ok: false, error }` — callers should decide whether to surface
 * the error to the end user or just log it.
 */
export async function sendSms(to: string, body: string): Promise<SmsResult> {
  const { username, apiKey, senderId, baseUrl } = config.at;
  if (!username || !apiKey) {
    // eslint-disable-next-line no-console
    console.log(`[sms:dev] to=${to} body=${body}`);
    return { ok: true, devMode: true, provider: "console" };
  }

  const form = new URLSearchParams();
  form.set("username", username);
  form.set("to", to);
  form.set("message", body);
  if (senderId) form.set("from", senderId);

  try {
    const r = await fetch(`${baseUrl}/messaging`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        apiKey,
      },
      body: form.toString(),
    });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* keep as text */
    }
    if (!r.ok) {
      return {
        ok: false,
        devMode: false,
        provider: "africastalking",
        error: `HTTP ${r.status}: ${text.slice(0, 400)}`,
      };
    }
    // AT response shape: { SMSMessageData: { Message, Recipients: [{ status, cost, messageId }] } }
    const rec = ((json as any)?.SMSMessageData?.Recipients ?? [])[0] ?? {};
    return {
      ok: rec.status === "Success" || rec.status === "Sent",
      devMode: false,
      provider: "africastalking",
      status: rec.status,
      cost: rec.cost,
      messageId: rec.messageId,
    };
  } catch (e) {
    return {
      ok: false,
      devMode: false,
      provider: "africastalking",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
