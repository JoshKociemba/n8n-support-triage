const fs = require('node:fs');
const path = require('node:path');
const { triage } = require('../src/triage.cjs');
const { THREADS_QUERY, CREATE_EVENT, preparePlainThreads, buildPlainEvent, checkPlainWrite } = require('../src/plain.cjs');
const code = (id, name, x, jsCode) => ({ id, name, position: [x, 0], type: 'n8n-nodes-base.code', typeVersion: 2, parameters: { mode: 'runOnceForAllItems', jsCode } });
const http = (id, name, x, jsonBody) => ({
  id, name, position: [x, 0], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
  parameters: {
    method: 'POST', url: 'https://core-api.uk.plain.com/graphql/v1',
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody,
    options: { timeout: 30000, batching: { batch: { batchSize: 1, batchInterval: 250 } } },
  },
  retryOnFail: true, maxTries: 3, waitBetweenTries: 2000,
});
const nodes = [
  { id: 'manual', name: 'Test now', position: [0, -100], type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, parameters: {} },
  { id: 'schedule', name: 'Every minute', position: [0, 100], type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, parameters: { rule: { interval: [{ field: 'minutes', minutesInterval: 1 }] } } },
  http('fetch', 'Fetch recent Plain threads', 260, '={{ { query: ' + JSON.stringify(THREADS_QUERY) + ', variables: { since: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() } } }}'),
  code('prepare', 'Skip processed threads', 520, `${preparePlainThreads.toString()}\nreturn preparePlainThreads($input.first().json).map(json => ({json}));`),
  code('triage', 'Triage and build internal event', 780, `const CREATE_EVENT = ${JSON.stringify(CREATE_EVENT)};\n${triage.toString()}\n${buildPlainEvent.toString()}\nreturn $input.all().map(item => ({json: buildPlainEvent(item.json, triage(item.json.ticket))}));`),
  http('write', 'Add Plain triage event', 1040, '={{ $json }}'),
  code('check', 'Confirm write succeeded', 1300, `${checkPlainWrite.toString()}\nreturn $input.all().map(item => ({json: checkPlainWrite(item.json)}));`),
];
const connections = {};
for (const [from, to] of [['Test now', 'Fetch recent Plain threads'], ['Every minute', 'Fetch recent Plain threads'], ['Fetch recent Plain threads', 'Skip processed threads'], ['Skip processed threads', 'Triage and build internal event'], ['Triage and build internal event', 'Add Plain triage event'], ['Add Plain triage event', 'Confirm write succeeded']]) {
  connections[from] = { main: [[{ node: to, type: 'main', index: 0 }]] };
}
const workflow = { name: 'Plain support triage — automatic local demo', active: false, nodes, connections, settings: { executionOrder: 'v1' } };
const outputDir = path.resolve(__dirname, '../workflows');
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'plain-support-triage.json'), JSON.stringify(workflow, null, 2) + '\n');
