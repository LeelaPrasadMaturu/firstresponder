# Integration: PagerDuty (alternative to Opsgenie)

Opsgenie is easier (see opsgenie.md) — use PagerDuty only if that's what your
team already uses.

## Setup

1. PagerDuty → **Integrations → Generic Webhook V3** → Add
2. **Destination URL:** `https://xyz.ngrok.app/oncall` (ngrok tunnel to :7788)
3. Subscribe to event: **`incident.triggered`**
4. PagerDuty V3 sends a nested envelope; the engine normalizes it — the
   fields it reads are `event.data.title` (→ alert), `event.data.urgency` /
   `event.data.priority` (→ severity).
5. Fire a test incident:
   ```bash
   curl -XPOST 'https://api.pagerduty.com/incidents' \
     -H "Authorization: Token token=$PD_TOKEN" \
     -H "From: you@example.com" -H 'Content-Type: application/json' \
     -d '{"incident":{"type":"incident","title":"signer-prod memory pressure","service":{"id":"PX","type":"service_reference"}}}'
   ```

## Note on plan limits

Webhook V3 works on the free tier, but richer routing (Event Orchestration)
is paid. For the hackathon demo: use the mock 🔥 button live, PagerDuty for
the README story.
