// Unit tests for shared/leads-core.js. Run: node --test extensions/maps-lead-extractor-tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../maps-lead-extractor/shared/leads-core.js');

test('parseRating handles dot and comma decimals', () => {
  assert.equal(Core.parseRating('4.6'), '4.6');
  assert.equal(Core.parseRating('4,6'), '4.6');
  assert.equal(Core.parseRating('5'), '5.0');
  assert.equal(Core.parseRating(''), '');
  assert.equal(Core.parseRating('12'), '');
});

test('parseReviewCount handles separators and abbreviations', () => {
  assert.equal(Core.parseReviewCount('(1,234)'), '1234');
  assert.equal(Core.parseReviewCount('(1.234)'), '1234');
  assert.equal(Core.parseReviewCount('(1 234)'), '1234');
  assert.equal(Core.parseReviewCount('(2.3K)'), '2300');
  assert.equal(Core.parseReviewCount('4.5(87)'), '87');
  assert.equal(Core.parseReviewCount(''), '');
});

test('parseRatingLabel reads star labels in any language', () => {
  assert.deepEqual(Core.parseRatingLabel('4.6 stars 1,234 Reviews'), { rating: '4.6', reviewCount: '1234' });
  assert.deepEqual(Core.parseRatingLabel('4,2 Sterne 87 Rezensionen'), { rating: '4.2', reviewCount: '87' });
  assert.deepEqual(Core.parseRatingLabel('1,234 reviews'), { rating: '', reviewCount: '1234' });
});

test('parsePlaceUrl extracts feature id, CID and coordinates', () => {
  const href =
    'https://www.google.com/maps/place/Acme+Pest/data=!4m7!3m6!1s0x89c25a2b3c4d5e6f:0x1a2b3c4d5e6f7081!8m2!3d40.7128!4d-74.006!16s%2Fg%2F11abc';
  const p = Core.parsePlaceUrl(href);
  assert.equal(p.placeId, '0x89c25a2b3c4d5e6f:0x1a2b3c4d5e6f7081');
  assert.equal(p.cid, BigInt('0x1a2b3c4d5e6f7081').toString());
  assert.equal(p.latitude, '40.7128');
  assert.equal(p.longitude, '-74.006');
  assert.equal(Core.placeKey(href), p.placeId);
  assert.equal(Core.placeKey(href.replace(':', '%3A')), p.placeId);
});

test('normalizeWebsite unwraps Google redirects and adds protocol', () => {
  assert.equal(Core.normalizeWebsite('https://www.google.com/url?q=https://acme.com/&sa=U'), 'https://acme.com/');
  assert.equal(Core.normalizeWebsite('acme.com'), 'https://acme.com/');
  assert.equal(Core.normalizeWebsite(''), '');
  assert.equal(Core.normalizeWebsite('not a url'), '');
});

test('rootDomain and sameSite', () => {
  assert.equal(Core.rootDomain('www.shop.acme.co.uk'), 'acme.co.uk');
  assert.equal(Core.rootDomain('mail.acme.com'), 'acme.com');
  assert.ok(Core.sameSite('acme.com', 'www.acme.com'));
  assert.ok(!Core.sameSite('acme.com', 'other.com'));
});

test('extractEmails finds mailto, text, Cloudflare and obfuscated emails', () => {
  // Cloudflare encodes with an XOR key: key 0x42.
  const encode = (email, key = 0x42) =>
    key.toString(16).padStart(2, '0') +
    Array.from(email)
      .map((c) => (c.charCodeAt(0) ^ key).toString(16).padStart(2, '0'))
      .join('');
  const html = `
    <a href="mailto:Info@Acme.com?subject=Hi">Mail</a>
    <p>Write to sales [at] acme [dot] com</p>
    <span class="__cf_email__" data-cfemail="${encode('office@acme.com')}">[email&#160;protected]</span>
    <img src="logo@2x.png"> <p>owner&#64;gmail.com</p>
    <script>var dsn="https://0123456789abcdef0123@o1.ingest.sentry.io/1"; var x="a1b2c3d4e5f6a7b8c9d0@sentry.wixpress.com"</script>
    <p>your@email.com john.doe@example.com</p>`;
  const emails = Core.extractEmails(html).map((e) => e.email);
  assert.ok(emails.includes('info@acme.com'));
  assert.ok(emails.includes('sales@acme.com'));
  assert.ok(emails.includes('office@acme.com'));
  assert.ok(emails.includes('owner@gmail.com'));
  assert.ok(!emails.some((e) => e.includes('2x.png')));
  assert.ok(!emails.some((e) => e.includes('sentry')));
  assert.ok(!emails.includes('your@email.com'));
  assert.ok(!emails.includes('john.doe@example.com'));
  const mailto = Core.extractEmails(html).find((e) => e.email === 'info@acme.com');
  assert.equal(mailto.mailto, true);
});

test('rankEmails prefers the business domain over designers and free mail', () => {
  const ranked = Core.rankEmails(
    [
      { email: 'design@webagency.com', mailto: true },
      { email: 'owner@gmail.com', mailto: false },
      { email: 'noreply@acme.com', mailto: false },
      { email: 'contact@acme.com', mailto: false },
    ],
    'acme.com',
  );
  assert.equal(ranked[0], 'contact@acme.com');
  assert.equal(ranked[1], 'owner@gmail.com');
  assert.equal(ranked[2], 'design@webagency.com');
  assert.equal(ranked[3], 'noreply@acme.com');
});

test('findContactLinks finds same-site contact pages in any language first', () => {
  const html = `
    <a href="/services">Services</a>
    <a href="/ueber-uns">Über uns</a>
    <a href="https://acme.com/kontakt#form">Kontakt</a>
    <a href="/reach">Get in touch</a>
    <a href="https://facebook.com/acme">Facebook</a>
    <a href="mailto:x@acme.com">Mail</a>
    <a href="/brochure.pdf">Contact brochure</a>`;
  const links = Core.findContactLinks(html, 'https://www.acme.com/');
  assert.deepEqual(links.slice(0, 2).sort(), ['https://acme.com/kontakt', 'https://www.acme.com/reach'].sort());
  assert.ok(links.includes('https://www.acme.com/ueber-uns'));
  assert.ok(!links.some((l) => l.includes('facebook') || l.includes('.pdf') || l.includes('services')));
});

test('extractSocialLinks skips share buttons', () => {
  const html = `
    <a href="https://www.facebook.com/sharer/sharer.php?u=x">share</a>
    <a href="https://www.facebook.com/AcmePest">fb</a>
    <a href="https://twitter.com/intent/tweet?text=x">tweet</a>
    <a href="https://x.com/acmepest">x</a>
    <a href="https://www.instagram.com/acme.pest/">ig</a>
    <a href="https://www.linkedin.com/company/acme-pest/">li</a>`;
  const s = Core.extractSocialLinks(html);
  assert.equal(s.facebook, 'https://www.facebook.com/AcmePest');
  assert.equal(s.twitter, 'https://x.com/acmepest');
  assert.equal(s.instagram, 'https://www.instagram.com/acme.pest/');
  assert.equal(s.linkedin, 'https://www.linkedin.com/company/acme-pest/');
});

test('csvCell escapes formulas, quotes and newlines', () => {
  assert.equal(Core.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(Core.csvCell('+1 212'), "'+1 212");
  assert.equal(Core.csvCell('-5'), '-5');
  assert.equal(Core.csvCell('-73.95'), '-73.95');
  assert.equal(Core.csvCell('-5+A1'), "'-5+A1");
  assert.equal(Core.csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(Core.csvCell('a,b'), '"a,b"');
  assert.equal(Core.csvCell('line1\nline2'), '"line1\nline2"');
  assert.equal(Core.csvCell(null), '');
  assert.equal(Core.csvCell('Acme Pest'), 'Acme Pest');
});

test('mergeRecords joins rows with email results and sets status', () => {
  const all = {
    'row:a': { name: 'A', website: 'https://a.com/', order: 2 },
    'row:b': { name: 'B', website: '', order: 1 },
    'row:c': { name: 'C', website: 'https://c.com/', order: 3 },
    'row:d': { name: 'D', website: 'https://d.com/', order: 4 },
    'email:a': {
      bestEmail: 'info@a.com',
      emails: ['info@a.com', 'x@gmail.com'],
      socials: { facebook: 'https://facebook.com/a' },
    },
    'email:d': { bestEmail: '', emails: [], socials: {}, error: 'Website did not load' },
    emailQueue: [{ key: 'c' }],
  };
  const rows = Core.mergeRecords(all);
  assert.deepEqual(
    rows.map((r) => r.name),
    ['B', 'A', 'C', 'D'],
  );
  assert.equal(rows[0].emailStatus, 'No website');
  assert.equal(rows[1].email, 'info@a.com');
  assert.equal(rows[1].allEmails, 'info@a.com; x@gmail.com');
  assert.equal(rows[1].facebook, 'https://facebook.com/a');
  assert.equal(rows[1].emailStatus, 'Found');
  assert.equal(rows[2].emailStatus, 'Pending');
  assert.equal(rows[3].emailStatus, 'Website error');
});

test('buildCsv starts with BOM and the core columns in order', () => {
  const csv = Core.buildCsv([{ name: 'Acme', rating: '4.5', reviewCount: '10' }]);
  assert.ok(csv.startsWith('﻿'));
  const header = csv.slice(1).split('\r\n')[0];
  assert.ok(header.startsWith('Business Name,Category,Phone,Address,Website,Email,Average Rating,Total Reviews'));
});
