# ZexLeads Maps Extractor

Chrome extension. Collects Google Business Profile leads from Google Maps search results and exports them to CSV.

## What you get in the CSV

Core columns, in this order:

- Business Name
- Category
- Phone
- Address
- Website
- Email
- Average Rating
- Total Reviews

Extra columns: all emails found, Facebook, Instagram, LinkedIn, X / Twitter, YouTube, TikTok, phone in dial format, plus code, latitude, longitude, Google Maps URL, place ID, CID, search query, email status, scrape time.

## Install

1. Open `chrome://extensions` in Chrome.
2. Turn on Developer mode (top right).
3. Click Load unpacked.
4. Select this `maps-lead-extractor` folder.
5. Pin the extension from the puzzle icon.

## Use

1. Open [Google Maps](https://www.google.com/maps). The panel appears on the right.
2. Type your keyword, for example `pest control new york`.
3. Press Start.
4. The extension scrolls the result list until Google shows the end of the list. Then it opens each business one at a time and reads its details.
5. Watch "Email checks left". When it reaches 0, press Export CSV.

## Getting every business in a city

Google Maps returns at most about 120 businesses for one search. The extension collects every business Google shows, but Google stops the list there.

To cover a whole city, split it into areas:

1. Keyword: `pest control`
2. Locations, one per line:
   ```
   Manhattan NY
   Brooklyn NY
   Queens NY
   Bronx NY
   Staten Island NY
   ```
3. Press Start.

The extension runs each search in turn and removes duplicates. For dense cities, use ZIP codes or neighborhoods. 50 ZIP codes give you up to 6,000 listings.

## How emails are found

Google Business Profiles do not show emails. The extension visits each business website in the background:

- Homepage, then pages linked as Contact, About, Kontakt, Contacto, Impressum and similar, then `/contact` and `/about`.
- Reads `mailto:` links, plain text, Cloudflare-protected emails and `name [at] domain [dot] com` formats.
- Ranks results. An email on the business's own domain ranks first, then Gmail/Outlook-style addresses, then the rest. No-reply addresses rank last. Junk like Sentry IDs, image names and `your@email.com` gets dropped.
- If a site shows no email in its HTML, the extension renders it in a minimized window, so sites built with JavaScript work too. Turn this off in Settings if you prefer.

The CSV "Email Status" column shows one of: Found, Not found, No website, Website error, Pending.

## Settings

- Delay between businesses: random wait between each business. Default 1.5 to 3.5 seconds. Lower values run faster and raise the chance of a Google captcha.
- Render JavaScript websites: on by default.

## Controls

- Pause / Resume: stops between businesses and keeps your place.
- Stop: ends the run. Saved rows stay.
- Export only rows with an email: filters the CSV.
- Clear data: deletes every saved row.

Data is saved after each business. Closing the tab, reloading or restarting Chrome keeps your rows. Starting the same search again skips businesses already saved.

## Captchas

If Google shows a verification check, the run pauses. Solve it in the tab, then press Resume.

## Speed

About 3 to 5 seconds per business with default settings. A list of 120 takes 6 to 10 minutes. Email checks run in parallel, 3 at a time.

## Permissions

- `storage`, `unlimitedStorage`: saves rows on your computer. Nothing is sent to any server except the business websites being checked.
- `scripting` and access to all sites: needed to read business websites for emails.

## Tests

From the repo root:

```
node --test extensions/maps-lead-extractor-tests/core.test.js
node extensions/maps-lead-extractor-tests/e2e.mjs
```

The end-to-end test loads the extension in Chromium against a mock Google Maps page and mock business websites. It needs Playwright installed.
