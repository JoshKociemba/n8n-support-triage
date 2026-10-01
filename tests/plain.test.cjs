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
