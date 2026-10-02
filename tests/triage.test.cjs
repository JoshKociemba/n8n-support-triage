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

test('billing and general questions avoid technical troubleshooting requests', () => {
  for (const description of ['Why was I charged twice this month?', 'There is an unauthorized charge on my invoice.']) {
    const result = triage({...ticket, subject: 'Billing question', description, logs: '', impact: 'single_user'}).result;
    assert.equal(result.ticketType, 'billing');
    assert.equal(result.category, 'billing');
    assert.deepEqual(result.escalationSummary.missingInformation, []);
    assert.ok(!JSON.stringify(result.nextSteps).includes('reproduction'));
    assert.ok(!result.customerReplyDraft.includes('version'));
    assert.ok(!result.customerReplyDraft.includes('execution ID'));
    assert.ok(result.customerReplyDraft.includes('billing question'));
  }
  const general = triage({...ticket, subject: 'Product question', description: 'Where can I find the getting started guide?', logs: ''}).result;
  assert.equal(general.ticketType, 'general');
  assert.deepEqual(general.escalationSummary.missingInformation, []);
  const technical = triage({...ticket, subject: 'API fails after subscription change', description: '401 Unauthorized', logs: ''}).result;
  assert.equal(technical.ticketType, 'technical');
  assert.equal(technical.category, 'authentication');
});
