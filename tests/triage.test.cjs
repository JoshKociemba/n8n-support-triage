const { test } = require('node:test');
const assert = require('node:assert/strict');
const { triage } = require('../src/triage.cjs');
const ticket = require('../examples/authentication.json');
test('classifies authentication and removes sample secrets from all output', () => {
  const { statusCode, result } = triage(ticket);
  assert.equal(statusCode, 200);
  assert.equal(result.category, 'authentication');
  assert.equal(result.priority, 'medium');
  assert.equal(result.requiresHumanReview, true);
  assert.ok(result.findings[0].evidence.length);
  assert.ok(!JSON.stringify(result).includes('synthetic-demo-token'));
  assert.ok(!JSON.stringify(result).includes('demo@example.com'));
});
test('rejects malformed input and invalid impact', () => {
  for (const body of [null, [], {}, { ...ticket, logs: [] }, { ...ticket, impact: 'critical' }, { ...ticket, logs: 'a'.repeat(50001) }]) {
    assert.equal(triage(body).statusCode, 400);
  }
});
test('retains multiple hypotheses without claiming a root cause', () => {
  const result = triage({ ...ticket, logs: '401 Unauthorized\n429 Too Many Requests' }).result;
  assert.deepEqual(result.findings.map(f => f.category), ['authentication', 'rate_limit']);
});
test('unknown cases ask for evidence and outages recommend escalation', () => {
  const unknown = triage({ ...ticket, subject: 'Unexpected behavior', description: 'The result looks wrong.', logs: '' }).result;
  assert.equal(unknown.category, 'needs_investigation');
  const outage = triage(require('../examples/outage.json')).result;
  assert.equal(outage.priority, 'high');
  assert.equal(outage.escalationSummary.escalationRecommended, true);
});
