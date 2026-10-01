const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../src/triage.cjs');
const { preparePlainThreads, buildPlainEvent, checkPlainWrite } = require('../src/plain.cjs');
const thread = {
  id: 'th_demo', title: 'API auth broken', description: null, previewText: 'Preview',
  messages: { edges: [{ node: { actor: { __typename: 'CustomerActor' }, llmText: '401 Unauthorized\nBearer sample-secret' } }, { node: { actor: { __typename: 'UserActor' }, llmText: '429 agent discussion' } }], pageInfo: { hasNextPage: false } },
  triageEvents: { edges: [], pageInfo: { hasNextPage: false } },
};
const response = (node = thread) => ({ data: { threads: { edges: [{ node }], pageInfo: { hasNextPage: false } } } });
test('uses customer content, redacts it, and creates an idempotent event', () => {
  const [item] = preparePlainThreads(response());
  const request = buildPlainEvent(item, triage(item.ticket));
  assert.equal(request.variables.input.externalId, 'n8n-support-triage:rules-v1:th_demo');
  assert.equal(request.variables.input.threadId, 'th_demo');
  assert.ok(JSON.stringify(request).includes('authentication'));
  assert.ok(!JSON.stringify(request).includes('sample-secret'));
  assert.ok(!JSON.stringify(request).includes('429 agent discussion'));
  assert.ok(request.variables.input.components.every(c => c.componentPlainText.plainText.length <= 10000));
});
test('skips completed threads and empty workspaces', () => {
  assert.deepEqual(preparePlainThreads(response({ ...thread, triageEvents: { edges: [{ node: { entry: { externalId: 'n8n-support-triage:rules-v1:th_demo' } } }] } })), []);
  assert.deepEqual(preparePlainThreads({ data: { threads: { edges: [], pageInfo: { hasNextPage: false } } } }), []);
});
test('includes a directly queried onboarding test thread without duplicating it', () => {
  const data = { threads: { edges: [], pageInfo: {hasNextPage: false} }, testThread: thread };
  assert.equal(preparePlainThreads({data}).length, 1);
  data.threads.edges = [{node: thread}];
  assert.equal(preparePlainThreads({data}).length, 1);
});
test('reports query failures and overflow instead of losing tickets', () => {
  assert.throws(() => preparePlainThreads({ errors: [{ message: 'Unauthorized' }] }), /Unauthorized/);
  assert.throws(() => preparePlainThreads({ data: { threads: { edges: [], pageInfo: { hasNextPage: true } } } }), /100 threads/);
});
test('rejects HTTP-200 GraphQL and mutation errors', () => {
  assert.throws(() => checkPlainWrite({ errors: [{ message: 'No permission' }] }), /No permission/);
  assert.throws(() => checkPlainWrite({ data: { createThreadEvent: { error: { code: 'forbidden', message: 'Denied' } } } }), /forbidden/);
  assert.throws(() => checkPlainWrite({ data: {} }), /confirm/);
  assert.equal(checkPlainWrite({ data: { createThreadEvent: { threadEvent: { id: 'tev_demo' } } } }).eventId, 'tev_demo');
});
