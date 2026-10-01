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
    const warnings = ['Customer impact is unknown; priority is a suggestion using the single-user default.'];
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
  const sections = [
    item.marker,
    `INTERNAL TRIAGE NOTES — rules-v1\nCategory: ${r.category}\nSuggested priority: ${r.priority}\nHuman review required`,
    'Input limitations\n' + item.warnings.join('\n'),
    'Reported issue\n' + r.ticket.subject + '\n' + r.ticket.description,
    'Findings\n' + (r.findings.map(f => `${f.category}: ${f.hypothesis}\nEvidence: ${f.evidence.join('\n')}`).join('\n\n') || 'No known error pattern matched.'),
    'Investigation steps\n' + r.nextSteps.join('\n'),
    'Escalation summary\n' + JSON.stringify(r.escalationSummary, null, 2),
    'Customer reply draft — review before sending\n' + r.customerReplyDraft,
  ];
  // createNote is team-only. Plain text avoids interpreting customer Markdown.
  return { query: CREATE_NOTE, variables: { input: {
    threadId: item.threadId, customerId: item.customerId,
    text: sections.join('\n\n').replace(item.marker + '\n\n', item.marker + '\n'),
  } } };
}

function checkPlainWrite(response) {
  if (response.errors?.length) throw new Error('Plain mutation failed: ' + response.errors.map(e => e.message).join('; '));
  const result = response.data?.createNote;
  if (result?.error) throw new Error(`Plain write failed (${result.error.code}): ${result.error.message}`);
  if (!result?.note?.id) throw new Error('Plain did not confirm internal note creation.');
  return { status: 'triaged', noteId: result.note.id, visibility: 'internal' };
}

module.exports = { THREADS_QUERY, THREAD_QUERY, CREATE_NOTE, normalizePlainCreation, preparePlainThread, preparePlainThreads, buildPlainNote, checkPlainWrite };
