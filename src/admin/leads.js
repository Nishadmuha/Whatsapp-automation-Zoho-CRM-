'use strict';
(() => {
  const el = id => document.getElementById(id);
  const labels = { company_name: 'Company', contact_name: 'Contact', phone: 'Phone', email: 'Email', address: 'Address', trn_no: 'TRN number', project_name: 'Project',
    project_location: 'Project location', product_or_service: 'Product or service', requirement: 'Requirement', quantity: 'Quantity',
    deadline: 'Deadline', notes: 'Notes', extraction_status: 'Extraction', validation_status: 'Validation', zoho_status: 'Zoho Sync Status',
    zoho_lead_id: 'Zoho Lead ID', zoho_url: 'Zoho Lead URL', sender_phone: 'Sender', whatsapp_message_id: 'WhatsApp message ID', id: 'MongoDB Lead ID',
    created_at: 'Created', updated_at: 'Updated', error_stage: 'Error stage', error_code: 'Error code' };
  const fields = ['company_name', 'contact_name', 'phone', 'email', 'address', 'trn_no', 'project_name', 'project_location',
    'product_or_service', 'requirement', 'quantity', 'deadline', 'notes'];
  const knownStatuses = new Set(['pending', 'processing', 'completed', 'failed', 'valid', 'incomplete', 'invalid',
    'not_started', 'existing_found', 'creating', 'updating', 'saved']);
  let signedIn = false;
  let loginPending = false;
  let logoutPending = false;
  let session = 0;
  let listing = 0;
  let detailRequest = 0;
  let page = 1;
  let totalPages = 0;
  let activeFilters = {};
  const initialSearch = new URLSearchParams(window.location?.search || '').get('search');
  if (initialSearch) { activeFilters.search = initialSearch; el('search').value = initialSearch; }
  const linkedLead = new URLSearchParams(window.location?.search || '').getAll('lead');
  let requestedLead = linkedLead.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(linkedLead[0])
    ? linkedLead[0] : null;
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const readable = value => text(value).replaceAll('_', ' ');
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = text(value);
    if (className) element.className = className;
    return element;
  }
  function badge(value) { return node('span', readable(value), 'badge' + (knownStatuses.has(value) ? ' ' + value : '')); }
  function leadName(lead) {
    if (lead.company_name || lead.contact_name) return lead.company_name || lead.contact_name;
    const field = fields.find(name => lead[name]);
    return field ? labels[field] + ': ' + lead[field] : lead.id || 'View lead';
  }
  function conversationLink(lead, label) {
    if (typeof lead.conversation_id !== 'string' || !/^\+[1-9]\d{6,14}$/.test(lead.conversation_id)) return null;
    const link = node('a', label, 'lead-link');
    link.href = '/admin/chats?' + new URLSearchParams({ conversation: lead.conversation_id });
    return link;
  }
  function feedback(message = '') { el('feedback').textContent = message; }
  function lock(message = '') {
    signedIn = false;
    session++;
    listing++;
    detailRequest++;
    el('password').value = '';
    el('login-panel').hidden = false;
    el('workspace').hidden = true;
    el('lock').hidden = true;
    el('lead-rows').replaceChildren();
    el('detail-content').replaceChildren();
    el('detail-title').textContent = 'Lead details';
    el('detail').close();
    for (const name of ['search', 'validation', 'extraction', 'zoho']) el(name).value = '';
    activeFilters = {};
    page = 1;
    totalPages = 0;
    el('page-label').textContent = 'No leads loaded';
    for (const name of ['total', 'valid', 'incomplete', 'zoho_pending']) el('stat-' + name).textContent = '—';
    feedback(message);
  }
  function request(path, { method = 'GET', body } = {}) {
    return fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  }
  function failureMessage(status) {
    return status === 503 ? 'Internal leads access is unavailable. Contact your administrator.'
      : status === 429 ? 'Too many requests. Please wait a minute and try again.' : 'Unable to load leads. Please try again.';
  }
  async function api(path) {
    const activeSession = session;
    const response = await request('/api/leads' + path);
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    if (response.status === 401) { lock('Session expired. Please sign in again.'); throw new Error('SESSION_CHANGED'); }
    if (!response.ok) throw new Error(failureMessage(response.status));
    const data = await response.json();
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    return data;
  }
  function renderRows(items) {
    const rows = items.map(lead => {
      const row = node('tr');
      const company = node('td');
      const open = node('button', leadName(lead), 'lead-name-btn');
      open.type = 'button';
      open.addEventListener('click', () => showDetail(lead.id));
      company.append(open);
      row.append(company);

      // Col 2: STATUS
      const statusCell = node('td');
      statusCell.append(badge(lead.validation_status || lead.extraction_status || 'new'));
      row.append(statusCell);

      // Col 3: SOURCE
      const sourceVal = lead.source || (lead.phone ? 'WhatsApp (' + lead.phone + ')' : (lead.contact_name ? 'Direct Contact' : 'WhatsApp Inquiry'));
      row.append(node('td', sourceVal));

      // Col 4: EST. VALUE
      const estVal = lead.est_value || lead.requirement || '—';
      row.append(node('td', estVal));

      // Col 5: LOCATION
      const locVal = lead.project_location || lead.address || 'Dubai, UAE';
      row.append(node('td', locVal));

      // Col 6: LAST ACTION (View chat link)
      const conversation = node('td');
      const chatLink = conversationLink(lead, 'View chat');
      if (chatLink) {
        chatLink.classList.add('btn-view-chat');
        conversation.append(chatLink);
      } else {
        conversation.append(node('span', '—'));
      }
      row.append(conversation);
      return row;
    });
    el('lead-rows').replaceChildren(...rows);
    el('empty').hidden = items.length > 0;
  }
  async function load() {
    if (!signedIn) return;
    const request = ++listing;
    feedback('Loading leads…');
    const query = new URLSearchParams({ ...activeFilters, page: String(page), page_size: el('page-size').value });
    try {
      const [result, stats] = await Promise.all([api('?' + query), api('/stats')]);
      if (request !== listing) return;
      page = result.page;
      totalPages = result.total_pages;
      renderRows(result.items);
      for (const name of ['total', 'valid', 'incomplete', 'zoho_pending']) el('stat-' + name).textContent = text(stats[name]);
      try { if (el('stat-total-display')) el('stat-total-display').textContent = text(stats.total); } catch { /* optional dashboard counter */ }
      el('page-label').textContent = result.total ? `${result.total} leads · Page ${page} of ${Math.max(1, totalPages)}` : '0 leads';
      el('previous').disabled = page <= 1;
      el('next').disabled = page >= totalPages;
      el('login-panel').hidden = true;
      el('workspace').hidden = false;
      el('lock').hidden = false;
      feedback();
      if (requestedLead) {
        const id = requestedLead;
        requestedLead = null;
        await showDetail(id);
      }
    } catch (error) { if (request === listing && error.message !== 'SESSION_CHANGED') feedback(error.message); }
  }
  function section(title) {
    const wrapper = node('section', undefined, 'detail-section');
    wrapper.append(node('h3', title));
    el('detail-content').append(wrapper);
    return wrapper;
  }
  function definitions(target, names, lead) {
    const list = node('dl');
    for (const name of names) {
      list.append(node('dt', labels[name] || readable(name)));
      const value = node('dd');
      if (name === 'zoho_url' && lead[name]) {
        const link = document.createElement('a');
        link.href = lead[name];
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.className = 'lead-link';
        link.textContent = lead[name];
        value.append(link);
      } else {
        value.append(name.endsWith('_status') ? badge(lead[name]) : node('span', name.endsWith('_at') ? date(lead[name]) : lead[name]));
      }
      list.append(value);
    }
    target.append(list);
  }
  async function showDetail(id) {
    if (!signedIn) return;
    const request = ++detailRequest;
    el('detail-title').textContent = 'Lead details';
    el('detail-content').replaceChildren(node('p', 'Loading lead…'));
    el('detail').showModal();
    try {
      const lead = await api('/' + encodeURIComponent(id));
      if (request !== detailRequest) return;
      el('detail-title').textContent = leadName(lead);
      el('detail-content').replaceChildren();
      const link = conversationLink(lead, 'Open related WhatsApp conversation');
      if (link) section('Conversation').append(link);
      definitions(section('Extracted fields'), fields, lead);
      const statusSection = section('Current status');
      definitions(statusSection, ['id', 'extraction_status', 'validation_status', 'zoho_status', 'attachment_status', 'zoho_lead_id', 'zoho_url', 'error_stage', 'error_code'], lead);

      // Zoho CRM Synchronization Overview
      const zohoSection = section('Zoho CRM');
      const zohoBlock = node('div', undefined, 'zoho-sync-block');

      const leadSynced = lead.zoho_status === 'saved';
      const leadCreating = ['creating', 'updating', 'pending'].includes(lead.zoho_status);
      const leadFailed = lead.zoho_status === 'failed';
      const leadDot = leadSynced ? '🟢' : leadCreating ? '🟠' : leadFailed ? '🔴' : '⚪';
      const leadLabel = leadSynced ? 'Lead synced' : leadCreating ? 'Lead sync in progress' : leadFailed ? 'Lead sync failed' : 'Lead not synced';
      zohoBlock.append(node('div', `${leadDot} ${leadLabel}`, 'zoho-sync-item'));

      const atts = Array.isArray(lead.attachments) ? lead.attachments : [];
      if (atts.length > 0) {
        const anyFailed = atts.some(a => (a.zoho_upload_status || a.zohoUploadStatus) === 'failed');
        const allUploaded = atts.every(a => (a.zoho_upload_status || a.zohoUploadStatus) === 'uploaded');
        const anyPending = atts.some(a => (a.zoho_upload_status || a.zohoUploadStatus) === 'pending' || (a.zoho_upload_status || a.zohoUploadStatus) === 'uploading');
        const attDot = allUploaded ? '🟢' : anyFailed ? '🔴' : anyPending ? '🟠' : '⚪';
        const attLabel = allUploaded ? 'Attachment synced' : anyFailed ? 'Attachment upload failed' : 'Attachment upload pending';
        zohoBlock.append(node('div', `${attDot} ${attLabel}`, 'zoho-sync-item'));
      }
      zohoSection.append(zohoBlock);

      const hasFailedAtts = atts.some(a => (a.zoho_upload_status || a.zohoUploadStatus) === 'failed' || (a.zoho_upload_status || a.zohoUploadStatus) === 'pending');
      if (lead.zoho_status !== 'saved' || hasFailedAtts) {
        const btnLabel = lead.zoho_status !== 'saved' ? 'Push to Zoho' : 'Retry Attachment Upload';
        const pushBtn = node('button', btnLabel);
        pushBtn.type = 'button';
        if (pushBtn.style) pushBtn.style.marginTop = '0.8rem';
        pushBtn.addEventListener('click', async () => {
          pushBtn.disabled = true;
          pushBtn.textContent = 'Syncing to Zoho…';
          try {
            const res = await request('/api/leads/' + encodeURIComponent(id) + '/sync-zoho', { method: 'POST' });
            const body = await res.json();
            if (body.success) {
              alert('Successfully synced to Zoho! Zoho Lead ID: ' + (body.zoho_lead_id || lead.zoho_lead_id));
              await showDetail(id);
              await load();
            } else {
              alert('Zoho sync failed: ' + (body.message || 'Unknown error'));
              pushBtn.disabled = false;
              pushBtn.textContent = btnLabel;
            }
          } catch (e) {
            alert('Error syncing to Zoho: ' + e.message);
            pushBtn.disabled = false;
            pushBtn.textContent = btnLabel;
          }
        });
        zohoSection.append(pushBtn);
      }
      const validation = section('Validation result');
      if (!lead.validation_result) validation.append(node('p', 'Validation has not completed.'));
      else {
        validation.append(node('p', lead.validation_result.valid ? 'Available lead information passed validation.' : 'This lead needs review.'));
        const list = node('ul', undefined, 'validation-list');
        for (const field of lead.validation_result.missing_fields) list.append(node('li', 'Missing: ' + (labels[field] || readable(field))));
        for (const code of lead.validation_result.errors) list.append(node('li', readable(code)));
        validation.append(list);
      }
      section('Original WhatsApp message').append(node('pre', lead.original_message, 'original'));

      if (Array.isArray(lead.attachments) && lead.attachments.length > 0) {
        const mediaSection = section('Media & Attachments (' + lead.attachments.length + ')');
        const grid = node('div', undefined, 'lead-media-grid');
        for (const att of lead.attachments) {
          const card = node('div', undefined, 'lead-media-card');
          const mimeType = att.mime_type || att.mimeType || '';
          const mediaType = att.type || att.media_type || '';
          const isAudio = mediaType === 'audio' || mimeType.startsWith('audio/');
          const isImage = mediaType === 'image' || mimeType.startsWith('image/');
          // Prefer the persistent GridFS URL; fall back to the Meta proxy only when absent
          const persistentUrl = att.storage_url || att.storageUrl;
          const mediaId = att.media_id || att.mediaId || att.whatsapp_media_id;
          const fallbackUrl = mediaId ? ('/api/chats/media/' + encodeURIComponent(mediaId)) : '';
          const mediaSrc = persistentUrl || fallbackUrl;
          if (isImage) {
            const img = document.createElement('img');
            img.className = 'lead-media-img';
            img.src = mediaSrc;
            img.alt = att.filename || 'Lead image';
            img.loading = 'lazy';
            let triedFallback = false;
            img.onerror = () => {
              if (persistentUrl && fallbackUrl && !triedFallback) {
                triedFallback = true;
                img.src = fallbackUrl;
              } else {
                img.onerror = null;
                const placeholder = node('div', undefined, 'media-unavailable');
                placeholder.append(
                  node('span', '🖼️', 'media-unavailable-icon'),
                  node('span', 'Image expired or unavailable', 'media-unavailable-text')
                );
                img.replaceWith(placeholder);
              }
            };
            img.addEventListener('click', () => {
              if (img.src) window.open(img.src, '_blank');
            });
            card.append(img);
            if (att.ocr_text || att.extractedText) {
              card.append(node('div', 'OCR Text:', 'media-label'));
              card.append(node('pre', att.ocr_text || att.extractedText, 'media-text'));
            }
          } else if (isAudio) {
            const audio = document.createElement('audio');
            audio.className = 'lead-audio-player';
            audio.controls = true;
            audio.preload = 'none';
            audio.src = mediaSrc;
            let triedAudioFallback = false;
            audio.onerror = () => {
              if (persistentUrl && fallbackUrl && !triedAudioFallback) {
                triedAudioFallback = true;
                audio.src = fallbackUrl;
              } else {
                audio.onerror = null;
                const placeholder = node('div', undefined, 'media-unavailable');
                placeholder.append(
                  node('span', '🎤', 'media-unavailable-icon'),
                  node('span', 'Audio unavailable or expired', 'media-unavailable-text')
                );
                audio.replaceWith(placeholder);
              }
            };
            card.append(audio);
            if (att.transcription_text || att.transcription) {
              card.append(node('div', 'Voice Transcription:', 'media-label'));
              card.append(node('pre', att.transcription_text || att.transcription, 'media-text'));
            }
          } else {
            card.append(node('div', (mediaType || 'File') + ' (' + (mimeType || 'unknown') + ')', 'media-label'));
          }
          // Filename and MIME type
          if (att.filename) card.append(node('div', '📎 ' + att.filename, 'media-label'));
          if (mimeType) card.append(node('div', '📄 ' + mimeType, 'media-meta-sub'));

          // Zoho upload status & metadata
          const zohoStatus = att.zoho_upload_status || att.zohoUploadStatus || 'pending';
          const zohoAttId = att.zoho_attachment_id || att.zohoAttachmentId;
          const uploadedAt = att.uploaded_at || att.uploadedAt;
          const zohoLabel = { uploaded: '🟢 Uploaded to Zoho', failed: '🔴 Zoho upload failed', pending: '🟠 Pending Zoho upload' }[zohoStatus] || zohoStatus;
          const zohoSpan = node('div', zohoLabel, 'media-label zoho-att-' + zohoStatus);
          card.append(zohoSpan);

          if (zohoAttId && zohoAttId !== 'attached') {
            card.append(node('div', '🆔 Attachment ID: ' + zohoAttId, 'media-meta-sub'));
          }
          if (uploadedAt) {
            card.append(node('div', '🕒 Synced: ' + date(uploadedAt), 'media-meta-sub'));
          }
          if (zohoStatus === 'failed' && (att.zoho_error || att.zohoError)) {
            card.append(node('div', att.zoho_error || att.zohoError, 'media-label media-error'));
          }
          grid.append(card);
        }
        mediaSection.append(grid);
      }

      if (Array.isArray(lead.messages) && lead.messages.length > 0) {
        const historySection = section('Lead Message History (' + lead.messages.length + ')');
        const list = node('div', undefined, 'lead-messages-list');
        for (const msg of lead.messages) {
          const item = node('div', undefined, 'lead-msg-item incoming');
          const meta = node('span', (msg.message_type || 'text').toUpperCase() + ' · ' + date(msg.created_at), 'msg-meta');
          item.append(meta);
          if (msg.body) {
            item.append(node('div', msg.body, 'msg-body'));
          }
          if (msg.media_id) {
            item.append(node('div', 'Attached media: ' + msg.media_id, 'msg-extra'));
          }
          list.append(item);
        }
        historySection.append(list);
      }

      definitions(section('Audit details'), ['sender_phone', 'whatsapp_message_id', 'id', 'created_at', 'updated_at'], lead);
    } catch (error) {
      if (request === detailRequest && error.message !== 'SESSION_CHANGED') el('detail-content').replaceChildren(node('p', error.message));
    }
  }
  el('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (loginPending || logoutPending) return;
    const credentials = { username: el('username').value.trim(), password: el('password').value };
    el('password').value = '';
    const activeSession = ++session;
    loginPending = true;
    el('login-submit').disabled = true;
    feedback('Signing in…');
    try {
      const response = await request('/api/admin/login', { method: 'POST', body: credentials });
      if (activeSession !== session) return;
      if (response.status === 401) { feedback('Incorrect username or password.'); return; }
      if (!response.ok) { feedback(failureMessage(response.status)); return; }
      const result = await response.json();
      if (activeSession !== session) return;
      if (result.authenticated !== true) throw new Error('Unable to sign in. Please try again.');
      signedIn = true;
      window.VoltronixNav?.updateUser(result);
      el('login-panel').hidden = true;
      el('lock').hidden = false;
      page = 1;
      load();
    } catch { if (activeSession === session) feedback('Unable to sign in. Please try again.'); }
    finally { loginPending = false; el('login-submit').disabled = logoutPending; }
  });
  el('filters').addEventListener('submit', event => {
    event.preventDefault();
    activeFilters = {};
    for (const [id, name] of [['search', 'search'], ['validation', 'validation_status'], ['extraction', 'extraction_status'], ['zoho', 'zoho_status']]) {
      if (el(id).value) activeFilters[name] = el(id).value;
    }
    page = 1;
    load();
  });
  el('previous').addEventListener('click', () => { if (page > 1) { page--; load(); } });
  el('next').addEventListener('click', () => { if (page < totalPages) { page++; load(); } });
  el('page-size').addEventListener('change', () => { page = 1; load(); });
  el('refresh').addEventListener('click', load);
  el('lock').addEventListener('click', async () => {
    if (logoutPending) return;
    logoutPending = true;
    lock();
    el('username').value = '';
    el('login-submit').disabled = true;
    const activeSession = session;
    try {
      const response = await request('/api/admin/logout', { method: 'POST', body: {} });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
    } catch {
      if (activeSession === session) {
        feedback('Sign out could not be confirmed. Please retry signing out.');
        el('lock').hidden = false;
      }
    } finally { logoutPending = false; el('login-submit').disabled = loginPending; }
  });
  el('close-detail').addEventListener('click', () => { detailRequest++; el('detail').close(); });
  window.addEventListener('pagehide', () => lock());
  async function restoreSession() {
    const activeSession = session;
    try {
      const response = await request('/api/admin/session');
      if (activeSession !== session) return;
      if (response.status === 401) return;
      if (!response.ok) throw new Error('SESSION_UNAVAILABLE');
      const result = await response.json();
      if (activeSession !== session || result.authenticated !== true) return;
      signedIn = true;
      window.VoltronixNav?.updateUser(result);
      el('login-panel').hidden = true;
      el('lock').hidden = false;
      await load();
    } catch { if (activeSession === session) feedback('Unable to check your session. Please sign in.'); }
  }
  window.addEventListener('pageshow', event => { if (event.persisted) restoreSession(); });
  try {
    if (typeof window !== 'undefined' && window.VoltronixNav) {
      window.VoltronixNav.initNav({ activePage: 'leads', pageOwnsLogout: true });
    }
  } catch { /* optional navigation enhancement */ }
  restoreSession();
})();
