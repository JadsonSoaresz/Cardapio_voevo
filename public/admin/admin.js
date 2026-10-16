(() => {
  'use strict';

  const WEEKDAYS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
  const INFO_FIELDS = [
    { key: 'name', label: 'Nome do estabelecimento', max: 80 },
    { key: 'subtitle', label: 'Subtítulo', max: 80, placeholder: 'Café & Tapiocaria' },
    { key: 'tagline', label: 'Frase de destaque (topo)', max: 160, wide: true },
    { key: 'footer', label: 'Mensagem do rodapé', max: 200, wide: true },
    { key: 'hours', label: 'Horário de funcionamento', max: 200, placeholder: 'Ter a dom, 15h às 22h' },
    { key: 'address', label: 'Endereço', max: 200 },
    { key: 'whatsapp', label: 'WhatsApp (com DDD)', max: 20, placeholder: '86999999999', inputmode: 'tel' },
    { key: 'instagram', label: 'Instagram (sem @)', max: 60, placeholder: 'voevocafe' },
  ];

  const $ = (selector, root = document) => root.querySelector(selector);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  let menu = null;
  let dirty = false;
  let uid = 0;
  const openIds = new Set();

  const newId = () => `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const countItems = (category) => category.sections.reduce((sum, s) => sum + s.items.length, 0);

  // ---------- API ----------

  async function api(path, { method = 'GET', body } = {}) {
    const isFile = body instanceof Blob;
    const response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': isFile ? body.type : 'application/json' },
      body: body === undefined || isFile ? body : JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/api/login') {
      showLogin();
      throw new Error(data.error || 'Sessão expirada. Entre novamente.');
    }
    if (!response.ok) throw new Error(data.error || 'Erro inesperado. Tente novamente.');
    return data;
  }

  // ---------- Avisos ----------

  let toastTimer;
  function toast(message, type = 'ok') {
    const node = $('#toast');
    node.textContent = message;
    node.className = type === 'error' ? 'toast toast--error' : 'toast';
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3500);
  }

  function markDirty() {
    dirty = true;
    updateSaveBar();
  }

  function updateSaveBar() {
    $('#savebar').classList.toggle('is-dirty', dirty);
    $('#save-status').textContent = dirty ? 'Alterações não salvas' : 'Tudo salvo';
    $('#save').disabled = !dirty;
    $('#discard').disabled = !dirty;
  }

  // ---------- Campos ----------

  function textField(label, obj, key, opts = {}) {
    const id = `f${++uid}`;
    const input = el(opts.multiline ? 'textarea' : 'input', {
      id,
      class: 'input',
      type: opts.multiline ? null : 'text',
      rows: opts.multiline ? 2 : null,
      maxlength: opts.max,
      placeholder: opts.placeholder,
      inputmode: opts.inputmode,
    });
    input.value = obj[key] ?? '';
    input.addEventListener('input', () => {
      obj[key] = input.value;
      opts.onInput?.(input.value);
      markDirty();
    });
    return el('div', { class: `field ${opts.class || ''}` }, el('label', { for: id, text: label }), input);
  }

  function parsePrice(text) {
    const value = text.trim().replace(/^R\$\s*/i, '');
    if (!value) return null;
    const normalized = value.includes(',') ? value.replace(/\./g, '').replace(',', '.') : value;
    const n = Number(normalized);
    return Number.isFinite(n) && n >= 0 && n < 100000 ? Math.round(n * 100) / 100 : undefined;
  }

  const formatPrice = (price) => (price === null ? '' : price.toFixed(2).replace('.', ','));

  function priceField(item) {
    const id = `f${++uid}`;
    const input = el('input', { id, class: 'input', type: 'text', inputmode: 'decimal', placeholder: '0,00', 'data-price': true });
    input.value = formatPrice(item.price);
    input.addEventListener('input', () => {
      const parsed = parsePrice(input.value);
      input.classList.toggle('is-invalid', parsed === undefined);
      if (parsed !== undefined) item.price = parsed;
      markDirty();
    });
    input.addEventListener('blur', () => {
      const parsed = parsePrice(input.value);
      if (parsed !== undefined) input.value = formatPrice(parsed);
    });
    return el('div', { class: 'field f-price' }, el('label', { for: id, text: 'Preço (R$)' }), input);
  }

  // Reduz a foto no navegador antes de enviar: fotos de celular têm vários MB e o cardápio só precisa de ~1200px.
  async function resizeImage(file, maxSide = 1200) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      throw new Error('Formato de imagem não suportado. Use JPG, PNG ou WebP.');
    }
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Não foi possível processar a imagem.'))),
        'image/jpeg', 0.85);
    });
  }

  function imageField(item) {
    const preview = el('img', { class: 'thumb', alt: '' });
    const empty = el('span', { class: 'thumb thumb--empty', text: 'Sem foto' });
    const fileInput = el('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp', hidden: true });
    const upload = el('button', { type: 'button', class: 'btn btn--small', onclick: () => fileInput.click() });
    const remove = el('button', {
      type: 'button',
      class: 'btn btn--small',
      text: 'Remover foto',
      onclick: () => {
        item.image = '';
        sync();
        markDirty();
      },
    });

    function sync() {
      preview.hidden = !item.image;
      if (item.image) preview.src = item.image;
      empty.hidden = Boolean(item.image);
      remove.hidden = !item.image;
      upload.textContent = item.image ? 'Trocar foto' : 'Enviar foto';
    }

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      upload.disabled = true;
      upload.textContent = 'Enviando…';
      try {
        const { url } = await api('/api/upload', { method: 'POST', body: await resizeImage(file) });
        item.image = url;
        markDirty();
        toast('Foto enviada. Clique em “Salvar alterações” para publicar.');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        upload.disabled = false;
        sync();
      }
    });

    sync();
    return el('div', { class: 'image-field' },
      preview, empty,
      el('div', { class: 'image-field__actions' }, upload, remove),
      fileInput);
  }

  // Ícones em SVG: os caracteres ↑ ↓ ✕ viram emoji colorido em alguns sistemas.
  const ICONS = {
    up: 'M12 19V5M5 12l7-7 7 7',
    down: 'M12 5v14M5 12l7 7 7-7',
    delete: 'M6 6l12 12M18 6L6 18',
  };

  function icon(name) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', ICONS[name]);
    svg.append(path);
    return svg;
  }

  function iconButton(iconName, label, onClick, { disabled = false, danger = false } = {}) {
    return el('button', {
      type: 'button',
      class: danger ? 'icon-btn icon-btn--danger' : 'icon-btn',
      'aria-label': label,
      title: label,
      disabled,
      onclick: (event) => {
        // Os botões ficam dentro de <summary>; sem isso o clique também abriria/fecharia o bloco.
        event.preventDefault();
        event.stopPropagation();
        onClick();
      },
    }, icon(iconName));
  }

  function moveControls(list, index, label) {
    const move = (to) => {
      [list[index], list[to]] = [list[to], list[index]];
      changed();
    };
    return el('div', { class: 'move' },
      iconButton('up', `Mover ${label} para cima`, () => move(index - 1), { disabled: index === 0 }),
      iconButton('down', `Mover ${label} para baixo`, () => move(index + 1), { disabled: index === list.length - 1 }),
      iconButton('delete', `Excluir ${label}`, () => {
        if (!confirm(`Excluir ${label}? Esta ação só vale depois de salvar.`)) return;
        list.splice(index, 1);
        changed();
      }, { danger: true }),
    );
  }

  function changed() {
    markDirty();
    renderCategories();
  }

  function collapsible(className, id, summary, body) {
    const details = el('details', { class: className, open: openIds.has(id) }, summary, body);
    details.addEventListener('toggle', () => {
      if (details.open) openIds.add(id);
      else openIds.delete(id);
    });
    return details;
  }

  // ---------- Editor do cardápio ----------

  function renderItem(section, item, index) {
    const card = el('div', { class: item.available ? 'item' : 'item item--off' });
    const toggleId = `f${++uid}`;
    const toggle = el('input', { id: toggleId, type: 'checkbox' });
    toggle.checked = item.available;
    toggle.addEventListener('change', () => {
      item.available = toggle.checked;
      card.classList.toggle('item--off', !item.available);
      markDirty();
    });

    card.append(
      imageField(item),
      el('div', { class: 'item__grid' },
        textField('Nome', item, 'name', { max: 120, class: 'f-name' }),
        priceField(item),
        textField('Selo', item, 'badge', { max: 30, class: 'f-badge', placeholder: 'Ex.: Mais pedido' }),
        textField('Descrição', item, 'description', { max: 300, multiline: true, class: 'f-desc', placeholder: 'Opcional' }),
      ),
      el('div', { class: 'item__footer' },
        el('label', { class: 'switch', for: toggleId }, toggle, 'Disponível'),
        moveControls(section.items, index, `o item "${item.name || 'sem nome'}"`),
      ),
    );
    return card;
  }

  function renderSection(category, section, index) {
    const nameNode = el('span', { class: 'summary__name', text: section.name || 'Seção sem título' });
    const weekdayId = `f${++uid}`;
    const weekday = el('select', { id: weekdayId, class: 'input' },
      el('option', { value: '', text: 'Nenhum' }),
      WEEKDAYS.map((day, i) => el('option', { value: String(i), text: day })));
    weekday.value = section.weekday === null ? '' : String(section.weekday);
    weekday.addEventListener('change', () => {
      section.weekday = weekday.value === '' ? null : Number(weekday.value);
      markDirty();
    });

    const items = el('div', { class: 'items' },
      section.items.length === 0 && el('p', { class: 'empty', text: 'Nenhum item nesta seção.' }),
      section.items.map((item, i) => renderItem(section, item, i)));

    const summary = el('summary', { class: 'sec__summary' },
      el('span', { class: 'summary__text' }, nameNode, el('span', { class: 'summary__meta', text: `${section.items.length} itens` })),
      moveControls(category.sections, index, `a seção "${section.name || 'sem título'}"`));

    const body = el('div', { class: 'sec__body' },
      el('div', { class: 'sec-fields' },
        textField('Título da seção', section, 'name', {
          max: 80,
          placeholder: 'Ex.: Salgadas',
          onInput: (value) => { nameNode.textContent = value || 'Seção sem título'; },
        }),
        textField('Observação', section, 'note', { max: 300, placeholder: 'Opcional' }),
        el('div', { class: 'field' }, el('label', { for: weekdayId, text: 'Destacar no dia' }), weekday),
      ),
      items,
      el('button', {
        type: 'button',
        class: 'btn btn--dashed btn--small',
        text: '+ Item',
        onclick: () => {
          section.items.push({ id: newId(), name: '', description: '', price: null, badge: '', image: '', available: true });
          openIds.add(section.id);
          changed();
          focusLast(`#sec-${CSS.escape(section.id)} .item .f-name .input`);
        },
      }),
    );

    const details = collapsible('sec', section.id, summary, body);
    details.id = `sec-${section.id}`;
    return details;
  }

  function renderCategory(category, index) {
    const nameNode = el('span', { class: 'summary__name', text: category.name || 'Nova categoria' });
    const summary = el('summary', { class: 'cat__summary' },
      el('span', { class: 'summary__text' },
        nameNode,
        el('span', { class: 'summary__meta', text: `${category.sections.length} seções · ${countItems(category)} itens` })),
      moveControls(menu.categories, index, `a categoria "${category.name || 'sem nome'}"`));

    const body = el('div', { class: 'cat__body' },
      el('div', { class: 'grid-3' },
        textField('Nome da categoria', category, 'name', {
          max: 80,
          onInput: (value) => { nameNode.textContent = value || 'Nova categoria'; },
        }),
        textField('Descrição', category, 'description', { max: 300, placeholder: 'Opcional' }),
        textField('Observação (destaque)', category, 'note', { max: 300, placeholder: 'Ex.: válido de terça a quinta' }),
      ),
      category.sections.map((section, i) => renderSection(category, section, i)),
      el('button', {
        type: 'button',
        class: 'btn btn--dashed btn--small',
        text: '+ Seção',
        onclick: () => {
          const section = { id: newId(), name: '', note: '', weekday: null, items: [] };
          category.sections.push(section);
          openIds.add(section.id);
          changed();
          focusLast(`#sec-${CSS.escape(section.id)} .sec-fields .input`);
        },
      }),
    );

    const details = collapsible('cat', category.id, summary, body);
    details.id = `cat-${category.id}`;
    return details;
  }

  function renderCategories() {
    const root = $('#categories');
    root.replaceChildren(...menu.categories.map(renderCategory));
    if (menu.categories.length === 0) {
      root.append(el('p', { class: 'empty', text: 'Nenhuma categoria. Clique em “+ Categoria” para começar.' }));
    }
  }

  function focusLast(selector) {
    const nodes = document.querySelectorAll(selector);
    const target = nodes[nodes.length - 1];
    if (!target) return;
    target.scrollIntoView({ block: 'center' });
    target.focus({ preventScroll: true });
  }

  function renderInfo() {
    $('#info-fields').replaceChildren(...INFO_FIELDS.map((field) =>
      textField(field.label, menu.info, field.key, {
        max: field.max,
        placeholder: field.placeholder,
        inputmode: field.inputmode,
        class: field.wide ? 'field--wide' : '',
      })));
  }

  function renderAll() {
    renderCategories();
    renderInfo();
    updateSaveBar();
  }

  // ---------- Ações ----------

  async function save() {
    const invalid = $('[data-price].is-invalid');
    if (invalid) {
      toast('Há um preço inválido (em vermelho). Use o formato 12,50.', 'error');
      invalid.closest('details.cat')?.setAttribute('open', '');
      invalid.closest('details.sec')?.setAttribute('open', '');
      invalid.scrollIntoView({ block: 'center' });
      invalid.focus({ preventScroll: true });
      return;
    }
    const button = $('#save');
    button.disabled = true;
    button.textContent = 'Salvando…';
    try {
      menu = await api('/api/menu', { method: 'PUT', body: menu });
      dirty = false;
      renderAll();
      toast('Cardápio salvo! Os clientes já veem a nova versão.');
    } catch (err) {
      toast(err.message, 'error');
      updateSaveBar();
    } finally {
      button.textContent = 'Salvar alterações';
    }
  }

  async function discard() {
    if (!confirm('Descartar todas as alterações não salvas?')) return;
    try {
      menu = await api('/api/menu');
      dirty = false;
      renderAll();
      toast('Alterações descartadas.');
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function addCategory() {
    const category = {
      id: newId(),
      name: '',
      description: '',
      note: '',
      sections: [{ id: newId(), name: '', note: '', weekday: null, items: [] }],
    };
    menu.categories.push(category);
    openIds.add(category.id);
    changed();
    focusLast(`#cat-${CSS.escape(category.id)} .grid-3 .input`);
  }

  function setAllOpen(open) {
    for (const details of document.querySelectorAll('#categories details')) details.open = open;
  }

  function switchPanel(panelId) {
    for (const tab of document.querySelectorAll('.panel-tab')) {
      const active = tab.dataset.panel === panelId;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      $(`#${tab.dataset.panel}`).hidden = !active;
    }
  }

  // ---------- Telas ----------

  function showLogin() {
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-password').value = '';
    $('#login-password').focus();
  }

  async function startApp() {
    // Se a sessão expirou com alterações pendentes, mantém o que foi editado.
    if (!menu || !dirty) menu = await api('/api/menu');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    renderAll();
  }

  $('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#login-error');
    const button = event.submitter || $('#login-form button');
    error.hidden = true;
    button.disabled = true;
    try {
      await api('/api/login', { method: 'POST', body: { password: $('#login-password').value } });
      await startApp();
      if (dirty) toast('Sessão renovada. Suas alterações foram mantidas; lembre de salvar.');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  });

  $('#password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = $('#pw-error');
    const current = $('#pw-current').value;
    const next = $('#pw-next').value;
    error.hidden = true;
    if (next.length < 6) {
      error.textContent = 'A nova senha precisa ter pelo menos 6 caracteres.';
      error.hidden = false;
      return;
    }
    if (next !== $('#pw-confirm').value) {
      error.textContent = 'As senhas novas não conferem.';
      error.hidden = false;
      return;
    }
    try {
      await api('/api/password', { method: 'POST', body: { current, next } });
      event.target.reset();
      toast('Senha alterada com sucesso.');
    } catch (err) {
      error.textContent = err.message;
      error.hidden = false;
    }
  });

  $('#logout').addEventListener('click', async () => {
    if (dirty && !confirm('Há alterações não salvas. Sair mesmo assim?')) return;
    await api('/api/logout', { method: 'POST' }).catch(() => {});
    dirty = false;
    menu = null;
    showLogin();
  });

  $('#save').addEventListener('click', save);
  $('#discard').addEventListener('click', discard);
  $('#add-category').addEventListener('click', addCategory);
  $('#expand-all').addEventListener('click', () => setAllOpen(true));
  $('#collapse-all').addEventListener('click', () => setAllOpen(false));
  for (const tab of document.querySelectorAll('.panel-tab')) {
    tab.addEventListener('click', () => switchPanel(tab.dataset.panel));
  }

  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && !$('#app-view').hidden) {
      event.preventDefault();
      if (dirty) save();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
  });

  api('/api/session')
    .then(({ authenticated, passwordRequired }) => {
      if (passwordRequired === false) {
        // Modo de teste no servidor: sem login, então "Sair" e a troca de senha não fazem sentido.
        $('#logout').hidden = true;
        $('.panel-tab[data-panel="panel-password"]').hidden = true;
        $('#no-password-warning').hidden = false;
      }
      return authenticated ? startApp() : showLogin();
    })
    .catch((err) => {
      showLogin();
      toast(err.message, 'error');
    });
})();
