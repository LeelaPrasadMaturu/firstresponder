# Integration: Opsgenie (recommended — easiest real pager)

Opsgenie is the easiest real paging system to wire: free tier, webhook
integration with templated payloads, no plan restrictions like PagerDuty's.

## One-time setup (~15 min)

1. **Opsgenie account** (free: 5 users) → `app.opsgenie.com`
2. **Integrations → Search "Webhook" → Add**
3. Fill in:
   - **URL:** your publicly reachable gate. For dev/demo use a tunnel:
     ```bash
     ngrok http 7788        # → copy the https://xyz.ngrok.app URL
     ```
     then set URL to `https://xyz.ngrok.app/oncall`
   - **Payload template** (must match what firerun expects):
     ```json
     {
       "alert": "{{message}}",
       "severity": "{{priority}}",
       "service": "signer-prod",
       "fired_at": "{{_createdAt}}"
     }
     ```
4. **Save + turn the integration ON**

## Fire an alert (the demo trigger)

```bash
curl -XPOST 'https://api.opsgenie.com/v2/alerts' \
  -H "Authorization: GenieKey $OPSGENIE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"message":"signer-prod memory pressure","priority":"P2","tags":["firerun-demo"]}'
```

(Get `$OPSGENIE_API_KEY` from Teams/Settings → API Key Management.)

## Arm the agent (auto-on-call)

```bash
npm run cli -- serve ../the-stage/runbooks/incident-memory-leak.md
# → now ANY alert that matches the webhook fires the full flow automatically:
#   rehearse-if-needed → investigate → mitigate → gate → verify → addendum
```

The engine also normalizes Opsgenie/PagerDuty native webhook envelopes (see
`gate.ts /oncall`) — the `alert` field is what fingerprint-matches the runbook.

## Demo-day advice

Demo with the **mock 🔥 button** (deterministic, zero network). Show the
Opsgenie wiring in the README and mention it in Q&A — "the same webhook that
Opsgenie fires is what our mock sends." Betting the live demo on ngrok is how
demos die.
