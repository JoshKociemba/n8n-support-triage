// Embedded in n8n Code nodes; never send free-form ticket text to the search API.
function prepareWebSearch(item, triageResult) {
  if (triageResult.statusCode !== 200) throw new Error('Cannot search an invalid ticket.');
  const ticket = triageResult.result.ticket;
  const source = `${ticket.subject}\n${ticket.description}`;
  const vendors = [
    ['n8n', /\bn8n\b/i, ['docs.n8n.io']],
    ['Plain', /\bplain\b/i, ['plain.com']],
    ['Slack', /\bslack\b/i, ['docs.slack.dev']],
    ['Google Sheets', /\bgoogle sheets\b/i, ['developers.google.com']],
    ['Microsoft Graph', /\bmicrosoft graph\b/i, ['learn.microsoft.com']],
    ['OpenAI', /\bopenai\b/i, ['platform.openai.com', 'developers.openai.com']],
    ['Stripe', /\bstripe\b/i, ['docs.stripe.com']],
    ['GitHub', /\bgithub\b/i, ['docs.github.com']],
    ['Notion', /\bnotion\b/i, ['developers.notion.com']],
    ['PostgreSQL', /\bpostgres(?:ql)?\b/i, ['postgresql.org']],
  ].filter(([, pattern]) => pattern.test(source));
  if (!vendors.length) vendors.push(['n8n', null, ['docs.n8n.io']]);
  // Match only known public error tokens, avoiding numbers from URLs or secrets.
  const tokens = [...new Set(source.match(/\b(?:401|403|429|500|502|503|504|ETIMEDOUT|ECONNREFUSED|ENOTFOUND)\b/g) || [])].slice(0, 3);
  const categories = [...new Set(triageResult.result.findings.map(f => f.category.replace(/_/g, ' ')))];
  const query = [...vendors.map(([name]) => name), ...tokens, ...categories, triageResult.result.ticketType === 'billing' ? 'pricing billing policy' : triageResult.result.ticketType === 'general' ? 'product documentation' : 'troubleshooting'].join(' ');
  const domains = [...new Set(vendors.flatMap(([name, , domains]) => triageResult.result.ticketType === 'billing' && name === 'n8n' ? [...domains, 'n8n.io'] : domains))];
  return {...item, triageResult, search: {query, domains, request: {
    query, include_domains: domains, search_depth: 'basic', topic: 'general', max_results: 3,
    include_answer: false, include_raw_content: false, auto_parameters: false,
  }}};
}

function attachWebEvidence(item, response, now = new Date().toISOString()) {
  const base = {query: item.search.query, searchedAt: now, results: []};
  if (response?.error || !Array.isArray(response?.results)) {
    return {...item, webResearch: {...base, status: 'unavailable'}};
  }
  const seen = new Set();
  const results = response.results.flatMap(result => {
    try {
      // n8n's isolated Code runner does not expose the global URL constructor.
      const match = typeof result.url === 'string' && /^https:\/\/([a-z0-9.-]+)(?::443)?(\/[^\s<>\\]*)?$/i.exec(result.url);
      if (!match) return [];
      const hostname = match[1].toLowerCase();
      if (!item.search.domains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) return [];
      const url = 'https://' + hostname + (match[2] || '/').split('#')[0];
      if (seen.has(url)) return [];
      seen.add(url);
      return [{title: String(result.title || hostname).slice(0, 160), url,
        snippet: String(result.content || '').slice(0, 600)}];
    } catch { return []; }
  }).slice(0, 3);
  return {...item, webResearch: {...base, status: results.length ? 'found' : 'no_results', results}};
}
module.exports = {prepareWebSearch, attachWebEvidence};
