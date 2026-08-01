# Los Angeles Exterminators — Rank & Rent Site

A static, local-SEO pest control website for the Los Angeles market, built under the
"rank and rent" model: launch and rank the site under a generic, ownable brand, then
lease access to leads to a real, licensed pest control operator once it's ranking.

## Stack

Plain static HTML/CSS/JS — no build step, no framework, no backend. Matches the
pattern used by the main ZexMarketing site (`/index.html`, `/css/style.css`, etc.)
at the repo root. Deploy by pointing any static host (Netlify, Vercel, S3 + CloudFront,
GitHub Pages, etc.) at this folder.

## Structure

```
index.html                 Homepage
about.html, contact.html, faq.html, reviews.html, service-areas.html
privacy.html, terms.html   Legal (noindexed)
services/                  10 service pages (one per money keyword)
locations/                 6 city/location pages (LA, Hollywood, Santa Monica,
                            Pasadena, Long Beach, Glendale)
css/style.css               Shared design system
js/script.js                 Mobile nav, FAQ accordion, lead-form stub
robots.txt, sitemap.xml
```

## Before going live / before renting to a client

This site is intentionally built with **no fabricated facts** — no fake reviews,
no invented license number, no made-up "years in business" or job-count stats.
Swap these in with real information once a domain and/or a real operator is attached:

- [ ] Register a real domain and update all `https://www.losangelesexterminators.com/`
      canonical URLs, the JSON-LD in `index.html`, `sitemap.xml`, and `robots.txt`.
- [ ] Replace the placeholder phone number `(323) 555-0142` (`tel:+13235550142`) —
      used consistently across every page — with a real tracked number.
- [ ] Replace `info@losangelesexterminators.com` with a real inbox.
- [ ] Wire the two lead forms (`index.html` hero form, `contact.html`) to a real
      backend/CRM — right now `js/script.js` just shows a success message locally
      (`form[data-lead-form]`), nothing is actually sent anywhere.
- [ ] Add the operator's real CA Structural Pest Control Board license number to the
      footer (`footer-license` paragraph) once one exists — do not invent one.
- [ ] Replace the `reviews.html` "commitments" content with real, verified Google/Yelp
      reviews once the business has them — do not add fabricated testimonials.
- [ ] Consider adding real photos (technician, vehicle, treated properties) — the
      site currently uses emoji icons only, by design, to avoid stock-photo generic-ness.
- [ ] Set up Google Business Profile with a real service-area business listing.
- [ ] Point Google Search Console / Analytics at the final domain.

## SEO structure

- One page per service (money keyword) × one page per major city, plus a broader
  `service-areas.html` covering ~35 additional LA County neighborhoods for semantic/
  internal-link coverage without creating thin duplicate pages for every one of them.
- `FAQPage` JSON-LD on `faq.html`, `PestControl`/`LocalBusiness` JSON-LD on `index.html`.
- Every page shares consistent NAP (name/phone) for local SEO trust signals.
