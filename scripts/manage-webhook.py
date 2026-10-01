import sys, json, pathlib, secrets as secure, subprocess, re, urllib.request, urllib.error
import types
root = pathlib.Path(__file__).resolve().parents[1]
keys = {}
for line in (root / '.env').read_text().splitlines():
    line = line.strip()
    if line and not line.startswith('#') and '=' in line:
        key, value = line.split('=', 1)
        keys[key.strip()] = value.strip().strip(chr(34) + chr(39))

def request(url, method='GET', data=None, plain=False):
    headers = {'Content-Type': 'application/json', 'User-Agent': 'n8n-support-triage-demo/1.0'}
    headers['Authorization' if plain else 'X-N8N-API-KEY'] = ('Bearer ' if plain else '') + keys['PLAIN_API_KEY' if plain else 'N8N_API_KEY']
    req = urllib.request.Request(url, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise SystemExit('HTTP error ' + str(error.code) + '. Check API permissions and credentials.')

api = types.SimpleNamespace(request=request, N8N='http://127.0.0.1:5678/api/v1', PLAIN='https://core-api.uk.plain.com/graphql/v1')
state_path = root / '.plain-webhook-state.json'
compose = ['docker', 'compose', '-f', 'compose.yaml', '-f', 'compose.webhooks.yaml']

def save(state):
    state_path.write_text(json.dumps(state))
    state_path.chmod(0o600)

def plain(query, variables=None):
    result = api.request(api.PLAIN, 'POST', {'query': query, 'variables': variables or {}}, plain=True)
    if result.get('errors'):
        print('Plain GraphQL errors:', json.dumps(result['errors']))
        raise SystemExit(1)
    return result['data']

mode = sys.argv[1] if len(sys.argv) > 1 else 'status'
state = json.loads(state_path.read_text()) if state_path.exists() else {}
if mode == 'install':
    if state.get('workflowId'):
        raise SystemExit('Webhook workflow already installed; use register to synchronize its URL.')
    token = secure.token_urlsafe(48)
    credential = api.request(api.N8N + '/credentials', 'POST', {'name': 'Plain webhook ingress', 'type': 'httpHeaderAuth', 'data': {'name': 'X-Triage-Webhook-Token', 'value': token}})
    state.update({'ingressCredentialId': credential['id'], 'ingressToken': token})
    save(state)
    workspace = plain('query { myWorkspace { id } }')['myWorkspace']['id']
    plain_credential = api.request(api.N8N + '/credentials', 'POST', {'name': 'Plain test workspace', 'type': 'httpHeaderAuth', 'data': {'name': 'Authorization', 'value': 'Bearer ' + keys['PLAIN_API_KEY'], 'allowedHttpRequestDomains': 'domains', 'allowedDomains': 'core-api.uk.plain.com'}})
    workflow = json.loads((root / 'workflows/plain-ticket-created.json').read_text())
    for node in workflow['nodes']:
        if node['type'] == 'n8n-nodes-base.httpRequest':
            node['credentials'] = {'httpHeaderAuth': {'id': plain_credential['id'], 'name': 'Plain test workspace'}}
        if node['type'] == 'n8n-nodes-base.webhook':
            node['credentials'] = {'httpHeaderAuth': {'id': credential['id'], 'name': 'Plain webhook ingress'}}
        if node['name'] == 'Validate Plain creation event':
            node['parameters']['jsCode'] = node['parameters']['jsCode'].replace('SET_WORKSPACE_ID', workspace)
    payload = {k: workflow[k] for k in ['name', 'nodes', 'connections', 'settings']}
    created = api.request(api.N8N + '/workflows', 'POST', payload)
    state.update({'workflowId': created['id'], 'workspaceId': workspace})
    save(state)
    api.request(api.N8N + '/workflows/' + state['workflowId'] + '/activate', 'POST', {})
    print('Webhook workflow installed and active:', state['workflowId'])
elif mode == 'update':
    current = api.request(api.N8N + '/workflows/' + state['workflowId'])
    workflow = json.loads((root / 'workflows/plain-ticket-created.json').read_text())
    credentials = {n['name']: n.get('credentials') for n in current['nodes'] if n.get('credentials')}
    for node in workflow['nodes']:
        if node['name'] in credentials: node['credentials'] = credentials[node['name']]
        if node['name'] == 'Validate Plain creation event': node['parameters']['jsCode'] = node['parameters']['jsCode'].replace('SET_WORKSPACE_ID', state['workspaceId'])
    api.request(api.N8N + '/workflows/' + state['workflowId'] + '/deactivate', 'POST', {})
    api.request(api.N8N + '/workflows/' + state['workflowId'], 'PUT', {k: workflow[k] for k in ['name', 'nodes', 'connections', 'settings']})
    api.request(api.N8N + '/workflows/' + state['workflowId'] + '/activate', 'POST', {})
    print('Webhook workflow updated.')
elif mode in ['register', 'sync']:
    logs = subprocess.check_output(compose + ['logs', '--no-color', 'webhook-tunnel'], cwd=root, text=True, stderr=subprocess.STDOUT)
    urls = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', logs)
    if not urls: raise SystemExit('Tunnel URL not ready yet.')
    url = urls[-1] + '/webhook/plain-ticket-created'
    state['url'] = url
    save(state)
    target_input = {'url': url, 'description': 'Local n8n internal support triage', 'isEnabled': True, 'version': '2026-02-11', 'eventSubscriptions': [{'eventType': 'thread.thread_created'}], 'headers': [{'name': 'X-Triage-Webhook-Token', 'value': state['ingressToken']}]}
    if state.get('targetId'):
        update = {'webhookTargetId': state['targetId'], 'url': {'value': url}, 'isEnabled': {'value': True}, 'headers': target_input['headers']}
        result = plain('mutation($input: UpdateWebhookTargetInput!) { updateWebhookTarget(input: $input) { webhookTarget {id} error {code message} } }', {'input': update})['updateWebhookTarget']
    else:
        result = plain('mutation($input: CreateWebhookTargetInput!) { createWebhookTarget(input: $input) { webhookTarget {id} error {code message} } }', {'input': target_input})['createWebhookTarget']
    if result.get('error'):
        print('Plain webhook registration error:', json.dumps(result['error']))
        raise SystemExit(1)
    state.update({'targetId': result['webhookTarget']['id'], 'url': url})
    save(state)
    print('Plain creation webhook enabled. Target:', state['targetId'])
    print('Public endpoint:', url)
elif mode == 'smoke':
    if len(sys.argv) < 3: raise SystemExit('Pass an existing thread ID to smoke.')
    if not state.get('url'):
        logs = subprocess.check_output(compose + ['logs', '--no-color', 'webhook-tunnel'], cwd=root, text=True, stderr=subprocess.STDOUT)
        urls = re.findall(r'https://[a-z0-9-]+\.trycloudflare\.com', logs)
        if not urls: raise SystemExit('Tunnel URL not ready yet.')
        state['url'] = urls[-1] + '/webhook/plain-ticket-created'
        save(state)
    event = {'id': 'pEv_local_smoke', 'type': 'thread.thread_created', 'workspaceId': state['workspaceId'], 'payload': {'thread': {'id': sys.argv[2]}}}
    for suffix, token in [('/', None), ('/webhook/plain-ticket-created', None), ('/webhook/plain-ticket-created', state['ingressToken'])]:
        origin = state['url'].split('/webhook/')[0]
        headers = {'Content-Type': 'application/json', 'User-Agent': 'n8n-support-triage-demo/1.0'}
        if token: headers['X-Triage-Webhook-Token'] = token
        req = urllib.request.Request(origin + suffix, data=json.dumps(event).encode(), headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=90) as response:
                print('Endpoint check:', suffix, 'authenticated:', bool(token), 'status:', response.status)
        except urllib.error.HTTPError as e:
            print('Endpoint check:', suffix, 'authenticated:', bool(token), 'status:', e.code)
elif mode == 'executions':
    result = api.request(api.N8N + '/executions?workflowId=' + state['workflowId'] + '&limit=10')
    for execution in result['data']:
        last = api.request(api.N8N + '/executions/' + execution['id'] + '?includeData=true')
        data = last.get('data', {}).get('resultData', {})
        print('Execution:', execution['id'], execution['status'], 'Error:', (data.get('error') or {}).get('message'))
        fetches = data.get('runData', {}).get('Fetch created Plain ticket', [])
        if fetches:
            items = fetches[-1].get('data', {}).get('main', [[]])[0] or []
            if items:
                payload = items[0].get('json', {})
                print('Fetch response keys:', list(payload), 'Thread present:', bool(payload.get('data', {}).get('thread')), 'GraphQL errors:', json.dumps(payload.get('errors')))
        for name in ['Confirm internal note']:
            entries = data.get('runData', {}).get(name, [])
            if entries: print(name, json.dumps(entries[-1].get('data')))
elif mode in ['deliveries', 'status']:
    query = 'query($id: ID!) { webhookDeliveryAttempts(webhookTargetId: $id, first: 10) { edges { node { id publicEventId publicEventEventType result { __typename ... on WebhookDeliveryAttemptSuccessfulResult {status httpStatusCode} ... on WebhookDeliveryAttemptFailedResult {status httpStatusCode} ... on WebhookDeliveryAttemptErrorResult {status errorCode} } } } } }'
    print('Plain deliveries:', json.dumps(plain(query, {'id': state['targetId']})))
else:
    raise SystemExit('Unknown mode')
