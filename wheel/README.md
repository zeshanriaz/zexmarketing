# ZexWheel

A static wheel spinner. Plain HTML, CSS, and JavaScript. No build step and no dependencies.

## Deploy to Cloudflare Pages

Option 1, Git (auto deploy on every push):
1. Cloudflare dashboard > Workers & Pages > Create > Pages > Connect to Git.
2. Pick the `zexmarketing` repo.
3. Framework preset: None. Build command: leave empty. Build output directory: `wheel`.
4. Deploy. Add your custom domain under the project's Custom domains tab.

Option 2, CLI:
```
npx wrangler pages deploy wheel --project-name zexwheel
```

## Files

- `index.html`: page, dialogs, SEO copy, FAQ schema
- `css/styles.css`: layout, light and dark themes
- `js/app.js`: wheel engine, audio, confetti, storage, sharing
- `sw.js`: offline cache. Change `VERSION` on each release.
- `_headers`: Cloudflare security and cache headers
- `manifest.webmanifest`, `img/`: install icon and social image

## Rename the brand

Search for `ZexWheel` in `index.html`, `manifest.webmanifest`, and `js/app.js`.
