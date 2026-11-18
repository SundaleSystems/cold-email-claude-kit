// Optional email alert to your own inbox via the Gmail API. Instantly
// can only reply to existing threads, so a fresh "here are the numbers"
// email needs its own transport. This activates only when all three
// GMAIL_* secrets are set (see README for the one-time OAuth setup);
// otherwise it's a silent no-op and Slack carries the alert alone.
import { config } from "./config.ts";

/** Exchange the long-lived refresh token for a short-lived access token. */
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.gmailClientId,
      client_secret: config.gmailClientSecret,
      refresh_token: config.gmailRefreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) throw new Error(`gmail token → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token as string;
}

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Send an HTML email from the authorized account to ALERT_EMAIL_TO.
 * Returns a short status string ("sent" | "skipped" | "error:..."); it
 * never throws, so a Gmail hiccup can't break the pipeline.
 */
export async function sendAlertEmail(subject: string, html: string): Promise<string> {
  if (!config.gmailEnabled) return "skipped";
  try {
    const token = await getAccessToken();
    const raw = base64url(
      new TextEncoder().encode(
        [
          `To: ${config.alertEmailTo}`,
          "From: me",
          `Subject: ${subject}`,
          "MIME-Version: 1.0",
          'Content-Type: text/html; charset="UTF-8"',
          "",
          html,
        ].join("\r\n"),
      ),
    );
    const res = await fetch(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ raw }),
      },
    );
    if (!res.ok) {
      console.error("gmail send failed:", res.status, await res.text());
      return `error:${res.status}`;
    }
    return "sent";
  } catch (err) {
    console.error("gmail send failed (non-fatal):", err);
    return "error";
  }
}
