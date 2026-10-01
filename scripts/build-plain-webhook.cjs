const fs = require('node:fs');
const path = require('node:path');
const {triage} = require('../src/triage.cjs');
const {THREAD_QUERY, CREATE_NOTE, normalizePlainCreation, preparePlainThread, preparePlainThreads, buildPlainNote, checkPlainWrite} = require('../src/plain.cjs');
const code = (id, name, x, jsCode) => ({id, name, position: [x, 0], type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {mode: 'runOnceForAllItems', jsCode}});
const http = (id, name, x, jsonBody, retryOnFail) => ({id, name, position: [x, 0], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, retryOnFail, maxTries: 3, waitBetweenTries: 2000,
  parameters: {method: 'POST', url: 'https://core-api.uk.plain.com/graphql/v1', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody, options: {timeout: 20000}}
});
const nodes = [
  {id: 'receive', name: 'Plain ticket created', position: [0, 0], type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: 'plain-ticket-created', parameters: {httpMethod: 'POST', path: 'plain-ticket-created', authentication: 'headerAuth', responseMode: 'responseNode', options: {}}},
  code('validate', 'Validate Plain creation event', 260, `const workspaceId = 'SET_WORKSPACE_ID';\nconst query = ${JSON.stringify(THREAD_QUERY)};\n${normalizePlainCreation.toString()}\nconst event = normalizePlainCreation($input.first().json.body, workspaceId);\nreturn [{json: {...event, request: {query, variables: {threadId: event.threadId}}}}];`),
  {id: 'wait', name: 'Allow opening message to arrive', position: [520, 0], type: 'n8n-nodes-base.wait', typeVersion: 1.1, parameters: {resume: 'timeInterval', amount: 5, unit: 'seconds'}},
  http('fetch', 'Fetch created Plain ticket', 780, '={{ $json.request }}', true),
  code('prepare', 'Skip existing internal triage note', 1040, `${preparePlainThreads.toString()}\n${preparePlainThread.toString()}\nconst items = preparePlainThread($input.first().json);\nreturn items.length ? items.map(json => ({json: {...json, skip: false}})) : [{json: {skip: true, status: 'already_triaged'}}];`),
  {id: 'duplicate', name: 'Already triaged?', position: [1170, 0], type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: {conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2}, conditions: [{id: 'skip', leftValue: '={{ $json.skip }}', rightValue: '', operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {}}},
  code('triage', 'Triage and build internal note', 1300, `const CREATE_NOTE = ${JSON.stringify(CREATE_NOTE)};\n${triage.toString()}\n${buildPlainNote.toString()}\nreturn $input.all().map(item => ({json: buildPlainNote(item.json, triage(item.json.ticket))}));`),
  http('write', 'Add Plain internal note', 1560, '={{ $json }}', false),
  code('confirm', 'Confirm internal note', 1820, `${checkPlainWrite.toString()}\nreturn $input.all().map(item => ({json: checkPlainWrite(item.json)}));`),
  {id: 'respond', name: 'Acknowledge Plain delivery', position: [2080, 0], type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, parameters: {respondWith: 'json', responseBody: '={{ $json }}', options: {responseCode: 200}}},
];
const connections = {};
for (let i = 0; i < nodes.length - 1; i++) connections[nodes[i].name] = {main: [[{node: nodes[i + 1].name, type: 'main', index: 0}]]};
connections['Already triaged?'] = {main: [[{node: 'Acknowledge Plain delivery', type: 'main', index: 0}], [{node: 'Triage and build internal note', type: 'main', index: 0}]]};
const workflow = {name: 'Plain support triage — ticket creation webhook', active: false, nodes, connections, settings: {executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 120}};
fs.writeFileSync(path.resolve(__dirname, '../workflows/plain-ticket-created.json'), JSON.stringify(workflow, null, 2) + '\n');
