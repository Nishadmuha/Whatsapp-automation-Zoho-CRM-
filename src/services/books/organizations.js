'use strict';

const BOOKS_ORGANIZATIONS = Object.freeze([
  Object.freeze({
    name: 'VOLTRONIX CONTRACTING LLC',
    organizationId: '828765858',
    aliases: Object.freeze(['VOLTRONIX CONTRACTING LLC', 'VOLTRONIX CONTRACTING']),
  }),
  Object.freeze({
    name: 'VOLTRONIX SWITCHGEAR LLC',
    organizationId: '802911060',
    aliases: Object.freeze(['VOLTRONIX SWITCHGEAR LLC', 'VOLTRONIX SWITCHGEAR']),
  }),
]);

function compactName(value) {
  return String(value || '').normalize('NFKC').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function confidence(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function organizationById(value) {
  const id = String(value || '').trim();
  return BOOKS_ORGANIZATIONS.find(organization => organization.organizationId === id) || null;
}

function organizationByName(value) {
  const candidate = compactName(value);
  if (!candidate) return null;
  return BOOKS_ORGANIZATIONS.find(organization => organization.aliases.some(alias => compactName(alias) === candidate)) || null;
}

function resolveOrganization(input, { selected = false } = {}) {
  if (!input) return null;
  const source = typeof input === 'string' ? { name: input } : input;
  if (!source || typeof source !== 'object') return null;

  const id = source.organizationId ?? source.organization_id ?? source.id;
  const name = source.name ?? source.organizationName ?? source.companyName;
  const byId = organizationById(id);
  const byName = organizationByName(name);
  if ((id && !byId) || (name && !byName)) return null;
  if (byId && byName && byId.organizationId !== byName.organizationId) return null;
  const organization = byId || byName;
  if (!organization) return null;

  return {
    name: organization.name,
    organizationId: organization.organizationId,
    confidence: confidence(source.confidence, selected ? 1 : null),
  };
}

function findOrganizationsInText(text) {
  // Match complete company-name tokens, not substrings of another company's
  // name. Normalize punctuation/spacing only; never fuzzy-match OCR guesses.
  const source = String(text || '').normalize('NFKC').toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\bL\s+L\s+C\b/g, 'LLC').trim();
  if (!source) return [];
  return BOOKS_ORGANIZATIONS.filter(organization => ` ${source} `.includes(` ${organization.name} `));
}

module.exports = {
  BOOKS_ORGANIZATIONS,
  compactName,
  findOrganizationsInText,
  organizationById,
  organizationByName,
  resolveOrganization,
};
