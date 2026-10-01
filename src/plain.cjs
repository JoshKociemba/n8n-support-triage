const THREADS_QUERY = `query SupportTriageThreads($since: String!) {
  threads(first: 100, filters: {createdAt: {after: $since}, isMarkedAsSpam: false}, sortBy: {field: CREATED_AT, direction: ASC}) {
    pageInfo { hasNextPage }
    edges { node {
      id title description previewText
      messages: timelineEntries(first: 20, filters: {isMessage: true}) {
        pageInfo { hasNextPage }
        edges { node { llmText actor { __typename } } }
      }
      triageEvents: timelineEntries(first: 100, filters: {entryTypes: [THREAD_EVENT]}) {
        pageInfo { hasNextPage }
        edges { node { entry { ... on ThreadEventEntry { externalId } } } }
      }
    } }
  }
}`;

const CREATE_EVENT = `mutation SupportTriageEvent($input: CreateThreadEventInput!) {
  createThreadEvent(input: $input) {
    threadEvent { id }
    error { code message }
  }
}`;

function preparePlainThreads(response) {
  if (response.errors?.length) throw new Error('Plain query failed: ' + response.errors.map(e => e.message).join('; '));
  const connection = response.data?.threads;
  if (!connection?.edges) throw new Error('Plain returned no threads connection.');
  if (connection.pageInfo?.hasNextPage) throw new Error('More than 100 threads in the 24-hour window. Add pagination before processing this volume.');
  return connection.edges.flatMap(({ node: thread }) => {
    const externalId = `n8n-support-triage:rules-v1:${thread.id}`;
    if (thread.triageEvents?.pageInfo?.hasNextPage) throw new Error('Too many events to check deduplication for ' + thread.id);
    if (thread.triageEvents?.edges?.some(e => e.node.entry.externalId === externalId)) return [];
    const messages = (thread.messages?.edges || [])
      .filter(e => e.node.actor?.__typename === 'CustomerActor')
      .map(e => e.node.llmText).filter(Boolean);
    const source = [thread.description, ...messages].filter(Boolean).join('\n\n') || thread.previewText || '';
    const warnings = ['Customer impact is unknown; priority is a suggestion using the single-user default.'];
    if (thread.messages?.pageInfo?.hasNextPage) warnings.push('Only the first 20 message entries were inspected.');
    if (!messages.length) warnings.push('No customer message text was available; using thread description or preview.');
    if (source.length > 10000) warnings.push('Source text was truncated to 10000 characters.');
    return [{
      threadId: thread.id, externalId, warnings,
      ticket: { ticketId: thread.id, subject: thread.title.slice(0, 10000), description: source.slice(0, 10000) || 'No description provided.', logs: '', impact: 'single_user' },
    }];
  });
}

function buildPlainEvent(item, triageResult) {
  if (triageResult.statusCode !== 200) throw new Error('Ticket validation failed: ' + triageResult.result.error);
  const r = triageResult.result;
  const sections = [
    `Support triage — rules-v1\nCategory: ${r.category}\nSuggested priority: ${r.priority}\nHuman review required`,
    'Input limitations\n' + item.warnings.join('\n'),
    'Reported issue\n' + r.ticket.subject + '\n' + r.ticket.description,
    'Findings\n' + (r.findings.map(f => `${f.category}: ${f.hypothesis}\nEvidence: ${f.evidence.join('\n')}`).join('\n\n') || 'No known error pattern matched.'),
    'Investigation steps\n' + r.nextSteps.join('\n'),
    'Escalation summary\n' + JSON.stringify(r.escalationSummary, null, 2),
    'Customer reply draft — review before sending\n' + r.customerReplyDraft,
  ];
  // Plain text avoids interpreting customer text as Markdown or mentions.
  const components = sections.flatMap(text => {
    const chunks = [];
    for (let i = 0; i < text.length; i += 10000) chunks.push({ componentPlainText: { plainText: text.slice(i, i + 10000) } });
    return chunks;
  });
  return { query: CREATE_EVENT, variables: { input: {
    threadId: item.threadId, externalId: item.externalId,
    title: 'Support triage — rules-v1', components,
  } } };
}

function checkPlainWrite(response) {
  if (response.errors?.length) throw new Error('Plain mutation failed: ' + response.errors.map(e => e.message).join('; '));
  const result = response.data?.createThreadEvent;
  if (result?.error) throw new Error(`Plain write failed (${result.error.code}): ${result.error.message}`);
  if (!result?.threadEvent?.id) throw new Error('Plain did not confirm event creation.');
  return { status: 'triaged', eventId: result.threadEvent.id };
}

module.exports = { THREADS_QUERY, CREATE_EVENT, preparePlainThreads, buildPlainEvent, checkPlainWrite };
