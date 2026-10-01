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
