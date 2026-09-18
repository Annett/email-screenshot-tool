const express = require("express");
const multer = require("multer");
const puppeteer = require("puppeteer");
const archiver = require("archiver");
const { simpleParser } = require("mailparser");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");

const PORT = process.env.PORT || 4747;
// Loopback only by default: this is a local tool, not a service other machines
// on your network should be able to drive.
const HOST = process.env.HOST || "127.0.0.1";
const OUTPUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // .eml files can carry embedded images/attachments

const app = express();

// ---------------------------------------------------------------------------
// Local-only protection
// ---------------------------------------------------------------------------
const LOCAL_ONLY = ["127.0.0.1", "localhost", "::1"].includes(HOST);
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  );

  if (LOCAL_ONLY) {
    // Blocks DNS-rebinding and cross-site requests from other web pages in your browser.
    if (!ALLOWED_HOSTS.has((req.headers.host || "").toLowerCase())) {
      return res.status(403).json({ error: "This tool only accepts requests from localhost." });
    }
    const origin = req.headers.origin;
    if (origin && req.method !== "GET" && req.method !== "HEAD") {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {}
      if (!ALLOWED_HOSTS.has(originHost)) {
        return res.status(403).json({ error: "Cross-site requests are not allowed." });
      }
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(OUTPUT_DIR));

// Uploads stay in memory (no temp files on disk).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES },
});
const sourceUpload = upload.fields([
  { name: "htmlFile", maxCount: 1 },
  { name: "emlFile", maxCount: 1 },
]);

// Generated screenshots are scratch files; sweep old ones. Only files matching
// the exact names this tool creates are ever touched.
const GENERATED_FILE = /^[a-f0-9]{12}-(desktop|mobile)-(light|dark)\.png$/;
const MAX_FILE_AGE_MS = 24 * 60 * 60 * 1000;
function cleanOutputDir() {
  const cutoff = Date.now() - MAX_FILE_AGE_MS;
  for (const name of fs.readdirSync(OUTPUT_DIR)) {
    if (!GENERATED_FILE.test(name)) continue;
    const file = path.join(OUTPUT_DIR, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    } catch {}
  }
}
cleanOutputDir();
setInterval(cleanOutputDir, 60 * 60 * 1000).unref();

// The four shots this tool exists to produce. Width is the default viewport
// (the UI can override it per run); height is just a starting point —
// fullPage screenshots capture the true scroll height regardless.
const VARIANTS = [
  { key: "desktop-light", label: "Desktop — Light", device: "desktop", width: 700, height: 900, dark: false },
  { key: "desktop-dark", label: "Desktop — Dark", device: "desktop", width: 700, height: 900, dark: true },
  { key: "mobile-light", label: "Mobile — Light", device: "mobile", width: 390, height: 844, dark: false },
  { key: "mobile-dark", label: "Mobile — Dark", device: "mobile", width: 390, height: 844, dark: true },
];
const DEFAULT_WIDTHS = {
  desktop: VARIANTS.find((v) => v.device === "desktop").width,
  mobile: VARIANTS.find((v) => v.device === "mobile").width,
};
const MIN_WIDTH = 200;
const MAX_WIDTH = 3840;

// Returns the parsed width, the fallback when the field is empty, or null when invalid.
function parseWidth(raw, fallback) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_WIDTH || n > MAX_WIDTH) return null;
  return n;
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    // Clear the cache if Chrome dies or fails to start, so the next request
    // launches a fresh one instead of reusing a dead connection.
    browserPromise = puppeteer
      .launch({ headless: "new" })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// ---------------------------------------------------------------------------
// Network guard for uploaded (untrusted) content
// ---------------------------------------------------------------------------
const PRIVATE_RANGES = new net.BlockList();
[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
].forEach(([addr, prefix]) => PRIVATE_RANGES.addSubnet(addr, prefix, "ipv4"));
[
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
].forEach(([addr, prefix]) => PRIVATE_RANGES.addSubnet(addr, prefix, "ipv6"));

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (!family) return true;
  // BlockList also matches IPv4-mapped IPv6 addresses against the IPv4 rules.
  return PRIVATE_RANGES.check(ip, family === 6 ? "ipv6" : "ipv4");
}

// "ok" | "private" (loopback / LAN / link-local) | "scheme" (not http(s)/data)
async function classifyRequestUrl(rawUrl, dnsCache) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return "scheme";
  }
  if (u.protocol === "data:" || u.protocol === "about:") return "ok";
  if (u.protocol !== "http:" && u.protocol !== "https:") return "scheme";

  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return "private";
  }
  if (net.isIP(host)) return isPrivateAddress(host) ? "private" : "ok";

  if (!dnsCache.has(host)) {
    let result;
    try {
      const addrs = await dns.lookup(host, { all: true });
      result = addrs.some((a) => isPrivateAddress(a.address)) ? "private" : "ok";
    } catch {
      // Unresolvable: let Chrome fail it naturally so it's reported as a failed image.
      result = "ok";
    }
    dnsCache.set(host, result);
  }
  return dnsCache.get(host);
}

async function guardUploadedContent(page, issues) {
  const dnsCache = new Map();
  await page.setRequestInterception(true);
  page.on("request", async (request) => {
    const url = request.url();
    let verdict = "scheme";
    try {
      verdict = await classifyRequestUrl(url, dnsCache);
    } catch {}
    if (request.isInterceptResolutionHandled()) return;
    if (verdict === "ok") return request.continue();

    issues.handled.add(url);
    if (verdict === "private") issues.blocked.set(url, request.resourceType());
    else if (request.resourceType() === "image" && !url.startsWith("cid:")) {
      issues.failedImages.set(url, "blocked: unsupported URL scheme");
    }
    request.abort(verdict === "private" ? "blockedbyclient" : "failed");
  });
}

function trackImageFailures(page, issues) {
  page.on("requestfailed", (request) => {
    if (request.resourceType() !== "image" || issues.handled.has(request.url())) return;
    const reason = (request.failure() && request.failure().errorText) || "failed";
    if (reason === "net::ERR_ABORTED") return;
    issues.failedImages.set(request.url(), reason);
  });
  page.on("response", (response) => {
    const request = response.request();
    if (request.resourceType() === "image" && response.status() >= 400) {
      issues.failedImages.set(request.url(), `HTTP ${response.status()}`);
    }
  });
}

// Returns the page's raw HTML source when rendering a URL (used for the
// diagnostics); null otherwise.
async function shoot(browser, { url, html, widths, issues }, variant, outPath) {
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: variant.dark ? "dark" : "light" },
    ]);
    await page.setViewport({ width: widths[variant.device], height: variant.height });
    trackImageFailures(page, issues);

    let sourceHtml = null;
    if (html) {
      // Uploaded HTML/.eml content is untrusted: it renders in its own headless
      // page (never in this app's UI), with JavaScript switched off like an
      // inbox, and can't reach private/local network addresses.
      await page.setJavaScriptEnabled(false);
      await guardUploadedContent(page, issues);
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    } else {
      const response = await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
      sourceHtml = response ? await response.text().catch(() => null) : null;
    }

    // Let webfonts / late-loading images settle.
    await new Promise((r) => setTimeout(r, 400));

    await page.screenshot({ path: outPath, fullPage: true });
    return sourceHtml;
  } finally {
    await page.close();
  }
}

function friendlyRenderError(err, isUrl) {
  const msg = String((err && err.message) || err);
  if (/timeout|timed out/i.test(msg)) {
    return "it took too long to load (30 second limit). Check that the email's images and stylesheets are reachable.";
  }
  if (isUrl && /ERR_NAME_NOT_RESOLVED/.test(msg)) return "that web address couldn't be found. Check the URL for typos.";
  if (isUrl && /ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT/.test(msg)) {
    return "the page couldn't be reached. Is the site up?";
  }
  if (isUrl && /ERR_CERT|ERR_SSL/.test(msg)) return "the site's security certificate wasn't accepted.";
  if (/Connection closed|Target closed|Session closed|Protocol error|Browser has disconnected/i.test(msg)) {
    return "the browser stopped unexpectedly. Please try again.";
  }
  return msg.replace(/^net::/, "");
}

// ---------------------------------------------------------------------------
// Developer Mode diagnostics — string checks on the email's source only. The
// HTML is never parsed into, or injected into, any DOM in this app.
// ---------------------------------------------------------------------------
function analyzeDarkMode(source) {
  return [
    { key: "prefers-color-scheme", label: "prefers-color-scheme", detected: /@media[^{]*prefers-color-scheme\s*:\s*dark/i.test(source) },
    { key: "color-scheme-meta", label: "color-scheme meta", detected: /<meta\b[^>]*\bname\s*=\s*["']color-scheme["']/i.test(source) },
    { key: "supported-color-schemes-meta", label: "supported-color-schemes meta", detected: /<meta\b[^>]*\bname\s*=\s*["']supported-color-schemes["']/i.test(source) },
    { key: "data-ogsc", label: "Outlook [data-ogsc] targeting", detected: /\[data-ogsc\]/i.test(source) },
    { key: "data-ogsb", label: "Outlook [data-ogsb] targeting", detected: /\[data-ogsb\]/i.test(source) },
  ];
}

const IMG_TAG = /<img\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi;
const ATTRIBUTE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

function parseAttributes(tag) {
  const attrs = {};
  const inner = tag.replace(/^<\w+/i, "").replace(/\/?>$/, "");
  for (const m of inner.matchAll(ATTRIBUTE)) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

function analyzeImages(source) {
  const out = { total: 0, remote: 0, embedded: 0, cid: 0, other: 0, missingWidth: 0, missingHeight: 0 };
  for (const tag of source.match(IMG_TAG) || []) {
    const attrs = parseAttributes(tag);
    const src = (attrs.src || "").trim().toLowerCase();
    out.total++;
    if (src.startsWith("cid:")) out.cid++;
    else if (src.startsWith("data:")) out.embedded++;
    else if (/^(https?:)?\/\//.test(src)) out.remote++;
    else out.other++;
    if (!attrs.width) out.missingWidth++;
    if (!attrs.height) out.missingHeight++;
  }
  return out;
}

function analyzeStructure(source) {
  const breakpoints = new Set();
  let widthQueries = 0;
  for (const m of source.matchAll(/@media([^{]*)\{/gi)) {
    let widthBased = false;
    for (const q of m[1].matchAll(/\(\s*(?:max|min)-(?:device-)?width\s*:\s*([\d.]+)\s*(px|em|rem)\s*\)/gi)) {
      widthBased = true;
      const px = q[2].toLowerCase() === "px" ? Number(q[1]) : Number(q[1]) * 16;
      breakpoints.add(Math.round(px));
    }
    if (widthBased) widthQueries++;
  }

  const tables = source.match(/<table\b[^>]*>/gi) || [];
  const presentationTables = tables.filter((t) => /\brole\s*=\s*["']?(presentation|none)\b/i.test(t)).length;

  // Widest fixed pixel width declared on a table/div/td, ignoring full-bleed values.
  const widths = [];
  for (const tag of source.match(/<(?:table|div|td)\b[^>]*>/gi) || []) {
    const attr = tag.match(/\swidth\s*=\s*["']?(\d{2,4})["']?(?![\d%])/i);
    if (attr) widths.push(Number(attr[1]));
    const style = tag.match(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i);
    if (style) {
      for (const w of (style[1] || style[2]).matchAll(/(?:^|[;\s])(?:max-)?width\s*:\s*(\d{2,4})px/gi)) {
        widths.push(Number(w[1]));
      }
    }
  }
  const candidates = widths.filter((w) => w >= 320 && w <= 1200);

  return {
    containerWidth: candidates.length ? Math.max(...candidates) : null,
    mediaQueries: { count: widthQueries, breakpoints: [...breakpoints].sort((a, b) => a - b) },
    tables: { total: tables.length, presentation: presentationTables },
  };
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// .eml parsing
// ---------------------------------------------------------------------------
class UserError extends Error {}

function headerText(value) {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.text === "string") return value.text;
  if (typeof value.value === "string") return value.value;
  if (value.url || value.mail) return [value.url, value.mail].filter(Boolean).join(", ");
  return JSON.stringify(value);
}

const EML_HEADERS = [
  ["from", "From"],
  ["to", "To"],
  ["cc", "Cc"],
  ["reply-to", "Reply-To"],
  ["date", "Date"],
  ["message-id", "Message-ID"],
  ["return-path", "Return-Path"],
  ["x-mailer", "X-Mailer"],
];

function plainTextEmailPage(bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<style>
  body { margin: 0; padding: 32px 24px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.6; background: #ffffff; color: #141413; }
  .wrap { max-width: 640px; margin: 0 auto; }
  a { color: #0b57d0; }
  @media (prefers-color-scheme: dark) {
    body { background: #1c1a19; color: #f1ece7; }
    a { color: #8ab4f8; }
  }
</style></head><body><div class="wrap">${bodyHtml}</div></body></html>`;
}

// Turns an .eml buffer into renderable HTML plus metadata.
async function parseEml(buffer) {
  if (buffer.length === 0) throw new UserError("That .eml file is empty.");
  if (buffer.subarray(0, 8).equals(Buffer.from("D0CF11E0A1B11AE1", "hex"))) {
    throw new UserError("That looks like an Outlook .msg file, which isn't supported. Save or export the message as .eml instead.");
  }
  if (buffer.subarray(0, 8192).includes(0)) {
    throw new UserError("That file looks like a binary file, not an .eml email.");
  }

  // keepCidLinks: we inline cid: images ourselves so unresolved ones can be reported.
  const parsed = await simpleParser(buffer, { keepCidLinks: true });

  const hasEmailHeaders = ["from", "to", "subject", "date", "message-id", "mime-version", "content-type"].some((k) =>
    parsed.headers.has(k)
  );
  if (!hasEmailHeaders) {
    throw new UserError("That doesn't look like a valid .eml file (no email headers were found).");
  }

  const originalHtml = typeof parsed.html === "string" ? parsed.html : "";
  let html = originalHtml;
  let usedTextFallback = false;
  const cidUnresolved = new Set();

  if (originalHtml.trim()) {
    const byCid = new Map();
    for (const a of parsed.attachments || []) {
      if (a.cid && a.content) byCid.set(a.cid.toLowerCase(), a);
    }
    html = originalHtml.replace(/(["'(]\s*)cid:([^'"\s)>]{1,256})/gi, (match, lead, id) => {
      let key = id;
      try {
        key = decodeURIComponent(id);
      } catch {}
      const attachment = byCid.get(key.toLowerCase());
      if (!attachment) {
        cidUnresolved.add(key);
        return match;
      }
      return `${lead}data:${attachment.contentType};base64,${attachment.content.toString("base64")}`;
    });
  } else {
    if (!parsed.textAsHtml) {
      throw new UserError("This .eml has no readable body (no HTML or plain-text part).");
    }
    html = plainTextEmailPage(parsed.textAsHtml);
    usedTextFallback = true;
  }

  const headers = {};
  for (const [key, label] of EML_HEADERS) {
    const text = headerText(parsed.headers.get(key));
    if (text) headers[label] = truncate(text, 500);
  }
  // mailparser folds every List-* header into one "list" object.
  const list = parsed.headers.get("list");
  const unsubscribe = list && headerText(list.unsubscribe);
  if (unsubscribe) headers["List-Unsubscribe"] = truncate(unsubscribe, 500);

  const attachments = (parsed.attachments || []).map((a) => ({
    filename: a.filename || null,
    contentType: a.contentType || "application/octet-stream",
    size: a.size ?? (a.content ? a.content.length : 0),
    inline: a.contentDisposition === "inline" || a.related === true,
    cid: a.cid || null,
  }));

  return {
    html,
    // Diagnostics look at what the author wrote, not the tool's plain-text wrapper.
    analysisSource: usedTextFallback ? null : originalHtml,
    cidUnresolved: [...cidUnresolved],
    info: {
      subject: parsed.subject || null,
      headers,
      usedTextFallback,
      attachments,
    },
  };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const SOURCE_LABELS = { eml: ".eml upload", html: "HTML file upload", url: "URL" };

// Express 4 doesn't catch rejected promises; without this an unexpected error would crash the server.
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post("/generate", sourceUpload, asyncRoute(async (req, res) => {
  const body = req.body || {}; // non-multipart requests leave req.body undefined
  const url = (body.url || "").trim();
  const htmlFile = req.files && req.files.htmlFile ? req.files.htmlFile[0] : null;
  const emlFile = req.files && req.files.emlFile ? req.files.emlFile[0] : null;

  const provided = [url, htmlFile, emlFile].filter(Boolean).length;
  if (provided === 0) {
    return res.status(400).json({ error: "Provide a URL, an HTML file, or an .eml file." });
  }
  if (provided > 1) {
    return res.status(400).json({ error: "Provide only one: a URL, an HTML file, or an .eml file." });
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "URL must start with http:// or https://" });
  }
  if (htmlFile && !/\.(html?|xhtml)$/i.test(htmlFile.originalname)) {
    return res.status(400).json({
      error: "That doesn't look like an HTML file. Upload a .html or .htm file — or drop an .eml file in the .eml box.",
    });
  }
  if (emlFile && !/\.eml$/i.test(emlFile.originalname)) {
    const isMsg = /\.msg$/i.test(emlFile.originalname);
    return res.status(400).json({
      error: isMsg
        ? "Outlook .msg files aren't supported. Save or export the message as .eml instead."
        : "That doesn't look like an .eml file. Only .eml files can be used here.",
    });
  }

  const desktopWidth = parseWidth(body.desktopWidth, DEFAULT_WIDTHS.desktop);
  const mobileWidth = parseWidth(body.mobileWidth, DEFAULT_WIDTHS.mobile);
  if (desktopWidth === null || mobileWidth === null) {
    return res.status(400).json({ error: `Widths must be whole numbers between ${MIN_WIDTH} and ${MAX_WIDTH} pixels.` });
  }
  const widths = { desktop: desktopWidth, mobile: mobileWidth };

  const kind = emlFile ? "eml" : htmlFile ? "html" : "url";
  let html = null;
  let analysisSource = null;
  let emailInfo = null;
  let cidUnresolved = [];

  if (htmlFile) {
    html = htmlFile.buffer.toString("utf8");
    if (!html.trim()) return res.status(400).json({ error: "That HTML file is empty." });
    analysisSource = html;
  } else if (emlFile) {
    try {
      const eml = await parseEml(emlFile.buffer);
      html = eml.html;
      analysisSource = eml.analysisSource;
      emailInfo = eml.info;
      cidUnresolved = eml.cidUnresolved;
    } catch (err) {
      if (err instanceof UserError) return res.status(400).json({ error: err.message });
      console.error("Couldn't parse .eml:", err);
      return res.status(400).json({ error: "Couldn't read that .eml file. It may be damaged or not a real email." });
    }
  }

  const jobId = crypto.randomBytes(6).toString("hex");
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return res.status(500).json({ error: `Couldn't start the browser: ${err.message}` });
  }

  const issues = { failedImages: new Map(), blocked: new Map(), handled: new Set() };
  const images = {};
  let urlSource = null;
  for (const variant of VARIANTS) {
    const fileName = `${jobId}-${variant.key}.png`;
    const outPath = path.join(OUTPUT_DIR, fileName);
    try {
      const fetchedSource = await shoot(browser, { url, html, widths, issues }, variant, outPath);
      if (fetchedSource && urlSource === null) urlSource = fetchedSource;
      images[variant.key] = { label: variant.label, href: `/output/${fileName}` };
    } catch (err) {
      return res.status(500).json({
        error: `Couldn't render ${variant.label}: ${friendlyRenderError(err, kind === "url")}`,
        partial: images,
      });
    }
  }

  const source = kind === "url" ? urlSource : analysisSource;
  const failed = [...issues.failedImages];
  const blocked = [...issues.blocked];
  const diagnostics = {
    source: {
      kind,
      label: SOURCE_LABELS[kind],
      url: kind === "url" ? url : null,
      filename: emlFile ? emlFile.originalname : htmlFile ? htmlFile.originalname : null,
    },
    sourceAvailable: source !== null,
    darkMode: source !== null ? analyzeDarkMode(source) : null,
    html: source !== null ? { bytes: Buffer.byteLength(source, "utf8") } : null,
    images:
      source !== null
        ? {
            ...analyzeImages(source),
            cidUnresolved,
            failed: {
              count: failed.length,
              items: failed.slice(0, 20).map(([u, reason]) => ({ url: truncate(u, 200), reason })),
            },
            blocked: {
              count: blocked.length,
              items: blocked.slice(0, 20).map(([u, type]) => ({ url: truncate(u, 200), type })),
            },
          }
        : null,
    structure: source !== null ? analyzeStructure(source) : null,
  };

  const warnings = [];
  if (emailInfo && emailInfo.usedTextFallback) {
    warnings.push("This email has no HTML version, so its plain-text version was rendered.");
  }
  if (cidUnresolved.length) {
    const one = cidUnresolved.length === 1;
    warnings.push(
      `${plural(cidUnresolved.length, "embedded (CID) image", "embedded (CID) images")} couldn't be found inside the .eml, so ${one ? "it" : "they"} won't appear in the screenshots.`
    );
  }
  if (failed.length) {
    const one = failed.length === 1;
    warnings.push(
      `${plural(failed.length, "image", "images")} couldn't be loaded, so ${one ? "it" : "they"} may be missing from the screenshots.`
    );
  }
  if (blocked.length) {
    warnings.push(
      `${plural(blocked.length, "request", "requests")} to private or local network addresses ${blocked.length === 1 ? "was" : "were"} blocked for safety.`
    );
  }

  res.json({ jobId, source: kind, widths, images, diagnostics, email: emailInfo, warnings });
}));

app.get("/download-all/:jobId", (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-f0-9]{12}$/.test(jobId)) {
    return res.status(400).json({ error: "Invalid job id." });
  }

  const files = VARIANTS.map((v) => ({
    key: v.key,
    path: path.join(OUTPUT_DIR, `${jobId}-${v.key}.png`),
  })).filter((f) => fs.existsSync(f.path));

  if (files.length === 0) {
    return res.status(404).json({ error: "No screenshots found for that job — generate them again." });
  }

  res.attachment(`email-screenshots-${jobId}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => res.status(500).end(err.message));
  archive.pipe(res);
  for (const f of files) {
    archive.file(f.path, { name: `${f.key}.png` });
  }
  archive.finalize();
});

// Turns upload errors (e.g. file too large) into readable JSON instead of an HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: `That file is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB. Try a smaller file.` });
    }
    return res.status(400).json({ error: "The upload couldn't be read. Please try again." });
  }
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server. Check the terminal running npm start for details." });
});

app.listen(PORT, HOST, () => {
  console.log(`Email screenshot tool running at http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
