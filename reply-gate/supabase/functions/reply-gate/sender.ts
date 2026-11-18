// The send sweep, run once a minute by pg_cron. Approved replies sit
// queued with a send-after time; this claims anything due (atomically,
// via claim_due_replies) and sends it from the same mailbox that ran
// the campaign. The claim means two overlapping runs can never send
// the same email twice.
import { claimDueReplies, updateLogRow } from "./db.ts";
import { sendReply } from "./instantly.ts";
import { errorMessage, sentMessage, slackPost } from "./slack.ts";
import { config } from "./config.ts";

export async function runSendSweep(): Promise<{ sent: number; errors: number }> {
  // Global kill switch: if shadow mode was flipped back on while
  // replies were queued, hold them instead of sending.
  if (config.shadowMode) {
    return { sent: 0, errors: 0 };
  }

  const due = await claimDueReplies();
  let sent = 0, errors = 0;

  for (const row of due) {
    try {
      if (!row.reply_to_uuid || !row.eaccount || !row.final_body) {
        throw new Error("queued row missing reply_to_uuid / eaccount / final_body");
      }
      await sendReply({
        replyToUuid: row.reply_to_uuid,
        eaccount: row.eaccount,
        subject: row.reply_subject ?? "",
        body: row.final_body,
      });
      await updateLogRow(row.id, { status: "sent", decision: "sent", sent_at: new Date().toISOString() });
      await slackPost(sentMessage(row.lead_email, row.campaign_id));
      sent++;
    } catch (e) {
      errors++;
      await updateLogRow(row.id, { status: "error", error: String(e) });
      await slackPost(errorMessage(`sending reply to ${row.lead_email} — send it by hand`, String(e)));
    }
  }
  return { sent, errors };
}
