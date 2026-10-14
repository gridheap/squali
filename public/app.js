const $ = (s, root = document) => root.querySelector(s);
const state = { importPolls:0, importTimer:null, nativeImports:false, clerk: null, authUser: null, authGeneration: 0, githubRepos: [], githubNext: 1, imports: [], importStop: false, selectedChanges: null, token: '', session: null, projects: [], project: null, changes: [], overlaps: [], view: 'changes', search: '', filter: 'active' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = value => value ? value.slice(0, 8) : '—';
const tag = value => `<span class="badge ${escape(value)}">${escape(value)}</span>`;
const gate = text => `<span data-font-gated>${escape(text)}</span>`;
function status(message, error = false) { $('#status').textContent = message; $('#status').classList.toggle('error', error); }
async function api(path, body) {
  const generation = state.authGeneration;
  const token = state.clerk?.session ? await state.clerk.session.getToken() : state.token;
  const response = await fetch('/api' + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json();
  if (generation !== state.authGeneration) throw new Error('Account changed. Please try again.');
  if (!response.ok) { const error = new Error(value.message + (value.details ? '\n' + JSON.stringify(value.details) : '')); error.status = response.status; throw error; }
  return value;
}
const route = suffix => `/projects/${state.project.id}${suffix}`;
async function busy(button, fn) {
  if (button.disabled) return;
  const inDialog = $('#dialog').contains(button);
  if (inDialog) $('#dialog-close').disabled = true;
  button.disabled = true; button.setAttribute('aria-busy', 'true');
  try { await fn(); } catch (e) { status(e.message, true); const notice = $('#dialog-notice'); if (notice) notice.textContent = e.message; }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); if (inDialog) $('#dialog-close').disabled = false; }
}
function dialog(title, html) {
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = html + '<div id="dialog-notice" role="status" class="notice"></div>';
  for (const label of $('#dialog-body').querySelectorAll('label')) for (const child of [...label.childNodes]) {
    if (child.nodeType !== Node.TEXT_NODE || !child.textContent.trim()) continue;
    const text = document.createElement('span'); text.dataset.fontGated = ''; text.textContent = child.textContent; child.replaceWith(text);
  }
  if (!$('#dialog').open) $('#dialog').showModal();
}
const close = () => $('#dialog').close();
$('#dialog').addEventListener('cancel', e => { if ($('#dialog-close').disabled) e.preventDefault(); });
$('#dialog-close').onclick = close;
$('#dialog').addEventListener('click', e => { if (e.target === $('#dialog')) { const b = e.target.getBoundingClientRect(); if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) close(); } });
function connect() {
  dialog('Connect your workspace', `${state.clerk ? '<button class="button primary full-button" id="github-signin" aria-label="Continue with GitHub"><span aria-hidden="true">↗</span>'+gate('Continue with GitHub')+'</button><p class="muted" data-font-gated>Sign in to import your repositories. Agent access tokens remain available below.</p>' : ''}<form class="form connect-form" id="connect-form" inert><p class="muted" data-font-gated>Use a reviewer or agent token. It stays in memory for this tab and is cleared when you leave.</p><label>Access token<input name="token" type="password" autocomplete="off" required placeholder="Paste your access token" aria-label="Access token"></label><div class="form-actions"><button class="button primary" aria-label="Connect"><span aria-hidden="true">↗</span>${gate('Connect')}</button></div></form>`);
  if ($('#github-signin')) $('#github-signin').onclick = e => busy(e.currentTarget, () => state.clerk.redirectToSignIn({signInForceRedirectUrl:location.origin+'/?view=github',signUpForceRedirectUrl:location.origin+'/?view=github'}));
  const form = $('#connect-form');
  form.onsubmit = e => { e.preventDefault(); busy($('button', form), async () => { const previous = state.token; state.authGeneration++; state.token = form.elements.token.value; try { state.session = await api('/session'); } catch (e) { state.token = previous; throw e; } form.elements.token.value = ''; close(); $('#connection').textContent = '● ' + state.session.principal.role; $('#mode').textContent = state.session.mode; status('Connected as ' + state.session.principal.id); await loadProjects(); }); };
  form.inert = false;
}
$('#connect-open').onclick = connect;
async function loadProjects() {
  state.projects = (await api('/projects')).projects;
  $('#workspace').innerHTML = '<option value="">Select workspace</option>' + state.projects.map(p => `<option value="${escape(p.id)}">${escape(p.name)}</option>`).join('');
  state.project = state.projects.find(p => p.id === state.project?.id) ?? state.projects[0] ?? null;
  $('#workspace').value = state.project?.id ?? '';
  await refresh();
}
$('#workspace').onchange = async e => { state.selectedChanges = null; state.project = state.projects.find(p => p.id === e.target.value) ?? null; await refresh(); };
async function refresh() {
  if (state.project) {
    const [project, changes] = await Promise.all([api(route('')), api(route('/changes'))]);
    state.project = project; state.changes = changes.changes; state.overlaps = changes.overlaps;
  } else { state.changes = []; state.overlaps = []; }
  await render();
}
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => busy(button, async () => { state.view = button.dataset.view; await render(); });
function createWorkspace() {
  if (!state.session) return connect();
  dialog('New workspace', `<form class="form" id="workspace-form" inert><div class="form-row"><label>Workspace name<input name="name" required placeholder="Orbital SDK" aria-label="Workspace name"></label><label>Workspace ID<input name="id" required pattern="[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}" placeholder="orbital-sdk" aria-label="Workspace ID"></label></div><p class="muted" data-font-gated>Starts with a README. Agents can submit changes immediately.</p><div class="form-actions"><button class="button primary" aria-label="Create workspace">${gate('Create workspace')}</button></div></form>`);
  const form = $('#workspace-form'); form.onsubmit = e => { e.preventDefault(); busy($('button', form), async () => { const name = form.elements.name.value; const made = await api('/projects', { id: form.elements.id.value, name, files: [{ path: 'README.md', content: `# ${name}\n\nBuilt together with Squali.\n` }] }); state.project = made; close(); status('Workspace created'); await loadProjects(); }); }; form.inert = false;
}
$('#new-workspace').onclick = createWorkspace;
$('#review-policy').onclick = e => busy(e.currentTarget, managePolicy);
$('#agent-access').onclick = e => busy(e.currentTarget, manageAgents);
$('#new-change').onclick = () => compose();
function compose(existing) {
  if (!state.project) return;
  let edits = existing ? existing.diff.map(file => ({
    path: file.path, content: file.after,
    mode: existing.files.find(delta => delta.path === file.path)?.mode ?? '100644'
  })) : [{ path: 'src/client.ts', content: 'export const retries = 3;\n', mode: '100644' }];
  const immutable = existing ? 'readonly' : '';
  dialog(existing ? 'Resolve with a new revision' : 'Propose a change', `<form class="form" id="change-form" inert>
    <div class="form-row"><label>Change ID<input name="id" required value="change-${Date.now().toString(36)}"></label><label>Change title<input name="title" required ${immutable} value="${escape(existing?.title ?? '')}" placeholder="Add a retry-aware client"></label></div>
    <label>Intent<textarea name="intent" required ${immutable}>${escape(existing?.intent ?? '')}</textarea></label>
    <label>Dependencies<input name="dependencies" ${immutable} value="${escape(existing?.dependencies?.join(', ') ?? '')}" placeholder="Optional comma-separated change IDs"></label>
    <div id="file-editors"></div><button type="button" class="button" id="add-file" aria-label="Add file"><span aria-hidden="true">＋</span>${gate('Add file')}</button>
    <label>Context / evidence (JSON)<textarea name="context" spellcheck="false" ${immutable}>${escape(JSON.stringify(existing?.context ?? { prompt: '', evidence: [] }, null, 2))}</textarea></label>
    ${existing ? '<p class="notice">Original intent, context and dependencies are retained. Edit the complete set of file changes below; removing a file explicitly drops that edit from the revision.</p><label>Resolution note<input name="note" required></label>' : ''}
    <div class="form-actions"><button class="button primary" aria-label="Submit change"><span aria-hidden="true">↑</span>${gate(existing ? 'Create revision' : 'Submit change')}</button></div></form>`);
  const form = $('#change-form');
  const collect = () => [...form.querySelectorAll('[data-file-editor]')].map(row => ({
    path: $('[data-file-path]', row).value,
    content: $('[data-file-action]', row).value === 'delete' ? null : $('[data-file-content]', row).value,
    mode: $('[data-file-mode]', row).value
  }));
  function renderEditors() {
    $('#file-editors').innerHTML = edits.map((file, i) => `<fieldset class="file-editor" data-file-editor>
      <legend data-font-gated>File ${i + 1}</legend><div class="form-row"><label><span data-font-gated>Path</span><input data-file-path required aria-label="File path ${i + 1}" value="${escape(file.path)}"></label>
      <label><span data-font-gated>Action</span><select data-file-action aria-label="File action ${i + 1}"><option value="write" ${file.content !== null ? 'selected' : ''}>Write file</option><option value="delete" ${file.content === null ? 'selected' : ''}>Delete file</option></select></label></div>
      <label data-content-label ${file.content === null ? 'hidden' : ''}><span data-font-gated>Content</span><textarea data-file-content spellcheck="false" class="code-input" aria-label="File content ${i + 1}">${escape(file.content ?? '')}</textarea></label>
      <div class="form-row"><label><span data-font-gated>Mode</span><select data-file-mode aria-label="File mode ${i + 1}"><option value="100644" ${file.mode === '100644' ? 'selected' : ''}>Regular file</option><option value="100755" ${file.mode === '100755' ? 'selected' : ''}>Executable file</option></select></label>
      <button type="button" class="button" data-remove-file="${i}" aria-label="Remove file ${i + 1}" ${edits.length === 1 ? 'disabled' : ''}><span aria-hidden="true">×</span>${gate('Remove this edit')}</button></div></fieldset>`).join('');
    for (const row of form.querySelectorAll('[data-file-editor]')) $('[data-file-action]', row).onchange = e => { $('[data-content-label]', row).hidden = e.target.value === 'delete'; };
    for (const button of form.querySelectorAll('[data-remove-file]')) button.onclick = () => { edits = collect(); edits.splice(Number(button.dataset.removeFile), 1); renderEditors(); };
    $('#add-file').disabled = edits.length >= 64;
  }
  $('#add-file').onclick = () => { edits = collect(); edits.push({ path: '', content: '', mode: '100644' }); renderEditors(); };
  renderEditors();
  form.onsubmit = e => { e.preventDefault(); busy($('button[type="submit"], button[aria-label="Submit change"]', form), async () => {
    const f = form.elements; const files = collect();
    if (existing) await api(route(`/changes/${existing.id}/revise`), { id: f.id.value, files, note: f.note.value });
    else await api(route('/changes'), { id: f.id.value, title: f.title.value, intent: f.intent.value, context: JSON.parse(f.context.value), dependencies: f.dependencies.value.split(',').map(s => s.trim()).filter(Boolean), base: state.project.head, files });
    close(); await refresh(); status('Change submitted for review');
  }); }; form.inert = false;
}

async function details(cid) {
  const c = await api(route(`/changes/${cid}`));
  dialog(c.title, `<div class="detail-summary">${tag(c.status)}<span class="mono muted">${escape(c.author)} / ${short(c.oid)}</span><span class="muted">base ${short(c.base)}</span></div><h3 data-font-gated>Intent</h3><p class="muted intent-copy">${escape(c.intent)}</p><h3 data-font-gated>Context carried forward</h3><pre class="context">${escape(JSON.stringify(c.context, null, 2))}</pre>${c.dependencies.length ? `<p class="muted">Depends on: ${escape(c.dependencies.join(', '))}</p>` : ''}${c.diff.map(f => `<div class="diff"><div class="diff-title">${escape(f.path)}</div><div class="diff-columns"><pre aria-label="Before">${escape(f.before ?? '(new file)')}</pre><pre aria-label="After">${escape(f.after ?? '(deleted)')}</pre></div></div>`).join('')}<div class="review-actions">${['proposed', 'approved', 'rejected'].includes(c.status) ? `<button class="button primary" id="approve" aria-label="Approve change">${gate('Approve change')}</button><button class="button danger" id="reject" aria-label="Reject change">${gate('Request revision')}</button><button class="button" id="revise" aria-label="Revise change">${gate('Resolve / revise')}</button>` : ''}</div>`);
  for (const [selector, decision] of [['#approve', 'approved'], ['#reject', 'rejected']]) if ($(selector)) $(selector).onclick = e => busy(e.currentTarget, async () => { await api(route(`/changes/${cid}/review`), { decision, note: 'Reviewed through Squali' }); status(decision === 'approved' ? 'Approval recorded for this immutable version' : 'Revision requested'); await refresh(); await details(cid); });
  if ($('#revise')) $('#revise').onclick = () => compose(c);
}
async function preview() {
  const changes = state.changes.filter(c => c.status === 'approved' && (!state.selectedChanges || state.selectedChanges.has(c.id))).map(c => c.id);
  if (!changes.length) { status('Approve at least one change before preparing a batch.', true); return; }
  const plan = await api(route('/preview'), { changes });
  dialog(plan.ready ? 'Ready to publish' : 'Conflicts need a decision', `<p class="muted">${plan.changes.length} changes · ${plan.files.length} files · target <code>${short(plan.head)}</code></p>${plan.conflicts.map(c => `<div class="conflict-item"><strong>${escape(c.path)}</strong><p>${escape(c.reason)}</p><button class="button small conflict-open" data-id="${escape(c.change)}">Review ${escape(c.change)}</button></div>`).join('')}<div class="context">${plan.changes.map(escape).join('\n')}</div><div class="callout">${plan.ready ? 'The batch is compatible. Publishing verifies the current main version again and updates it atomically.' : 'Source and intent are preserved. Create a revision against the current main, then review the new version.'}</div>${plan.ready ? '<div class="form-actions"><button class="button primary" id="publish" aria-label="Publish batch">Publish batch ↗</button></div>' : ''}`);
  for (const b of document.querySelectorAll('.conflict-open')) b.onclick = () => details(b.dataset.id);
  if ($('#publish')) {
    const publicationId = 'batch-' + crypto.randomUUID();
    $('#publish').onclick = e => busy(e.currentTarget, async () => { const result = await api(route('/publish'), { id: publicationId, changes, expectedHead: plan.head }); close(); await refresh(); status(`Published ${result.changes.length} changes · ${short(result.oid)} · ${result.metrics.bytes.toLocaleString()} bytes uploaded`); });
  }
}
async function render() {
  document.querySelectorAll('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $('#crumb').textContent = state.project?.name ?? 'Overview';
  $('#review-policy').hidden = !state.project || state.session?.principal.role !== 'admin';
  $('#agent-access').hidden = !state.project || !state.session?.principal.owner;
  $('#new-change').hidden = !state.project || state.view !== 'changes';
  $('#nav-count').textContent = state.changes.filter(c => ['proposed', 'approved'].includes(c.status)).length;
  $('#page-title').textContent = state.view === 'github' ? 'Bring your work to Squali.' : state.view === 'cost' ? 'Cost & limits' : state.view === 'history' ? 'A history of shared progress.' : state.view === 'source' ? 'Read only what you need.' : state.project?.name ?? 'Your next shared direction.';
  $('#subtitle').textContent = state.view === 'cost' ? 'Bound the work. Measure the result. Keep the cost visible.' : state.view === 'history' ? 'Every publication preserves its changes, decisions, and context.' : state.view === 'source' ? 'Browse immutable source without cloning the repository.' : state.project ? 'Independent changes, brought together with intent.' : 'A home for agent changes, context, and the decisions that connect them.';
  if (state.view === 'github') return renderGitHub();
  if (state.view === 'cost') return renderCost();
  if (!state.project) { $('#content').innerHTML = `<div class="welcome"><div><h2 data-font-gated>More agents.<br>One shared direction.</h2><p data-font-gated>Give each agent space to work. Keep the context. Review the changes that matter, then bring compatible work together.</p><div class="review-actions"><button class="button primary" id="start">${gate(state.session ? 'Create your first workspace' : 'Connect your workspace')} <span aria-hidden="true">↗</span></button></div></div><div class="welcome-diagram" aria-hidden="true"><div class="diagram-lane"><span>agent / docs</span>immutable change</div><div class="diagram-lane"><span>agent / client</span>immutable change</div><div class="diagram-lane"><span>agent / tests</span>immutable change</div><div class="diagram-result">Review → reconcile → publish together</div></div></div>`; $('#start').onclick = state.session ? createWorkspace : connect; return; }
  if (state.view === 'source') return renderSource();
  if (state.view === 'history') {
    const [history, activity] = await Promise.all([api(route('/publications')), api(route('/events'))]);
    $('#content').innerHTML = `<div class="content-grid"><section class="panel"><div class="panel-head"><h2>Published batches</h2><span class="muted">${history.publications.length} batches</span></div><div class="panel-body">${history.publications.length ? history.publications.map(p => `<div class="event"><strong>${escape(p.id)}</strong> ${tag(p.state)}<small class="mono">${short(p.base)} → ${short(p.oid)} · ${p.changes.length} changes</small><small>${escape(p.changes.join(', '))}</small></div>`).join('') : '<p class="muted">No publications yet.</p>'}</div></section><aside class="panel"><div class="panel-head"><h2>Activity</h2></div><div class="panel-body">${activity.events.slice(-20).reverse().map(e => `<div class="event">${escape(e.kind)}<small>${escape(e.actor)} · ${escape(e.data.id)}</small></div>`).join('')}</div></aside></div>`; return;
  }
  renderChanges();
}
function renderChanges() {
  const active = state.changes.filter(c => ['proposed', 'approved'].includes(c.status));
  const approved = state.changes.filter(c => c.status === 'approved');
  const landed = state.changes.filter(c => c.status === 'landed');
  const authors = new Set(state.changes.map(c => c.author)).size;
  $('#content').innerHTML = `<div class="stats">${[['Active changes', active.length, 'Independent work in progress', ''], ['Ready for review', active.filter(c => c.status === 'proposed').length, 'Intent and evidence attached', ''], ['Approved', approved.length, 'Ready for a compatibility check', 'green'], ['Landed', landed.length, 'Preserved in source history', '']].map(([label, value, note, color]) => `<div class="stat"><div class="stat-label" data-font-gated>${label}<span>↗</span></div><div class="stat-value ${color}" data-font-gated>${value}</div><div class="stat-note" data-font-gated>${note}</div></div>`).join('')}</div><div class="content-grid"><section class="panel"><div class="panel-head"><h2 data-font-gated>Change workspace <small> / ${state.changes.length}</small></h2><button class="button small" id="refresh" aria-label="Refresh"><span aria-hidden="true">↻</span>${gate('Refresh')}</button></div><div class="toolbar"><input class="search" placeholder="⌕  Search changes, intent, or agent…" aria-label="Search changes" value="${escape(state.search)}"><select class="filter" aria-label="Filter changes"><option value="active">Active changes</option><option value="all">All changes</option><option value="landed">Landed</option></select></div><div id="change-list"></div></section><div class="side-stack"><aside class="panel"><div class="panel-body"><div class="aside-title" data-font-gated>THE NEXT SHARED STEP</div><h3 data-font-gated>Bring good changes together.</h3><div class="flow" aria-hidden="true"><div class="flow-node">⌘</div><div class="flow-line"></div><div class="flow-node">✓</div><div class="flow-line"></div><div class="flow-node">↗</div></div><p class="muted" data-font-gated>Squali checks approved changes against main and each other before publishing.</p><div class="aside-divider"></div><div class="detail-list"><span data-font-gated>Approved</span><strong>${approved.length} changes</strong></div><div class="detail-list"><span data-font-gated>Shared paths</span><strong>${state.overlaps.length}</strong></div><button class="button primary full-button" id="preview" aria-label="Preview batch">${gate('Preview batch')} <span aria-hidden="true">→</span></button></div></aside><aside class="panel"><div class="panel-body"><div class="aside-title" data-font-gated>WORKSPACE SIGNALS</div><div class="detail-list"><span data-font-gated>Contributors</span><strong>${authors}</strong></div><div class="detail-list"><span data-font-gated>Main</span><code>${short(state.project.head)}</code></div><div class="detail-list"><span data-font-gated>Conflict policy</span><strong>Review required</strong></div><div class="aside-divider"></div><p class="muted" data-font-gated>Source, decisions, and agent context stay with each reviewed change.</p></div></aside></div></div>`;
  $('.filter').value = state.filter; $('.filter').onchange = e => { state.filter = e.target.value; renderRows(); };
  $('.search').oninput = e => { state.search = e.target.value; renderRows(); };
  $('#refresh').onclick = e => busy(e.currentTarget, refresh); $('#preview').onclick = e => busy(e.currentTarget, preview); renderRows();
}
function renderRows() {
  const rows = state.changes.filter(c => (state.filter === 'all' || (state.filter === 'active' ? ['proposed', 'approved', 'rejected'].includes(c.status) : c.status === 'landed')) && `${c.title} ${c.intent} ${c.author}`.toLowerCase().includes(state.search.toLowerCase()));
  $('#change-list').innerHTML = rows.length ? rows.map(c => `<div class="change-row">${c.status === 'approved' ? `<input type="checkbox" data-include="${escape(c.id)}" aria-label="Include ${escape(c.title)}" ${!state.selectedChanges || state.selectedChanges.has(c.id) ? 'checked' : ''}>` : `<div class="avatar" aria-hidden="true">${escape(c.author.slice(0, 2).toUpperCase())}</div>`}<div><button class="change-title" data-change="${escape(c.id)}">${escape(c.title)}</button><div class="change-meta"><span>${escape(c.author)}</span><span>·</span><span>${c.files.length} files</span><span class="mono">${short(c.oid)}</span>${state.overlaps.some(o => o.left_id === c.id || o.right_id === c.id) ? '<span class="overlap-label">Shared path</span>' : ''}</div></div>${tag(c.status)}</div>`).join('') : '<div class="empty"><div class="empty-symbol" aria-hidden="true">⌘</div><h2 data-font-gated>Space for the next idea.</h2><p data-font-gated>No changes in this view. Submit a change through the API or create one above.</p></div>';
  for (const input of document.querySelectorAll('[data-include]')) input.onchange = () => { if (!state.selectedChanges) state.selectedChanges = new Set(state.changes.filter(c => c.status === 'approved').map(c => c.id)); if (input.checked) state.selectedChanges.add(input.dataset.include); else state.selectedChanges.delete(input.dataset.include); };
  for (const b of document.querySelectorAll('[data-change]')) b.onclick = () => busy(b, () => details(b.dataset.change));
}
async function openSourceFile(path, ref) {
  const file = await api(route('/file?ref='+ref+'&path='+encodeURIComponent(path)));
  dialog(file.path, `<p class="muted mono">${file.oid}</p><div class="review-actions"><button class="button" id="file-history" aria-label="File history">${gate('File history')}</button><button class="button" id="file-blame" aria-label="Blame lines">${gate('Blame lines')}</button></div><pre class="context">${escape(file.content)}</pre>`);
  $('#file-blame').onclick = e => busy(e.currentTarget, async () => {const result = await api(route('/blame?ref='+ref+'&path='+encodeURIComponent(path)));dialog('Blame · '+path, `<div class="context">${result.lines.map((line,i)=>`<div><code>${i+1} · ${short(line.commit)}:${line.originalLine}</code> <span>${escape(line.text)}</span></div>`).join('')}</div>`);});
  $('#file-history').onclick = e => busy(e.currentTarget, async () => {const result = await api(route('/path-history?ref='+ref+'&path='+encodeURIComponent(path)));dialog('History · '+path, `<p class="muted">First-parent history · ${result.next ? 'More history is available through the paginated API.' : 'Beginning of history reached.'}</p>${result.commits.map(c=>`<div class="event"><code>${short(c.oid)}</code><p>${escape(c.message)}</p><button class="button" data-source-ref="${c.oid}">Open this version</button></div>`).join('')}`);for(const button of document.querySelectorAll('[data-source-ref]'))button.onclick=()=>openSourceFile(path,button.dataset.sourceRef);});
}
async function renderSource(path = '') {
  const result = await api(route('/tree?path=' + encodeURIComponent(path)));
  $('#content').innerHTML = `<section class="panel"><div class="panel-head"><h2 data-font-gated>Source / ${escape(path || '/')}</h2><code class="muted">${short(result.ref)}</code></div><form class="form panel-body" id="source-search" inert><label>Search repository paths<input name="query" aria-label="Search repository paths" maxlength="128" placeholder="File or directory name"></label><button class="button" aria-label="Find paths"><span aria-hidden="true">⌕</span>${gate('Find paths')}</button><div class="notice" role="status" id="source-feedback"></div></form><div id="source-entries">${path ? '<button class="source-row" id="source-back">↑ Parent directory</button>' : ''}${result.entries.map(e => `<button class="source-row" data-path="${escape(path ? path + '/' + e.name : e.name)}" data-type="${e.type}" aria-label="Open ${escape(path ? path + '/' + e.name : e.name)}"><span data-font-gated>${e.type === 'tree' ? '▧' : '≡'} ${escape(e.name)}</span><code class="muted">${short(e.oid)}</code></button>`).join('')}</div></section>`;
  if ($('#source-back')) $('#source-back').onclick = () => renderSource(path.split('/').slice(0, -1).join('/'));
  const bind = () => {for(const b of document.querySelectorAll('[data-path]'))b.onclick=()=>busy(b,()=>b.dataset.type==='tree'?renderSource(b.dataset.path):openSourceFile(b.dataset.path,result.ref));};bind();
  const form=$('#source-search');form.onsubmit=e=>{e.preventDefault();busy($('button',form),async()=>{const found=await api(route('/search?ref='+result.ref+'&path='+encodeURIComponent(path)+'&query='+encodeURIComponent(form.elements.query.value)));$('#source-feedback').textContent=found.matches.length+' matching paths'+(found.next?' · Refine the query or use the API cursor for more.':'');$('#source-entries').innerHTML=found.matches.map(f=>`<button class="source-row" data-path="${escape(f.path)}" data-type="blob" aria-label="Open ${escape(f.path)}"><span data-font-gated>${escape(f.path)}</span><code>${short(f.oid)}</code></button>`).join('');bind();});};form.inert=false;
}
async function managePolicy() {
 const policy=await api(route('/policy'));
 dialog('Review policy', `<p class="muted" data-font-gated>Rules apply to file or directory prefixes. Independent review requires a different principal. Evidence is supplied by the agent and must be assessed by the reviewer.</p><form class="form" id="policy-form" inert><label>Review rules (JSON)<textarea name="rules" aria-label="Review rules (JSON)" rows="10">${escape(JSON.stringify(policy.rules,null,2))}</textarea></label><p class="muted" data-font-gated>Each rule has prefix, independentReview and requireEvidence. Optional semantic constraints: javascript-comments preserves the JavaScript syntax tree and tool directives; json-values preserves JSON values. Saving requires affected changes to be reviewed again.</p><button class="button primary" aria-label="Save review policy">${gate('Save review policy')}</button></form>`);
 const form=$('#policy-form');form.onsubmit=e=>{e.preventDefault();busy($('button',form),async()=>{await api(route('/policy'),{rules:JSON.parse(form.elements.rules.value)});close();status('Review policy saved');});};form.inert=false;
}
async function renderCost() {
  const usage = state.session ? await api('/usage') : null;
  const measured = usage ? `<section class="panel usage-panel"><div class="panel-body"><h2 data-font-gated>Reserved operations this month</h2><p class="cost-number"><span data-testid="usage-attempts">${Number(usage.attempts).toLocaleString()}</span> / <span data-testid="usage-cap">${Number(usage.cap).toLocaleString()}</span></p><p class="muted" data-font-gated>${Math.max(0, usage.cap - usage.attempts).toLocaleString()} reservations remaining · ${escape(usage.mode)}</p><p class="muted" data-font-gated>A conservative application counter. Failed and uncertain attempts count; this is not the provider’s measured bill.</p>${usage.source?`<h3 data-font-gated>Authoritative R2 content</h3><p class="notice"><span data-testid="source-reads">${Number(usage.source.reads).toLocaleString()}</span> reads / ${Number(usage.source.readCap??0).toLocaleString()} cap · <span data-testid="source-writes">${Number(usage.source.writes).toLocaleString()}</span> writes / ${Number(usage.source.writeCap??0).toLocaleString()} cap</p><p class="muted" data-font-gated>Source blobs have no expiry. Git packs are compatibility copies; proposals do not create Git refs.</p>`:''}${usage.cache?`<p class="muted" data-font-gated>Shared cache reservations: ${Number(usage.cache.reservedReads).toLocaleString()} reads / ${usage.cache.readCap??'local'} limit · ${Number(usage.cache.reservedWrites).toLocaleString()} writes / ${usage.cache.writeCap??'local'} limit. Immutable entries expire after seven days.</p>`:''}</div></section>` : '<p class="notice">Connect to see this deployment’s usage and remaining allowance.</p>';
  $('#content').innerHTML = `${measured}<div class="cost-grid">${[['R2 source storage', '$0.015', 'per GB-month of Standard storage, before any shared free allowance.'], ['Git compatibility', '$0.50', 'Artifacts storage per GB-month above its allowance; $0.15 per 1,000 operations above its allowance.'], ['Coordination', 'PostgreSQL', 'Reuses durable SQL. No D1. No application Durable Objects.']].map(([title, value, note]) => `<section class="panel"><div class="panel-body"><div class="aside-title" data-font-gated>${title}</div><div class="cost-number" data-font-gated>${value}</div><p class="muted" data-font-gated>${note}</p></div></section>`).join('')}</div><section class="cost-details"><h2 data-font-gated>Bounded by design</h2><p data-font-gated>Separate persistent monthly caps bound source R2 reads, writes, the disposable cache and Artifacts calls. Failed and uncertain calls consume the cap. Writes use immutable operation IDs; retries reuse successful results.</p><p data-font-gated>At most 64 changed files, 256 KiB per editable file, 1 MiB per change, 32 dependencies, and 64 changes per publication. Text reconciliation is bounded to 2,000 lines per input and 12,000 lines per batch.</p><p data-font-gated>Source workspaces store independent compressed blobs in R2 and changesets in PostgreSQL. Artifacts limits each derived Git repository to 1 GB. Initial native imports admit up to 500,000 objects and 16 GiB of expanded content; large Git compatibility copies remain subject to the provider limit.</p><p data-font-gated>R2 Standard requests cost $4.50 per million writes and $0.36 per million reads before any shared free allowance. Workers Paid, PostgreSQL hosting, backup, network, and native-worker CPU charges are additional. These are provider list prices, not measured deployment costs.</p><a href="https://developers.cloudflare.com/artifacts/platform/pricing/" target="_blank" rel="noopener">Artifacts pricing ↗</a> · <a href="https://developers.cloudflare.com/r2/pricing/" target="_blank" rel="noopener">R2 pricing · checked October 15, 2026 ↗</a></section>`;
}
await render();
await initIdentity();
if (!state.session) connect();

async function initIdentity() {
  try {
    const {publishableKey,nativeImports} = await fetch('/api/auth/config').then(r => r.json()); state.nativeImports=!!nativeImports;
    if (!publishableKey) return;
    $('#github-nav').hidden = false;
    const domain = atob(publishableKey.replace(/^pk_(live|test)_/, '')).replace(/\$$/, '');
    if (!/^[\w.-]+$/.test(domain)) throw new Error('Invalid sign-in configuration');
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = `https://${domain}/npm/@clerk/clerk-js@6.39.0/dist/clerk.browser.js`; script.crossOrigin = 'anonymous'; script.dataset.clerkPublishableKey = publishableKey;
      const timer = setTimeout(() => { script.remove(); reject(new Error('GitHub sign-in is taking too long. Reload to retry, or use an agent token.')); }, 12000);
      script.onload = () => { clearTimeout(timer); resolve(); }; script.onerror = () => { clearTimeout(timer); reject(new Error('GitHub sign-in could not load. Reload to retry.')); }; document.head.append(script);
    });
    await window.Clerk.load(); state.clerk = window.Clerk;
    async function accountChanged({user}) {
      if ((user?.id ?? null) === state.authUser) return;
      state.selectedChanges = null; state.authUser = user?.id ?? null; state.authGeneration++; state.token = ''; state.session = null; state.project = null; state.projects = []; state.changes = []; state.overlaps = []; state.githubRepos = []; state.githubNext = 1; state.imports = []; state.importStop = true;
      $('#workspace').innerHTML = '<option value="">Select workspace</option>'; $('#sign-out').hidden = !user; $('#connect-open').hidden = !!user;
      $('#content').replaceChildren(); $('#dialog-body').replaceChildren(); close(); $('#connection').textContent = user ? '● Connecting' : '● Disconnected';
      if (user) {
        state.session = await api('/session'); state.view = 'github'; close(); $('#connection').textContent = '● GitHub'; $('#mode').textContent = state.session.mode; await loadProjects(); status('Signed in with GitHub');
      } else { state.view = 'changes'; await render(); status('Signed out'); connect(); }
    }
    state.clerk.addListener(value => accountChanged(value).catch(e => status(e.message, true)));
    await accountChanged({user:state.clerk.user});
    $('#sign-out').onclick = e => busy(e.currentTarget, () => state.clerk.signOut());
  } catch (e) { status(e.message, true); }
}
async function fetchGitHubPage() {
  if (state.githubNext === null) return;
  const result = await api('/github/repositories?page=' + state.githubNext);
  const repos = new Map(state.githubRepos.map(r => [r.id, r]));
  for (const repo of result.repositories) repos.set(repo.id, repo);
  state.githubRepos = [...repos.values()]; state.githubNext = result.nextPage;
  if (result.truncated) throw new Error('Repository discovery reached its 10,000-repository safety limit. Import this selection first.');
}
async function renderGitHub() {
  if (!state.session?.principal.owner) {
    $('#content').innerHTML = '<section class="panel"><div class="panel-body"><h2 data-font-gated>Your repositories, ready for agents.</h2><p class="muted" data-font-gated>Sign in with GitHub to choose repositories or import them all into private Squali workspaces.</p><button class="button primary" id="github-connect" aria-label="Sign in to import"><span aria-hidden="true">↗</span>'+gate('Sign in to import')+'</button></div></section>';
    $('#github-connect').onclick = connect; return;
  }
  const account = state.clerk.user?.externalAccounts?.find(a => a.provider === 'github' || a.provider === 'oauth_github');
  if (!account?.approvedScopes?.split(/[ ,]+/).includes('repo')) {
    $('#content').innerHTML = '<section class="panel"><div class="panel-body"><h2 data-font-gated>Choose when to connect your repositories.</h2><p class="muted" data-font-gated>You are signed in. Repository access is optional until you want to import. GitHub’s repo permission covers public and private repositories and includes write access; Squali only reads from GitHub.</p><button class="button primary" id="github-authorize" aria-label="Grant repository access"><span aria-hidden="true">↗</span>'+gate('Grant repository access')+'</button><div class="notice" role="status" id="github-permission-status"></div></div></section>';
    $('#github-authorize').onclick = e => busy(e.currentTarget, async () => {
      if (!account) throw new Error('Sign in with GitHub to connect your repositories.');
      $('#github-permission-status').textContent = 'Opening GitHub’s permission screen…';
      try {
        const updated = await account.reauthorize({additionalScopes:['repo'],redirectUrl:location.origin+'/?view=github'});
        const url = updated.verification?.externalVerificationRedirectURL;
        if (!url) throw new Error('GitHub did not return an authorization URL. Try signing in again.');
        location.assign(url.href);
      } catch (error) { $('#github-permission-status').textContent = error.message; throw error; }
    });
    return;
  }
  if (!state.githubRepos.length && state.githubNext) await fetchGitHubPage();
  state.imports = (await api('/github/imports')).imports;
  const imported = new Map(state.imports.map(row => [row.repositoryId, row]));
  $('#content').innerHTML = `<section class="panel"><div class="panel-head"><h2 data-font-gated>GitHub repositories <small>/ ${state.githubRepos.length}${state.githubNext ? '+' : ''}</small></h2></div><div class="panel-body"><p class="muted" data-font-gated>Import independent private copies, including Git history, branches, and tags. GitHub stays unchanged. Only repositories authorized by GitHub are listed.</p><p class="muted" data-font-gated>Git LFS file payloads and submodule repositories are not copied. Their pointers and links remain in Git. ${state.nativeImports?'Native imports: up to 2 GiB of Git storage, 500,000 objects, and 16 GiB of expanded content.':'Legacy imports: up to 512 MiB per transfer.'} Workspace and monthly operation caps also apply.</p><div class="import-actions"><button class="button primary" id="import-all" aria-label="Import all repositories"><span aria-hidden="true">↙</span>${gate('Import all repositories')}</button><button class="button" id="import-selected" aria-label="Import selected"><span aria-hidden="true">＋</span>${gate('Import selected')}</button><button class="button" id="import-resume" aria-label="Resume pending imports"><span aria-hidden="true">↻</span>${gate('Resume pending')}</button><button class="button" id="import-pause" aria-label="Pause imports"><span aria-hidden="true">Ⅱ</span>${gate('Pause')}</button></div><div id="import-progress" role="status" class="notice">${state.imports.filter(r => r.state === 'complete').length} complete · ${state.imports.filter(r => r.state !== 'complete').length} pending</div></div><div class="repository-list">${state.githubRepos.map(repo => { const job = imported.get(repo.id); return `<label class="repository-row"><input type="checkbox" value="${repo.id}" aria-label="Select ${escape(repo.full_name)}" ${job?.state === 'complete' ? 'disabled' : ''}><span><strong data-font-gated>${escape(repo.full_name)}</strong><span class="muted repository-meta" data-font-gated>${repo.private ? 'Private' : 'Public'} · ${escape(repo.default_branch || 'Empty')} · ${Number(repo.size).toLocaleString()} KiB</span>${job?.error ? `<span class="notice error">${escape(job.error)}</span>` : ''}</span>${tag(job?.state ?? 'available')}</label>`; }).join('')}</div>${state.githubNext ? '<div class="panel-body"><button class="button" id="github-more" aria-label="Load more repositories">↓ '+gate('Load more')+'</button></div>' : ''}</section>`;
  for(const job of state.imports){const row=[...document.querySelectorAll('.repository-row')].find(element=>element.querySelector('input')?.value===String(job.repositoryId));if(!row)continue;row.dataset.importId=job.id;const detail=document.createElement('span');detail.className='repository-meta notice import-detail';row.querySelector('strong').parentElement.append(detail);}
  updateImportProgress();scheduleImportPoll();
  if ($('#github-more')) $('#github-more').onclick = e => busy(e.currentTarget, async () => { await fetchGitHubPage(); await renderGitHub(); });
  const enqueue = async all => {
    if (all) while (state.githubNext) { await fetchGitHubPage(); if (state.githubRepos.length > 1000) throw new Error('Choose up to 1,000 repositories for this import batch.'); }
    const ids = all ? state.githubRepos.map(r => r.id) : [...document.querySelectorAll('.repository-row input:checked')].map(input => Number(input.value));
    if (!ids.length) throw new Error('Select at least one repository.');
    await api('/github/imports', {repositoryIds:ids}); await continueImports();
  };
  $('#import-all').onclick = e => busy(e.currentTarget, () => enqueue(true));
  $('#import-selected').onclick = e => busy(e.currentTarget, () => enqueue(false));
  $('#import-resume').onclick = e => busy(e.currentTarget, continueImports);
  $('#import-pause').onclick = e => busy(e.currentTarget,async()=>{state.importStop=true;clearTimeout(state.importTimer);const rows=(await api('/github/imports')).imports;for(const row of rows.filter(r=>r.engine==='source'&&['queued','running','pausing'].includes(r.state)))await api('/github/imports/'+row.id+'/pause',{});await renderGitHub();status(state.imports.some(r=>r.state==='pausing')?'Pausing. Uploaded objects and native Git cache will be saved.':'Paused. Uploaded objects and native Git cache are saved.');});
}
function updateImportProgress(){
 const summary=$('#import-progress');if(!summary)return;
 const completed=state.imports.filter(r=>r.state==='complete').length;summary.textContent=`${completed} complete · ${state.imports.length-completed} pending`;
 for(const job of state.imports){const row=document.querySelector(`[data-import-id="${job.id}"]`);if(!row)continue;const detail=row.querySelector('.import-detail'),badge=row.querySelector('.badge'),p=job.progress;badge.textContent=job.state;detail.textContent=job.engine==='source'?`${p?.stage??job.state}${p?.sourceObjects?' · '+Number(p.objectsProcessed??0).toLocaleString()+' / '+Number(p.sourceObjects).toLocaleString()+' objects':''}${p?.commitsProcessed?' · '+Number(p.commitsProcessed).toLocaleString()+' changesets':''} · Native attempts: ${job.nativeAttempts} / 3`:`Transfer attempts: ${job.attempts} / 3`;if(job.state==='complete')row.querySelector('input').disabled=true;}
}
function scheduleImportPoll(){
 clearTimeout(state.importTimer);
 if(state.view!=='github'||document.hidden||state.importPolls>=240||!state.imports.some(r=>r.engine==='source'&&['queued','running','pausing'].includes(r.state)))return;
 const generation=state.authGeneration;state.importTimer=setTimeout(async()=>{if(state.view!=='github'||document.hidden||generation!==state.authGeneration)return;try{state.importPolls++;const value=await api('/github/imports');if(generation!==state.authGeneration)return;state.imports=value.imports;updateImportProgress();scheduleImportPoll();}catch(error){status(error.message,true);}},15000);
}
document.addEventListener('visibilitychange',scheduleImportPoll);
async function continueImports() {
  if (state.importRunning) return;
  state.importRunning = true; state.importStop = false;
  const generation = state.authGeneration; let pauseReason = '';
  try {
    const rows = (await api('/github/imports')).imports;
    for (const row of rows) {
      if (state.importStop || generation !== state.authGeneration) break;
      if (row.state === 'complete' || (row.engine==='source'||state.nativeImports ? row.nativeAttempts>=3 : row.attempts>=3)) continue;
      status('Importing ' + row.repository + '…'); const progress = $('#import-progress'); if (progress) progress.textContent = 'Importing ' + row.repository + '…';
      try { await api('/github/imports/' + row.id + '/run', {}); }
      catch (e) { status(row.repository + ': ' + e.message, true); if ([403,409,429].includes(e.status)) { pauseReason = e.message; state.importStop = true; break; } }
    }
    if (generation !== state.authGeneration) return;
    await loadProjects();
    const rowsNow = (await api('/github/imports')).imports; const pending = rowsNow.filter(r => r.state !== 'complete').length; const complete = rowsNow.length - pending;
    status(pending ? `${complete} repositories imported. ${pending} pending. ${rowsNow.some(r=>r.engine==='source'&&['queued','running'].includes(r.state))?'Background imports continue when you close this page.':'Progress is saved.'}${pauseReason ? ' '+pauseReason : ''}` : `${complete} repositories imported. No pending imports.`);
  } finally { state.importRunning = false; }
}

async function manageAgents() {
  const {tokens} = await api(route('/tokens'));
  dialog('Agent access', `<p class="muted" data-font-gated>Create a credential for this workspace only. An agent can propose changes; a reviewer can approve and publish. Expired or revoked credentials stop working immediately.</p><form class="form" id="agent-form" inert><label>Credential label<input name="label" required maxlength="80" aria-label="Credential label" placeholder="Documentation agent"></label><div class="form-row"><label>Role<select name="role" aria-label="Credential role"><option value="agent">Agent</option><option value="reader">Reader</option><option value="reviewer">Reviewer</option></select></label><label>Expires in days<input type="number" name="days" min="1" max="30" value="7" required aria-label="Expires in days"></label></div><label>Allowed paths<input name="paths" aria-label="Allowed paths" placeholder="docs, src/api (blank allows the whole workspace)"></label><div class="form-actions"><button class="button primary" aria-label="Create agent token"><span aria-hidden="true">＋</span>${gate('Create agent token')}</button></div></form>${tokens.length ? '<h3 data-font-gated>Existing credentials</h3>' : ''}${tokens.map(token => `<div class="repository-row"><span aria-hidden="true">⚿</span><span><strong data-font-gated>${escape(token.label)}</strong><span class="repository-meta muted" data-font-gated>${escape(token.role)} · ${escape(token.paths?.join(', ')??'Whole workspace')} · expires ${escape(new Date(token.expiresAt).toLocaleDateString())}</span></span>${token.revokedAt ? gate('Revoked') : `<button class="button small" data-revoke="${token.id}" aria-label="Revoke ${escape(token.label)}">× ${gate('Revoke')}</button>`}</div>`).join('')}`);
  const form = $('#agent-form');
  form.onsubmit = e => { e.preventDefault(); busy($('button', form), async () => {
    const credential = await api(route('/tokens'), {label:form.elements.label.value,role:form.elements.role.value,days:Number(form.elements.days.value),paths:form.elements.paths.value.trim()?form.elements.paths.value.split(',').map(p=>p.trim()):null});
    dialog('Save your agent credential', `<p class="muted" data-font-gated>This token is shown once. Save it in your agent’s secret manager as SQUALI_TOKEN.</p><div class="form"><label>Agent token<input type="password" readonly value="${escape(credential.token)}" aria-label="Agent token"></label><button class="button" id="copy-agent-token" aria-label="Copy agent token"><span aria-hidden="true">⧉</span>${gate('Copy token')}</button><pre class="context">SQUALI_URL=${escape(location.origin)}\nWorkspace: ${escape(state.project.id)}\nRole: ${escape(credential.role)}</pre></div>`);
    $('#copy-agent-token').onclick = e => busy(e.currentTarget, async () => { await navigator.clipboard.writeText(credential.token); $('#dialog-notice').textContent = 'Copied. Store it securely; it will not be shown again.'; });
  }); }; form.inert = false;
  for (const button of document.querySelectorAll('[data-revoke]')) button.onclick = e => busy(e.currentTarget, async () => { await api(route('/tokens/' + button.dataset.revoke + '/revoke'), {}); await manageAgents(); });
}
