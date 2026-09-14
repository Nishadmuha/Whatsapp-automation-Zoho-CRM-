'use strict';

const mongoose = require('mongoose');
const { getLeadModel } = require('./leadModel');

function isMongoConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function syncLeadToMongo(leadData, { logger } = {}) {
  if (!isMongoConnected()) return null;
  const leadId = leadData?.leadId || leadData?.id;
  if (!leadId) return null;
  try {
    const Lead = getLeadModel();

    const doc = {
      leadId,
      source: leadData.source || 'boss',
      senderPhone: leadData.senderPhone || leadData.sender_phone,
      senderName: leadData.senderName || leadData.sender_name || null,
      companyName: leadData.companyName || leadData.company_name || null,
      contactName: leadData.contactName || leadData.contact_name || null,
      phone: leadData.phone || null,
      email: leadData.email || null,
      projectLocation: leadData.projectLocation || leadData.project_location || null,
      projectName: leadData.projectName || leadData.project_name || null,
      productOrService: leadData.productOrService || leadData.product_or_service || null,
      requirement: leadData.requirement || null,
      quantity: leadData.quantity || null,
      deadline: leadData.deadline || null,
      notes: leadData.notes || null,
      address: leadData.address || null,
      trnNo: leadData.trnNo || leadData.trn_no || null,
      originalMessage: leadData.originalMessage || leadData.original_message || '',
      extractedData: leadData.extractedData || leadData.extracted_data || leadData.result || {},
      validationStatus: leadData.validationStatus || leadData.validation_status || 'pending',
      confirmationStatus: leadData.confirmationStatus || leadData.confirmation_status || 'collecting',
      zohoStatus: leadData.zohoStatus || leadData.zoho_status || 'not_started',
      zohoLeadId: leadData.zohoLeadId || leadData.zoho_lead_id || null,
      zohoError: leadData.zohoError || leadData.zoho_error || null,
    };

    const updateOps = { $set: doc };
    if (leadData.message) {
      updateOps.$addToSet = { messages: leadData.message };
    }
    if (leadData.attachment) {
      updateOps.$addToSet = { ...(updateOps.$addToSet || {}), attachments: leadData.attachment };
    }

    const lead = await Lead.findOneAndUpdate(
      { leadId },
      updateOps,
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    logger?.info?.({ event: 'mongo_lead_saved', leadId, action: 'upsert' });
    return lead;
  } catch (error) {
    logger?.error?.({ event: 'mongo_lead_save_error', leadId, error: error.message });
    throw error;
  }
}

async function updateLeadZohoInMongo(leadId, zohoData, { logger } = {}) {
  if (!isMongoConnected() || !leadId) return null;
  try {
    const Lead = getLeadModel();
    const update = {
      zohoStatus: zohoData.zohoStatus,
      updatedAt: new Date(),
    };
    if (zohoData.zohoLeadId) update.zohoLeadId = zohoData.zohoLeadId;
    if (zohoData.zohoError) update.zohoError = zohoData.zohoError;

    const lead = await Lead.findOneAndUpdate(
      { leadId },
      { $set: update },
      { returnDocument: 'after' }
    );
    return lead;
  } catch (error) {
    logger?.warn?.({ event: 'mongo_zoho_update_error', error: error.message }, 'Failed to update Zoho status in MongoDB');
    return null;
  }
}

async function getLeadFromMongo(leadId) {
  if (!isMongoConnected() || !leadId) return null;
  try {
    const Lead = getLeadModel();
    return await Lead.findOne({ leadId }).lean();
  } catch {
    return null;
  }
}

module.exports = {
  isMongoConnected,
  syncLeadToMongo,
  updateLeadZohoInMongo,
  getLeadFromMongo,
};
