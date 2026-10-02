const {test} = require('node:test');
const assert = require('node:assert/strict');
const {triage} = require('../src/triage.cjs');
const {prepareWebSearch, attachWebEvidence} = require('../src/search.cjs');
const {buildPlainNote} = require('../src/plain.cjs');
const item = {threadId: 'th_demo', customerId: 'c_demo', marker: '[marker]', warnings: []};
const ticket = {ticketId: 'th_demo', subject: 'OpenAI credential failure for alice@example.com', description: '401 Unauthorized\nBearer secret-value\nPrivate workspace https://private.example.com/123', impact: 'single_user'};
const input = prepareWebSearch(item, triage(ticket));
test('search query contains only approved product and error tokens, never customer data', () => {
  assert.equal(input.search.query, 'OpenAI 401 authentication troubleshooting');
  assert.deepEqual(input.search.domains, ['platform.openai.com', 'developers.openai.com']);
  const request = JSON.stringify(input.search.request);
  for (const value of ['alice', 'example.com', 'secret-value', 'Private workspace', 'th_demo']) assert.ok(!request.includes(value));
  assert.equal(input.search.request.include_answer, false);
  const fallback = prepareWebSearch(item, triage({...ticket, subject: 'Request fails', description: 'ENOTFOUND'}));
  assert.equal(fallback.search.query, 'n8n ENOTFOUND connectivity troubleshooting');
});
test('accepts only official HTTPS references, deduplicates and bounds snippets', () => {
  const result = attachWebEvidence(input, {results: [
    {url: 'https://platform.openai.com/docs/errors', title: 'Errors', content: 'a'.repeat(900)},
    {url: 'https://platform.openai.com/docs/errors', title: 'Duplicate'},
    {url: 'https://platform.openai.com.attacker.test/page'},
    {url: 'http://platform.openai.com/docs/errors'},
    {url: 'javascript:alert(1)'},
  ]}, '2026-10-01T00:00:00Z');
  assert.equal(result.webResearch.results.length, 1);
  assert.equal(result.webResearch.results[0].snippet.length, 600);
  const note = buildPlainNote(result, result.triageResult).variables.input;
  assert.ok(note.markdown.includes('[Errors](https://platform.openai.com/docs/errors)'));
  assert.ok(note.text.includes('not confirmation of the root cause'));
  assert.ok(note.text.includes('2026-10-01T00:00:00Z'));
});
test('search failures and empty results still build a note without inventing evidence', () => {
  for (const response of [{error: 'Unauthorized token must not appear in note'}, {results: []}]) {
    const result = attachWebEvidence(input, response);
    const note = buildPlainNote(result, result.triageResult).variables.input;
    assert.ok(note.text.includes('401 Unauthorized'));
    assert.ok(note.text.includes(result.webResearch.status === 'unavailable' ? 'Web search was unavailable' : 'No usable documentation'));
    assert.ok(!note.text.includes('token must not appear'));
  }
});
