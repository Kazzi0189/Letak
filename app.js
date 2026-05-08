const STORE_CATALOG = [
  {
    id: 'penny-default',
    chain: 'Penny',
    name: 'Penny – aktuální nabídky',
    address: 'celostátní / podle webu Penny',
    type: 'diskont',
    status: 'napojeno přes import Penny'
  },
  {
    id: 'kaufland-demo',
    chain: 'Kaufland',
    name: 'Kaufland – demo pobočka',
    address: 'bude napojeno podle konkrétní prodejny',
    type: 'hypermarket',
    status: 'čeká na import konkrétní prodejny'
  },
  {
    id: 'albert-hyper-demo',
    chain: 'Albert',
    name: 'Albert hypermarket – demo',
    address: 'bude rozlišeno podle lokality',
    type: 'hypermarket',
    status: 'čeká na import hypermarket letáku'
  },
  {
    id: 'albert-super-demo',
    chain: 'Albert',
    name: 'Albert supermarket – demo',
    address: 'bude rozlišeno podle lokality',
    type: 'supermarket',
    status: 'čeká na import supermarket letáku'
  }
];

const state = {
  postcode: localStorage.getItem('postcode') || '',
  selectedStoreIds: JSON.parse(localStorage.getItem('selectedStoreIds') || '["penny-default"]'),
  query: '',
  offers: [],
  cart: JSON.parse(localStorage.getItem('cart') || '[]'),
  sortBy: 'unitPrice',
  dataStatus: 'Načítám data…'
};

const app = document.querySelector('#app');

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK' }).format(number);
}

function saveState() {
  localStorage.setItem('postcode', state.postcode);
  localStorage.setItem('selectedStoreIds', JSON.stringify(state.selectedStoreIds));
  localStorage.setItem('cart', JSON.stringify(state.cart));
}

function visibleOffers() {
  const query = normalize(state.query.trim());
  return state.offers
    .filter((offer) => state.selectedStoreIds.includes(offer.storeId))
    .filter((offer) => {
      if (!query) return true;
      return normalize(`${offer.product} ${offer.brand} ${offer.chain} ${offer.storeName} ${offer.packageSize}`).includes(query);
    })
    .sort((a, b) => {
      if (state.sortBy === 'price') return Number(a.price || 0) - Number(b.price || 0);
      return Number(a.unitPrice || a.price || 0) - Number(b.unitPrice || b.price || 0);
    });
}

function cheapestMap() {
  const map = new Map();
  for (const offer of state.offers.filter((offer) => state.selectedStoreIds.includes(offer.storeId))) {
    const key = normalize(offer.product);
    const current = map.get(key);
    const offerValue = Number(offer.unitPrice || offer.price || Infinity);
    const currentValue = Number(current?.unitPrice || current?.price || Infinity);
    if (!current || offerValue < currentValue) map.set(key, offer);
  }
  return map;
}

function cartTotal() {
  return state.cart.reduce((sum, item) => sum + Number(item.price || 0), 0);
}

function selectedStores() {
  return STORE_CATALOG.filter((store) => state.selectedStoreIds.includes(store.id));
}

function addToCart(offerId) {
  const offer = state.offers.find((item) => String(item.id) === String(offerId));
  if (!offer) return;
  state.cart.push({ ...offer, cartId: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
  saveState();
  render();
}

function removeFromCart(cartId) {
  state.cart = state.cart.filter((item) => item.cartId !== cartId);
  saveState();
  render();
}

function toggleStore(storeId) {
  if (state.selectedStoreIds.includes(storeId)) {
    state.selectedStoreIds = state.selectedStoreIds.filter((id) => id !== storeId);
  } else {
    state.selectedStoreIds.push(storeId);
  }
  saveState();
  render();
}

function addCheapestVisible() {
  const cheapest = cheapestMap();
  const unique = new Map();
  for (const offer of visibleOffers()) {
    const best = cheapest.get(normalize(offer.product));
    if (best && String(best.id) === String(offer.id)) unique.set(offer.id, offer);
  }
  for (const offer of unique.values()) {
    state.cart.push({ ...offer, cartId: `${Date.now()}-${Math.random().toString(16).slice(2)}` });
  }
  saveState();
  render();
}

function renderStores() {
  return STORE_CATALOG.map((store) => {
    const active = state.selectedStoreIds.includes(store.id);
    return `
      <button class="store-tile ${active ? 'active' : ''}" data-action="toggle-store" data-store-id="${store.id}">
        <div class="sub">${store.chain} · ${store.type}</div>
        <div class="title">${store.name}</div>
        <div class="sub">${store.address}</div>
        <div class="note">${store.status}</div>
      </button>
    `;
  }).join('');
}

function renderOffers() {
  const offers = visibleOffers();
  const cheapest = cheapestMap();

  if (!state.selectedStoreIds.length) {
    return '<div class="warning">⚠️ Vyber alespoň jednu prodejnu.</div>';
  }

  if (!offers.length) {
    return '<div class="card empty">Nic jsem nenašel. Zkus jiné hledání nebo vyber další prodejnu.</div>';
  }

  return offers.map((offer) => {
    const isCheapest = String(cheapest.get(normalize(offer.product))?.id) === String(offer.id);
    const unit = offer.unitPrice ? `${Number(offer.unitPrice).toFixed(2).replace('.', ',')} ${offer.unit || ''}` : '';
    return `
      <article class="offer ${isCheapest ? 'cheapest' : ''}">
        <div class="offer-top">
          <span class="pill">${offer.storeName || offer.chain}</span>
          ${isCheapest ? '<span class="pill dark">nejlevnější</span>' : ''}
          <span class="small">platí do ${offer.validTo || 'neuvedeno'}</span>
        </div>
        <div class="offer-main">
          <div>
            <div class="offer-title">${offer.product || 'Neznámý produkt'}</div>
            <p>${offer.brand || 'značka neuvedena'} · ${offer.packageSize || 'balení neuvedeno'} · ${offer.priceType || 'akce'}</p>
          </div>
          <div class="price-box">
            <div>
              <div class="price">${formatPrice(offer.price)}</div>
              <div class="unit">${unit}</div>
            </div>
            <button class="btn" data-action="add-cart" data-offer-id="${offer.id}">Přidat</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderCart() {
  const stores = selectedStores();
  if (!stores.length) return '<div class="empty">Nejdřív vyber prodejnu.</div>';

  return stores.map((store) => {
    const items = state.cart.filter((item) => item.storeId === store.id);
    const total = items.reduce((sum, item) => sum + Number(item.price || 0), 0);
    return `
      <section class="cart-store">
        <div class="cart-store-head">
          <span>${store.name}</span>
          <span>${formatPrice(total)}</span>
        </div>
        ${items.length ? items.map((item) => `
          <div class="cart-item">
            <div>
              <strong>${item.product}</strong>
              <div class="small">${item.brand || ''} · ${item.packageSize || ''}</div>
              <strong>${formatPrice(item.price)}</strong>
            </div>
            <button class="btn danger" data-action="remove-cart" data-cart-id="${item.cartId}">Smazat</button>
          </div>
        `).join('') : '<div class="small">Zatím prázdné</div>'}
      </section>
    `;
  }).join('');
}

function render() {
  const updatedAt = state.offersMeta?.updatedAt
    ? new Date(state.offersMeta.updatedAt).toLocaleString('cs-CZ')
    : 'zatím neznámé';

  app.innerHTML = `
    <main class="app">
      <header class="hero">
        <div class="badge">🛒 PWA prototyp</div>
        <h1>Letáky podle tvých prodejen</h1>
        <p>Vyber prodejny, hledej akční produkty a skládej si košíky podle obchodů. První reálný import je připravený pro Penny.</p>
        <div class="status">${state.dataStatus} · aktualizováno: ${updatedAt}</div>
      </header>

      <section class="section card">
        <div class="location-row">
          <div>
            <h2>1. Moje lokalita a prodejny</h2>
            <p>Kaufland a Albert budeme později tahat podle konkrétní prodejny. Penny je první napojený zdroj.</p>
          </div>
          <div>
            <label class="small" for="postcode">PSČ nebo město</label>
            <input id="postcode" class="input" value="${state.postcode}" placeholder="např. 700 30" />
          </div>
        </div>
        <div class="store-grid">${renderStores()}</div>
      </section>

      <section class="section grid main-grid">
        <div class="grid">
          <div class="card">
            <h2>2. Nabídky</h2>
            <p>Hledej produkt a přidej nejlevnější nabídky do košíku.</p>
            <div class="toolbar">
              <input id="query" class="input" value="${state.query}" placeholder="Hledej: máslo, mléko, káva…" />
              <select id="sort" class="select">
                <option value="unitPrice" ${state.sortBy === 'unitPrice' ? 'selected' : ''}>Jednotková cena</option>
                <option value="price" ${state.sortBy === 'price' ? 'selected' : ''}>Cena balení</option>
              </select>
            </div>
            <div class="toolbar">
              <button class="btn" data-action="add-cheapest">Přidat nejlevnější z výsledků</button>
              <button class="btn secondary" data-action="clear-cart">Vyprázdnit košík</button>
            </div>
          </div>
          ${renderOffers()}
        </div>

        <aside class="card cart">
          <div>
            <h2>3. Košíky</h2>
            <p>Celkem: <strong>${formatPrice(cartTotal())}</strong></p>
          </div>
          ${renderCart()}
        </aside>
      </section>
    </main>

    <div class="bottom-bar">
      <div>
        <div class="small">Košík celkem</div>
        <div class="bottom-total">${formatPrice(cartTotal())}</div>
      </div>
      <button class="btn" data-action="add-cheapest">Přidat nejlevnější</button>
    </div>
  `;

  document.querySelector('#postcode')?.addEventListener('input', (event) => {
    state.postcode = event.target.value;
    saveState();
  });

  document.querySelector('#query')?.addEventListener('input', (event) => {
    state.query = event.target.value;
    render();
  });

  document.querySelector('#sort')?.addEventListener('change', (event) => {
    state.sortBy = event.target.value;
    render();
  });
}

app.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'toggle-store') toggleStore(target.dataset.storeId);
  if (action === 'add-cart') addToCart(target.dataset.offerId);
  if (action === 'remove-cart') removeFromCart(target.dataset.cartId);
  if (action === 'add-cheapest') addCheapestVisible();
  if (action === 'clear-cart') {
    state.cart = [];
    saveState();
    render();
  }
});

async function loadOffers() {
  try {
    const response = await fetch('./data/offers.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    state.offers = Array.isArray(payload.offers) ? payload.offers : [];
    state.offersMeta = payload.meta || {};
    state.dataStatus = `Načteno ${state.offers.length} nabídek`;
  } catch (error) {
    state.dataStatus = `Nepodařilo se načíst data: ${error.message}`;
    state.offers = [];
  }
  render();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./service-worker.js').catch(() => {});
}

render();
loadOffers();
