const fs = require('node:fs');
const path = require('node:path');
const {triage} = require('../src/triage.cjs');
const {THREAD_QUERY, CREATE_NOTE, normalizePlainCreation, checkPlainOpeningMessage, preparePlainThread, preparePlainThreads, buildPlainNote, checkPlainWrite} = require('../src/plain.cjs');
const {prepareWebSearch, attachWebEvidence} = require('../src/search.cjs');
const {prepareResearchSummary, attachResearchSummary} = require('../src/summary.cjs');
const code = (id, name, x, jsCode) => ({id, name, position: [x, 0], type: 'n8n-nodes-base.code', typeVersion: 2, parameters: {mode: 'runOnceForAllItems', jsCode}});
const http = (id, name, x, jsonBody, retryOnFail) => ({id, name, position: [x, 0], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, retryOnFail, maxTries: 3, waitBetweenTries: 2000,
  parameters: {method: 'POST', url: 'https://core-api.uk.plain.com/graphql/v1', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth', sendBody: true, specifyBody: 'json', jsonBody, options: {timeout: 20000}}
});
const nodes = [
  {id: 'receive', name: 'Plain ticket created', position: [0, 0], type: 'n8n-nodes-base.webhook', typeVersion: 2, webhookId: 'plain-ticket-created', parameters: {httpMethod: 'POST', path: 'plain-ticket-created', authentication: 'headerAuth', responseMode: 'responseNode', options: {}}},
  code('validate', 'Validate Plain creation event', 260, `const workspaceId = 'SET_WORKSPACE_ID';\nconst query = ${JSON.stringify(THREAD_QUERY)};\n${normalizePlainCreation.toString()}\nconst event = normalizePlainCreation($input.first().json.body, workspaceId);\nreturn [{json: {...event, messageDeadline: Date.now() + 60000, request: {query, variables: {threadId: event.threadId}}}}];`),
  http('fetch', 'Fetch created Plain ticket', 520, "={{ $('Validate Plain creation event').first().json.request }}", true),
  code('check-body', 'Check opening message', 700, `${preparePlainThreads.toString()}\n${preparePlainThread.toString()}\n${checkPlainOpeningMessage.toString()}\nreturn [{json: checkPlainOpeningMessage($input.first().json, $('Validate Plain creation event').first().json.messageDeadline)}];`),
  {id: 'body-ready', name: 'Opening message ready?', position: [880, 0], type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: {conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2}, conditions: [{id: 'ready', leftValue: '={{ $json.ready }}', rightValue: '', operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {}}},
  {id: 'wait', name: 'Wait before checking again', position: [880, 240], type: 'n8n-nodes-base.wait', typeVersion: 1.1, parameters: {resume: 'timeInterval', amount: 5, unit: 'seconds'}},
  code('prepare', 'Skip existing internal triage note', 1040, `${preparePlainThreads.toString()}\n${preparePlainThread.toString()}\nconst items = preparePlainThread($input.first().json);\nreturn items.length ? items.map(json => ({json: {...json, skip: false}})) : [{json: {skip: true, status: 'already_triaged'}}];`),
  {id: 'duplicate', name: 'Already triaged?', position: [1170, 0], type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: {conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2}, conditions: [{id: 'skip', leftValue: '={{ $json.skip }}', rightValue: '', operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {}}},
  code('research-query', 'Triage ticket and prepare search', 1350, `${triage.toString()}\n${prepareWebSearch.toString()}\nreturn $input.all().map(item => ({json: prepareWebSearch(item.json, triage(item.json.ticket))}));`),
  {id: 'search', name: 'Search issue on the web', position: [1600, 0], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, onError: 'continueRegularOutput', parameters: {
    method: 'POST', url: 'https://api.tavily.com/search', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.search.request }}', options: {timeout: 10000},
  }},
  code('research-evidence', 'Attach web evidence', 1850, `${attachWebEvidence.toString()}\nreturn [{json: attachWebEvidence($('Triage ticket and prepare search').first().json, $input.first().json)}];`),
  code('summary-input', 'Prepare issue-specific summary', 2100, `${prepareResearchSummary.toString()}\nreturn $input.all().map(item => ({json: prepareResearchSummary(item.json, 'SET_SUMMARY_MODEL')}));`),
  {id: 'summary-needed', name: 'Have web evidence?', position: [2350, 0], type: 'n8n-nodes-base.if', typeVersion: 2.2, parameters: {conditions: {options: {caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2}, conditions: [{id: 'has-evidence', leftValue: '={{ Boolean($json.summaryRequest) }}', rightValue: '', operator: {type: 'boolean', operation: 'true', singleValue: true}}], combinator: 'and'}, options: {}}},
  {id: 'summarize', name: 'Summarize findings for customer issue', position: [2600, 0], type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2, onError: 'continueRegularOutput', parameters: {
    method: 'POST', url: 'http://host.docker.internal:11434/api/chat', authentication: 'none',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ $json.summaryRequest }}', options: {timeout: 20000},
  }},
  code('summary-check', 'Validate cited summary', 2850, `${attachResearchSummary.toString()}\nreturn [{json: attachResearchSummary($('Prepare issue-specific summary').first().json, $input.first().json)}];`),
  code('triage', 'Triage and build internal note', 3100, `const CREATE_NOTE = ${JSON.stringify(CREATE_NOTE)};\n${buildPlainNote.toString()}\nreturn $input.all().map(item => ({json: buildPlainNote(item.json, item.json.triageResult)}));`),
  http('write', 'Add Plain internal note', 3350, '={{ $json }}', false),
  code('confirm', 'Confirm internal note', 3600, `${checkPlainWrite.toString()}\nreturn $input.all().map(item => ({json: checkPlainWrite(item.json)}));`),
  {id: 'respond', name: 'Acknowledge Plain delivery', position: [3850, 0], type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.4, parameters: {respondWith: 'json', responseBody: '={{ $json }}', options: {responseCode: 200}}},
];
const connections = {};
const connect = (from, to) => { connections[from] = {main: [[{node: to, type: 'main', index: 0}]]}; };
const route = node => [{node, type: 'main', index: 0}];
connect('Plain ticket created', 'Validate Plain creation event');
connect('Validate Plain creation event', 'Fetch created Plain ticket');
connect('Fetch created Plain ticket', 'Check opening message');
connect('Check opening message', 'Opening message ready?');
connections['Opening message ready?'] = {main: [route('Skip existing internal triage note'), route('Wait before checking again')]};
connect('Wait before checking again', 'Fetch created Plain ticket');
connect('Skip existing internal triage note', 'Already triaged?');
connections['Already triaged?'] = {main: [route('Acknowledge Plain delivery'), route('Triage ticket and prepare search')]};
connect('Triage ticket and prepare search', 'Search issue on the web');
connect('Search issue on the web', 'Attach web evidence');
connect('Attach web evidence', 'Prepare issue-specific summary');
connect('Prepare issue-specific summary', 'Have web evidence?');
connections['Have web evidence?'] = {main: [route('Summarize findings for customer issue'), route('Validate cited summary')]};
connect('Summarize findings for customer issue', 'Validate cited summary');
connect('Validate cited summary', 'Triage and build internal note');
connect('Triage and build internal note', 'Add Plain internal note');
connect('Add Plain internal note', 'Confirm internal note');
connect('Confirm internal note', 'Acknowledge Plain delivery');
const workflow = {name: 'Plain support triage — ticket creation webhook', active: false, nodes, connections, settings: {executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all', executionTimeout: 120}};
fs.writeFileSync(path.resolve(__dirname, '../workflows/plain-ticket-created.json'), JSON.stringify(workflow, null, 2) + '\n');
