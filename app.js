const STORE_CATALOG = [
  { id: 'penny-default', chain: 'Penny', name: 'Penny – aktuální nabídky', address: 'celostátní / podle webu Penny', type: 'diskont', status: 'napojeno přes import Penny' },
  { id: 'kaufland-teplice-centrum', chain: 'Kaufland', name: 'Kaufland Teplice-Centrum', address: 'Čs. Dobrovolců 3356, 415 01 Teplice', type: 'hypermarket', status: 'napojeno přes import Kaufland Teplice' },
  { id: 'albert-supermarket', chain: 'Albert', name: 'Albert supermarket', address: 'aktuální supermarket leták Albert', type: 'supermarket', status: 'napojeno přes import Albert PDF V7 clean' },
  { id: 'albert-hypermarket', chain: 'Albert', name: 'Albert hypermarket', address: 'aktuální hypermarket leták Albert', type: 'hypermarket', status: 'napojeno přes import Albert PDF V7 clean' }
]; function getInitialSelectedStoreIds() {
  const savedRaw = localStorage.getItem('selectedStoreIds');
  const saved = JSON.parse(savedRaw || '["penny-default","kaufland-teplice-centrum","albert-supermarket","albert-hypermarket"]');

  const migrated = saved
    .map((id) => (id === 'kaufland-demo' ? 'kaufland-teplice-centrum' : id))
    .map((id) => (id === 'albert-hyper-demo' ? 'albert-hypermarket' : id))
    .map((id) => (id === 'albert-super-demo' ? 'albert-supermarket' : id))
    .filter((id, index, array) => array.indexOf(id) === index);

  for (const requiredId of ['kaufland-teplice-centrum', 'albert-supermarket', 'albert-hypermarket']) {
    if (!migrated.includes(requiredId)) {
      migrated.push(requiredId);
    }
  }

  return migrated;
} const state = {
  postcode: localStorage.getItem('postcode') || '',
  selectedStoreIds: getInitialSelectedStoreIds(),
  query: '',
  offers: [],
  cart: JSON.parse(localStorage.getItem('cart') || '[]'),
  sortBy: 'unitPrice',
  qualityMode: localStorage.getItem('qualityMode') || 'trusted',
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
  localStorage.setItem('qualityMode', state.qualityMode);
}

function offerQuality(offer) {
  const confidence = String(offer.confidence || '').toLowerCase();
  const suspect =
    offer.suspect === true ||
    String(offer.suspect || '').toLowerCase() === 'true';

  if (suspect) return 'suspect';
  if (confidence === 'low') return 'low';
  if (confidence === 'medium') return 'medium';
  return 'high';
}

function shouldShowOfferByQuality(offer) {
  const quality = offerQuality(offer);

  if (state.qualityMode === 'all') return true;
  if (state.qualityMode === 'high') return quality === 'high';
  if (state.qualityMode === 'review') return quality === 'low' || quality === 'suspect';

  return quality === 'high' || quality === 'medium';
}

function qualityLabel(offer) {
  const quality = offerQuality(offer);

  if (quality === 'high') return 'vysoká jistota';
  if (quality === 'medium') return 'střední jistota';
  if (quality === 'low') return 'nízká jistota';
  return 'ke kontrole';
}



function productImageUrl(offer) {
  return (
    offer.imageUrl ||
    offer.image ||
    offer.imageSrc ||
    offer.thumbnailUrl ||
    offer.productImageUrl ||
    offer.pageImageUrl ||
    ''
  );
}

function renderOfferImage(offer) {
  const url = productImageUrl(offer);

  if (!url) {
    return '';
  }

  const isPageThumbnail = offer.imageType === 'page-thumbnail' && !offer.imageUrl;
  const alt = (offer.imageAlt || offer.product || (isPageThumbnail ? 'Miniatura stránky letáku' : 'Obrázek produktu'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `
    <div class="offer-image-wrap">
      <img class="offer-image ${isPageThumbnail ? 'offer-page-image' : ''}" src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer" />
      ${isPageThumbnail ? '<span class="offer-image-label">leták</span>' : ''}
    </div>
  `;
}

function renderQualityBadge(offer) {
  const quality = offerQuality(offer);

  if (quality === 'high') return '<span class="pill ok">ověřeno</span>';
  if (quality === 'medium') return '<span class="pill warn">střední jistota</span>';
  if (quality === 'low') return '<span class="pill warn">nízká jistota</span>';

  return '<span class="pill danger">ke kontrole</span>';
}

function renderOfferQualityText(offer) {
  const quality = offerQuality(offer);
  const page = offer.pageNumber ? ` · str. ${offer.pageNumber}` : '';

  if (quality === 'high') return page;

  const reasons = Array.isArray(offer.suspectReasons) && offer.suspectReasons.length
    ? ` · ${offer.suspectReasons.join(', ')}`
    : '';

  return ` · ${qualityLabel(offer)}${reasons}${page}`;
}

function qualitySummary() {
  const selected = state.offers.filter((offer) => state.selectedStoreIds.includes(offer.storeId));
  const counts = selected.reduce(
    (acc, offer) => {
      acc[offerQuality(offer)] += 1;
      return acc;
    },
    { high: 0, medium: 0, low: 0, suspect: 0 }
  );

  return `Jistota dat: vysoká ${counts.high}, střední ${counts.medium}, nízká ${counts.low}, ke kontrole ${counts.suspect}`;
}

function visibleOffers() {
  const query = normalize(state.query.trim());
  return state.offers
    .filter((offer) => state.selectedStoreIds.includes(offer.storeId))
    .filter((offer) => shouldShowOfferByQuality(offer))
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
  for (const offer of state.offers.filter((offer) => state.selectedStoreIds.includes(offer.storeId) && shouldShowOfferByQuality(offer))) {
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
  renderDynamic();
}

function removeFromCart(cartId) {
  state.cart = state.cart.filter((item) => item.cartId !== cartId);
  saveState();
  renderDynamic();
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
  renderDynamic();
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
      <article class="offer ${isCheapest ? 'cheapest' : ''} offer-with-image">
      ${renderOfferImage(offer)}
        <div class="offer-top">
          <span class="pill">${offer.storeName || offer.chain}</span>
          ${isCheapest ? '<span class="pill dark">nejlevnější</span>' : ''}
        ${renderQualityBadge(offer)}
        <span class="small">platí do ${offer.validTo || 'neuvedeno'}</span>
        </div>
        <div class="offer-main">
          <div>
            <div class="offer-title">${offer.product || 'Neznámý produkt'}</div>
            <p>${offer.brand || 'značka neuvedena'} · ${offer.packageSize || 'balení neuvedeno'} · ${offer.priceType || 'akce'}${renderOfferQualityText(offer)}</p>
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
        <p>Vyber prodejny, hledej akční produkty a skládej si košíky podle obchodů. Reálné importy jsou připravené pro Penny, Kaufland Teplice a Albert.</p>
        <div class="status">${state.dataStatus} · aktualizováno: ${updatedAt}</div>
      </header>

      <section class="section card">
        <div class="location-row">
          <div>
            <h2>1. Moje lokalita a prodejny</h2>
            <p>Kaufland Teplice je napojený podle konkrétní pobočky. Albert je napojený z clean PDF importu supermarket/hypermarket.</p>
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
            <p class="quality-note">${qualitySummary()}</p>
            <div class="toolbar">
              <input id="query" class="input" value="${state.query}" placeholder="Hledej: máslo, mléko, káva…" />
              <select id="sort" class="select">
                <option value="unitPrice" ${state.sortBy === 'unitPrice' ? 'selected' : ''}>Jednotková cena</option>
                <option value="price" ${state.sortBy === 'price' ? 'selected' : ''}>Cena balení</option>
            </select>

            <select id="quality" class="select">
              <option value="trusted" ${state.qualityMode === 'trusted' ? 'selected' : ''}>Jisté + střední</option>
              <option value="high" ${state.qualityMode === 'high' ? 'selected' : ''}>Jen vysoká jistota</option>
              <option value="review" ${state.qualityMode === 'review' ? 'selected' : ''}>Jen ke kontrole</option>
              <option value="all" ${state.qualityMode === 'all' ? 'selected' : ''}>Vše včetně nízké jistoty</option>
            </select>
            </div>
            <div class="toolbar">
              <button class="btn" data-action="add-cheapest">Přidat nejlevnější z výsledků</button>
              <button class="btn secondary" data-action="clear-cart">Vyprázdnit košík</button>
            </div>
          </div>
          <div id="offers-list">${renderOffers()}</div>
        </div>

        <aside class="card cart">
          <div>
            <h2>3. Košíky</h2>
            <p>Celkem: <strong id="cart-total-inline">${formatPrice(cartTotal())}</strong></p>
          </div>
          <div id="cart-list">${renderCart()}</div>
        </aside>
      </section>
    </main>

    <div class="bottom-bar">
      <div>
        <div class="small">Košík celkem</div>
        <div id="bottom-total" class="bottom-total">${formatPrice(cartTotal())}</div>
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
    renderDynamic();
  });

  document.querySelector('#sort')?.addEventListener('change', (event) => {
    state.sortBy = event.target.value;
    renderDynamic();
  });

  document.querySelector('#quality')?.addEventListener('change', (event) => {
    state.qualityMode = event.target.value;
    saveState();
    renderDynamic();
  });
}

function renderDynamic() {
  const offersList = document.querySelector('#offers-list');
  if (offersList) offersList.innerHTML = renderOffers();

  const cartList = document.querySelector('#cart-list');
  if (cartList) cartList.innerHTML = renderCart();

  const total = formatPrice(cartTotal());
  const inlineTotal = document.querySelector('#cart-total-inline');
  if (inlineTotal) inlineTotal.textContent = total;

  const bottomTotal = document.querySelector('#bottom-total');
  if (bottomTotal) bottomTotal.textContent = total;
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
    renderDynamic();
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
