/*
 * Pure, dependency-free helpers for the portal proxy — unit-testable without
 * firebase-admin or network. The redaction here is security-critical: the
 * public customer view is built by WHITELIST, so internal financials
 * (labor/material cost, margins, internal notes) can never leak even if they
 * exist on the source records.
 */
'use strict';

// Is a portal link currently usable?
function linkLive(link, nowMs) {
  if (!link || link.revoked) return false;
  if (link.expiresAt && Date.parse(link.expiresAt) < (nowMs || Date.now())) return false;
  return true;
}

// Build the customer-safe contract view. WHITELIST ONLY.
function publicContract(contract) {
  if (!contract) return null;
  return {
    customerName: String(contract.customerName || 'Customer'),
    // Each line: description + amount only. Never _labor/_material/cost/margin.
    lines: (Array.isArray(contract.lines) ? contract.lines : []).map((l) => ({
      description: String((l && l.description) || ''),
      amount: Number((l && l.amount) || 0)
    })),
    total: Number(contract.total || 0),
    terms: Array.isArray(contract.terms) ? contract.terms.map(String) : [],
    status: contract.status === 'signed' ? 'signed' : (contract.status === 'void' ? 'void' : 'draft'),
    signed: contract.status === 'signed',
    signedBy: contract.signature ? String(contract.signature.name || '') : null,
    signedAt: contract.signature ? String(contract.signature.signedAt || '') : null
  };
}

// Build the customer-safe invoice view (amount + payment status only).
function publicInvoice(invoice, paidAmount) {
  if (!invoice) return null;
  const total = Number(invoice.amount || 0);
  const paid = Number(paidAmount || 0);
  return {
    total: total,
    paid: Math.min(paid, total),
    balance: Math.max(0, Math.round((total - paid) * 100) / 100),
    status: invoice.status === 'paid' || paid + 1e-6 >= total ? 'paid' : (paid > 0 ? 'partial' : 'unpaid')
  };
}

// Assemble the whole public payload from raw records.
function buildView(opts) {
  const o = opts || {};
  return {
    ok: true,
    businessName: o.businessName || 'AAA Carpet',
    contract: publicContract(o.contract),
    invoice: o.invoice ? publicInvoice(o.invoice, o.paidAmount) : null,
    canSign: !!(o.link && o.link.allowSign) && o.contract && o.contract.status === 'draft'
  };
}

module.exports = { linkLive, publicContract, publicInvoice, buildView };
