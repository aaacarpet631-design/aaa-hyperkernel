/*
 * Pure, dependency-free helpers for the QBO proxy — unit-testable without
 * firebase-admin or network. index.js requires these.
 */
'use strict';

// Strip client-supplied fields; emit only the QBO Invoice shape we allow.
function sanitizeInvoice(inv) {
  const out = { Line: [], CustomerRef: (inv && inv.CustomerRef) || undefined };
  if (inv && inv.TxnDate) out.TxnDate = inv.TxnDate;
  ((inv && inv.Line) || []).forEach((l) => {
    out.Line.push({
      DetailType: 'SalesItemLineDetail',
      Amount: Number((l && l.Amount) || 0),
      Description: String((l && l.Description) || 'Services'),
      SalesItemLineDetail: { ItemRef: (l && l.SalesItemLineDetail && l.SalesItemLineDetail.ItemRef) || { name: 'Services' } }
    });
  });
  return out;
}

// Is a stored token expired? (with a clock-skew cushion in ms)
function isExpired(expiresAt, skewMs) {
  if (!expiresAt) return true;
  return Date.parse(expiresAt) < (Date.now() + (skewMs || 0));
}

// API base for an environment.
function apiBase(env) {
  return env === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
}

// Decide whether an upstream HTTP status is worth retrying.
function isRetryable(status) {
  return status === 429 || (status >= 500 && status <= 599) || status === 0;
}

module.exports = { sanitizeInvoice, isExpired, apiBase, isRetryable };
