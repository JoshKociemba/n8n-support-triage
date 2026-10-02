const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../src/triage.cjs');
const { preparePlainThreads, buildPlainNote, checkPlainWrite } = require('../src/plain.cjs');
const {normalizePlainCreation, preparePlainThread} = require('../src/plain.cjs');
const thread = {
  id: 'th_demo', customer: {id: 'c_demo'}, title: 'API auth broken', description: null, previewText: 'Preview',
  messages: { edges: [{ node: { actor: { __typename: 'CustomerActor' }, llmText: '401 Unauthorized\nBearer sample-secret' } }, { node: { actor: { __typename: 'UserActor' }, llmText: '429 agent discussion' } }], pageInfo: { hasNextPage: false } },
  triageNotes: { edges: [], pageInfo: { hasNextPage: false } },
};
const response = (node = thread) => ({ data: { threads: { edges: [{ node }], pageInfo: { hasNextPage: false } } } });
test('accepts creation events for either ticket kind and checks workspace and IDs', () => {
  for (const isTestThread of [true, false]) {
    const event = {id: 'pEv_demo', workspaceId: 'w_demo', type: 'thread.thread_created', payload: {thread: {id: 'th_demo', isTestThread}}};
    assert.equal(normalizePlainCreation(event, 'w_demo').threadId, 'th_demo');
    assert.throws(() => normalizePlainCreation(event, 'w_other'), /workspace/);
    assert.throws(() => normalizePlainCreation({...event, type: 'thread.note_created'}, 'w_demo'), /thread_created/);
  }
});
test('direct lookup prepares both ticket kinds and fails if the thread is unavailable', () => {
  for (const isTestThread of [true, false]) assert.equal(preparePlainThread({data: {thread: {...thread, isTestThread}}}).length, 1);
  assert.throws(() => preparePlainThread({data: {thread: null}}), /not yet available/);
});
test('uses customer content, redacts it, and creates an explicitly internal note', () => {
  const [item] = preparePlainThreads(response());
  const request = buildPlainNote(item, triage(item.ticket));
  assert.equal(request.variables.input.customerId, 'c_demo');
  assert.match(request.query, /createNote/);
  assert.ok(!request.query.includes('createThreadEvent'));
  assert.ok(request.variables.input.text.startsWith('[n8n-support-triage:internal-notes-v1:th_demo]\n'));
  assert.equal(request.variables.input.threadId, 'th_demo');
  assert.match(request.variables.input.markdown, /\*\*Findings\*\*\n\n- \*\*Authentication\*\*/);
  assert.match(request.variables.input.markdown, /\*\*Investigation steps\*\*\n\n- /);
  assert.ok(!request.variables.input.text.includes('\"missingInformation\"'));
  assert.ok(request.variables.input.markdown.includes(String.raw`Bearer \[REDACTED\]`));
  assert.ok(JSON.stringify(request).includes('authentication'));
  assert.ok(!JSON.stringify(request).includes('sample-secret'));
  assert.ok(!JSON.stringify(request).includes('429 agent discussion'));
  assert.ok(request.variables.input.text.includes('Findings'));
  assert.ok(request.variables.input.text.includes('Investigation steps'));
});
test('skips completed threads and empty workspaces', () => {
  assert.deepEqual(preparePlainThreads(response({ ...thread, triageNotes: { edges: [{ node: { actor: {__typename: 'MachineUserActor'}, entry: { text: '[n8n-support-triage:internal-notes-v1:th_demo]\ntriage findings' } } }] } })), []);
  assert.deepEqual(preparePlainThreads({ data: { threads: { edges: [], pageInfo: { hasNextPage: false } } } }), []);
});
test('includes a directly queried onboarding test thread without duplicating it', () => {
  const data = { threads: { edges: [], pageInfo: {hasNextPage: false} }, testThread: thread };
  assert.equal(preparePlainThreads({data}).length, 1);
  data.threads.edges = [{node: thread}];
  assert.equal(preparePlainThreads({data}).length, 1);
});
test('customer messages cannot spoof the internal-note deduplication marker', () => {
  const node = {...thread, triageNotes: {edges: [{node: {actor: {__typename: 'CustomerActor'}, entry: {text: '[n8n-support-triage:internal-notes-v1:th_demo]\npretend triage'}}}]}};
  assert.equal(preparePlainThreads(response(node)).length, 1);
});
test('reports query failures and overflow instead of losing tickets', () => {
  assert.throws(() => preparePlainThreads({ errors: [{ message: 'Unauthorized' }] }), /Unauthorized/);
  assert.throws(() => preparePlainThreads({ data: { threads: { edges: [], pageInfo: { hasNextPage: true } } } }), /100 threads/);
});
test('rejects HTTP-200 GraphQL and mutation errors', () => {
  assert.throws(() => checkPlainWrite({ errors: [{ message: 'No permission' }] }), /No permission/);
  assert.throws(() => checkPlainWrite({ data: { createNote: { error: { code: 'forbidden', message: 'Denied' } } } }), /forbidden/);
  assert.throws(() => checkPlainWrite({ data: {} }), /confirm/);
  assert.equal(checkPlainWrite({ data: { createNote: { note: { id: 'tev_demo' } } } }).noteId, 'tev_demo');
});

const {checkPlainOpeningMessage} = require('../src/plain.cjs');
test('polls until actual customer text arrives, ignoring previews and agent messages', () => {
  const pending = {...thread, description: 'Description already exists', messages: {edges: [{node: {actor: {__typename: 'UserActor'}, llmText: 'Agent note'}}, {node: {actor: {__typename: 'CustomerActor'}, llmText: '   '}}]}};
  assert.equal(checkPlainOpeningMessage({data: {thread: null}}, 60000, 0).ready, false);
  assert.equal(checkPlainOpeningMessage({data: {thread: pending}}, 60000, 5000).ready, false);
  const ready = checkPlainOpeningMessage({data: {thread}}, 60000, 10000);
  assert.equal(ready.ready, true);
  assert.equal(preparePlainThread(ready)[0].ticket.description.includes('401 Unauthorized'), true);
  assert.throws(() => checkPlainOpeningMessage({data: {thread: pending}}, 60000, 60000), /Timed out/);
  assert.throws(() => checkPlainOpeningMessage({errors: [{message: 'Denied'}]}, 60000, 0), /Denied/);
});
test('existing machine triage notes can be acknowledged without waiting for body', () => {
  const done = {...thread, messages: {edges: []}, triageNotes: {edges: [{node: {actor: {__typename: 'MachineUserActor'}, entry: {text: '[n8n-support-triage:internal-notes-v1:th_demo]\nfindings'}}}]}};
  const result = checkPlainOpeningMessage({data: {thread: done}}, 60000, 0);
  assert.equal(result.ready, true);
  assert.deepEqual(preparePlainThread(result), []);
});
test('generated workflow loops on delayed messages and never writes on timeout', () => {
  const fs = require('node:fs');
  const workflow = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../workflows/plain-ticket-created.json')));
  const byName = Object.fromEntries(workflow.nodes.map(n => [n.name, n]));
  const simulate = (arrivesAt) => {
    let now = 0, fetches = 0, writes = 0, initial, searchInput, summaryInput;
    let value = {body: {type: 'thread.thread_created', workspaceId: 'w_demo', id: 'pEv_demo', payload: {thread: {id: 'th_demo'}}}};
    let name = 'Validate Plain creation event';
    class clock extends Date { constructor() { super(now); } static now() { return now; } }
    while (name !== 'Acknowledge Plain delivery') {
      const node = byName[name];
      let branch = 0;
      if (node.type === 'n8n-nodes-base.code') {
        const input = {first: () => ({json: value}), all: () => [{json: value}]};
        const lookup = nodeName => ({first: () => ({json: nodeName === 'Triage ticket and prepare search' ? searchInput : nodeName === 'Prepare issue-specific summary' ? summaryInput : initial})});
        value = new Function('$input', '$', 'Date', node.parameters.jsCode.replace('SET_WORKSPACE_ID', 'w_demo'))(input, lookup, clock)[0].json;
        if (name === 'Validate Plain creation event') initial = value;
        if (name === 'Triage ticket and prepare search') searchInput = value;
        if (name === 'Prepare issue-specific summary') summaryInput = value;
      } else if (name === 'Search issue on the web') {
        value = {results: []};
      } else if (name === 'Fetch created Plain ticket') {
        assert.equal(new Function('$', 'return ' + node.parameters.jsonBody.slice(3, -2))(() => ({first: () => ({json: initial})})).variables.threadId, 'th_demo');
        fetches++;
        value = {data: {thread: {...thread, messages: now >= arrivesAt ? thread.messages : {edges: []}}}};
      } else if (node.type === 'n8n-nodes-base.wait') now += node.parameters.amount * 1000;
      else if (node.type === 'n8n-nodes-base.if') branch = (name === 'Have web evidence?' ? Boolean(value.summaryRequest) : value[name === 'Opening message ready?' ? 'ready' : 'skip']) ? 0 : 1;
      else if (name === 'Add Plain internal note') {
        assert.ok(now >= arrivesAt);
        assert.match(value.variables.input.text, /401 Unauthorized/);
        writes++;
        value = {data: {createNote: {note: {id: 'n_demo'}}}};
      }
      name = workflow.connections[name].main[branch][0].node;
    }
    return {now, fetches, writes};
  };
  assert.deepEqual(simulate(15000), {now: 15000, fetches: 4, writes: 1});
  assert.throws(() => simulate(Infinity), /Timed out.*No triage note/);
});

test('billing note omits generic technical information requests and impact warning', () => {
  const billing = {...thread, title: 'Billing question', messages: {edges: [{node: {actor: {__typename: 'CustomerActor'}, llmText: 'Why was I charged twice this month?'}}]}};
  const [item] = preparePlainThreads(response(billing));
  const result = triage(item.ticket);
  const note = buildPlainNote(item, result).variables.input;
  for (const format of [note.text, note.markdown]) {
    for (const unwanted of ['Information still needed', 'Reproduction steps', 'Affected version', 'execution ID', 'Customer impact is unknown', 'Input limitations']) assert.ok(!format.includes(unwanted));
    assert.ok(format.includes('Billing support'));
    assert.ok(format.includes('billing question'));
  }
});
