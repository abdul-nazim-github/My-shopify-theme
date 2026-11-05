/**
 * Product-specific, gender-based upsell popup shown before checkout.
 *
 * Public API:  window.UpsellPopup.start({ mainVariantId, gender, attributes }) -> boolean
 *   true  -> popup is shown; this module handles add/skip and the checkout redirect.
 *   false -> nothing to offer (or config problem); caller should redirect to checkout itself.
 *
 * Configuration comes from the #upsell-config JSON block (snippets/upsell-config.liquid),
 * which is driven by product metafields in Shopify Admin. No product IDs live in this file.
 */
(function (global) {
  'use strict';

  var CONFIG_ID = 'upsell-config';
  var MODAL_ID = 'upsell-popup';
  var ROOT_CLASS = 'upsell-popup-open';
  var JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

  var routesRoot =
    (global.Shopify && global.Shopify.routes && global.Shopify.routes.root) || '/';

  var state = {
    busy: false,
    mainVariantId: null,
    attributes: {},
    offers: [],
    previousFocus: null
  };

  var els = null;

  /* ---------- Config / filtering ---------- */

  function readConfig() {
    var node = document.getElementById(CONFIG_ID);
    if (!node) return null;
    try {
      return JSON.parse(node.textContent);
    } catch (error) {
      console.error('[UpsellPopup] Invalid upsell config JSON:', error);
      return null;
    }
  }

  /** Offers for this main variant + gender. Never returns another product's upsells. */
  function getOffers(config, mainVariantId, gender) {
    if (!config || !config.variantToProduct || !config.products) return [];
    var productId = config.variantToProduct[String(mainVariantId)];
    var product = productId ? config.products[productId] : null;
    var list = product && product[String(gender || '').toLowerCase()];
    return Array.isArray(list) ? list : [];
  }

  /* ---------- Cart helpers ---------- */

  async function requestJson(path, options) {
    var response = await fetch(routesRoot + path, options);
    var data = null;
    try {
      data = await response.json();
    } catch (ignored) {
      /* non-JSON body; fall through to status handling */
    }
    if (!response.ok) {
      throw new Error(
        (data && (data.description || data.message)) ||
          'Request failed (' + response.status + ').'
      );
    }
    return data;
  }

  function cartVariantIds(cart) {
    var ids = new Set();
    (cart.items || []).forEach(function (item) {
      ids.add(Number(item.variant_id));
    });
    return ids;
  }

  /** Confirms main product, chosen upsells and patient attributes are all in the cart. */
  function verifyCart(cart, expectedVariantIds) {
    var inCart = cartVariantIds(cart);

    if (!inCart.has(Number(state.mainVariantId))) {
      throw new Error(
        'Your selected panel is no longer in the cart. Please go back and select it again.'
      );
    }

    expectedVariantIds.forEach(function (id) {
      if (!inCart.has(id)) {
        throw new Error('One of the selected add-ons could not be added to your cart.');
      }
    });

    var cartAttributes = cart.attributes || {};
    Object.keys(state.attributes).forEach(function (key) {
      var expected = state.attributes[key];
      // Shopify drops empty attribute values, so only check the ones that have content.
      if (expected !== '' && cartAttributes[key] !== expected) {
        throw new Error('Your patient information was not saved. Please try again.');
      }
    });
  }

  function goToCheckout() {
    global.location.assign(routesRoot + 'checkout');
  }

  /* ---------- UI ---------- */

  function cacheElements() {
    var modal = document.getElementById(MODAL_ID);
    if (!modal) return false;
    els = {
      modal: modal,
      panel: modal.querySelector('.upsell-popup__panel'),
      list: modal.querySelector('[data-upsell-list]'),
      error: modal.querySelector('[data-upsell-error]'),
      addButton: modal.querySelector('[data-upsell-add]'),
      skipButton: modal.querySelector('[data-upsell-skip]')
    };
    return Boolean(els.panel && els.list && els.error && els.addButton && els.skipButton);
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.textContent = '';
    els.error.hidden = true;
  }

  function selectedVariantIds() {
    return Array.prototype.map.call(
      els.list.querySelectorAll('input[type="checkbox"]:checked'),
      function (input) {
        return Number(input.value);
      }
    );
  }

  function updateAddButton() {
    els.addButton.disabled = state.busy || selectedVariantIds().length === 0;
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    els.skipButton.disabled = isBusy;
    els.addButton.textContent = isBusy ? 'Please wait…' : els.addButton.dataset.label;
    els.list.querySelectorAll('input[type="checkbox"]').forEach(function (input) {
      input.disabled = isBusy || input.dataset.available !== 'true';
    });
    updateAddButton();
  }

  function buildOffer(offer) {
    var item = document.createElement('li');
    var label = document.createElement('label');
    label.className = 'upsell-popup__option';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'upsell-popup__checkbox';
    checkbox.value = String(offer.variantId);
    checkbox.dataset.available = String(Boolean(offer.available));
    checkbox.disabled = !offer.available;

    var media;
    if (offer.image) {
      media = document.createElement('img');
      media.className = 'upsell-popup__image';
      media.src = offer.image;
      media.alt = '';
      media.loading = 'lazy';
      media.width = 64;
      media.height = 64;
    } else {
      media = document.createElement('span');
      media.className = 'upsell-popup__image-placeholder';
    }

    var info = document.createElement('span');
    info.className = 'upsell-popup__info';
    var name = document.createElement('span');
    name.className = 'upsell-popup__name';
    name.textContent = offer.title;
    info.appendChild(name);

    if (!offer.available) {
      label.classList.add('is-unavailable');
      var badge = document.createElement('span');
      badge.className = 'upsell-popup__badge';
      badge.textContent = 'Sold out';
      info.appendChild(badge);
    }

    var price = document.createElement('span');
    price.className = 'upsell-popup__price';
    price.textContent = offer.price;

    checkbox.addEventListener('change', function () {
      label.classList.toggle('is-selected', checkbox.checked);
      clearError();
      updateAddButton();
    });

    label.appendChild(checkbox);
    label.appendChild(media);
    label.appendChild(info);
    label.appendChild(price);
    item.appendChild(label);
    return item;
  }

  function renderOffers(offers) {
    els.list.textContent = '';
    offers.forEach(function (offer) {
      els.list.appendChild(buildOffer(offer));
    });
  }

  function trapFocus(event) {
    if (event.key !== 'Tab') return;
    var focusable = els.panel.querySelectorAll(
      'button:not([disabled]), input:not([disabled])'
    );
    if (!focusable.length) {
      event.preventDefault();
      els.panel.focus();
      return;
    }
    var first = focusable[0];
    var last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === els.panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function openModal() {
    state.previousFocus = document.activeElement;
    els.modal.hidden = false;
    document.documentElement.classList.add(ROOT_CLASS);
    els.modal.addEventListener('keydown', trapFocus);
    els.panel.focus();
  }

  /* ---------- Actions ---------- */

  async function handleAdd() {
    if (state.busy) return;
    var chosen = selectedVariantIds();
    if (!chosen.length) return;

    setBusy(true);
    clearError();

    try {
      // Skip anything already in the cart so retries never create duplicates.
      var currentCart = await requestJson('cart.js');
      var alreadyInCart = cartVariantIds(currentCart);
      var toAdd = chosen.filter(function (id) {
        return !alreadyInCart.has(id);
      });

      if (toAdd.length) {
        // One request for all items: Shopify adds all of them or none.
        await requestJson('cart/add.js', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({
            items: toAdd.map(function (id) {
              return { id: id, quantity: 1 };
            })
          })
        });
      }

      verifyCart(await requestJson('cart.js'), chosen);
      goToCheckout(); // stay busy while the browser navigates
    } catch (error) {
      console.error('[UpsellPopup] Add to cart failed:', error);
      showError(error.message || 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  async function handleSkip() {
    if (state.busy) return;

    setBusy(true);
    clearError();

    try {
      verifyCart(await requestJson('cart.js'), []);
      goToCheckout();
    } catch (error) {
      console.error('[UpsellPopup] Skip failed:', error);
      showError(error.message || 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  /* ---------- Public entry point ---------- */

  function start(options) {
    try {
      var config = readConfig();
      var offers = getOffers(config, options.mainVariantId, options.gender);

      // Nothing purchasable to recommend -> let the caller go straight to checkout.
      var hasAvailable = offers.some(function (offer) {
        return offer.available;
      });
      if (!hasAvailable || !cacheElements()) return false;

      state.mainVariantId = options.mainVariantId;
      state.attributes = options.attributes || {};
      state.offers = offers;

      els.addButton.dataset.label = els.addButton.textContent.trim();
      els.addButton.onclick = handleAdd;
      els.skipButton.onclick = handleSkip;

      renderOffers(offers);
      clearError();
      setBusy(false);
      openModal();
      return true;
    } catch (error) {
      console.error('[UpsellPopup] Could not start, continuing to checkout:', error);
      return false;
    }
  }

  // Back button from checkout can restore this page from bfcache with the buttons locked.
  global.addEventListener('pageshow', function (event) {
    if (event.persisted && els && !els.modal.hidden) setBusy(false);
  });

  global.UpsellPopup = { start: start };
})(window);
