'use strict';
(() => {
  const el = id => document.getElementById(id);
  const fieldLabels = { company_name: 'Company', contact_name: 'Contact', phone: 'Phone', email: 'Email', address: 'Address', trn_no: 'TRN number',
    project_name: 'Project', project_location: 'Location', product_or_service: 'Product or service',
    requirement: 'Requirement', quantity: 'Quantity', deadline: 'Deadline', notes: 'Notes' };
  const mediaLabels = { image: 'Image / screenshot', audio: 'Voice message / audio', video: 'Video',
    document: 'Document', sticker: 'Sticker', location: 'Location', contacts: 'Contact card',
    interactive: 'Interactive message', button: 'Button response', reaction: 'Reaction', unsupported: 'Media / unsupported message' };
  const types = { boss_lead: 'Boss lead intake', conversation: 'Customer chat', other: 'WhatsApp chat' };
  let signedIn = false;
  let loginPending = false;
  let logoutPending = false;
  let session = 0;
  let listing = 0;
  let detailRequest = 0;
  let page = 1;
  let totalPages = 0;
  let search = '';
  let selectedId = null;
  let messagePage = 1;
  let messagePages = 0;
  const navigation = new URLSearchParams(window.location?.search || '');
  const linkedConversation = navigation.getAll('conversation');
  let requestedConversation = linkedConversation.length === 1 && /^\+[1-9]\d{6,14}$/.test(linkedConversation[0])
    ? linkedConversation[0] : null;
  const text = value => value === null || value === undefined || value === '' ? '—' : String(value);
  const readable = value => text(value).replaceAll('_', ' ');
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : '—';
  function node(tag, value, className) {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = text(value);
    if (className) element.className = className;
    return element;
  }
  function getInitials(name) {
    if (!name) return 'WA';
    const clean = String(name).replace(/<[^>]*>/g, '').trim();
    const parts = clean.split(/\s+/);
    if (parts.length >= 2 && parts[0] && parts[1]) {
      return (parts[0][0] + parts[1][0]).toUpperCase();
    }
    return clean.slice(0, 2).toUpperCase() || 'WA';
  }
  function feedback(message = '') { el('feedback').textContent = message; }
  function clearHistory() {
    detailRequest++;
    selectedId = null;
    messagePage = 1;
    messagePages = 0;
    el('conversation-title').textContent = 'Select a conversation';
    el('conversation-meta').textContent = 'Choose a name or phone on the left to see its message history.';
    try {
      if (el('stream-avatar-initials')) el('stream-avatar-initials').textContent = 'RH';
      if (el('contact-panel-name')) el('contact-panel-name').textContent = 'ROBERT HARRISON';
      if (el('contact-panel-phone')) el('contact-panel-phone').textContent = '+971 50 123 4567';
      if (el('contact-avatar-initials')) el('contact-avatar-initials').textContent = 'RH';
    } catch { /* optional contact-panel enhancement */ }
    el('linked-leads').replaceChildren();
    el('linked-leads').hidden = true;
    el('message-history').replaceChildren();
    el('message-pagination').hidden = true;
    el('message-page-label').textContent = '';
    if (el('reply-form')) el('reply-form').hidden = true;
  }
  function lock(message = '') {
    signedIn = false;
    session++;
    listing++;
    el('password').value = '';
    el('login-panel').hidden = false;
    el('workspace').hidden = true;
    el('lock').hidden = true;
    el('conversation-list').replaceChildren();
    clearHistory();
    el('search').value = '';
    search = '';
    page = 1;
    totalPages = 0;
    el('page-label').textContent = 'No conversations loaded';
    feedback(message);
  }
  function request(path, { method = 'GET', body } = {}) {
    return fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      credentials: 'same-origin', cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  }
  function failureMessage(status) {
    return status === 503 ? 'Internal chat access is unavailable. Contact your administrator.'
      : status === 429 ? 'Too many requests. Please wait a minute and try again.' : 'Unable to load chats. Please try again.';
  }
  async function api(path) {
    const activeSession = session;
    const response = await request('/api/chats' + path);
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    if (response.status === 401) { lock('Session expired. Please sign in again.'); throw new Error('SESSION_CHANGED'); }
    if (!response.ok) throw new Error(failureMessage(response.status));
    const data = await response.json();
    if (activeSession !== session) throw new Error('SESSION_CHANGED');
    return data;
  }
  function conversationName(conversation) {
    return conversation.sender_name || (conversation.type === 'boss_lead' ? 'Boss' : conversation.sender_phone);
  }
  function leadName(lead = {}, fallback = 'Lead details') {
    if (!lead) return fallback;
    if (lead.company_name || lead.contact_name) return lead.company_name || lead.contact_name;
    const field = Object.keys(fieldLabels).find(name => lead[name]);
    return field ? fieldLabels[field] + ': ' + lead[field] : lead.id || fallback;
  }
  function preview(conversation) {
    const media = conversation.last_message_type !== 'text' && conversation.last_message_type
      ? mediaLabels[conversation.last_message_type] || 'Media message' : '';
    return [media, conversation.last_message].filter(Boolean).join(' · ') || 'No messages';
  }
  function selectRow() {
    for (const row of el('conversation-list').children) {
      const selected = row.dataset.id === selectedId;
      row.className = 'conversation' + (selected ? ' selected' : '');
      row.setAttribute('aria-pressed', String(selected));
    }
  }
  function renderConversations(items) {
    el('conversation-list').replaceChildren(...items.map(conversation => {
      const row = node('button', undefined, 'conversation');
      row.type = 'button';
      row.dataset.id = conversation.id;

      // Avatar with status
      const avatar = node('div', getInitials(conversationName(conversation)), 'conversation-avatar');
      avatar.append(node('span', undefined, 'conv-online-dot'));
      row.append(avatar);

      // Content
      const content = node('div', undefined, 'conversation-content');
      const topRow = node('div', undefined, 'conv-top-row');
      topRow.append(node('strong', conversationName(conversation)));
      topRow.append(node('span', date(conversation.last_message_at), 'conv-time'));
      content.append(topRow);

      const bottomRow = node('div', undefined, 'conv-bottom-row');
      bottomRow.append(node('span', preview(conversation), 'preview'));
      if (conversation.sender_name || conversation.type === 'boss_lead') {
        content.append(node('small', conversation.sender_phone, 'sr-only'));
      }
      content.append(node('span', (types[conversation.type] || 'WhatsApp chat') + ' · ' + readable(conversation.status), 'badge sr-only'));
      bottomRow.append(node('span', '2', 'conv-unread-badge'));
      content.append(bottomRow);

      row.append(content);
      row.addEventListener('click', () => showConversation(conversation.id, 1));
      return row;
    }));
    selectRow();
    el('empty').hidden = items.length > 0;
  }
  async function load() {
    if (!signedIn) return;
    const requestId = ++listing;
    feedback('Loading conversations…');
    try {
      const result = await api('?' + new URLSearchParams({ search, page: String(page), page_size: '20' }));
      if (requestId !== listing) return;
      page = result.page;
      totalPages = result.total_pages;
      renderConversations(result.items);
      el('page-label').textContent = result.total ? `${result.total} conversations · Page ${page} of ${totalPages}` : '0 conversations';
      el('previous').disabled = page <= 1;
      el('next').disabled = page >= totalPages;
      el('login-panel').hidden = true;
      el('workspace').hidden = false;
      el('lock').hidden = false;
      feedback();
      if (requestedConversation) {
        const id = requestedConversation;
        requestedConversation = null;
        await showConversation(id, 1);
      } else if (selectedId) await showConversation(selectedId, messagePage);
      else if (result.items.length) await showConversation(result.items[0].id, 1);
    } catch (error) { if (requestId === listing && error.message !== 'SESSION_CHANGED') feedback(error.message); }
  }
  function renderLeads(conversation) {
    const sections = [];
    if (conversation.active_session) {
      const draft = node('section', undefined, 'lead-summary');
      draft.append(node('h3', 'Current lead · ' + readable(conversation.active_session.state)));
      if (conversation.active_session.pending_action === 'new_lead') {
        draft.append(node('p', 'Waiting for the boss to confirm whether to close this draft and start another lead.'));
      }
      for (const [field, label] of Object.entries(fieldLabels)) {
        if (conversation.active_session.lead?.[field]) draft.append(node('p', label + ': ' + conversation.active_session.lead[field]));
      }
      sections.push(draft);
    }
    for (const session of conversation.archived_sessions || []) {
      if (session.lead_id) continue;
      const archived = node('details', undefined, 'lead-summary');
      archived.append(node('summary', 'Closed unsaved draft · ' + leadName(session.lead, date(session.completed_at || session.updated_at))));
      archived.append(node('p', 'Status: ' + readable(session.state)));
      for (const [field, label] of Object.entries(fieldLabels)) {
        if (session.lead?.[field]) archived.append(node('p', label + ': ' + session.lead[field]));
      }
      if (session.original_message) archived.append(node('p', 'Original details'), node('pre', session.original_message, 'original'));
      sections.push(archived);
    }
    for (const lead of conversation.leads || []) {
      const linked = node('section', undefined, 'lead-summary');
      linked.append(node('h3', 'Saved lead · ' + leadName(lead)),
        node('p', [lead.contact_name, lead.phone, readable(lead.validation_status)].filter(Boolean).join(' · ')),
        node('p', 'Lead ID: ' + lead.id));
      for (const field of ['email', 'address', 'trn_no', 'project_name', 'project_location', 'product_or_service', 'requirement', 'quantity', 'deadline', 'notes']) {
        if (lead[field]) linked.append(node('p', fieldLabels[field] + ': ' + lead[field]));
      }
      if (typeof lead.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(lead.id)) {
        const link = node('a', 'Open this lead');
        link.href = '/admin/leads?' + new URLSearchParams({ lead: lead.id });
        linked.append(link);
      }
      sections.push(linked);
    }
    if (sections.length) {
      const link = node('a', 'Open lead dashboard');
      link.href = '/admin/leads';
      sections.push(link);
    }
    el('linked-leads').replaceChildren(...sections);
    el('linked-leads').hidden = !sections.length;
  }
  function renderMessages(items, conversation) {
    const leads = new Map((conversation.leads || []).map(lead => [lead.id, leadName(lead)]));
    el('message-history').replaceChildren(...items.map(message => {
      const outgoing = message.direction === 'outgoing';
      const bubble = node('article', undefined, 'message ' + (outgoing ? 'outgoing' : 'incoming'));
      const sender = message.sender_type || (conversation.type === 'boss_lead' ? 'boss' : conversation.type === 'conversation' ? 'customer' : 'participant');
      bubble.append(node('span', outgoing ? 'BOT · OUTGOING' : sender === 'boss' ? 'BOSS · INCOMING'
        : sender === 'customer' ? 'CUSTOMER · INCOMING' : 'PARTICIPANT · INCOMING', 'speaker'));
      if (message.message_type && message.message_type !== 'text') {
        bubble.append(node('p', mediaLabels[message.message_type] || 'Media message', 'media-indicator'));
        if (message.media_filename) bubble.append(node('p', message.media_filename, 'media-indicator'));
        if (message.message_type === 'image' && (message.media_id || message.storage_url)) {
          const img = document.createElement('img');
          img.className = 'chat-media-img';
          const primarySrc = message.storage_url || ('/api/chats/media/' + encodeURIComponent(message.media_id));
          const fallbackSrc = (message.storage_url && message.media_id)
            ? ('/api/chats/media/' + encodeURIComponent(message.media_id))
            : '';
          img.src = primarySrc;
          img.alt = 'Screenshot / image';
          img.loading = 'lazy';
          let triedFallback = false;
          img.onerror = () => {
            if (fallbackSrc && !triedFallback) {
              triedFallback = true;
              img.src = fallbackSrc;
            } else {
              img.onerror = null;
              const placeholder = node('div', undefined, 'media-unavailable');
              placeholder.append(
                node('span', '🖼️', 'media-unavailable-icon'),
                node('span', 'Media expired or unavailable', 'media-unavailable-text')
              );
              img.replaceWith(placeholder);
            }
          };
          img.addEventListener('click', () => {
            const zoomImg = el('zoom-image');
            if (zoomImg) zoomImg.src = img.src;
            const dialog = el('media-zoom-dialog');
            if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
          });
          bubble.append(img);
        }
        if ((message.message_type === 'audio' || message.message_type === 'voice') && (message.media_id || message.storage_url)) {
          const audio = document.createElement('audio');
          audio.className = 'chat-audio-player';
          audio.controls = true;
          audio.preload = 'none';
          const primaryAudio = message.storage_url || ('/api/chats/media/' + encodeURIComponent(message.media_id));
          const fallbackAudio = (message.storage_url && message.media_id)
            ? ('/api/chats/media/' + encodeURIComponent(message.media_id))
            : '';
          audio.src = primaryAudio;
          let triedAudioFallback = false;
          audio.onerror = () => {
            if (fallbackAudio && !triedAudioFallback) {
              triedAudioFallback = true;
              audio.src = fallbackAudio;
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
          bubble.append(audio);
        }
      }
      if (message.text) bubble.append(node('p', message.text));
      if (message.transcription) bubble.append(node('p', 'Voice transcription', 'media-indicator'), node('p', message.transcription));
      if (message.extracted_text) bubble.append(node('p', 'Extracted image / document text', 'media-indicator'), node('p', message.extracted_text));
      const timestamp = node('time', date(message.created_at || message.received_at));
      if (message.created_at || message.received_at) timestamp.dateTime = message.created_at || message.received_at;
      bubble.append(timestamp);
      if (outgoing && message.status) bubble.append(node('span', readable(message.status), 'delivery'));
      if (message.lead_id) bubble.append(node('p', 'Lead: ' + (leads.get(message.lead_id) || message.lead_id), 'message-lead'));
      return bubble;
    }));
    if (!items.length) el('message-history').append(node('p', 'No messages on this page.', 'empty'));
    el('message-history').scrollTop = 0;
  }
  async function showConversation(id, desiredPage) {
    if (!signedIn) return;
    const requestId = ++detailRequest;
    selectedId = id;
    selectRow();
    el('conversation-title').textContent = 'Loading conversation…';
    el('conversation-meta').textContent = '';
    if (el('reply-form')) el('reply-form').hidden = false;
    el('linked-leads').replaceChildren();
    el('linked-leads').hidden = true;
    el('message-history').replaceChildren();
    el('message-pagination').hidden = true;
    try {
      const base = '/' + encodeURIComponent(id);
      const [conversation, result] = await Promise.all([api(base), api(base + '/messages?' + new URLSearchParams({ page: String(desiredPage), page_size: '100' }))]);
      if (requestId !== detailRequest) return;
      const cName = conversationName(conversation);
      el('conversation-title').textContent = cName;
      el('conversation-meta').textContent = [conversation.sender_phone, types[conversation.type] || 'WhatsApp chat', readable(conversation.status)].join(' · ');

      // Update Stream Header & Right Profile Column
      try {
        const initials = getInitials(cName);
        if (el('stream-avatar-initials')) el('stream-avatar-initials').textContent = initials;
        if (el('contact-panel-name')) el('contact-panel-name').textContent = cName.toUpperCase();
        if (el('contact-panel-phone')) el('contact-panel-phone').textContent = conversation.sender_phone || '—';
        if (el('contact-avatar-initials')) el('contact-avatar-initials').textContent = initials;
        if (el('contact-tag-type')) el('contact-tag-type').textContent = conversation.type === 'boss_lead' ? 'INTERNAL' : 'VENDOR';

        if (conversation.leads && conversation.leads.length) {
          const lead = conversation.leads[0];
          if (el('entity-inv-title')) el('entity-inv-title').textContent = lead.company_name || 'Inv #VOLT-2024';
          if (el('entity-proj-title')) el('entity-proj-title').textContent = lead.project_name ? 'Project: ' + lead.project_name : 'Project: Oasis 2.0';
        }
      } catch { /* optional profile data */ }

      renderLeads(conversation);
      renderMessages(result.items, conversation);
      messagePage = result.page;
      messagePages = result.total_pages;
      const start = result.total ? (messagePage - 1) * result.page_size + 1 : 0;
      el('message-page-label').textContent = `${start}–${start ? start + result.items.length - 1 : 0} of ${result.total} messages · Oldest first`;
      el('older').disabled = messagePage <= 1;
      el('newer').disabled = messagePage >= messagePages;
      el('message-pagination').hidden = false;
    } catch (error) {
      if (requestId === detailRequest && error.message !== 'SESSION_CHANGED') {
        el('conversation-title').textContent = 'Conversation unavailable';
        el('message-history').replaceChildren(node('p', error.message, 'empty'));
      }
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
      if (result.authenticated !== true) throw new Error('LOGIN_FAILED');
      signedIn = true;
      el('login-panel').hidden = true;
      el('lock').hidden = false;
      try {
        if (typeof window !== 'undefined' && window.VoltronixNav && result) {
          window.VoltronixNav.updateUser(result);
        }
      } catch { /* optional contact metadata */ }
      page = 1;
      load();
    } catch { if (activeSession === session) feedback('Unable to sign in. Please try again.'); }
    finally { loginPending = false; el('login-submit').disabled = logoutPending; }
  });
  el('filters').addEventListener('submit', event => { event.preventDefault(); search = el('search').value; page = 1; clearHistory(); load(); });
  el('previous').addEventListener('click', () => { if (page > 1) { page--; clearHistory(); load(); } });
  el('next').addEventListener('click', () => { if (page < totalPages) { page++; clearHistory(); load(); } });
  el('older').addEventListener('click', () => { if (messagePage > 1) showConversation(selectedId, messagePage - 1); });
  el('newer').addEventListener('click', () => { if (messagePage < messagePages) showConversation(selectedId, messagePage + 1); });
  el('reply-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    if (!selectedId) return;
    const input = el('reply-text');
    const text = input ? input.value.trim() : '';
    if (!text) return;
    const submitBtn = el('reply-submit');
    if (submitBtn) submitBtn.disabled = true;
    feedback('Sending WhatsApp reply…');
    try {
      const res = await request('/api/chats/' + encodeURIComponent(selectedId) + '/messages', {
        method: 'POST',
        body: { text },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || 'Failed to send reply');
      }
      if (input) input.value = '';
      feedback('Reply sent successfully!');
      setTimeout(() => feedback(), 4000);
      await showConversation(selectedId, messagePage);
    } catch (err) {
      feedback('Error sending reply: ' + err.message);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
  el('close-zoom')?.addEventListener('click', () => {
    el('media-zoom-dialog')?.close();
  });
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
      if (activeSession === session) { feedback('Sign out could not be confirmed. Please retry signing out.'); el('lock').hidden = false; }
    } finally { logoutPending = false; el('login-submit').disabled = loginPending; }
  });

  // AI Smart Replies & Profile action handlers
  try {
    const repliesContainer = el('ai-smart-replies-list');
    if (repliesContainer) {
      const cards = repliesContainer.children;
      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        card.addEventListener('click', () => {
          const raw = card.getAttribute('data-reply') || card.textContent || '';
          const reply = raw.replace(/✓\s*$/, '').trim();
          if (reply && el('reply-text')) {
            el('reply-text').value = reply;
            el('reply-text').focus();
          }
        });
      }
    }
    el('btn-view-lead-profile')?.addEventListener('click', () => {
      window.location.href = '/leads';
    });
  } catch { /* optional smart-reply enhancement */ }

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
      el('login-panel').hidden = true;
      el('lock').hidden = false;
      try {
        if (typeof window !== 'undefined' && window.VoltronixNav && result) {
          window.VoltronixNav.updateUser(result);
        }
      } catch { /* optional logout confirmation */ }
      await load();
    } catch { if (activeSession === session) feedback('Unable to check your session. Please sign in.'); }
  }
  window.addEventListener('pageshow', event => { if (event.persisted) restoreSession(); });

  try {
    if (typeof window !== 'undefined' && window.VoltronixNav) {
      window.VoltronixNav.initNav({ activePage: 'chats', pageOwnsLogout: true });
    }
  } catch { /* optional navigation enhancement */ }

  restoreSession();
})();
