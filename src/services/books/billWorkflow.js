'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { validateBill } = require('./billValidator');
const { formatInitialReviewPrompt, formatCustomerSelectionPrompt, formatSuccessReport, formatDuplicateWarning } = require('./billFormatter');
const { PAYMENT_METHODS, normalizePaymentMethod } = require('./paymentMethods');
// Preserve persisted legacy state names; only SAVE/1 can authorize a write.
const WORKFLOW_STATES = Object.freeze({ PROCESSING: 'EXTRACTING', AWAITING_ADDITIONAL_INFO_CHOICE: 'AWAITING_ADDITIONAL_INFO', WAITING_FOR_ADDITIONAL_INFO: 'WAITING_FOR_ADDITIONAL_INFO', WAITING_FOR_CUSTOMER_SELECTION: 'WAITING_FOR_CUSTOMER_SELECTION', AWAITING_EDIT_CHOICE: 'AWAITING_EDIT', WAITING_FOR_EDIT_INSTRUCTION: 'WAITING_FOR_EDIT_INSTRUCTION', AWAITING_FINAL_CONFIRMATION: 'AWAITING_FINAL_CONFIRMATION', SAVING: 'CREATING_IN_ZOHO', COMPLETED: 'COMPLETED', CANCELLED: 'CANCELLED', FAILED: 'FAILED' });
const REVIEW = WORKFLOW_STATES.AWAITING_FINAL_CONFIRMATION;
const EDIT = WORKFLOW_STATES.WAITING_FOR_EDIT_INSTRUCTION;
const SAVING = WORKFLOW_STATES.SAVING;
function parseYesNo(input) {
  const value = String(input || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  return ['yes', 'y', 'yeah', 'yep'].includes(value) ? 'YES' : ['no', 'n', 'nope'].includes(value) ? 'NO' : null;
}
function command(text) {
  return ({ '1': 'SAVE', SAVE: 'SAVE', '2': 'EDIT', EDIT: 'EDIT', '3': 'DELETE', DELETE: 'DELETE' })[String(text || '').trim().toUpperCase()] || null;
}
function parseWorkerDetails(text, { allowShorthand = true } = {}) {
  const source = String(text || '').trim();
  if (!source) return {};
  const details = {};
  const payment = source.match(/(?:payment\s*(?:type|method)?|paid\s*by)\s*[:=-]\s*([^\n;,]+)/i);
  const shorthand = allowShorthand ? source.match(/\b(cash|bank\s+remittance|bank\s+transfer|credit\s+card|cheque)\b/i) : null;
  const paymentValue = payment?.[1]?.trim().slice(0, 80) || shorthand?.[1];
  if (paymentValue) {
    const normalizedPayment = normalizePaymentMethod(paymentValue);
    if (normalizedPayment) details.payment_type = normalizedPayment;
    else details.payment_type_invalid = paymentValue;
  }
  const customer = {};
  const customerName = source.match(/(?:customer|client)(?:\s+name)?\s*[:=-]\s*([^\n]+)/i);
  const customerPhone = source.match(/(?:customer\s*)?(?:phone|mobile|contact)\s*[:=-]?\s*(\+?\d[\d\s()-]{6,})/i);
  const projectSite = source.match(/(?:project|site|location)\s*[:=-]\s*([^\n;,]+)/i);
  if (customerName) customer.customer_name = customerName[1].split(';')[0].trim().slice(0, 160);
  if (customerPhone) customer.customer_phone = customerPhone[1].replace(/[\s()-]/g, '').slice(0, 20);
  if (projectSite) customer.project_site = projectSite[1].trim().slice(0, 200);
  if (customerName && (!customerPhone || !projectSite)) {
    const parts = customerName[1].split(',').map(part => part.trim()).filter(Boolean);
    if (parts[0]) customer.customer_name = parts[0].slice(0, 160);
    if (!customerPhone && parts[1] && /^\+?\d[\d\s()-]{6,}$/.test(parts[1])) customer.customer_phone = parts[1].replace(/[\s()-]/g, '').slice(0, 20);
    if (!projectSite && parts[2]) customer.project_site = parts.slice(2).join(', ').slice(0, 200);
  }
  if (Object.keys(customer).length) details.customer_details = customer;
  return details;
}
function mergeWorkerDetails(currentBill, text, parsed = parseWorkerDetails(text)) {
  const existing = currentBill.customer_details || {};
  return {
    ...currentBill,
    ...(parsed.payment_type ? { payment_type: parsed.payment_type } : {}),
    ...(parsed.customer_details ? { customer_details: { ...existing, ...parsed.customer_details } } : {}),
  };
}
function createBillWorkflow({ billStore, billExtractionService, zohoBooksClient, whatsappService = null, aiService = null, store = null, config = {} } = {}) {
  function reply(session, text, extra = {}) {
    return { success: true, sessionId: session?.session_id, billId: session?.bill_id, state: session?.state, replyText: text, ...extra };
  }
  async function askForCustomer(session, bill, searchText = '') {
    if (typeof zohoBooksClient?.searchCustomer !== 'function') return null;
    let customers;
    try {
      customers = await zohoBooksClient.searchCustomer({ searchText });
    } catch {
      return reply(session, 'I could not load the Zoho Books customer list. Reply EDIT with the customer name, or try again.', { state: REVIEW, bill });
    }
    const options = (customers || []).slice(0, 10).map(customer => ({
      id: String(customer.id), name: String(customer.name || customer.companyName || 'Unnamed customer').slice(0, 160),
      description: String(customer.phone || customer.email || '').slice(0, 72),
      phone: customer.phone || null, email: customer.email || null,
    })).filter(option => /^[a-zA-Z0-9_-]+$/.test(option.id));
    if (!options.length) {
      return reply(session, searchText ? 'No matching Zoho Books customer was found. Reply with another customer name.' : 'No Zoho Books customers were found. Reply EDIT with the customer name.', { state: REVIEW, bill });
    }
    await billStore.updateBillSession(session.session_id, { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION, customer_options: options, bill_data: bill });
    return reply(session, formatCustomerSelectionPrompt(options), {
      state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION,
      bill,
      replyInteractive: {
        header: 'Customer details', body: 'Select the customer from Zoho Books.', footer: 'Voltronix Contracting LLC',
        button: 'Select customer', sections: [{ title: 'Zoho Books customers', rows: options.map(option => ({ id: `zoho-customer:${option.id}`, title: option.name.slice(0, 24), description: option.description })) }],
      },
    });
  }
  async function selectCustomer(session, incoming) {
    const options = Array.isArray(session.customer_options) ? session.customer_options : [];
    const rawId = incoming.interactiveId || (options[Number(incoming.text) - 1] ? `zoho-customer:${options[Number(incoming.text) - 1].id}` : '');
    const option = options.find(candidate => rawId === `zoho-customer:${candidate.id}` || rawId === candidate.id);
    if (!option) return reply(session, 'Please select one of the customers shown in the Zoho Books list.', { state: WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION });
    // Zoho is authoritative, including missing values; do not retain OCR guesses.
    const bill = { ...session.bill_data, customer_details: { ...(session.bill_data?.customer_details || {}), customer_id: option.id, customer_name: option.name, customer_phone: option.phone || null, customer_email: option.email || null } };
    await billStore.updateBill(session.bill_id, { ...bill, status: 'PENDING_REVIEW' });
    await billStore.updateBillSession(session.session_id, { state: REVIEW, bill_data: bill, customer_options: [], last_message_id: incoming.messageId });
    return reply(session, formatInitialReviewPrompt(bill), { state: REVIEW, bill });
  }
  async function readSingleInput(incoming) {
    const media = Boolean(incoming.mediaId || incoming.mediaBuffer || ['image', 'document', 'pdf', 'audio'].includes(incoming.messageType));
    if (!media) return { text: incoming.text || '', attachment: null };
    let buffer = incoming.mediaBuffer;
    let mimeType = incoming.mediaMimeType;
    if (!buffer && incoming.mediaId && whatsappService?.downloadMedia) {
      const downloaded = await whatsappService.downloadMedia(incoming.mediaId);
      buffer = Buffer.isBuffer(downloaded) ? downloaded : downloaded?.buffer;
      mimeType = downloaded?.mimeType || mimeType;
    }
    if (!Buffer.isBuffer(buffer) || !buffer.length || !mimeType) throw new Error('MEDIA_UNAVAILABLE');
    if (!store?.saveMediaFile) throw new Error('MEDIA_STORAGE_UNAVAILABLE');
    const filename = incoming.mediaFilename || `bill-${randomUUID()}.${mimeType === 'application/pdf' ? 'pdf' : mimeType.split('/')[1]?.split(';')[0] || 'bin'}`;
    const saved = await store.saveMediaFile({ messageId: incoming.messageId, mediaId: incoming.mediaId, buffer, mimeType, filename });
    const storageReference = typeof saved === 'string' ? saved : saved?.storageReference;
    if (!storageReference) throw new Error('MEDIA_NOT_PERSISTED');
    const extracted = await aiService?.extractMediaText({ buffer, mimeType, type: incoming.messageType === 'audio' ? 'audio' : mimeType.startsWith('image/') ? 'image' : 'document' });
    if (typeof extracted !== 'string' || !extracted.trim()) throw new Error('MEDIA_UNREADABLE');
    return { text: [extracted, incoming.text].filter(Boolean).join('\n'), attachment: { storage_reference: storageReference, original_filename: filename, mime_type: mimeType, media_id: incoming.mediaId, message_id: incoming.messageId } };
  }
  async function readInput(incoming) {
    const items = Array.isArray(incoming.items) && incoming.items.length ? incoming.items : [incoming];
    const settled = await Promise.allSettled(items.map(readSingleInput));
    const text = [];
    const attachments = [];
    const failedMessageIds = [];
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index];
      if (outcome.status === 'fulfilled') {
        if (outcome.value.text?.trim()) text.push(outcome.value.text.trim());
        if (outcome.value.attachment) attachments.push(outcome.value.attachment);
      } else {
        failedMessageIds.push(items[index].messageId);
        if (items[index].text?.trim()) text.push(items[index].text.trim());
      }
    }
    if (!text.length) throw new Error('MEDIA_UNREADABLE');
    return { text: text.join('\n'), attachment: attachments[0] || null, attachments, failedMessageIds };
  }
  async function processUnlocked(incoming) {
    if (!incoming.senderPhone) return reply(null, 'Sender phone is required.', { success: false });
    if (config.booksSenders && !config.booksSenders.has(incoming.senderPhone)) return reply(null, null, { success: false, error: { code: 'NOT_AUTHORIZED' } });
    const session = await billStore.getActiveBillSession(incoming.senderPhone);
    const cmd = command(incoming.text);
    const sourceItems = Array.isArray(incoming.items) && incoming.items.length ? incoming.items : [incoming];
    const media = sourceItems.some(item => Boolean(item.mediaId || item.mediaBuffer || ['image', 'document', 'pdf', 'audio'].includes(item.messageType)));
    if (session?.last_message_id === incoming.messageId && incoming.messageId) return reply(session, null, { idempotent: true });
    if (session) {
      const existing = await billStore.getBill(session.bill_id);
      if (session.state === SAVING || existing?.zoho_bill_id) {
        if (existing?.zoho_bill_id && cmd === 'SAVE') return finishCreated(session, existing);
        return reply(session, existing?.zoho_bill_id ? `Bill already created (ID: ${existing.zoho_bill_id}). Reply SAVE to retry the PDF only. No new bill will be created.` : 'The save outcome is unconfirmed. Your draft is retained and locked to prevent duplicates. Please ask an administrator to reconcile it in Zoho Books.');
      }
      if (session.state === WORKFLOW_STATES.WAITING_FOR_CUSTOMER_SELECTION && !media) {
        if (incoming.interactiveId || /^\d+$/.test(String(incoming.text || '').trim())) return selectCustomer(session, incoming);
        return askForCustomer(session, session.bill_data, String(incoming.text || '').trim());
      }
      if (!media && cmd === 'DELETE') {
        await billStore.updateBill(session.bill_id, { status: 'CANCELLED', line_items: [], attachments: [], notes: null });
        await billStore.updateBillSession(session.session_id, { state: 'CANCELLED', bill_data: {}, attachments: [], last_message_id: incoming.messageId });
        return reply(session, 'Pending bill deleted. Nothing was sent to Zoho Books. Please send the next bill.', { state: 'CANCELLED' });
      }
      if (!media && cmd === 'SAVE') {
        const key = createHash('sha256').update(`${session.bill_data?.vendor_name || ''}\n${session.bill_data?.bill_number || ''}`.trim().toLowerCase().replace(/\s+/g, ' ')).digest('hex');
        const run = () => save(session, incoming.messageId);
        return store?.withContactLock ? store.withContactLock(`books-bill:${key}`, run) : run();
      }
      if (!media && cmd === 'EDIT') {
        await billStore.updateBillSession(session.session_id, { state: EDIT, last_message_id: incoming.messageId });
        return reply(session, 'Send corrections, a clearer image, another page of this same bill, or a voice note. Other fields will be preserved.', { state: EDIT });
      }
      if (!media && !cmd && Object.keys(parseWorkerDetails(incoming.text)).length) {
        const parsed = parseWorkerDetails(incoming.text);
        if (parsed.payment_type_invalid) return reply(session, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`, { state: REVIEW, bill: session.bill_data });
        const bill = mergeWorkerDetails(session.bill_data || {}, incoming.text, parsed);
        const attachments = session.attachments || [];
        await billStore.updateBill(session.bill_id, { ...bill, attachments, status: 'PENDING_REVIEW' });
        await billStore.updateBillSession(session.session_id, { state: REVIEW, bill_data: bill, attachments, last_message_id: incoming.messageId });
        return reply(session, formatInitialReviewPrompt(bill), { state: REVIEW, bill });
      }
      if (session.state !== EDIT && session.state !== WORKFLOW_STATES.WAITING_FOR_ADDITIONAL_INFO) return reply(session, media ? 'A bill is already pending. Reply EDIT to add a page or correction to this same bill. Otherwise SAVE or DELETE it before sending another bill.' : formatInitialReviewPrompt(session.bill_data));
      const editDetails = parseWorkerDetails(incoming.text);
      if (!media && editDetails.payment_type_invalid) return reply(session, `Payment method must be one of: ${PAYMENT_METHODS.join(', ')}.`, { state: EDIT });
      try {
        const input = await readInput(incoming);
        const edited = media ? await billExtractionService.mergeAdditionalInfo({ currentBill: session.bill_data, additionalText: input.text }) : await billExtractionService.applyEditInstructions({ currentBill: session.bill_data, editInstruction: input.text });
        if (!edited?.success || !edited.bill) throw new Error('EDIT_FAILED');
        // An incomplete model response must not erase unrelated existing facts.
        const updates = Object.fromEntries(Object.entries(edited.bill).filter(([field, value]) =>
          value != null && (field !== 'line_items' || value.length > 0)));
        const bill = validateBill(mergeWorkerDetails({ ...session.bill_data, ...updates }, incoming.text)).normalizedBill;
        const attachments = [...(session.attachments || []), ...(input.attachments || (input.attachment ? [input.attachment] : []))];
        await billStore.updateBill(session.bill_id, { ...bill, attachments, status: 'PENDING_REVIEW' });
        await billStore.updateBillSession(session.session_id, { state: REVIEW, bill_data: bill, attachments, last_message_id: incoming.messageId });
        return reply(session, formatInitialReviewPrompt(bill), { state: REVIEW, bill });
      } catch { return reply(session, 'I could not read or apply the correction. The existing bill is unchanged. Please resend clear details, or reply DELETE.'); }
    }
    if (!media && (cmd || /^(hi|hello|hey|salaam|start|\?)[.!?]*$/i.test((incoming.text || '').trim()) || !(incoming.text || '').trim())) return reply(null, 'Please send the bill image, PDF, or bill details.');
    try {
      const input = await readInput(incoming);
      const extracted = await billExtractionService.extractBillFromText({ text: input.text, sourceType: incoming.messageType || 'text' });
      if (!extracted?.success || !extracted.bill) throw new Error('EXTRACTION_FAILED');
      const grounded = { ...extracted.bill };
      for (const [field, evidence] of Object.entries(extracted.grounding || {})) {
        if (evidence === 'inferred') grounded[field] = field === 'line_items' ? [] : null;
      }
      const bill = validateBill(mergeWorkerDetails(mergeWorkerDetails(grounded, input.text, parseWorkerDetails(input.text, { allowShorthand: false })), input.text, parseWorkerDetails(input.text))).normalizedBill;
      const attachments = input.attachments || (input.attachment ? [input.attachment] : []);
      const draft = { session_id: randomUUID(), bill_id: randomUUID(), worker_phone: incoming.senderPhone, state: REVIEW, last_message_id: incoming.messageId, bill_data: bill, attachments };
      await billStore.createBillSession(draft);
      await billStore.saveBill({ ...bill, bill_id: draft.bill_id, session_id: draft.session_id, worker_phone: draft.worker_phone, source_message_id: incoming.messageId, attachments, status: 'PENDING_REVIEW' });
      const customerPrompt = await askForCustomer(draft, bill);
      if (customerPrompt) return customerPrompt;
      return reply(draft, formatInitialReviewPrompt(bill), { bill });
    } catch { return reply(null, 'I could not read or store this bill safely. Nothing was saved to Zoho Books. Please send a clearer image/PDF or the bill details as text.'); }
  }
  async function save(session, messageId) {
    const validation = validateBill(session.bill_data);
    const bill = { ...validation.normalizedBill, payment_type: normalizePaymentMethod(validation.normalizedBill.payment_type) };
    const customer = bill.customer_details || {};
    if (!bill.payment_type || !customer.customer_name) {
      return reply(session, `Before SAVE, please send a valid payment method and customer details.\nPayment method: ${PAYMENT_METHODS.join(' / ')}\nCustomer: ABC Contracting, 0501234567, Dubai site`);
    }
    const missing = ['bill_number', 'bill_date', 'currency'].filter(field => !bill[field]);
    if (!validation.valid || missing.length || !bill.line_items?.length || bill.line_items.some(item => !Number.isFinite(item.quantity) || item.quantity <= 0 || !Number.isFinite(item.rate))) return reply(session, `Cannot save yet: ${validation.issues[0]?.message || (missing.length ? `Please supply ${missing.join(', ')}.` : 'Each item needs a quantity and rate.')}\nReply EDIT to correct it, or DELETE.`);
    if (!await billStore.claimBillSave(session.session_id, messageId)) return reply(session, 'This bill is already being saved. Please wait.');
    await billStore.updateBill(session.bill_id, { payment_type: bill.payment_type, customer_details: bill.customer_details });
    const reviewFailure = async text => {
      await billStore.updateBillSession(session.session_id, { state: REVIEW });
      return reply(session, `${text}\nReply SAVE to retry, EDIT to correct, or DELETE.`, { state: REVIEW });
    };
    let vendor;
    try {
      const vendors = await zohoBooksClient.searchVendor({ searchText: bill.vendor_name, name: bill.vendor_name });
      const key = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const matches = vendors.filter(v => key(v.name) === key(bill.vendor_name) || key(v.companyName) === key(bill.vendor_name));
      if (matches.length !== 1 || !matches[0].id) return reviewFailure('Vendor not found or ambiguous. Please check the vendor in Zoho Books.');
      vendor = matches[0];
      const duplicate = await zohoBooksClient.checkDuplicateBill({ billNumber: bill.bill_number, vendorId: vendor.id });
      if (duplicate?.found) return reviewFailure(formatDuplicateWarning({ billNumber: bill.bill_number, vendorName: bill.vendor_name, existingBillId: duplicate.bills?.[0]?.id }));
      if (zohoBooksClient.prepareBill) await zohoBooksClient.prepareBill(bill, vendor);
    } catch (error) {
      return reviewFailure('Zoho vendor, currency, tax or duplicate validation failed. Nothing was created.');
    }
    await billStore.updateBill(session.bill_id, { status: 'CREATING', zoho_status: 'SYNCING', zoho_vendor_id: vendor.id });
    try {
      const detailNote = [`Payment method: ${bill.payment_type}`, `Customer: ${customer.customer_name}`, customer.customer_id ? `Zoho customer ID: ${customer.customer_id}` : null, customer.customer_phone ? `Customer phone: ${customer.customer_phone}` : null, customer.project_site ? `Project/site: ${customer.project_site}` : null].filter(Boolean).join(' | ');
      const notes = [bill.notes, detailNote].filter(Boolean).join('\n');
      const created = await zohoBooksClient.createBill({ vendorId: vendor.id, billNumber: bill.bill_number, billDate: bill.bill_date, dueDate: bill.due_date, lineItems: bill.line_items, total: bill.total_amount, currency: bill.currency, currencyId: bill.currency_id, customerId: customer.customer_id || null, paymentType: bill.payment_type, notes });
      if (!created?.id) throw new Error('MISSING_ZOHO_ID');
      // Persist the returned ID BEFORE any attachment or outbound document work.
      await billStore.updateBill(session.bill_id, { zoho_bill_id: created.id, zoho_bill_url: zohoBooksClient.buildZohoBillUrl(created.id), zoho_status: 'SYNCED', status: 'COMPLETED' });
    } catch (error) {
      if ([400, 401, 403, 422].includes(error.httpStatus) && error.providerCode) {
        await billStore.updateBill(session.bill_id, { status: 'PENDING_REVIEW', zoho_status: 'FAILED', zoho_error: 'ZOHO_REJECTED_BILL' });
        return reviewFailure('Zoho rejected this bill. Please check the accounting fields and permissions.');
      }
      await billStore.updateBill(session.bill_id, { zoho_error: 'CREATE_OUTCOME_UNCONFIRMED' });
      return reply(session, 'Zoho save could not be confirmed. Your draft is retained and locked to prevent duplicates. An administrator must reconcile the result before another save.', { state: SAVING });
    }
    return finishCreated(session, await billStore.getBill(session.bill_id));
  }
  async function finishCreated(session, record) {
    const id = record.zoho_bill_id;
    const attachments = [...(session.attachments || [])];
    for (const attachment of attachments) {
      if (attachment.zoho_upload_status === 'uploaded') continue;
      try {
        const saved = await store?.getMediaFile(attachment.storage_reference);
        const buffer = Buffer.isBuffer(saved) ? saved : saved?.buffer;
        if (!buffer) throw new Error('MEDIA_UNAVAILABLE');
        await zohoBooksClient.attachBillFile({ billId: id, buffer, filename: attachment.original_filename, mimeType: attachment.mime_type });
        attachment.zoho_upload_status = 'uploaded';
      } catch { attachment.zoho_upload_status = 'failed'; }
      await billStore.updateBillSession(session.session_id, { attachments });
      await billStore.updateBill(session.bill_id, { attachments });
    }
    const summary = formatSuccessReport({ bill: record, zohoBillId: id, zohoBillUrl: zohoBooksClient.buildZohoBillUrl(id), attachmentStatus: attachments.some(a => a.zoho_upload_status === 'failed') ? 'FAILED' : attachments.length ? 'ATTACHED' : 'NONE' });
    if (['SENDING', 'UNKNOWN'].includes(record.pdf_delivery_status)) return reply(session, `${summary}\nPDF delivery is unconfirmed. Ask an administrator to check delivery; it will not be sent twice automatically.`);
    if (record.pdf_delivery_status === 'ACCEPTED') {
      await billStore.completeBillSession(session.session_id);
      return reply(session, `${summary}\nThe PDF was accepted by WhatsApp.`, { state: 'COMPLETED' });
    }
    let document;
    try {
      document = await zohoBooksClient.getBillPdf(id);
      if (document.bill && (Math.abs(document.bill.total - record.total_amount) > 0.05 || document.bill.currency_code !== record.currency)) {
        await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'RECORD_MISMATCH' });
        return reply(session, `${summary}\nThe saved record amount or currency differs from the reviewed bill. Please ask an administrator to reconcile it. No second bill will be created.`);
      }
      if (!Buffer.isBuffer(document?.buffer) || document.buffer.subarray(0, 5).toString() !== '%PDF-') throw new Error('INVALID_PDF');
    } catch {
      await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'FETCH_FAILED' });
      return reply(session, `${summary}\nThe created bill PDF could not be retrieved. Reply SAVE to retry the PDF only; the bill will not be recreated.`);
    }
    await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'SENDING' });
    let delivery;
    try { delivery = await whatsappService.sendDocument(session.worker_phone, { buffer: document.buffer, filename: `Zoho-Bill-${id}.pdf`, caption: `PDF copy of saved Zoho Books bill ${record.bill_number || id}` }); }
    catch (error) {
      const status = ['NOT_ATTEMPTED', 'ATTEMPTED_FAILED'].includes(error.deliveryState) ? 'FAILED' : 'UNKNOWN';
      await billStore.updateBill(session.bill_id, { pdf_delivery_status: status });
      return reply(session, `${summary}\nPDF delivery ${status === 'UNKNOWN' ? 'is unconfirmed; ask an administrator to check it' : 'failed; reply SAVE to retry the PDF only'}. The bill will not be recreated.`);
    }
    await billStore.updateBill(session.bill_id, { pdf_delivery_status: 'ACCEPTED', pdf_message_id: delivery?.messages?.[0]?.id || null });
    await billStore.completeBillSession(session.session_id);
    return reply(session, `${summary}\nCreated bill PDF accepted by WhatsApp.`, { state: 'COMPLETED', zohoBillId: id });
  }
  async function processMessage(incoming = {}) {
    const run = () => processUnlocked(incoming);
    return store?.withContactLock && incoming.senderPhone ? store.withContactLock(`books:${incoming.senderPhone}`, run) : run();
  }
  return { processMessage, parseYesNo, WORKFLOW_STATES };
}
module.exports = { createBillWorkflow, parseYesNo, parseWorkerDetails, PAYMENT_METHODS, WORKFLOW_STATES };
