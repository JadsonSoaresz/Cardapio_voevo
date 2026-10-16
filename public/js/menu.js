(() => {
  'use strict';

  const CACHE_KEY = 'voevo:menu';
  const WEEKDAYS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  const $ = (selector, root = document) => root.querySelector(selector);
  const normalize = (text) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

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

  async function fetchMenu() {
    try {
      const response = await fetch('/api/menu', { cache: 'no-cache' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const menu = await response.json();
      try { localStorage.setItem(CACHE_KEY, JSON.stringify(menu)); } catch { /* armazenamento indisponível */ }
      return menu;
    } catch (err) {
      // Sem conexão: mostra a última versão vista neste aparelho, se houver.
      try {
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached) return JSON.parse(cached);
      } catch { /* armazenamento indisponível */ }
      throw err;
    }
  }

  function badgesFor(item) {
    const badges = [];
    if (item.badge) badges.push(el('span', { class: 'badge', text: item.badge }));
    if (!item.available) badges.push(el('span', { class: 'badge badge--off', text: 'Indisponível' }));
    return badges;
  }

  // ---------- Renderização ----------

  // id do item -> { item, section, category }, usado pela janela de detalhes.
  const itemIndex = new Map();

  function renderItem(item, section, category) {
    itemIndex.set(item.id, { item, section, category });
    const badges = badgesFor(item);

    return el('li', {
      class: item.available ? 'item' : 'item item--off',
      'data-search': normalize(`${item.name} ${item.description} ${category.name} ${section.name}`),
    },
      el('button', { class: 'card', type: 'button', onclick: () => openItem(item.id) },
        item.image && el('img', {
          class: 'card__img', src: item.image, alt: '', width: 96, height: 96, loading: 'lazy', decoding: 'async',
        }),
        el('span', { class: 'card__body' },
          el('span', { class: 'card__name', text: item.name }),
          item.description && el('span', { class: 'card__desc', text: item.description }),
          el('span', { class: 'card__foot' },
            item.price !== null && el('span', { class: 'card__price', text: brl.format(item.price) }),
            badges.length > 0 && el('span', { class: 'badges' }, badges),
          ),
        ),
      ),
    );
  }

  function renderSection(section, category, today) {
    const isToday = section.weekday === today;
    // Seções só com nome e preço (adicionais) usam cards pequenos, vários por linha.
    const compact = section.items.every((item) => !item.image && !item.description);
    const classes = ['section', compact && 'section--compact', isToday && 'section--today'].filter(Boolean).join(' ');

    return el('section', { class: classes, id: `sec-${section.id}` },
      section.name && el('h3', { class: 'section__title' },
        section.name,
        isToday && el('span', { class: 'badge badge--today', text: 'Hoje' }),
      ),
      section.note && el('p', { class: 'note', text: section.note }),
      el('ul', { class: 'cards' }, section.items.map((item) => renderItem(item, section, category))),
    );
  }

  function renderCategory(category, today) {
    return el('section', { class: 'category', id: `cat-${category.id}`, 'aria-labelledby': `title-${category.id}` },
      el('h2', { class: 'category__title', id: `title-${category.id}`, text: category.name }),
      el('div', { class: 'ornament', 'aria-hidden': 'true', text: '♥' }),
      category.description && el('p', { class: 'category__desc', text: category.description }),
      category.note && el('p', { class: 'note note--center', text: category.note }),
      category.sections
        .filter((section) => section.items.length > 0)
        .map((section) => renderSection(section, category, today)),
    );
  }

  function renderTodayBanner(categories, today) {
    const root = $('#today');
    root.replaceChildren();
    for (const category of categories) {
      for (const section of category.sections) {
        if (section.weekday !== today || section.items.length === 0) continue;
        root.append(el('a', { class: 'today', href: `#sec-${section.id}` },
          el('span', { class: 'today__kicker', text: `Hoje · ${WEEKDAYS[today]}` }),
          el('span', { class: 'today__text' },
            el('strong', { text: section.name }),
            el('span', { text: category.note || `Confira em ${category.name}` }),
          ),
          el('span', { class: 'today__arrow', 'aria-hidden': 'true', text: '→' }),
        ));
      }
    }
  }

  function renderFooter(info, updatedAt) {
    const links = [];
    if (info.whatsapp) {
      const phone = info.whatsapp.length <= 11 ? `55${info.whatsapp}` : info.whatsapp;
      links.push(el('a', { href: `https://wa.me/${phone}`, target: '_blank', rel: 'noopener', text: 'WhatsApp' }));
    }
    if (info.instagram) {
      links.push(el('a', { href: `https://instagram.com/${info.instagram}`, target: '_blank', rel: 'noopener', text: `@${info.instagram}` }));
    }
    const updated = updatedAt ? new Date(updatedAt) : null;

    $('#footer').replaceChildren(
      info.footer && el('p', { class: 'footer__message', text: info.footer }),
      info.hours && el('p', {}, el('strong', { text: 'Horário: ' }), info.hours),
      info.address && el('p', { text: info.address }),
      links.length > 0 && el('div', { class: 'footer__links' }, links),
      el('p', { text: `${info.name}${info.subtitle ? ` · ${info.subtitle}` : ''}` }),
      updated && !Number.isNaN(updated.getTime()) &&
        el('p', { class: 'footer__updated', text: `Cardápio atualizado em ${updated.toLocaleDateString('pt-BR')}` }),
    );
  }

  function render(menu) {
    const { info, categories } = menu;
    const today = new Date().getDay();
    const visible = categories.filter((category) => category.sections.some((s) => s.items.length > 0));

    document.title = `${info.name} · Cardápio`;
    $('#brand-name').textContent = info.name;
    $('#brand-subtitle').textContent = info.subtitle;
    $('#brand-tagline').textContent = info.tagline;
    $('#brand-tagline').hidden = !info.tagline;

    itemIndex.clear();
    $('#tabs').replaceChildren(...visible.map((category) =>
      el('a', { class: 'tab', href: `#cat-${category.id}`, 'data-target': `cat-${category.id}`, text: category.name })));
    $('#menu').replaceChildren(...visible.map((category) => renderCategory(category, today)));

    renderTodayBanner(visible, today);
    renderFooter(info, menu.updatedAt);
    setupScrollSpy();
  }

  // ---------- Detalhes do item ----------

  const sheet = $('#item-sheet');
  // true quando a abertura criou uma entrada no histórico (o botão "voltar" do celular fecha a janela).
  let pushedHistory = false;

  function openItem(id, { fromHash = false } = {}) {
    const entry = itemIndex.get(id);
    if (!entry) return;
    const { item, section, category } = entry;

    const img = $('#sheet-img');
    img.hidden = !item.image;
    if (item.image) img.src = item.image;
    else img.removeAttribute('src');
    $('#sheet-kicker').textContent = [category.name, section.name].filter(Boolean).join(' · ');
    $('#sheet-title').textContent = item.name;
    $('#sheet-badges').replaceChildren(...badgesFor(item));
    $('#sheet-desc').textContent = item.description;
    $('#sheet-desc').hidden = !item.description;
    $('#sheet-price').textContent = item.price === null ? '' : brl.format(item.price);

    if (!fromHash) {
      history.pushState({ item: id }, '', `#item-${id}`);
      pushedHistory = true;
    }
    document.documentElement.classList.add('is-locked');
    if (!sheet.open) sheet.showModal();
    sheet.scrollTop = 0;
  }

  function setupSheet() {
    $('#sheet-close').addEventListener('click', () => sheet.close());
    // Clique fora do conteúdo (no fundo escurecido) fecha.
    sheet.addEventListener('click', (event) => {
      if (event.target === sheet) sheet.close();
    });
    sheet.addEventListener('close', () => {
      document.documentElement.classList.remove('is-locked');
      if (pushedHistory) {
        pushedHistory = false;
        history.back();
      } else if (location.hash.startsWith('#item-')) {
        history.replaceState(null, '', location.pathname + location.search);
      }
    });
    window.addEventListener('popstate', () => {
      if (sheet.open) {
        pushedHistory = false;
        sheet.close();
      }
    });
  }

  // ---------- Navegação ----------

  let spy;

  function setActiveTab(id) {
    const track = $('#tabs');
    let active = null;
    for (const tab of track.children) {
      const isActive = tab.dataset.target === id;
      tab.classList.toggle('is-active', isActive);
      if (isActive) { tab.setAttribute('aria-current', 'true'); active = tab; } else tab.removeAttribute('aria-current');
    }
    if (active) {
      // Rola só a barra de abas; scrollIntoView poderia interromper a rolagem suave da página.
      track.scrollTo({ left: active.offsetLeft - (track.clientWidth - active.offsetWidth) / 2, behavior: 'smooth' });
    }
  }

  function setupScrollSpy() {
    spy?.disconnect();
    spy = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) setActiveTab(entry.target.id);
    }, { rootMargin: '-35% 0px -60% 0px' });
    document.querySelectorAll('.category').forEach((category) => spy.observe(category));
    const first = $('.category');
    if (first) setActiveTab(first.id);
  }

  function setupSearch() {
    const input = $('#search');
    input.addEventListener('input', () => {
      const term = normalize(input.value.trim());
      let total = 0;
      for (const category of document.querySelectorAll('.category')) {
        let inCategory = 0;
        for (const section of category.querySelectorAll('.section')) {
          let inSection = 0;
          for (const item of section.querySelectorAll('.item')) {
            const match = !term || item.dataset.search.includes(term);
            item.hidden = !match;
            if (match) inSection += 1;
          }
          section.hidden = inSection === 0;
          inCategory += inSection;
        }
        category.hidden = inCategory === 0;
        total += inCategory;
      }
      $('#empty').hidden = total > 0;
      $('#today').hidden = Boolean(term);
    });
  }

  function setupToTop() {
    const button = $('#to-top');
    const toggle = () => { button.hidden = window.scrollY < 600; };
    window.addEventListener('scroll', toggle, { passive: true });
    button.addEventListener('click', () => window.scrollTo({ top: 0 }));
    toggle();
  }

  async function start() {
    try {
      render(await fetchMenu());
      // Link direto para um item (ex.: compartilhado): abre os detalhes já na entrada.
      const match = location.hash.match(/^#item-(.+)$/);
      if (match) openItem(decodeURIComponent(match[1]), { fromHash: true });
    } catch {
      const retry = el('button', { class: 'retry', type: 'button', text: 'Tentar novamente' });
      retry.addEventListener('click', () => {
        $('#menu').replaceChildren(el('p', { class: 'status', text: 'Carregando cardápio…' }));
        start();
      });
      $('#menu').replaceChildren(el('div', { class: 'status' },
        el('p', { text: 'Não foi possível carregar o cardápio. Verifique sua conexão.' }), retry));
    }
  }

  setupSearch();
  setupToTop();
  setupSheet();
  start();
})();
