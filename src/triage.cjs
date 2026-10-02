// Embedded in the n8n Code node by scripts/build-plain-webhook.cjs.
// Keep this function dependency-free so it runs in n8n's task runner.
/** Return validated, redacted triage suggestions; malformed tickets return a 400 result. */
function triage(body) {
  const fail = (message) => ({ statusCode: 400, result: { error: message } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('Expected a JSON object.');
  for (const field of ['ticketId', 'subject', 'description']) {
    if (typeof body[field] !== 'string' || !body[field].trim()) return fail(`${field} must be a non-empty string.`);
    if (body[field].length > 10000) return fail(`${field} exceeds 10000 characters.`);
  }
  if (body.logs !== undefined && typeof body.logs !== 'string') return fail('logs must be a string.');
  if ((body.logs || '').length > 50000) return fail('logs exceeds 50000 characters.');
  if (body.impact !== undefined && !['single_user', 'multiple_users', 'outage'].includes(body.impact)) {
    return fail('impact must be single_user, multiple_users, or outage.');
  }
  // Best-effort redaction, not a guarantee. Use synthetic data for the demo.
  const redact = (text) => text
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [REDACTED]')
    .replace(/\b(api[_-]?key|token|password|secret)\b(["']?\s*[:=]\s*["']?)[^\s,"';}]+/gi, '$1$2[REDACTED]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL REDACTED]');
  const ticket = {
    ticketId: redact(body.ticketId.trim()),
    subject: redact(body.subject.trim()),
    description: redact(body.description.trim()),
    logs: redact(body.logs || ''),
    impact: body.impact || 'single_user',
  };
  const rules = [
    { category: 'authentication', pattern: /\b401\b|unauthorized|invalid credentials|invalid api key/i,
      hypothesis: 'Credentials may be missing, invalid, or expired.',
      steps: ['Confirm the configured credential is current without sharing its value.', 'Check the authentication header format and retry with a known working credential.'] },
    { category: 'permissions', pattern: /\b403\b|forbidden|insufficient permissions/i,
      hypothesis: 'The caller may lack access to the requested resource.',
      steps: ['Check the credential scopes and resource permissions.', 'Compare the failing request with one that succeeds for the same account.'] },
    { category: 'rate_limit', pattern: /\b429\b|rate.?limit|too many requests/i,
      hypothesis: 'The service may be throttling requests.',
      steps: ['Check Retry-After and the provider request limits.', 'Reduce concurrency and use bounded retries with backoff.'] },
    { category: 'connectivity', pattern: /ETIMEDOUT|ECONNREFUSED|ENOTFOUND|connection refused|timed out/i,
      hypothesis: 'DNS, network access, or upstream availability may be preventing the request.',
      steps: ['Check the destination URL and service availability.', 'Test DNS and connectivity from the same environment as the failing workflow.'] },
    { category: 'upstream_error', pattern: /\b50[0234]\b|bad gateway|service unavailable/i,
      hypothesis: 'The upstream service may be failing or unavailable.',
      steps: ['Check the upstream service status and request ID.', 'Retry only if the operation is safe to repeat; capture response headers and timestamps.'] },
  ];
  const source = `${ticket.subject}\n${ticket.description}\n${ticket.logs}`;
  const matches = rules.filter(rule => rule.pattern.test(source));
  let findings = matches.map(rule => ({
    category: rule.category,
    hypothesis: rule.hypothesis,
    evidence: source.split('\n').filter(line => rule.pattern.test(line)).slice(0, 3).map(line => line.slice(0, 500)),
    nextSteps: rule.steps,
  }));
  const isBilling = /\b(?:billing|invoice|refund|payment|subscription|pricing|charge|charged|charges|plan|renewal|credit balance|upgrade|downgrade)\b/i.test(source);
  // An unauthorized charge is a billing issue, not an API authentication error.
  const hasTechnicalContext = /\b(?:api|http|workflow|node|webhook|integration|credential|execution|ETIMEDOUT|ECONNREFUSED|ENOTFOUND)\b|\b(?:401|403|429|500|502|503|504)\s+(?:unauthorized|forbidden|too many|internal|bad gateway|service unavailable)/i.test(source);
  if (isBilling && !hasTechnicalContext) findings = [];
  const ticketType = findings.length ? 'technical' : isBilling ? 'billing' :
    /\b(?:workflow|node|api|webhook|integration|error|bug|fail(?:s|ed|ure)?|crash|execution|credential|unexpected behavior)\b/i.test(source) ? 'technical' : 'general';
  // Rule order selects the main category while retaining other matches as hypotheses.
  const primary = findings[0];
  const nextSteps = [...new Set(findings.flatMap(f => f.nextSteps))];
  if (!primary) {
    if (ticketType === 'billing') nextSteps.push(
      'Review the billing question and the customer account information already available in Plain.',
      'Use official pricing or billing documentation for general policy questions; verify account-specific charges, invoices, or refunds with the billing team.',
      'Ask a targeted follow-up only if a specific detail needed to answer the question is missing. Do not request payment card details.'
    );
    else if (ticketType === 'technical') nextSteps.push('Request exact reproduction steps, expected behavior, actual behavior, and timestamp with timezone.', 'Collect a sanitized error message and execution ID.');
    else nextSteps.push('Review the question and any relevant product documentation.', 'Ask a targeted clarification only if the customer request is unclear.');
  }
  // Public research gaps alone do not justify technical follow-ups for billing/general requests.
  const missingInformation = ticketType === 'technical' ? ['Reproduction steps', 'Expected behavior', 'Affected version', 'Timestamp and execution ID'] : [];
  const customerReplyDraft = ticketType === 'billing'
    ? "Thanks for your billing question. We'll review the details in your message and check the relevant billing information."
    : ticketType === 'general'
      ? "Thanks for reaching out. We'll review your question and get back to you with the relevant information."
      : `Thanks for reporting this. ${primary ? 'The information provided contains signals related to ' + primary.category.replace(/_/g, ' ') + '. We need to verify the cause.' : 'We need a little more information to investigate.'} Please share the exact reproduction steps, the affected version, and the timestamp with timezone. Please remove credentials and personal information from any logs you send.`;
  const priority = ticket.impact === 'outage' ? 'high' : ticket.impact === 'multiple_users' ? 'medium' : 'normal';
  return { statusCode: 200, result: {
    ticket,
    category: primary?.category || (ticketType === 'technical' ? 'needs_investigation' : ticketType),
    ticketType,
    priority,
    method: 'rules-v2',
    findings,
    nextSteps,
    requiresHumanReview: true,
    escalationSummary: {
      issue: ticket.subject,
      reportedBehavior: ticket.description,
      impact: ticket.impact,
      hypotheses: findings.map(f => f.hypothesis),
      missingInformation,
      escalationRecommended: ticket.impact === 'outage',
    },
    customerReplyDraft,
  } };
}

module.exports = { triage };
