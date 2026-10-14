/*
 * Shared, DOM-free helpers used by the content script, the background worker,
 * the popup and the Node unit tests. Exposed as `ZexCore` on the global object
 * and as a CommonJS module when `module` exists.
 */
(function (root) {
  'use strict';

  // CSV column order. The first eight are the core GBP fields.
  const COLUMNS = [
    ['name', 'Business Name'],
    ['category', 'Category'],
    ['phone', 'Phone'],
    ['address', 'Address'],
    ['website', 'Website'],
    ['email', 'Email'],
    ['rating', 'Average Rating'],
    ['reviewCount', 'Total Reviews'],
    ['allEmails', 'All Emails Found'],
    ['facebook', 'Facebook'],
    ['instagram', 'Instagram'],
    ['linkedin', 'LinkedIn'],
    ['twitter', 'X / Twitter'],
    ['youtube', 'YouTube'],
    ['tiktok', 'TikTok'],
    ['phoneRaw', 'Phone (Dial Format)'],
    ['plusCode', 'Plus Code'],
    ['latitude', 'Latitude'],
    ['longitude', 'Longitude'],
    ['mapsUrl', 'Google Maps URL'],
    ['placeId', 'Place ID'],
    ['cid', 'CID'],
    ['query', 'Search Query'],
    ['emailStatus', 'Email Status'],
    ['scrapedAt', 'Scraped At'],
  ];

  const SOCIAL_KEYS = ['facebook', 'instagram', 'linkedin', 'twitter', 'youtube', 'tiktok'];

  // ---------- generic text helpers ----------

  // Material icon glyphs live in the Unicode private-use area.
  const PRIVATE_USE = /[-]/g;

  function cleanText(value) {
    return String(value == null ? '' : value)
      .replace(PRIVATE_USE, '')
      .replace(/[\s  ]+/g, ' ')
      .trim();
  }

  function normalizeName(value) {
    return cleanText(value).toLowerCase();
  }

  // ---------- rating / review parsing ----------

  function parseRating(text) {
    const m = cleanText(text).match(/\d+(?:[.,]\d+)?/);
    if (!m) return '';
    const n = parseFloat(m[0].replace(',', '.'));
    if (!isFinite(n) || n < 0 || n > 5) return '';
    return n.toFixed(1);
  }

  function parseReviewCount(text) {
    const s = cleanText(text);
    if (!s) return '';
    const paren = s.match(/\(([^)]*)\)/);
    const src = paren ? paren[1] : s;
    const abbr = src.match(/(\d+(?:[.,]\d+)?)\s*([KkMm])\b/);
    if (abbr) {
      const n = parseFloat(abbr[1].replace(',', '.'));
      return String(Math.round(n * (/k/i.test(abbr[2]) ? 1e3 : 1e6)));
    }
    const digits = src.replace(/[^\d]/g, '');
    return digits ? String(parseInt(digits, 10)) : '';
  }

  // Parses labels like "4.6 stars 1,234 Reviews" or "4,6 Sterne 1.234 Rezensionen".
  function parseRatingLabel(label) {
    const nums = cleanText(label).match(/\d+(?:[.,\s  ]\d+)*/g) || [];
    const out = { rating: '', reviewCount: '' };
    if (nums.length === 0) return out;
    // A rating is one digit with an optional single decimal: 4, 4.6, 4,6.
    if (/^\d(?:[.,]\d)?$/.test(nums[0])) {
      out.rating = parseRating(nums[0]);
      if (nums[1]) out.reviewCount = parseReviewCount(nums[1]);
    } else {
      out.reviewCount = parseReviewCount(nums[0]);
    }
    return out;
  }

  // ---------- Google Maps URL parsing ----------

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch (e) {
      return value;
    }
  }

  function parsePlaceUrl(href) {
    const out = { placeId: '', cid: '', latitude: '', longitude: '' };
    const url = safeDecode(String(href || ''));
    const f = url.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
    if (f) {
      out.placeId = f[1].toLowerCase();
      try {
        out.cid = BigInt(out.placeId.split(':')[1]).toString();
      } catch (e) {
        out.cid = '';
      }
    }
    const lat = url.match(/!3d(-?\d+(?:\.\d+)?)/);
    const lng = url.match(/!4d(-?\d+(?:\.\d+)?)/);
    if (lat && lng) {
      out.latitude = lat[1];
      out.longitude = lng[1];
    } else {
      const at = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
      if (at) {
        out.latitude = at[1];
        out.longitude = at[2];
      }
    }
    return out;
  }

  // Stable identity for a place. Uses the feature id when present.
  function placeKey(href) {
    const p = parsePlaceUrl(href);
    if (p.placeId) return p.placeId;
    const url = safeDecode(String(href || ''));
    const m = url.match(/\/maps\/place\/([^/]+)/);
    if (!m) return '';
    return 'name:' + m[1].replace(/\+/g, ' ').toLowerCase() + (p.latitude ? '@' + p.latitude + ',' + p.longitude : '');
  }

  // ---------- website helpers ----------

  function unwrapGoogleRedirect(href) {
    try {
      const u = new URL(href);
      if (/(^|\.)google\.[a-z.]+$/i.test(u.hostname) && u.pathname === '/url') {
        return u.searchParams.get('q') || u.searchParams.get('url') || href;
      }
    } catch (e) {
      /* not a URL */
    }
    return href;
  }

  function normalizeWebsite(href) {
    let s = cleanText(href);
    if (!s) return '';
    s = unwrapGoogleRedirect(s);
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return '';
      return u.href;
    } catch (e) {
      return '';
    }
  }

  function hostOf(href) {
    try {
      return new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    } catch (e) {
      return '';
    }
  }

  const SECOND_LEVEL = /^(co|com|org|net|gov|edu|ac|gob|nic|ltd|plc)$/;

  // Approximate registrable domain: example.com, example.co.uk.
  function rootDomain(host) {
    const parts = String(host || '')
      .toLowerCase()
      .replace(/^www\./, '')
      .split('.')
      .filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length === 2 && SECOND_LEVEL.test(sld)) return parts.slice(-3).join('.');
    return parts.slice(-2).join('.');
  }

  function sameSite(hostA, hostB) {
    const a = rootDomain(hostA);
    return !!a && a === rootDomain(hostB);
  }

  // ---------- email extraction ----------

  const EMAIL_RE =
    /[a-z0-9][a-z0-9._%+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}/gi;

  const FILE_TLDS = new Set([
    'png',
    'jpg',
    'jpeg',
    'gif',
    'svg',
    'webp',
    'bmp',
    'ico',
    'avif',
    'tif',
    'tiff',
    'css',
    'js',
    'mjs',
    'json',
    'map',
    'pdf',
    'mp3',
    'mp4',
    'webm',
    'mov',
    'avi',
    'woff',
    'woff2',
    'ttf',
    'eot',
    'otf',
    'zip',
    'rar',
    'php',
    'html',
    'htm',
    'asp',
    'aspx',
    'jsp',
    'xml',
    'txt',
    'csv',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
  ]);

  const BLOCKED_DOMAINS = [
    'example.com',
    'example.org',
    'example.net',
    'domain.com',
    'email.com',
    'yourdomain.com',
    'yoursite.com',
    'yourwebsite.com',
    'website.com',
    'mysite.com',
    'yourcompany.com',
    'company.com',
    'test.com',
    'sentry.io',
    'wixpress.com',
    'wix.com',
    'squarespace.com',
    'godaddy.com',
    'wordpress.com',
    'wordpress.org',
    'w3.org',
    'schema.org',
    'sentry-next.wixpress.com',
    'mail.com',
    'address.com',
    'yourmail.com',
  ];

  const PLACEHOLDER_LOCALS = new Set([
    'your',
    'yourname',
    'your.name',
    'name',
    'user',
    'username',
    'email',
    'youremail',
    'your.email',
    'john',
    'johndoe',
    'john.doe',
    'jane',
    'janedoe',
    'jane.doe',
    'example',
    'test',
    'someone',
    'firstname.lastname',
    'first.last',
    'me',
    'xxx',
    'abc',
  ]);

  const NOREPLY_LOCALS =
    /^(no-?reply|do-?not-?reply|donotreply|postmaster|mailer-daemon|abuse|dmca|privacy|unsubscribe|bounce|bounces)\b/;

  const ROLE_LOCALS =
    /^(info|contact|hello|hi|office|admin|sales|enquiries|enquiry|inquiries|inquiry|service|services|support|booking|bookings|appointments|mail|team|help|customerservice|reception|frontdesk)\b/;

  const FREE_PROVIDERS = new Set([
    'gmail.com',
    'googlemail.com',
    'yahoo.com',
    'ymail.com',
    'outlook.com',
    'hotmail.com',
    'live.com',
    'msn.com',
    'aol.com',
    'icloud.com',
    'me.com',
    'mac.com',
    'protonmail.com',
    'proton.me',
    'comcast.net',
    'verizon.net',
    'att.net',
    'sbcglobal.net',
    'bellsouth.net',
    'optonline.net',
    'gmx.com',
    'zoho.com',
    'yandex.com',
    'mail.ru',
  ]);

  function isPlausibleEmail(email) {
    const e = String(email || '').toLowerCase();
    if (e.length > 254) return false;
    const at = e.lastIndexOf('@');
    if (at < 1) return false;
    const local = e.slice(0, at);
    const domain = e.slice(at + 1);
    const tld = domain.split('.').pop();
    if (FILE_TLDS.has(tld)) return false;
    if (/@\d+x\./.test(e)) return false; // retina image names: logo@2x.png
    if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
    if (/^[a-f0-9]{16,}$/.test(local)) return false; // tracking hashes (Sentry DSNs)
    if (PLACEHOLDER_LOCALS.has(local)) return false;
    if (domain.includes('sentry') || domain.includes('wixpress')) return false;
    if (BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return false;
    return true;
  }

  function decodeCloudflareEmail(hex) {
    try {
      const key = parseInt(hex.slice(0, 2), 16);
      let out = '';
      for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
      return out;
    } catch (e) {
      return '';
    }
  }

  function decodeEntities(html) {
    return String(html || '')
      .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&commat;/gi, '@')
      .replace(/&period;/gi, '.')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&');
  }

  // Returns [{ email, mailto }] with unique lowercase emails, in page order.
  function extractEmails(html) {
    const found = new Map();
    const add = (raw, mailto) => {
      const email = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^mailto:/, '')
        .replace(/[.,;:]+$/, '');
      if (!email || !isPlausibleEmail(email)) return;
      const m = email.match(EMAIL_RE);
      if (!m || m[0] !== email) return;
      const prev = found.get(email);
      found.set(email, { email, mailto: !!mailto || (prev ? prev.mailto : false) });
    };

    let text = String(html || '');

    // Cloudflare email protection.
    text = text.replace(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi, (m, hex) => {
      add(decodeCloudflareEmail(hex), true);
      return '';
    });
    text = text.replace(/\/cdn-cgi\/l\/email-protection#([0-9a-f]+)/gi, (m, hex) => {
      add(decodeCloudflareEmail(hex), true);
      return '';
    });

    text = decodeEntities(text);

    const mailtoRe = /mailto:([^"'<>\s?]+)/gi;
    let m;
    while ((m = mailtoRe.exec(text)) !== null) {
      safeDecode(m[1])
        .split(/[,;]/)
        .forEach((part) => add(part, true));
    }

    // "name [at] domain [dot] com" style obfuscation.
    const deobfuscated = text.replace(/\s*[[({]\s*at\s*[\])}]\s*/gi, '@').replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, '.');

    const matches = deobfuscated.match(EMAIL_RE) || [];
    for (const e of matches) add(e, false);
    return Array.from(found.values());
  }

  function scoreEmail(item, websiteHost) {
    const email = item.email;
    const at = email.lastIndexOf('@');
    const local = email.slice(0, at);
    const domain = email.slice(at + 1);
    let score = 0;
    if (websiteHost && sameSite(domain, websiteHost)) score += 100;
    else if (FREE_PROVIDERS.has(domain)) score += 30;
    if (item.mailto) score += 20;
    if (ROLE_LOCALS.test(local)) score += 10;
    if (NOREPLY_LOCALS.test(local)) score -= 200;
    if (/^(webmaster|hostmaster|wordpress|admin@wordpress)/.test(local)) score -= 20;
    score += Math.min(item.hits || 1, 5);
    return score;
  }

  // Best email first. Domain-matching, mailto and role addresses rank higher.
  function rankEmails(items, websiteHost) {
    return items
      .map((item, index) => ({ email: item.email, index, score: scoreEmail(item, websiteHost) }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((x) => x.email);
  }

  // ---------- link discovery ----------

  const CONTACT_WORDS =
    /(contact|kontakt|contacto|contato|contatti|contactez|impressum|imprint|get-?in-?touch|get in touch|reach-?us|reach us|enquir|inquir|write-?to-?us|email-?us)/i;
  const ABOUT_WORDS =
    /(about|team|who-?we-?are|our-?story|ueber-?uns|uber-?uns|quienes|chi-?siamo|a-?propos|sobre|locations?)/i;
  const SKIP_FILES = /\.(pdf|jpe?g|png|gif|svg|webp|zip|docx?|xlsx?|mp4|mp3)(\?|$)/i;

  function stripTags(html) {
    return cleanText(String(html || '').replace(/<[^>]*>/g, ' '));
  }

  function findContactLinks(html, baseUrl, limit) {
    const max = limit || 4;
    const baseHost = hostOf(baseUrl);
    const re = /<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
    const scored = new Map();
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      const rawHref = decodeEntities(m[2]).trim();
      if (!rawHref || /^(mailto:|tel:|javascript:|#)/i.test(rawHref)) continue;
      let url;
      try {
        url = new URL(rawHref, baseUrl);
      } catch (e) {
        continue;
      }
      if (!/^https?:$/.test(url.protocol) || !sameSite(url.hostname, baseHost)) continue;
      url.hash = '';
      if (SKIP_FILES.test(url.pathname)) continue;
      const href = url.href;
      if (href === baseUrl || href.replace(/\/$/, '') === String(baseUrl).replace(/\/$/, '')) continue;
      const label = stripTags(m[3]);
      const hay = url.pathname + ' ' + label;
      let score = 0;
      if (CONTACT_WORDS.test(hay)) score = 3;
      else if (ABOUT_WORDS.test(hay)) score = 1;
      if (score && (!scored.has(href) || scored.get(href) < score)) scored.set(href, score);
    }
    return Array.from(scored.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, max)
      .map((x) => x[0]);
  }

  const SOCIAL_PATTERNS = {
    facebook:
      /^https?:\/\/(?:www\.|m\.|business\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr[/?]|login|groups\/?$)[^"'\s<>]+/i,
    instagram: /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|share|explore|accounts)[A-Za-z0-9_.]+/i,
    linkedin: /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:company|in|school)\/[^"'\s<>]+/i,
    twitter: /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/(?!intent|share|home|search|hashtag)[A-Za-z0-9_]{1,15}\/?$/i,
    youtube: /^https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)[^"'\s<>]+/i,
    tiktok: /^https?:\/\/(?:www\.)?tiktok\.com\/@[^"'\s<>]+/i,
  };

  function extractSocialLinks(html) {
    const out = {};
    const re = /\bhref\s*=\s*(["'])(.*?)\1/gi;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
      const href = decodeEntities(m[2]).trim();
      for (const key of SOCIAL_KEYS) {
        if (!out[key] && SOCIAL_PATTERNS[key].test(href)) out[key] = href.split('#')[0];
      }
    }
    return out;
  }

  // ---------- records & CSV ----------

  // Joins `row:<key>` records with their `email:<key>` crawl results.
  function mergeRecords(all) {
    const rows = [];
    for (const k of Object.keys(all || {})) {
      if (!k.startsWith('row:')) continue;
      const key = k.slice(4);
      const row = Object.assign({}, all[k]);
      const e = all['email:' + key];
      if (!row.website) {
        row.emailStatus = 'No website';
      } else if (e) {
        row.email = e.bestEmail || '';
        row.allEmails = (e.emails || []).join('; ');
        for (const s of SOCIAL_KEYS) row[s] = (e.socials && e.socials[s]) || '';
        row.emailStatus = row.email ? 'Found' : e.error ? 'Website error' : 'Not found';
      } else {
        row.emailStatus = 'Pending';
      }
      rows.push(row);
    }
    rows.sort((a, b) => (a.order || 0) - (b.order || 0));
    return rows;
  }

  function csvCell(value) {
    let s = value == null ? '' : String(value);
    s = s.replace(/\r\n?/g, '\n');
    // Spreadsheet formula injection guard (OWASP): prefix risky leading chars.
    // Plain numbers such as -73.95 are safe and stay numeric.
    if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    if (/[",\n]/.test(s) || /^\s|\s$/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildCsv(rows, columns) {
    const cols = columns || COLUMNS;
    const lines = [cols.map((c) => csvCell(c[1])).join(',')];
    for (const row of rows) lines.push(cols.map((c) => csvCell(row[c[0]])).join(','));
    // BOM so Excel opens UTF-8 names correctly.
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  function csvFileName(label) {
    const slug = cleanText(label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
    const d = new Date();
    const stamp =
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return 'maps-leads-' + (slug ? slug + '-' : '') + stamp + '.csv';
  }

  const api = {
    COLUMNS,
    SOCIAL_KEYS,
    cleanText,
    normalizeName,
    parseRating,
    parseReviewCount,
    parseRatingLabel,
    parsePlaceUrl,
    placeKey,
    unwrapGoogleRedirect,
    normalizeWebsite,
    hostOf,
    rootDomain,
    sameSite,
    isPlausibleEmail,
    decodeCloudflareEmail,
    extractEmails,
    rankEmails,
    findContactLinks,
    extractSocialLinks,
    mergeRecords,
    csvCell,
    buildCsv,
    csvFileName,
  };

  root.ZexCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
