# Plain support triage with n8n

A self-hosted support engineering portfolio project running on a Mac. New Plain customer and onboarding test tickets automatically receive an internal Markdown triage note with issue-specific research, cited sources, suggested next steps, and a customer reply draft for review.

The integration combines explicit triage rules, Tavily web search, and a local Ollama model. It distinguishes technical incidents, billing questions, and general questions so follow-up requests fit the issue. It creates internal notes only; customer replies, ticket status, priority, and billing changes remain manual.

## How it works

The single workflow is [`workflows/plain-ticket-created.json`](workflows/plain-ticket-created.json).

1. **Receive and validate:** Authenticate Plain's creation event and check its workspace and thread ID.
2. **Wait for the opening message:** Fetch the thread and poll every five seconds for up to one minute until customer-authored text arrives.
3. **Skip duplicates:** Check existing internal notes for the stable triage marker.
4. **Triage and research:** Classify the issue, redact common secrets, and search official documentation using recognized product names and error tokens.
5. **Summarize the evidence:** Ask the local model to relate search snippets to the issue, then validate its structured response and source IDs.
6. **Write and acknowledge:** Add a team-only note with bold sections, bullets, source links, and a reviewed-before-sending reply draft; acknowledge the delivery.

Billing and general questions omit generic reproduction, version, and execution-ID requests. Empty information-needed sections are omitted. Failed searches or invalid model responses are disclosed while rule-based triage continues.

## Set up on your Mac

Requires Docker Desktop, Node.js/npm, Python 3, Apple Command Line Tools, and Homebrew for Ollama. No npm packages need installing.

### 1. Start n8n and the webhook tunnel

Start Docker Desktop, then run from this directory:

```sh
docker compose -f compose.yaml -f compose.webhooks.yaml up -d
```

Open <http://localhost:5678>, create your local owner account, and create an n8n API key. The editor binds to localhost. The Cloudflare Quick Tunnel reaches an Nginx proxy exposing only POST `/webhook/plain-ticket-created`; other public paths return 404.

### 2. Store API keys in Keychain

Create a Plain machine-user API key with `thread:read`, `customer:read`, `note:create`, `webhookTarget:create`, `webhookTarget:read`, and `webhookTarget:edit`. The n8n API key needs permission to create credentials and create, update, and activate workflows. Create a Tavily search API key, then enter the keys through hidden-input prompts:

```sh
python3 scripts/manage-secrets.py set N8N_API_KEY
python3 scripts/manage-secrets.py set PLAIN_API_KEY
python3 scripts/manage-secrets.py set TAVILY_API_KEY
python3 scripts/manage-secrets.py status
```

Secrets live in macOS Keychain under service `com.raeltek.n8n-support-triage`. A native Security-framework helper compiles on first use into Git-ignored `.local`. Install Apple Command Line Tools with `xcode-select --install` if needed. Allow the project's `keychain-helper` to access its items if macOS prompts, and keep it at the stable project path. Secret values travel through captured pipes, never command arguments or shell history.

For an existing plaintext setup, run:

```sh
python3 scripts/manage-secrets.py migrate
```

Migration verifies every Keychain value before removing secrets from `.env` and the webhook state file. Conflicting values stop migration without changing those files; re-running it is safe. An unused OpenAI key is preserved in Keychain if present, but this workflow does not use it.

### 3. Start the local model

```sh
brew install ollama
brew services start ollama
ollama pull qwen3:4b
```

Ollama runs natively on the Mac for Apple Silicon acceleration. n8n connects through `http://host.docker.internal:11434/api/chat`. Keep Ollama running; its endpoint is not exposed through the webhook tunnel.

The default model is `qwen3:4b`. To choose another installed model, set the non-secret configuration `OLLAMA_MODEL=your-model` in `.env`. The scripts refuse to read API keys from `.env`.

### 4. Install and register

```sh
npm run build
python3 scripts/manage-webhook.py install
python3 scripts/manage-webhook.py sync
```

Run `install` once. It creates encrypted n8n credentials, installs and activates the workflow, and generates the ingress token in Keychain as `PLAIN_WEBHOOK_TOKEN`. Run `sync` once the tunnel address is ready to register Plain's creation webhook.

`.plain-webhook-state.json` stores only workflow, credential, and webhook target IDs plus workspace and endpoint metadata. It has owner-only permissions and is excluded from Git. Workflow exports contain no credential values.

## Run and inspect

Your Mac, Docker, Ollama, and tunnel must remain running. After restarting the tunnel, synchronize its changed hostname with Plain:

```sh
docker compose -f compose.yaml -f compose.webhooks.yaml up -d
python3 scripts/manage-webhook.py sync
python3 scripts/manage-webhook.py status
python3 scripts/manage-webhook.py executions
```

Create a synthetic customer ticket or onboarding test ticket in Plain, such as “API request fails after credential rotation” with body “The request returns 401 Unauthorized,” or a billing question. Inspect the internal note and n8n execution. Subsequent messages do not trigger another analysis.

Quick Tunnels suit this local demo; a named Cloudflare Tunnel would provide a stable hostname. Stop the stack with `docker compose -f compose.yaml -f compose.webhooks.yaml stop`.

## Development

```sh
npm test
npm run build
python3 scripts/manage-webhook.py update
```

The build embeds source functions into the exported workflow. `update` deploys that export while preserving credentials and applying the configured local model.

- `src/plain.cjs`: Plain event validation, message readiness, duplicate detection, and note formatting.
- `src/triage.cjs`: Ticket classification, redaction, findings, and reply drafts.
- `src/search.cjs`: Restricted search queries and validated reference links.
- `src/summary.cjs`: Local model requests and citation/schema validation.
- `scripts/manage-webhook.py`: Installation, URL synchronization, deployment, and inspection.
- `scripts/manage-secrets.py`: Keychain setup and verified plaintext migration.
- `tests/` and `examples/`: Automated checks and synthetic ticket fixtures.

## Data handling and limits

API keys used by management scripts are in Keychain; runtime workflow credentials remain encrypted in the n8n Docker volume. These are separate stores. When rotating a Plain or Tavily key, update its n8n credential as well as its Keychain entry. Keep the Docker volume and its encryption key when recreating containers; `docker compose down -v` deletes them.

The webhook requires a random `X-Triage-Webhook-Token` header and validates the workspace. Production concurrency is one execution at a time. A stable note marker prevents repeated deliveries from creating another note; duplicates receive HTTP 200. Avoid overlapping manual executions, which bypass the production concurrency limit. Note creation is not blindly retried after an ambiguous failure.

Tavily receives only recognized product names, known error tokens, and rule categories, with up to three official-documentation results. Free-form customer text and identifiers are excluded from search queries. Search uses an external service and its account quota. The local model has no per-request API charge and no paid fallback; it receives a redacted subject/body and snippets. Redaction is best effort, and the findings remain hypotheses for human review.

Search has a 10-second timeout and summarization a 20-second timeout. No model call runs without usable evidence. Invalid, incomplete, or uncited responses fall back to rule-based triage. A cold or busy model can exceed the timeout; preload it after restarting with `ollama run qwen3:4b "Reply with OK."`.

The workflow reads the first 20 message entries, caps source text at 10,000 characters, and does not download attachments. A title, description, preview, or agent message alone does not satisfy the opening-message check. If customer text does not arrive within one minute, execution fails without a note so Plain can retry. Duplicate detection checks up to 100 notes and fails visibly if pagination is needed.

Use synthetic data for this demo. Raw Plain responses may appear in local n8n execution history, which is pruned after seven days. A sleeping Mac cannot receive deliveries; inspect Plain delivery failures after downtime.

## References

- [n8n Docker Compose setup](https://docs.n8n.io/deploy/host-n8n/install-options/install-using-docker-compose)
- [Plain thread-created event](https://www.plain.com/docs/webhooks/thread-created)
- [Plain internal notes](https://www.plain.com/docs/graphql/notes)
- [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
