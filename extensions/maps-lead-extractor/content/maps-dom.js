/*
 * Reads Google Maps markup. Every reader is defensive: a missing element
 * returns an empty value instead of throwing. Values come from attributes and
 * element positions, never from English label text, so any Maps language works.
 */
(function (root) {
  'use strict';

  const Core = root.ZexCore;
  const clean = Core.cleanText;

  const END_OF_LIST_TEXT = [
    "you've reached the end of the list",
    'has llegado al final de la lista',
    'vous êtes arrivé à la fin de la liste',
    'sie haben das ende der liste erreicht',
    'você chegou ao final da lista',
    'hai raggiunto la fine dell',
    'je hebt het einde van de lijst bereikt',
  ];

  function getFeed() {
    return document.querySelector('div[role="feed"]');
  }

  // The element that scrolls the result list.
  function getScroller(feed) {
    let el = feed;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 5) {
        const oy = getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
      }
      el = el.parentElement;
    }
    return feed;
  }

  // Map of placeKey -> <a> link for every result card in the feed.
  function getCardLinks(feed) {
    const out = new Map();
    if (!feed) return out;
    for (const a of feed.querySelectorAll('a[href*="/maps/place/"]')) {
      const key = Core.placeKey(a.href);
      if (key && !out.has(key)) out.set(key, a);
    }
    return out;
  }

  function cardOf(link) {
    return (link && (link.closest('[role="article"]') || link.closest('.Nv2PK') || link.parentElement)) || null;
  }

  function isEndOfList(feed) {
    if (!feed) return false;
    if (feed.querySelector('.HlvSq')) return true;
    const tail = feed.lastElementChild;
    const text = clean(tail && tail.textContent).toLowerCase();
    return !!text && END_OF_LIST_TEXT.some((t) => text.includes(t));
  }

  function cardCategory(card) {
    for (const row of card.querySelectorAll('.W4Efsd')) {
      if (row.querySelector('.W4Efsd')) continue; // only leaf rows
      if (row.querySelector('.MW4etd, .UY7F9, [role="img"]')) continue; // rating row
      const first = clean(row.textContent).split('·')[0].trim();
      // Category text has letters and no digits. An address in this slot means no category.
      if (first && /\p{L}/u.test(first) && !/\d/.test(first)) return first;
      return '';
    }
    return '';
  }

  // Fields visible on the result card. Used as a fallback for the detail pane.
  function readCard(link) {
    const out = { name: '', rating: '', reviewCount: '', category: '' };
    try {
      const card = cardOf(link);
      out.name =
        clean(link.getAttribute('aria-label')) ||
        clean(card && card.getAttribute('aria-label')) ||
        clean(
          card &&
            card.querySelector('.fontHeadlineSmall, .qBF1Pd') &&
            card.querySelector('.fontHeadlineSmall, .qBF1Pd').textContent,
        );
      if (!card) return out;
      const r = card.querySelector('.MW4etd');
      const c = card.querySelector('.UY7F9');
      if (r) out.rating = Core.parseRating(r.textContent);
      if (c) out.reviewCount = Core.parseReviewCount(c.textContent);
      if (!out.rating) {
        const img = Array.from(card.querySelectorAll('[role="img"][aria-label]')).find((x) =>
          /\d/.test(x.getAttribute('aria-label')),
        );
        if (img) {
          const p = Core.parseRatingLabel(img.getAttribute('aria-label'));
          out.rating = p.rating;
          out.reviewCount = out.reviewCount || p.reviewCount;
        }
      }
      out.category = cardCategory(card);
    } catch (e) {
      /* keep whatever was read */
    }
    return out;
  }

  // The open place-details pane, or null.
  function getPlacePane() {
    const panes = Array.from(document.querySelectorAll('div[role="main"]')).filter(
      (m) => !m.querySelector('div[role="feed"]') && m.querySelector('h1'),
    );
    if (panes.length) return panes[panes.length - 1];
    const h1 = document.querySelector('h1.DUwDvf');
    return h1 ? h1.closest('div[role="main"]') || h1.parentElement : null;
  }

  function paneName(pane) {
    if (!pane) return '';
    const h1 = pane.querySelector('h1.DUwDvf') || pane.querySelector('h1');
    return clean(h1 && h1.textContent) || clean(pane.getAttribute('aria-label'));
  }

  function paneHasInfo(pane) {
    return !!(pane && (pane.querySelector('[data-item-id]') || pane.querySelector('.F7nice')));
  }

  // Visible value of an info row. Falls back to the aria-label minus its "Label:" prefix.
  function rowText(el) {
    if (!el) return '';
    const inner = el.querySelector('.Io6YTe') || el.querySelector('.fontBodyMedium');
    let s = clean(inner ? inner.textContent : el.textContent);
    if (!s) {
      const label = clean(el.getAttribute('aria-label'));
      const i = label.indexOf(':');
      s = clean(i >= 0 ? label.slice(i + 1) : label);
    }
    return s;
  }

  function readRating(pane) {
    const out = { rating: '', reviewCount: '' };
    const box = pane.querySelector('.F7nice');
    if (box) {
      const hidden = box.querySelector('span[aria-hidden="true"]');
      out.rating = Core.parseRating(hidden && hidden.textContent);
      const countSpan = Array.from(box.querySelectorAll('span')).find((s) =>
        /\(\s*[\d.,\s  ]+[KkMm]?\s*\)/.test(s.textContent),
      );
      if (countSpan) out.reviewCount = Core.parseReviewCount(countSpan.textContent);
      if (!out.reviewCount) {
        const labelled = Array.from(box.querySelectorAll('[aria-label]')).find((x) =>
          /\d/.test(x.getAttribute('aria-label')),
        );
        if (labelled) out.reviewCount = Core.parseReviewCount(labelled.getAttribute('aria-label'));
      }
    }
    if (!out.rating) {
      const img = Array.from(pane.querySelectorAll('[role="img"][aria-label]')).find((x) =>
        /^\s*\d(?:[.,]\d)?\b/.test(x.getAttribute('aria-label')),
      );
      if (img) {
        const p = Core.parseRatingLabel(img.getAttribute('aria-label'));
        out.rating = p.rating;
        out.reviewCount = out.reviewCount || p.reviewCount;
      }
    }
    return out;
  }

  function readDetails(pane) {
    const out = {
      name: '',
      category: '',
      address: '',
      phone: '',
      phoneRaw: '',
      website: '',
      plusCode: '',
      rating: '',
      reviewCount: '',
    };
    if (!pane) return out;
    const safe = (fn) => {
      try {
        fn();
      } catch (e) {
        /* leave field empty */
      }
    };

    safe(() => (out.name = paneName(pane)));
    safe(() => {
      const btn = pane.querySelector('button[jsaction*="category"]') || pane.querySelector('.DkEaL');
      out.category = clean(btn && btn.textContent);
    });
    safe(() => (out.address = rowText(pane.querySelector('[data-item-id="address"]'))));
    safe(() => {
      const el = pane.querySelector('[data-item-id^="phone:tel:"]') || pane.querySelector('[data-item-id^="phone:"]');
      if (!el) return;
      const id = el.getAttribute('data-item-id') || '';
      out.phoneRaw = clean(decodeURIComponent(id.replace(/^phone:(tel:)?/, '')));
      out.phone = rowText(el) || out.phoneRaw;
    });
    safe(() => {
      const a = pane.querySelector('a[data-item-id="authority"]') || pane.querySelector('[data-item-id="authority"] a');
      if (!a) return;
      out.website = Core.normalizeWebsite(a.getAttribute('href') || '') || Core.normalizeWebsite(rowText(a));
    });
    safe(() => (out.plusCode = rowText(pane.querySelector('[data-item-id="oloc"]'))));
    safe(() => Object.assign(out, readRating(pane)));
    return out;
  }

  function isBlocked() {
    return !!(
      document.querySelector('iframe[src*="recaptcha"]') ||
      document.querySelector('#captcha-form') ||
      /\/sorry\//.test(location.pathname)
    );
  }

  function searchBoxValue() {
    const input =
      document.querySelector('input#searchboxinput') ||
      document.querySelector('input[name="q"]') ||
      document.querySelector('form input[type="text"]');
    return clean(input && input.value);
  }

  root.ZexMapsDom = {
    getFeed,
    getScroller,
    getCardLinks,
    cardOf,
    isEndOfList,
    readCard,
    getPlacePane,
    paneName,
    paneHasInfo,
    readDetails,
    isBlocked,
    searchBoxValue,
  };
})(globalThis);
