const fs = require('node:fs');
const path = require('node:path');
const { triage } = require('../src/triage.cjs');
const root = path.resolve(__dirname, '..');
const workflow = {
  name: 'Support triage — local demo',
  active: false,
  nodes: [
    { id: 'receive', name: 'Receive ticket', type: 'n8n-nodes-base.webhook', typeVersion: 2,
      position: [0, 0], webhookId: 'support-triage-local-demo',
      parameters: { httpMethod: 'POST', path: 'support-triage', responseMode: 'responseNode', options: {} } },
    { id: 'triage', name: 'Validate, redact, and triage', type: 'n8n-nodes-base.code', typeVersion: 2,
      position: [280, 0], parameters: { mode: 'runOnceForAllItems', jsCode: `${triage.toString()}\nreturn [{ json: triage($input.first().json.body) }];` } },
    { id: 'respond', name: 'Return triage result', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4,
      position: [560, 0], parameters: { respondWith: 'json', responseBody: '={{ $json.result }}', options: { responseCode: '={{ $json.statusCode }}' } } },
  ],
  connections: {
    'Receive ticket': { main: [[{ node: 'Validate, redact, and triage', type: 'main', index: 0 }]] },
    'Validate, redact, and triage': { main: [[{ node: 'Return triage result', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
};
fs.mkdirSync(path.join(root, 'workflows'), { recursive: true });
fs.writeFileSync(path.join(root, 'workflows/support-triage.json'), JSON.stringify(workflow, null, 2) + '\n');
