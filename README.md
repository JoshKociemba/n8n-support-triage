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

## Plain integration: new-ticket webhooks

The active integration is `workflows/plain-ticket-created.json`. Plain sends a `thread.thread_created` event whenever a customer or onboarding test ticket is created. The workflow validates the workspace and ticket ID, fetches the ticket directly and polls every five seconds for up to one minute until customer-authored message text is available, then writes a team-only Markdown note with bold section titles, bulleted findings and investigation steps, a readable escalation summary, and a reply draft for review. A plain-text version is included for fallback and deduplication.

No ticket IDs need to be entered. Direct lookup supports onboarding tickets that Plain excludes from its normal thread list. Only the creation event is subscribed, so posting the internal note does not trigger another triage run. The old polling workflow should remain unpublished.

### Setup

Keep these keys in the Git-ignored `.env` file:

```dotenv
N8N_API_KEY=your_n8n_key
PLAIN_API_KEY=your_plain_key
TAVILY_API_KEY=your_tavily_key
```

The Plain machine-user key needs `thread:read`, `customer:read`, `note:create`, `webhookTarget:create`, `webhookTarget:read`, and `webhookTarget:edit`. The n8n key must allow creating credentials and creating, updating, and activating workflows.

Start the local stack:

```sh
docker compose -f compose.yaml -f compose.webhooks.yaml up -d
```

For a new installation, install the workflow and credentials once:

```sh
python3 scripts/manage-webhook.py install
```

Once the tunnel prints its HTTPS address, register or update the Plain webhook:

```sh
python3 scripts/manage-webhook.py sync
```

The management script stores workflow IDs and a randomly generated webhook token in `.plain-webhook-state.json`, with owner-only file permissions. That file is excluded from Git. API keys are stored as encrypted n8n credentials; exported workflow files contain no credentials or keys.

### Restart and inspect

Cloudflare Quick Tunnels are intended for local demos. Their hostname changes when the tunnel restarts. After restarting Docker or the tunnel, run the start command above and then `python3 scripts/manage-webhook.py sync` to update Plain's target URL. A named Cloudflare Tunnel is the next step for a stable address.

```sh
python3 scripts/manage-webhook.py status
python3 scripts/manage-webhook.py executions
```

After source changes, run `npm run build` and `python3 scripts/manage-webhook.py update` to deploy the rebuilt workflow while preserving its credentials.

### Delivery and access

The tunnel reaches an Nginx proxy exposing only POST `/webhook/plain-ticket-created`. The n8n editor remains on localhost. Plain sends a random `X-Triage-Webhook-Token` header, checked by n8n before execution, and the workflow checks the workspace ID. Other public paths return 404; requests without the token are rejected.

Production executions are queued one at a time with `N8N_CONCURRENCY_PRODUCTION_LIMIT=1`. Each note has a stable marker that is checked before writing. Repeated deliveries receive HTTP 200 with `already_triaged`. Plain retries failed deliveries; note creation itself is not blindly retried after an ambiguous HTTP failure. Keep the polling workflow disabled and avoid overlapping manual runs, which bypass production concurrency limits.

### Web research

The webhook workflow adds **Triage ticket and prepare search → Search issue on the web → Attach web evidence** before building the internal note. Add `TAVILY_API_KEY` to `.env`, rebuild, and run `python3 scripts/manage-webhook.py update`. The script creates a domain-restricted encrypted n8n search credential and preserves it on future updates.

Each new ticket makes one basic [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) request, limited to three official documentation results and a 10-second timeout. Queries contain only recognized product names, known error tokens, and rule categories; free-form titles, message bodies, logs, and customer identifiers are not sent. If no supported product is named, the query defaults to n8n documentation. Extend the vendor allowlist in `src/search.cjs` for additional products.

Notes include linked titles, search snippets, the query, and search time. These are supporting references, not verified diagnoses or page-level analysis. No AI-generated search answer or raw page content is requested. Failed or empty searches are disclosed in the note and do not block triage. Duplicate tickets skip the search as well as the note write. The optional polling demo does not perform web research.

### Local issue-specific research summary

After search, **Prepare issue-specific summary → Have web evidence? → Summarize findings for customer issue → Validate cited summary** relates the snippets to the customer issue. The note leads with the issue-specific analysis, possible explanations, checks to distinguish causes, and uncertainty. The reference section contains source links instead of copied snippets.

Run [Ollama](https://docs.ollama.com/capabilities/structured-outputs) natively on your Mac to use Apple Silicon acceleration:

```sh
brew install ollama
brew services start ollama
ollama pull qwen3:4b
```

The default model is `qwen3:4b` (about 2.5 GB). Set `OLLAMA_MODEL` in `.env` to use another installed local model, then rebuild and run `python3 scripts/manage-webhook.py update`. The n8n container connects to `http://host.docker.internal:11434/api/chat`. Ollama's default service listens on localhost; it is not exposed through the public webhook tunnel. Ollama must keep running for summaries to work.

Summarization runs locally, with no API key or per-request model charge. Only the existing Tavily search uses an external service and its account quota; the search query still excludes free-form customer text. The redacted subject and body plus up to three snippets are sent to the local model. Internal ticket/customer IDs are excluded. Redaction is best effort.

Ollama receives a JSON schema, with streaming and thinking disabled and temperature zero. Local validation requires source IDs to refer to the actual results. Citations come from the stored source URLs, not model-generated URLs. Generated prose is escaped for Markdown and redacted again. No paid-model fallback is configured.

No model call is made when search returns no usable evidence. The model has no tools or write access. Empty, incomplete, malformed, or uncited responses are disclosed in the note; rule-based triage still continues. This remains human-reviewed analysis of snippets, not a verified diagnosis. Local summarization has a 20-second timeout and no automatic retry. Model loading or a busy Mac can exceed that timeout; preload the model with `ollama run qwen3:4b "Reply with OK."` after restarting if needed.

References: [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs), [Qwen3 4B](https://ollama.com/library/qwen3:4b).

### Ticket-type routing

The rules distinguish technical incidents, billing questions, and general questions. Billing and general questions do not receive generic reproduction/version/execution-ID requests. Their notes omit the empty “Information still needed” section and the technical impact warning. Billing queries search official billing/pricing references, and account-specific charges or refunds require billing-team review. An “unauthorized charge” is treated as billing; a reported API authentication error remains technical.

The local model receives the ticket type so its suggested checks stay relevant. All reply drafts still require review. This is conservative rule-based routing: ambiguous wording may need manual correction. No automatic billing changes or customer replies are sent.

### Scope and limits

- A title, description, preview, or agent message alone does not satisfy the opening-message check. If no customer text arrives within one minute, the execution fails without creating a note so Plain can retry. API errors also fail visibly. Existing triage notes are acknowledged immediately.

- The note contains rule-based hypotheses and requires human review. Customer impact is unknown, so the note discloses the single-user priority default.
- The workflow reads the first 20 message entries, retains customer-authored text, and caps source text at 10000 characters. Missing text or truncation is disclosed. Attachments are not downloaded.
- This is initial triage. Subsequent customer messages do not start another analysis.
- Deduplication inspects the first 100 notes and fails visibly if more notes require pagination.
- Your Mac, Docker, and tunnel must be running. Inspect delivery failures after downtime; the tunnel URL must be synchronized after restart.
- Raw webhook and Plain API responses can appear in local n8n execution history. Use synthetic data for the demo.

`workflows/plain-support-triage.json` remains available as an optional polling demo for regular tickets. It checks a 24-hour window and allows one explicitly configured onboarding ticket; it should not run alongside the webhook integration.

References: [Plain thread-created event](https://www.plain.com/docs/webhooks/thread-created), [Plain internal notes](https://www.plain.com/docs/graphql/notes), [Plain authentication](https://www.plain.com/docs/graphql/authentication), [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

## Development

```sh
npm test
npm run build
```

`src/triage.cjs` is the tested logic. The build script embeds that function into the importable workflow. Rebuild and reimport after changing it. There are no npm dependencies.

## Local operation

The editor and webhook listen on `127.0.0.1:5678`. SQLite, workflows, credentials, and the auto-generated encryption key persist in the Docker named volume. Stop with `docker compose stop`; restart with `docker compose up -d`. Execution history is pruned after seven days. Keep the volume when recreating containers; `docker compose down -v` deletes it. A sleeping Mac cannot receive webhook deliveries or run scheduled workflows.

Use synthetic tickets for this demo. Redaction is best-effort and occurs after the webhook receives input, so raw inputs can still appear in n8n execution history. The original generic ticket webhook is unauthenticated and accessible only on loopback; the Plain webhook requires its ingress token. Before adding real data or remote access, configure webhook authentication, execution-data retention, and appropriate access controls.

## Next iterations

- Add AI analysis with a structured output contract and rules as a fallback.
- Add a knowledge-base lookup and cite relevant troubleshooting articles.
- Add attachment extraction and a backfill path for extended downtime.
- Add a human approval step before publishing replies or escalations.
- Capture screenshots and a short demo showing success, invalid input, and outage cases.

## References

- [n8n Docker Compose guidance](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose)
- [Webhook node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/)
- [Pinned n8n release](https://github.com/n8n-io/n8n/releases/tag/n8n%402.41.5)
