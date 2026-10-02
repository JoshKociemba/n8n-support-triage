const THREAD_FIELDS = `
      id title description previewText customer { id }
      messages: timelineEntries(first: 20, filters: {isMessage: true}) {
        pageInfo { hasNextPage }
        edges { node { llmText actor { __typename } } }
      }
      triageNotes: timelineEntries(first: 100, filters: {entryTypes: [NOTE]}) {
        pageInfo { hasNextPage }
        edges { node { actor { __typename } entry { ... on NoteEntry { noteId text } } } }
      }`;

const THREADS_QUERY = `query SupportTriageThreads($since: String!, $testThreadId: ID! = "th_unused", $includeTestThread: Boolean! = false) {
  testThread: thread(threadId: $testThreadId) @include(if: $includeTestThread) { ${THREAD_FIELDS} }
  threads(first: 100, filters: {createdAt: {after: $since}, isMarkedAsSpam: false}, sortBy: {field: CREATED_AT, direction: ASC}) {
    pageInfo { hasNextPage }
    edges { node {
      ${THREAD_FIELDS}
    } }
  }
}`;

const CREATE_NOTE = `mutation SupportTriageNote($input: CreateNoteInput!) {
  createNote(input: $input) {
    note { id }
    error { code message }
  }
}`;

const THREAD_QUERY = `query SupportTriageThread($threadId: ID!) { thread(threadId: $threadId) { ${THREAD_FIELDS} } }`;

function normalizePlainCreation(event, workspaceId) {
  if (!event || event.type !== 'thread.thread_created') throw new Error('Expected a Plain thread.thread_created event.');
  if (!workspaceId || event.workspaceId !== workspaceId) throw new Error('Unexpected Plain workspace.');
  if (typeof event.id !== 'string' || !event.id.startsWith('pEv_')) throw new Error('Missing Plain event ID.');
  const threadId = event.payload?.thread?.id;
  if (typeof threadId !== 'string' || !threadId.startsWith('th_')) throw new Error('Missing Plain thread ID.');
  return {threadId, eventId: event.id};
}

function checkPlainOpeningMessage(response, deadline, now = Date.now()) {
  if (response.errors?.length) throw new Error('Plain query failed: ' + response.errors.map(e => e.message).join('; '));
  const thread = response.data?.thread;
  if (thread) {
    // Deduplication can finish immediately, even if the original message was removed.
    if (!preparePlainThread(response).length) return {...response, ready: true};
    const hasBody = thread.messages?.edges?.some(({node}) =>
      node.actor?.__typename === 'CustomerActor' && typeof node.llmText === 'string' && node.llmText.trim().length > 0);
    if (hasBody) return {...response, ready: true};
  }
  if (!Number.isFinite(deadline)) throw new Error('Missing opening-message polling deadline.');
  if (now >= deadline) throw new Error('Timed out waiting for the initial customer message. No triage note was created; Plain can retry delivery.');
  return {...response, ready: false};
}

function preparePlainThread(response) {
  if (response.errors?.length) throw new Error('Plain query failed: ' + response.errors.map(e => e.message).join('; '));
  if (!response.data?.thread) throw new Error('Created thread is not yet available from Plain.');
  return preparePlainThreads({data: {threads: {edges: [], pageInfo: {hasNextPage: false}}, testThread: response.data.thread}});
}

function preparePlainThreads(response) {
  if (response.errors?.length) throw new Error('Plain query failed: ' + response.errors.map(e => e.message).join('; '));
  const connection = response.data?.threads;
  if (!connection?.edges) throw new Error('Plain returned no threads connection.');
  if (connection.pageInfo?.hasNextPage) throw new Error('More than 100 threads in the 24-hour window. Add pagination before processing this volume.');
  const edges = [...connection.edges];
  if (response.data.testThread && !edges.some(e => e.node.id === response.data.testThread.id)) edges.push({node: response.data.testThread});
  return edges.flatMap(({ node: thread }) => {
    const marker = `[n8n-support-triage:internal-notes-v1:${thread.id}]`;
    if (thread.triageNotes?.pageInfo?.hasNextPage) throw new Error('Too many notes to check deduplication for ' + thread.id);
    if (thread.triageNotes?.edges?.some(e => e.node.actor?.__typename === 'MachineUserActor' && e.node.entry.text?.startsWith(marker + '\n'))) return [];
    if (!thread.customer?.id) throw new Error('Missing customer ID for ' + thread.id);
    const messages = (thread.messages?.edges || [])
      .filter(e => e.node.actor?.__typename === 'CustomerActor')
      .map(e => e.node.llmText).filter(Boolean);
    const source = [thread.description, ...messages].filter(Boolean).join('\n\n') || thread.previewText || '';
    const warnings = [];
    if (thread.messages?.pageInfo?.hasNextPage) warnings.push('Only the first 20 message entries were inspected.');
    if (!messages.length) warnings.push('No customer message text was available; using thread description or preview.');
    if (source.length > 10000) warnings.push('Source text was truncated to 10000 characters.');
    return [{
      threadId: thread.id, customerId: thread.customer.id, marker, warnings,
      ticket: { ticketId: thread.id, subject: thread.title.slice(0, 10000), description: source.slice(0, 10000) || 'No description provided.', logs: '', impact: 'single_user' },
    }];
  });
}

function buildPlainNote(item, triageResult) {
  if (triageResult.statusCode !== 200) throw new Error('Ticket validation failed: ' + triageResult.result.error);
  const r = triageResult.result;
  const humanize = value => value.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const render = rich => {
    // Treat customer content as literal text, rather than note formatting or HTML.
    const literal = value => rich
      ? String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+\-.!|~]/g, '\\$&')
      : String(value);
    const heading = title => rich ? `**${title}**` : title;
    const bullets = values => values.map(value => '- ' + literal(value).replace(/\n/g, '\n  ')).join('\n');
    const field = (title, value) => `- ${heading(title + ':')} ${literal(value).replace(/\n/g, '\n  ')}`;
    const quote = value => rich ? literal(value).split('\n').map(line => '> ' + line).join('\n') : literal(value);
    const sections = [
      heading('Internal triage notes') + '\n\n' + [
        field('Category', humanize(r.category)),
        field('Suggested priority', humanize(r.priority)),
        field('Review', r.ticketType === 'technical' ? 'Human review required; findings are hypotheses.' : 'Human review required.'),
      ].join('\n'),
      heading('Reported issue') + '\n\n' + literal(r.ticket.subject) + '\n\n' + quote(r.ticket.description),
      heading('Findings') + '\n\n' + (r.findings.map(f =>
        '- ' + heading(humanize(f.category)) + ': ' + literal(f.hypothesis) + '\n' +
        f.evidence.map(e => '  - ' + heading('Evidence:') + ' ' + literal(e).replace(/\n/g, '\n    ')).join('\n')
      ).join('\n') || (r.ticketType === 'technical' ? '- No known error pattern matched.' : '- ' + literal('Classified as a ' + r.ticketType + ' support request.'))),
      heading('Investigation steps') + '\n\n' + bullets(r.nextSteps),
      heading('Escalation summary') + '\n\n' + [
        field('Issue', r.escalationSummary.issue),
        ...(r.ticketType === 'technical' ? [field('Customer impact', 'Unknown; priority uses the single-user default.')] : [field('Suggested team', r.ticketType === 'billing' ? 'Billing support' : 'Support')]),
        field('Escalation recommended', r.escalationSummary.escalationRecommended ? 'Yes' : 'No automatic recommendation; review after investigation.'),
      ].join('\n') + (r.escalationSummary.missingInformation.length ? '\n\n' + heading('Information still needed') + '\n\n' + bullets(r.escalationSummary.missingInformation) : ''),
      heading('Customer reply draft — review before sending') + '\n\n' + quote(r.customerReplyDraft),
      ...(item.warnings.length ? [heading('Input limitations') + '\n\n' + bullets(item.warnings)] : []),
    ];
    if (item.webResearch) {
      const research = item.webResearch;
      const context = 'Public documentation references from search snippets; supporting context, not confirmation of the root cause.';
      const evidence = research.status === 'found'
        ? research.results.map(result => {
          const url = result.url.replace(/[()]/g, c => c === '(' ? '%28' : '%29');
          const link = rich ? `[${literal(result.title)}](${url})` : `${result.title}: ${url}`;
          return '- ' + link;
        }).join('\n')
        : bullets([research.status === 'unavailable' ? 'Web search was unavailable; triage continued using ticket evidence.' : 'No usable documentation references were returned.']);
      sections.splice(3, 0, heading('Web research — supporting references') + '\n\n' + context + '\n\n' +
        field('Search query', research.query) + '\n' + field('Searched at', research.searchedAt) + '\n\n' + evidence);
    }
    if (item.researchSummary) {
      const summary = item.researchSummary;
      const cite = ids => ids.map(id => {
        const source = item.webResearch.results[Number(id.slice(1)) - 1];
        const url = source.url.replace(/[()]/g, c => c === '(' ? '%28' : '%29');
        return rich ? `[Source ${id.slice(1)}](${url})` : `Source ${id.slice(1)}: ${url}`;
      }).join(', ');
      const body = summary.status === 'ready'
        ? literal(summary.issueSummary) + '\n\n' + heading('What the sources suggest') + '\n\n' +
          (summary.interpretations.map(p => '- ' + literal(p.finding) + '\n  ' + literal(p.customerRelevance) + ' ' + cite(p.sourceIds)).join('\n') || '- The sources do not establish an explanation for this issue.') +
          '\n\n' + heading('Recommended checks for this issue') + '\n\n' +
          (summary.recommendedChecks.map(p => '- ' + literal(p.check) + '\n  ' + literal(p.reason) + (p.sourceIds.length ? ' ' + cite(p.sourceIds) : '')).join('\n') || '- Gather more ticket context before recommending specific changes.') +
          '\n\n' + heading('Uncertainty and gaps') + '\n\n' + bullets([...summary.limitations, 'AI-generated analysis of search snippets; human review is required.'])
        : bullets([summary.status === 'no_evidence' ? 'No usable search evidence was available to summarize.' : 'The issue-specific summary was unavailable or failed validation; the rule-based findings and source links remain available.']);
      sections.splice(2, 0, heading('Research summary for this issue') + '\n\n' + body);
    }
    return sections.join('\n\n');
  };
  // Keep the plain-text marker stable so existing notes still deduplicate.
  return { query: CREATE_NOTE, variables: { input: {
    threadId: item.threadId, customerId: item.customerId,
    text: item.marker + '\n' + render(false),
    markdown: render(true) + '\n\n' + '`' + item.marker + '`',
  } } };
}

function checkPlainWrite(response) {
  if (response.errors?.length) throw new Error('Plain mutation failed: ' + response.errors.map(e => e.message).join('; '));
  const result = response.data?.createNote;
  if (result?.error) throw new Error(`Plain write failed (${result.error.code}): ${result.error.message}`);
  if (!result?.note?.id) throw new Error('Plain did not confirm internal note creation.');
  return { status: 'triaged', noteId: result.note.id, visibility: 'internal' };
}

module.exports = { THREADS_QUERY, THREAD_QUERY, CREATE_NOTE, normalizePlainCreation, checkPlainOpeningMessage, preparePlainThread, preparePlainThreads, buildPlainNote, checkPlainWrite };
