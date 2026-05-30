/*
 * AAA Customer Picker UI
 *
 * A modal for choosing the customer a job belongs to. It lists existing
 * customers (filterable) and offers an inline "add new customer" form. The
 * public pick() method resolves with the chosen/created customer record, or
 * null if the user cancels. It owns no global state beyond the single modal it
 * builds on demand.
 */
;(function (global) {
  'use strict';

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function createPicker() {
    /**
     * Open the picker. Resolves with a customer object or null on cancel.
     * @returns {Promise<Object|null>}
     */
    function pick() {
      return new Promise(async (resolve) => {
        const customerStore = global.AAA_CUSTOMER_STORE;
        let customers = [];
        try {
          customers = customerStore ? await customerStore.list() : [];
        } catch (_) {
          customers = [];
        }

        const overlay = el('div', 'aaa-modal-overlay');
        const modal = el('div', 'aaa-modal');
        const title = el('h2', 'aaa-modal-title', 'Select Customer');

        const search = el('input', 'aaa-input');
        search.type = 'search';
        search.placeholder = 'Search customers…';

        const listWrap = el('div', 'aaa-picker-list');

        function close(result) {
          overlay.remove();
          document.removeEventListener('keydown', onKey);
          resolve(result || null);
        }

        function onKey(e) {
          if (e.key === 'Escape') close(null);
        }

        function renderList(filter) {
          listWrap.innerHTML = '';
          const f = (filter || '').trim().toLowerCase();
          const matches = customers.filter(
            (c) =>
              !f ||
              String(c.name || '').toLowerCase().includes(f) ||
              String(c.address || '').toLowerCase().includes(f)
          );
          if (matches.length === 0) {
            listWrap.appendChild(
              el('p', 'aaa-empty', customers.length ? 'No matches.' : 'No customers yet — add one below.')
            );
            return;
          }
          matches.forEach((c) => {
            const row = el('button', 'aaa-picker-row');
            row.type = 'button';
            row.appendChild(el('span', 'aaa-picker-name', c.name || 'Unnamed'));
            if (c.address) row.appendChild(el('span', 'aaa-picker-sub', c.address));
            row.addEventListener('click', () => close(c));
            listWrap.appendChild(row);
          });
        }

        search.addEventListener('input', () => renderList(search.value));

        // --- Add new customer form ---
        const addTitle = el('h3', 'aaa-modal-subtitle', 'Add New Customer');
        const nameInput = el('input', 'aaa-input');
        nameInput.placeholder = 'Name *';
        const addrInput = el('input', 'aaa-input');
        addrInput.placeholder = 'Service address';
        const phoneInput = el('input', 'aaa-input');
        phoneInput.placeholder = 'Phone';
        const gateInput = el('input', 'aaa-input');
        gateInput.placeholder = 'Gate / access code';
        const sourceInput = el('input', 'aaa-input');
        sourceInput.placeholder = 'Lead source (e.g. Google, referral)';

        const addBtn = el('button', 'aaa-btn aaa-btn-primary', 'Add & Select');
        addBtn.type = 'button';
        addBtn.addEventListener('click', async () => {
          const name = nameInput.value.trim();
          if (!name) {
            nameInput.classList.add('aaa-input-error');
            nameInput.focus();
            return;
          }
          if (!customerStore) return close(null);
          const customer = await customerStore.add({
            name,
            address: addrInput.value.trim(),
            phone: phoneInput.value.trim(),
            gateCode: gateInput.value.trim(),
            source: sourceInput.value.trim() || null
          });
          close(customer);
        });

        const cancelBtn = el('button', 'aaa-btn aaa-btn-ghost', 'Cancel');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', () => close(null));

        const actions = el('div', 'aaa-modal-actions');
        actions.appendChild(cancelBtn);
        actions.appendChild(addBtn);

        const addForm = el('div', 'aaa-form');
        [nameInput, addrInput, phoneInput, gateInput, sourceInput].forEach((i) => addForm.appendChild(i));

        modal.appendChild(title);
        modal.appendChild(search);
        modal.appendChild(listWrap);
        modal.appendChild(addTitle);
        modal.appendChild(addForm);
        modal.appendChild(actions);
        overlay.appendChild(modal);
        overlay.addEventListener('click', (e) => {
          if (e.target === overlay) close(null);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(overlay);

        renderList('');
        nameInput.addEventListener('input', () => nameInput.classList.remove('aaa-input-error'));
        setTimeout(() => search.focus(), 0);
      });
    }

    return { pick };
  }

  global.AAA_CUSTOMER_PICKER_UI = createPicker();
})(typeof window !== 'undefined' ? window : this);
