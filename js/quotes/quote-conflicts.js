/* Three-way builder input merge. Work-line arrays stay together: index-based
 * matching could silently pair different rooms after an insertion or removal.
 */
;(function (global) {
  'use strict';
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const equal = (a, b) => a === undefined || b === undefined ? a === b : global.AAA_BACKUP_FORMAT.canonical(a) === global.AAA_BACKUP_FORMAT.canonical(b);
  function merge(base, local, remote, choices) {
    // Validate first so imported keys cannot be used as object paths.
    [base, local, remote].forEach(v => global.AAA_BACKUP_FORMAT.canonical(v));
    const conflicts = [];
    function visit(b, l, r, path) {
      if (equal(l, r)) return clone(l);
      if (equal(l, b)) return clone(r);
      if (equal(r, b)) return clone(l);
      if (object(b) && object(l) && object(r)) {
        const result = {};
        for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
          const value = visit(b[key], l[key], r[key], path.concat(key));
          if (value !== undefined) result[key] = value;
        }
        return result;
      }
      const id = JSON.stringify(path), choice = choices && choices[id];
      if (choice === 'local') return clone(l);
      if (choice === 'remote') return clone(r);
      conflicts.push({ id, path, base: clone(b), local: clone(l), remote: clone(r) });
      return clone(l);
    }
    return { input: visit(base, local, remote, []), conflicts };
  }
  global.AAA_QUOTE_CONFLICTS = { merge };
})(typeof window !== 'undefined' ? window : this);
