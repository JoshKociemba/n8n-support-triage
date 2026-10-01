# Local n8n support triage demo

A self-hosted support engineering portfolio project. A POST webhook accepts a ticket and logs, validates input, redacts common secrets, identifies known error patterns, and returns evidence, investigation steps, an escalation summary, and a reply draft for human review.

The first version uses explicit rules and requires no AI API key. Error patterns are signals, not verified diagnoses. The first matching rule determines the main category; all matching findings are retained. Priority comes from reported impact.

## Run on your Mac

Start Docker Desktop, then from this directory:

```sh
docker compose up -d
docker compose ps
```

Open <http://localhost:5678> and create your local owner account. Import `workflows/support-triage.json` through the workflow editor's import-from-file menu. Open **Receive ticket**, select **Listen for test event**, then send:

```sh
curl --fail-with-body -sS http://localhost:5678/webhook-test/support-triage \
  -H 'Content-Type: application/json' \
  --data-binary @examples/authentication.json
```

Listen again before sending another test request. Once you publish/activate the workflow, use the production path `/webhook/support-triage`. Open **Executions** to inspect each stage. Try `examples/outage.json` to demonstrate escalation routing, or send `{}` to receive HTTP 400.

## Plain integration: automatic triage

Import `workflows/plain-support-triage.json` as a separate workflow. It checks Plain every minute, reads threads created in the past 24 hours, and adds a triage event to each unprocessed thread. It works while your Mac and Docker are running and needs no tunnel or inbound connection. The original webhook demo remains available.

### Connect your test workspace

1. In Plain, open **Settings → Machine Users** and create a machine user named `n8n triage demo`.
2. Create an API key with `thread:read`, `customer:read`, `threadEvent:read`, and `threadEvent:create`. If Plain reports another required read permission for message content, grant that permission. No customer-reply permission is needed.
3. In n8n, create a **Header Auth** credential named `Plain test workspace`. Set its header name to `Authorization` and its value to `Bearer YOUR_PLAIN_API_KEY`. Enter the actual key only in the credential editor, never in workflow JSON or Git.
4. Select that same credential in both **Fetch recent Plain threads** and **Add Plain triage event**.
5. Create a synthetic ticket in your Plain workspace with a subject like `API request fails after credential rotation` and a description or customer message containing `401 Unauthorized`.
6. If you used Plain's onboarding **test thread**, open **Plain connection settings** and set `testThreadId` to its `th_...` ID (copy it with ⌘K → Copy thread ID). Plain excludes onboarding test threads from its thread list, so this optional setting fetches that thread directly. Leave it empty for normal threads.
7. Click **Execute workflow** once. Confirm a `Support triage — rules-v1` event appears on the Plain thread. Run it again to confirm it skips the processed thread.
8. Publish/activate the workflow to enable its one-minute schedule.

The event includes category, evidence, investigation steps, escalation context, and a reply draft for review. It does not send a customer reply or change ticket priority, assignment, or status. Customer impact cannot be inferred from Plain priority; the event explicitly calls out the single-user default.

### Reliability and limits

- Plain stores the unique external ID `n8n-support-triage:rules-v1:THREAD_ID`. The next poll skips matching events. The unique ID prevents duplicate writes even if executions overlap; a conflicting write may still show a failed execution.
- Each poll inspects at most 100 non-spam threads created in the past 24 hours. The initial run also processes existing threads in that window. More than 100 threads fails visibly rather than silently skipping a page; add pagination for higher volume.
- The workflow reads the first 20 message entries and keeps customer-authored text. If no customer text is available it falls back to the thread description or preview, and reports that limitation. It does not download attachments. Source text is capped at 10000 characters and truncation is disclosed in the event.
- This is initial triage only; later customer messages do not trigger a new analysis. A Mac offline for more than 24 hours needs a wider query window or a backfill.
- HTTP failures retry up to three times. GraphQL errors and mutation errors fail visibly even when HTTP status is 200. A later poll retries unfinished threads.
- Raw Plain responses can appear in local n8n execution history. Continue using synthetic tickets in the test workspace.

API calls use Plain's documented UK endpoint. Verify the endpoint for your workspace before connecting it if Plain gives you a different region.

References: [API authentication](https://www.plain.com/docs/graphql/authentication), [API endpoint](https://www.plain.com/docs/graphql/introduction), [Thread events](https://www.plain.com/docs/graphql/events/create-thread-event), [Public schema](https://core-api.uk.plain.com/graphql/v1/schema.graphql).

## Development

```sh
npm test
npm run build
```

`src/triage.cjs` is the tested logic. The build script embeds that function into the importable workflow. Rebuild and reimport after changing it. There are no npm dependencies.

## Local operation

The editor and webhook listen on `127.0.0.1:5678`. SQLite, workflows, credentials, and the auto-generated encryption key persist in the Docker named volume. Stop with `docker compose stop`; restart with `docker compose up -d`. Execution history is pruned after seven days. Keep the volume when recreating containers; `docker compose down -v` deletes it. A sleeping Mac cannot run scheduled workflows.

Use synthetic tickets for this demo. Redaction is best-effort and occurs after the webhook receives input, so raw inputs can still appear in n8n execution history. The webhook has no authentication for this loopback-only demo. Before adding real data or remote access, configure webhook authentication, execution-data retention, and appropriate access controls.

## Next iterations

- Add AI analysis with a structured output contract and rules as a fallback.
- Add a knowledge-base lookup and cite relevant troubleshooting articles.
- Integrate a ticket system, with bounded retries and duplicate-event handling.
- Add a human approval step before publishing replies or escalations.
- Capture screenshots and a short demo showing success, invalid input, and outage cases.

## References

- [n8n Docker Compose guidance](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose)
- [Webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
- [Pinned n8n release](https://github.com/n8n-io/n8n/releases/tag/n8n%402.41.5)
