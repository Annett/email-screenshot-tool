const express = require("express");
const multer = require("multer");
const puppeteer = require("puppeteer");
const archiver = require("archiver");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const PORT = process.env.PORT || 4747;
const OUTPUT_DIR = path.join(__dirname, "output");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.use("/output", express.static(OUTPUT_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, plenty for an email
});

// The four shots this tool exists to produce. Width is the viewport; height
// is just a starting point — fullPage screenshots capture the true scroll
// height regardless.
const VARIANTS = [
  { key: "desktop-light", label: "Desktop · Light", width: 700, height: 900, dark: false },
  { key: "desktop-dark", label: "Desktop · Dark", width: 700, height: 900, dark: true },
  { key: "mobile-light", label: "Mobile · Light", width: 390, height: 844, dark: false },
  { key: "mobile-dark", label: "Mobile · Dark", width: 390, height: 844, dark: true },
];

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({ headless: "new" });
  }
  return browserPromise;
}

async function shoot(browser, { url, html }, variant, outPath) {
  const page = await browser.newPage();
  try {
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: variant.dark ? "dark" : "light" },
    ]);
    await page.setViewport({ width: variant.width, height: variant.height });

    if (html) {
      await page.setContent(html, { waitUntil: "networkidle0", timeout: 30000 });
    } else {
      await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
    }

    // Let webfonts / late-loading images settle.
    await new Promise((r) => setTimeout(r, 400));

    await page.screenshot({ path: outPath, fullPage: true });
  } finally {
    await page.close();
  }
}

app.post("/generate", upload.single("htmlFile"), async (req, res) => {
  const url = (req.body.url || "").trim();
  const html = req.file ? req.file.buffer.toString("utf8") : null;

  if (!html && !url) {
    return res.status(400).json({ error: "Provide either a URL or an HTML file." });
  }
  if (html && url) {
    return res.status(400).json({ error: "Provide only one: a URL or an HTML file, not both." });
  }
  if (url && !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "URL must start with http:// or https://" });
  }

  const jobId = crypto.randomBytes(6).toString("hex");
  let browser;
  try {
    browser = await getBrowser();
  } catch (err) {
    return res.status(500).json({ error: `Couldn't start the browser: ${err.message}` });
  }

  const images = {};
  for (const variant of VARIANTS) {
    const fileName = `${jobId}-${variant.key}.png`;
    const outPath = path.join(OUTPUT_DIR, fileName);
    try {
      await shoot(browser, { url, html }, variant, outPath);
      images[variant.key] = { label: variant.label, href: `/output/${fileName}` };
    } catch (err) {
      return res.status(500).json({
        error: `Failed on ${variant.label}: ${err.message}`,
        partial: images,
      });
    }
  }

  res.json({ jobId, images });
});

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

app.listen(PORT, () => {
  console.log(`Email screenshot tool running at http://localhost:${PORT}`);
});

process.on("SIGINT", async () => {
  if (browserPromise) {
    const browser = await browserPromise;
    await browser.close();
  }
  process.exit(0);
});
