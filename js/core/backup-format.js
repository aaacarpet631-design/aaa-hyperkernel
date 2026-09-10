/* Portable backups contain only validated JSON, with a checksum covering both
 * records and metadata. A checksum detects corruption; it is not a signature.
 */
;(function (global) {
  'use strict';
  const COLLECTIONS = ['jobs', 'customers', 'quotes', 'quote_builder_working', 'audit_log', 'outcomes'];
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const safe = k => typeof k === 'string' && k.length > 0 && k.length <= 200 && !['__proto__', 'constructor', 'prototype'].includes(k);
  function canonical(value, depth = 0) {
    if (depth > 50) throw new Error('Backup nesting exceeds the supported limit.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + Array.from(value, v => canonical(v, depth + 1)).join(',') + ']';
    if (!object(value) || Object.prototype.toString.call(value) !== '[object Object]' || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Backup contains unsupported data.');
    const keys = Object.keys(value).sort();
    if (keys.some(k => ['__proto__', 'constructor', 'prototype'].includes(k))) throw new Error('Backup contains unsafe keys.');
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
  }
  async function digest(value) {
    const bytes = new TextEncoder().encode(canonical(value));
    const hash = await global.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
  }
  function validate(snapshot, workspace) {
    if (!object(snapshot) || snapshot.version !== 2 || !safe(snapshot.workspaceId) || snapshot.workspaceId !== workspace || !object(snapshot.collections)) throw new Error('Choose a backup from this workspace.');
    const names = Object.keys(snapshot.collections);
    if (names.length !== COLLECTIONS.length || names.some(n => !COLLECTIONS.includes(n))) throw new Error('Backup collections are incomplete or unsupported.');
    for (const rows of Object.values(snapshot.collections)) {
      if (!object(rows) || Object.keys(rows).length > 20000 || Object.entries(rows).some(([k, r]) => !safe(k) || !object(r) || r.workspaceId !== workspace)) throw new Error('Backup contains invalid or mixed-workspace records.');
    }
    if (new TextEncoder().encode(canonical(snapshot)).byteLength > 5 * 1024 * 1024) throw new Error('Backup exceeds the 5 MB limit.');
    return snapshot;
  }
  async function seal(payload) {
    const { checksum: _checksum, ...body } = payload;
    return Object.assign({}, body, { checksum: await digest(body) });
  }
  async function verify(snapshot, workspace) {
    validate(snapshot, workspace);
    if (!/^[a-f0-9]{64}$/.test(snapshot.checksum || '')) throw new Error('This backup has no valid integrity checksum.');
    const { checksum, ...body } = snapshot;
    if (await digest(body) !== checksum) throw new Error('Backup checksum mismatch. The file may be damaged; no records were changed.');
    return snapshot;
  }
  global.AAA_BACKUP_FORMAT = { COLLECTIONS, canonical, digest, seal, verify, validate };
})(typeof window !== 'undefined' ? window : globalThis);
