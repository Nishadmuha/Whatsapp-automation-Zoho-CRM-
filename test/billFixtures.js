'use strict';
const { createBillWorkflow } = require('../src/services/books/billWorkflow');
const WORKER = '+971568556901';
const validBill = () => ({ vendor_name: 'Supplier LLC', bill_number: 'INV-100', bill_date: '2026-09-19', due_date: null, currency: 'AED', subtotal: 100, tax_amount: 5, total_amount: 105, line_items: [{ name: 'Cable', quantity: 2, rate: 50, amount: 100, tax_percentage: 5 }], payment_type: 'Credit Card', customer_details: { customer_name: 'ABC Contracting', customer_phone: '+971501234567', project_site: 'Dubai site' }, notes: null });
function memoryStore() {
  const sessions = new Map(), bills = new Map();
  return {
    sessions, bills,
    async getActiveBillSession(phone) { return [...sessions.values()].find(s => s.worker_phone === phone && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(s.state)); },
    async createBillSession(s) { sessions.set(s.session_id, structuredClone(s)); return s; },
    async getBillSession(id) { return sessions.get(id); },
    async updateBillSession(id, updates) { Object.assign(sessions.get(id), updates); return sessions.get(id); },
    async completeBillSession(id) { return this.updateBillSession(id, { state: 'COMPLETED' }); },
    async claimBillSave(id, messageId) { const s = sessions.get(id); if (s.state === 'CREATING_IN_ZOHO') return false; s.state = 'CREATING_IN_ZOHO'; s.last_message_id = messageId; return true; },
    async saveBill(b) { bills.set(b.bill_id, structuredClone(b)); return b; },
    async updateBill(id, updates) { Object.assign(bills.get(id), updates); return bills.get(id); },
    async getBill(id) { return bills.get(id); },
  };
}
function fixture({ billStore = memoryStore(), sourceStore, bill = validBill(), zohoOverrides = {}, whatsappOverrides = {}, extractionOverrides = {} } = {}) {
  const calls = [], media = new Map();
  let next = 0;
  const extraction = {
    async extractBillFromText(input) { calls.push(['extract', input]); return { success: true, bill: structuredClone(bill) }; },
    async applyEditInstructions({ currentBill, editInstruction }) { calls.push(['edit', editInstruction]); return { success: true, bill: { ...currentBill, notes: editInstruction } }; },
    async mergeAdditionalInfo({ currentBill, additionalText }) { calls.push(['merge', additionalText]); return { success: true, bill: { ...currentBill, notes: additionalText } }; },
    ...extractionOverrides,
  };
  const zoho = {
    async searchVendor() { calls.push(['vendor']); return [{ id: 'v1', name: bill.vendor_name }]; },
    async checkDuplicateBill() { calls.push(['duplicate']); return { found: false }; },
    async createBill(data) { calls.push(['create', data]); return { id: '123456', ...data }; },
    async attachBillFile(data) { calls.push(['attach', data]); return { success: true }; },
    async getBillPdf(id) { calls.push(['pdf', id]); return { buffer: Buffer.from('%PDF-created-record') }; },
    buildZohoBillUrl(id) { return `https://books.zoho.com/app/org#/bills/${id}`; },
    ...zohoOverrides,
  };
  const whatsapp = {
    async downloadMedia(id) { calls.push(['download', id]); return { buffer: Buffer.from('original-image'), mimeType: 'image/jpeg' }; },
    async sendDocument(to, document) { calls.push(['document', to, document]); return { messages: [{ id: 'wamid.pdf' }] }; },
    async sendTextMessage(to, text) { calls.push(['text', to, text]); return { messages: [{ id: 'wamid.text' }] }; },
    ...whatsappOverrides,
  };
  const store = sourceStore || {
    async saveMediaFile(data) { const ref = 'stored-' + media.size; media.set(ref, data); return { storageReference: ref }; },
    async getMediaFile(ref) { return media.get(ref); },
  };
  const ai = { async extractMediaText(input) { calls.push(['ocr', input]); return 'Supplier LLC INV-100 Cable 2 50 100 VAT 5 Total 105 AED 2026-09-19'; } };
  const workflow = createBillWorkflow({ billStore, billExtractionService: extraction, zohoBooksClient: zoho, whatsappService: whatsapp, aiService: ai, store });
  const send = (text, extra = {}) => workflow.processMessage({ messageId: `m-${++next}`, senderPhone: WORKER, messageType: 'text', text, ...extra });
  return { workflow, billStore, calls, extraction, zoho, whatsapp, store, ai, send, media };
}
module.exports = { WORKER, validBill, memoryStore, fixture };
