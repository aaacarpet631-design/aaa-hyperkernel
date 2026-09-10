/* Shared customer picker: search and create in the accessible sheet system. */
;(function (global) {
  'use strict';
  async function pick() {
    const U = global.AAA_UI, store = global.AAA_CUSTOMER_STORE;
    const customers = store ? await store.list() : [];
    return new Promise(resolve => {
      let result = null, busy = false;
      const sheet = U.sheet({ title: 'Choose a customer', subtitle: 'Reuse saved contact details.', beforeClose: () => !busy, onClose: () => resolve(result) });
      const search = U.el('input', { className: 'aaa-input', attrs: { type: 'search', 'aria-label': 'Search customers', placeholder: 'Name, address, phone or email' } });
      const list = U.el('div', { className: 'aaa-picker-list' });
      function render() {
        list.innerHTML = '';
        const query = search.value.trim().toLowerCase();
        const matches = customers.filter(c => [c.name, c.address, c.phone, c.email].join(' ').toLowerCase().includes(query));
        if (!matches.length) list.appendChild(U.el('p', { text: customers.length ? 'No matching customers.' : 'No saved customers yet.' }));
        for (const customer of matches) {
          const row = U.button({ label: customer.name + (customer.address ? ' · ' + customer.address : ''), variant: 'secondary', full: true, onClick: () => { result = customer; sheet.close(); } });
          list.appendChild(row);
        }
      }
      search.addEventListener('input', render);
      sheet.body.appendChild(search); sheet.body.appendChild(list);
      if (store && global.AAA_RBAC && global.AAA_RBAC.can('EDIT_CUSTOMER')) {
        const details = U.el('details'); details.appendChild(U.el('summary', { text: 'Add a new customer' }));
        const form = U.el('form', { className: 'aaa-form' });
        const fields = {};
        for (const [key, label, type] of [['name', 'Name', 'text'], ['address', 'Service address', 'text'], ['phone', 'Phone', 'tel'], ['email', 'Email', 'email'], ['gateCode', 'Access code', 'text'], ['source', 'Lead source', 'text']]) {
          fields[key] = U.el('input', { className: 'aaa-input', attrs: { type, 'aria-label': label, maxlength: key === 'address' ? '500' : '200' } });
          if (key === 'name') fields[key].required = true;
          form.appendChild(U.el('label', { text: label }, [fields[key]]));
        }
        const error = U.el('p', { attrs: { role: 'alert' } });
        const submit = U.button({ label: 'Save & use customer', variant: 'primary' }); submit.type = 'submit';
        form.addEventListener('submit', async event => {
          event.preventDefault(); if (busy) return;
          if (!fields.name.value.trim()) { fields.name.focus(); return; }
          busy = true; form.inert = true; list.inert = true;
          try {
            result = await store.add(Object.fromEntries(Object.entries(fields).map(([key, input]) => [key, input.value.trim()])));
            sheet.close();
          } catch (_) { error.textContent = 'Customer could not be saved. Keep this form open and retry when device storage is available.'; }
          finally { busy = false; form.inert = false; list.inert = false; }
        });
        form.appendChild(submit); details.appendChild(form); details.appendChild(error); sheet.body.appendChild(details);
      }
      sheet.body.appendChild(U.button({ label: 'Cancel', variant: 'ghost', onClick: () => { if (!busy) sheet.close(); } }));
      document.body.appendChild(sheet.overlay); render();
    });
  }
  global.AAA_CUSTOMER_PICKER_UI = { pick };
})(typeof window !== 'undefined' ? window : this);
