# Email Screenshot Tool

Built by [EmailBoutique Digital Inc.](https://emailboutique.io) ·
[GitHub repo](https://github.com/Annett/email-screenshot-tool) for the latest
version and updates.

Paste a rendered email's URL, or upload its HTML file, and get four full-page
screenshots in one click: desktop/mobile × light/dark mode. No scrolling, no
manual stitching, no DevTools required.

Built with [Puppeteer](https://pptr.dev) — it drives a real headless Chrome,
emulates `prefers-color-scheme` for true dark-mode rendering, and captures the
*entire* scrollable page as one PNG (`fullPage: true`), however long the email
is.

## Requirements

- Node.js 18+

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:4747** in your browser.

## Use

1. Either paste the URL of any rendered email (from your ESP, CMS, or wherever it's hosted), or
   switch to the "Upload HTML" tab and pick a `.html` file.
2. Click **Generate screenshots**.
3. Download the four PNGs individually — Desktop · Light, Desktop · Dark,
   Mobile · Light, Mobile · Dark — or click **Download all (.zip)** to get
   all four in one file.

Screenshots are saved locally to `output/` (gitignored) and served back to the
browser for download — nothing leaves your machine.

## Notes

- Viewport widths: desktop 700px, mobile 390px. Change the `VARIANTS` array in
  `server.js` if you want different breakpoints.

## Disclaimer

This is an internal EmailBoutique tool, shared as-is under the MIT license
(see `LICENSE`) — no warranty, no guarantee of fitness for any particular
purpose, and no ongoing support commitment. In particular:

- It is a **local tool, not a hosted service**. It will fetch whatever URL or
  render whatever HTML you give it, with no sandboxing beyond what
  Puppeteer/Chrome do by default. Don't point it at untrusted HTML/URLs.
- **Do not deploy this as-is on the public internet.** Doing so exposes an
  open door for someone to point it at internal/malicious URLs (SSRF) or
  exhaust resources by spamming requests (each one spins up a real headless
  Chrome instance). Add authentication, rate limiting, and URL validation
  first if you host it anywhere reachable by others.
- Screenshot accuracy depends on Puppeteer's bundled Chromium. It's a close,
  practical approximation of how a given client renders dark mode — not a
  substitute for testing in actual email clients (Apple Mail, Gmail, Outlook,
  etc.) before a real send.

## License

MIT — see [LICENSE](LICENSE).
