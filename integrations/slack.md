# Integration: Slack approval cards (with working buttons)

Two levels. Both keep the HTTP gate UI (`:7788/gate`) as the source of truth.

## Level 1 — Notification cards (10 minutes, no public URL needed)

1. **api.slack.com/apps** → Create New App → From scratch → `firstreresponder`
2. **Incoming Webhooks** → toggle On → **Add New Webhook to Workspace** →
   pick your demo channel (create a throwaway `#firerun-demo` channel)
3. Copy the webhook URL into `firerun/.env`:
   ```
   SLACK_WEBHOOK_URL=https://hooks.slack.com/services/T000/B000/XXXX
   ```
4. Done — every gate now posts a rich card (blast radius, tested undo,
   rehearsal status) to your channel, with a link to the full gate UI.

Approvals still happen in the gate UI/phone — Slack is the theater + record.

## Level 2 — Approve/Reject buttons INSIDE Slack (needs a public URL)

Slack buttons require an Interactivity endpoint:

1. App config → **Interactivity & Shortcuts** → On →
   **Request URL:** `https://xyz.ngrok.app/slack/interact` (run `ngrok http 7788`)
2. The endpoint is already implemented in `gate.ts` (`/slack/interact`) —
   button presses carry `gateId:APPROVED|REJECTED` and are signed into the
   audit trail with your Slack username.
3. Restart `npm run cli -- serve` — gate cards now have live buttons.

## Q&A line

> "The gate is one primitive with three faces — browser card, phone card,
> Slack card — all writing the same signed audit record. The channel is UX;
> the invariant is the runtime."
