const {test} = require('node:test');
const assert = require('node:assert/strict');
const {triage} = require('../src/triage.cjs');
const {prepareResearchSummary, attachResearchSummary} = require('../src/summary.cjs');
const {buildPlainNote} = require('../src/plain.cjs');
const item = {threadId: 'th_private', customerId: 'c_private', marker: '[marker]', warnings: [],
  triageResult: triage({ticketId: 'th_private', subject: '401 after credential rotation', description: '401 Unauthorized\nBearer private-secret\nuser@example.com'}),
  webResearch: {status: 'found', query: 'n8n 401 authentication troubleshooting', searchedAt: '2026-10-01', results: [{title: 'Credential errors', url: 'https://docs.n8n.io/errors', snippet: 'A 401 may indicate invalid authentication credentials.'}]}};
const summary = {issueSummary: 'The request fails with 401 after credential rotation.',
  interpretations: [{finding: 'An outdated credential may still be selected.', customerRelevance: 'This fits the timing of the reported failure after rotation, but is not confirmed.', sourceIds: ['S1']}],
  recommendedChecks: [{check: 'Check which credential the failing node selects.', reason: 'This checks whether it still uses the old credential.', sourceIds: ['S1']}],
  limitations: ['The snippet does not establish which credential the customer is using.']};
const response = value => ({done: true, done_reason: 'stop', message: {content: JSON.stringify(value)}});
test('summary receives redacted ticket context and snippets without internal identifiers', () => {
  const prepared = prepareResearchSummary(item);
  const body = JSON.stringify(prepared.summaryRequest);
  for (const secret of ['private-secret', 'user@example.com', 'th_private', 'c_private']) assert.ok(!body.includes(secret));
  assert.ok(body.includes('credential rotation'));
  assert.equal(prepared.summaryRequest.stream, false);
  assert.equal(prepared.summaryRequest.think, false);
  assert.equal(prepared.summaryRequest.format.additionalProperties, false);
  assert.equal(prepareResearchSummary({...item, webResearch: {status: 'no_results'}}).summaryRequest, null);
});
test('valid summary relates symptoms to sources and renders linked recommendations', () => {
  const enriched = attachResearchSummary(prepareResearchSummary(item), response(summary));
  assert.equal(enriched.researchSummary.status, 'ready');
  const note = buildPlainNote(enriched, enriched.triageResult).variables.input;
  assert.ok(note.markdown.includes('**Research summary for this issue**'));
  assert.ok(note.markdown.includes('[Source 1](https://docs.n8n.io/errors)'));
  assert.ok(note.text.includes('fits the timing'));
  assert.ok(!note.text.includes(item.webResearch.results[0].snippet));
});
test('fabricated or missing citations, refusal, malformed and incomplete responses fall back', () => {
  const prepared = prepareResearchSummary(item);
  for (const invalid of [
    response({...summary, interpretations: [{...summary.interpretations[0], sourceIds: ['S9']}]}),
    response({...summary, interpretations: [{...summary.interpretations[0], sourceIds: []}]}),
    {done: true, done_reason: 'length', message: {content: '{}'}}, {error: 'Credential failure'},
    {status: 'completed', output: [{type: 'message', content: [{type: 'refusal', refusal: 'No'}]}]},
    response({}),
  ]) {
    const enriched = attachResearchSummary(prepared, invalid);
    assert.notEqual(enriched.researchSummary.status, 'ready');
    assert.ok(buildPlainNote(enriched, enriched.triageResult).variables.input.text.includes('failed validation'));
  }
});
