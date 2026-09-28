'use strict';

const { readOrganizationIds } = require('./organizations');

function accountError(code) {
  return Object.assign(new Error('The configured bill accounting account could not be verified.'), {
    code, operation: 'resolveBillAccount',
  });
}

function createBillAccountResolver({ env, readAccount }) {
  // Reuse verification only between prepareBill and its immediate createBill.
  // No cross-bill cache: every new SAVE checks the current account status.
  const preparedAccounts = new WeakMap();

  function configuration(organizationId) {
    const ids = readOrganizationIds(env);
    const matches = Object.keys(ids).filter(key => ids[key] && ids[key] === organizationId);
    if (matches.length > 1) throw accountError('BILL_ACCOUNT_ORGANIZATION_AMBIGUOUS');
    if (!matches.length) return null;
    const prefix = `ZOHO_BOOKS_${matches[0].toUpperCase()}_DEFAULT_ACCOUNT_`;
    const id = env[`${prefix}ID`];
    const name = env[`${prefix}NAME`];
    if ((id != null && typeof id !== 'string') || (name != null && typeof name !== 'string')) {
      throw accountError('BILL_ACCOUNT_CONFIG_INVALID');
    }
    const accountId = (id || '').trim();
    const accountName = (name || '').trim();
    // An unconfigured organization keeps its existing payload/permissions.
    // In particular, never inherit Contracting's mapping in Switchgear.
    if (!accountId && !accountName) return null;
    if (!/^\d{1,128}$/.test(accountId)) throw accountError('BILL_ACCOUNT_CONFIG_INVALID');
    return { organizationId, accountId, accountName };
  }

  async function verify(config) {
    if (!config) return null;
    let data;
    try { data = await readAccount(config.accountId, config.organizationId); }
    catch {
      // Drop raw transport/provider text: it can contain credentials or PII.
      throw accountError('BILL_ACCOUNT_LOOKUP_FAILED');
    }
    const account = data?.chart_of_account;
    if (!account || typeof account !== 'object' || data.code !== 0) throw accountError('BILL_ACCOUNT_NOT_FOUND');
    if (String(account.account_id) !== config.accountId) throw accountError('BILL_ACCOUNT_MISMATCH');
    if (account.organization_id != null && String(account.organization_id) !== config.organizationId) {
      throw accountError('BILL_ACCOUNT_ORGANIZATION_MISMATCH');
    }
    if (account.is_active !== true) throw accountError('BILL_ACCOUNT_INACTIVE');
    if (!['expense', 'cost_of_goods_sold', 'other_expense'].includes(account.account_type)) {
      throw accountError('BILL_ACCOUNT_TYPE_INVALID');
    }
    if (config.accountName && account.account_name !== config.accountName) throw accountError('BILL_ACCOUNT_NAME_MISMATCH');
    return config.accountId;
  }

  return {
    clear(lineItems) { preparedAccounts.delete(lineItems); },
    async prepare(lineItems, organizationId) {
      preparedAccounts.delete(lineItems);
      const config = configuration(organizationId);
      const accountId = await verify(config);
      if (accountId) preparedAccounts.set(lineItems, { ...config, accountId });
    },
    async forCreate(lineItems, organizationId) {
      const prepared = preparedAccounts.get(lineItems);
      preparedAccounts.delete(lineItems);
      const config = configuration(organizationId);
      if (config && prepared && prepared.organizationId === config.organizationId
          && prepared.accountId === config.accountId && prepared.accountName === config.accountName) {
        return prepared.accountId;
      }
      return verify(config);
    },
  };
}

module.exports = { createBillAccountResolver };
