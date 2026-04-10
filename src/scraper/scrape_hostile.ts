import { chromium, Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';

type TotalsRow = { key: string; value: string };
type NormalizedTotals = { subtotal?: number; tax?: number; total?: number };
type ExtractionResult<T> = { value: T; strategy?: string | null };

// Resilient scraper for a hostile, drift-prone page.
// The hostile site intentionally exhibits many real world problems:
// - unstable and unpredictable DOMs where IDs and classes change frequently
// - staggered rendering so different sections appear at different times
// - data split across multiple areas and duplicate or decoy tables
// - inconsistent currency and formatting across the page
// - visual noise and nested layout markup that looks like data
// These helpers try to be defensive and observable. They prefer small,
// focused strategies that are easy to reason about, and they record which
// strategy produced each value so operators can understand failure modes.

// Log a structured JSON event so the scraper produces a timeline that is
// easy to query later. Each event contains a timestamp, an event name,
// and a payload object. Use this for navigation, retries, strategy
// choices, extraction results, and errors.
function log(event: string, data: any = {}) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, event, ...data }));
}

// Retry wrapper that runs an async function repeatedly until it either
// succeeds or the maximum attempts are exhausted. Use exponential backoff
// with a little random jitter to handle network slowness and staggered
// rendering. Each retry emits a log event so transient failures are
// visible in the logs. This is lightweight and focused on making
// individual extraction steps robust.
export async function retry<T>(
  fn: () => Promise<T>,
  label: string,
  retries = 5,
  baseDelay = 500
): Promise<T> {
  let attempt = 0;

  while (true) {
    try {
      return await fn();
    } catch (err: any) {
      attempt++;
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 200;

      log('retry', { label, attempt, delay, error: err?.message ?? String(err) });

      if (attempt >= retries) throw err;
      await new Promise(res => setTimeout(res, delay));
    }
  }
}

// JSDOM helpers for unit tests. These are pure functions that mirror the
// Playwright based extractors but run against a raw HTML string. That lets
// us write focused unit tests for the heuristics without launching a
// browser, which keeps the test suite fast and reliable.
export function detectLayoutFromHtml(html: string): string {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  if (doc.querySelector('table.weirdClass')) return 'A';
  if (doc.querySelector('table.invoiceTable')) return 'B';
  if (doc.querySelector('div.invoice-grid')) return 'C';
  return 'unknown';
}

// Extract client info from raw HTML using the same layered strategies that
// the browser based extractor uses. The value returned includes which
// strategy succeeded so callers can make informed decisions or record
// diagnostics. Strategies are intentionally simple and robust: id prefix,
// nearby label, and a body level regex scan.
export function extractClientInfoFromHtml(html: string): ExtractionResult<string | null> {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  // Strategy 1: ID prefix
  const el = document.querySelector('[id^="client_"]');
  if (el) return { value: el.textContent?.trim() ?? null, strategy: 'id_prefix' };

  // Strategy 2: label proximity
  const nodes = Array.from(document.querySelectorAll('*')) as Element[];
  const label = nodes.find((n: Element) => {
    const t = n.textContent ?? '';
    return /client|owner/i.test(t);
  });
  if (label) {
    const sib = label.nextElementSibling as Element | null;
    if (sib && sib.textContent) return { value: sib.textContent.trim(), strategy: 'label_proximity' };
  }

  // Strategy 3: regex scan on body text
  const body = document.body.innerText;
  const match = body.match(/Client[:\s]+(.+)/i);
  if (match) return { value: match[1].trim(), strategy: 'body_regex' };

  return { value: null, strategy: null };
}

// Extract the invoice table from raw HTML. Use a small ordered list of
// heuristics: known class, large table, and table that contains invoice
// keywords. The goal is to produce a matrix of cell text while being
// tolerant of decoy tables and noisy layout markup.
export function extractTableFromHtml(html: string): ExtractionResult<string[][] | null> {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const pickTable = (): { table: HTMLTableElement | null; strategy: string | null } => {
    let table = document.querySelector('table.weirdClass') as HTMLTableElement | null;
    if (table) return { table, strategy: 'weirdClass' };

    const tables = Array.from(document.querySelectorAll('table')) as HTMLTableElement[];
    table = tables.find(t => t.querySelectorAll('tr').length > 2) ?? null;
    if (table) return { table, strategy: 'large_table' };

    table = tables.find(t => {
      const text = (t as HTMLElement).innerText || '';
      return /qty|quantity|total|price|amount/i.test(text);
    }) ?? null;

    return { table: table ?? null, strategy: table ? 'keyword_table' : null };
  };

  const picked = pickTable();
  if (!picked.table) return { value: null, strategy: null };

  const trs = Array.from(picked.table.querySelectorAll('tr'));
  const rows = trs.map(tr =>
    Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent?.trim() ?? '')
  );

  return { value: rows, strategy: picked.strategy };
}

// Extract totals rows from raw HTML. Totals are often presented in a
// right aligned block, in labeled spans, or as freeform body lines. This
// function returns an array of detected key value pairs and the strategy
// used. Keep the heuristics simple so they do not break when the markup
// drifts or when visual noise is present.
export function extractTotalsFromHtml(html: string): ExtractionResult<TotalsRow[] | null> {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const collectFromContainer = (container: Element): TotalsRow[] => {
    const spans = Array.from(container.querySelectorAll('span.label'));
    if (spans.length) {
      return spans.map(label => {
        const key = label.textContent?.replace(':', '').trim() ?? '';
        const value = label.nextSibling?.textContent?.trim() ?? '';
        return { key, value };
      });
    }

    const lines = (container.textContent ?? '').split('\n');
    return lines
      .map((l: string) => l.trim())
      .filter((l: string) => /(total|tax|subtotal)/i.test(l))
      .map((l: string) => {
        const parts = l.split(/:(.+)/);
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const value = parts[1].trim();
          return { key, value };
        }
        const [key, ...rest] = l.split(/[:\s]+/);
        return { key, value: rest.join(' ').trim() };
      });
  };

  let container = document.querySelector('div[style*="text-align: right"]');
  if (container) return { value: collectFromContainer(container), strategy: 'right_aligned_container' };

  const blocks = Array.from(document.querySelectorAll('div, section')) as Element[];
  container = blocks.find((n: Element) => /(total|tax|subtotal)/i.test(n.textContent ?? '')) ?? null;
  if (container) return { value: collectFromContainer(container), strategy: 'block_scan' };

  const body = document.body.innerText;
  const lines = body.split('\n');
  const found = lines
    .map((l: string) => l.trim())
    .filter((l: string) => /(total|tax|subtotal)/i.test(l))
    .map((l: string) => {
      const parts = l.split(/:(.+)/);
      if (parts.length >= 2) {
        return { key: parts[0].trim(), value: parts[1].trim() };
      }
      const [key, ...rest] = l.split(/[:\s]+/);
      return { key, value: rest.join(' ').trim() };
    });

  return { value: found.length ? found : null, strategy: found.length ? 'body_scan' : null };
}

const FRAME_TIMEOUT = Number(process.env.FRAME_TIMEOUT) || 8000;
const HEADLESS = (process.env.HEADLESS || 'false') === 'true';

// Find and return the iframe that contains the invoice. Many hostile
// pages hide important views inside iframes and those iframes can load
// slowly or reload unexpectedly. Treat this as the anchor for subsequent
// extraction work and fail early if the frame is not accessible.
async function getInvoiceFrame(page: Page): Promise<Frame> {
  log('wait_for_invoice_frame');
  const iframeHandle = await page.waitForSelector('#invoice-frame', { timeout: FRAME_TIMEOUT });
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Unable to access iframe content');
  return frame;
}

// Detect which layout variant is present so the scraper can pick the most
// appropriate heuristics. The detection is intentionally coarse because
// version drift means exact fingerprinting is brittle. A short code is
// returned to make logs compact and human readable.
async function detectLayout(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    if (document.querySelector('table.weirdClass')) return 'A';
    if (document.querySelector('table.invoiceTable')) return 'B';
    if (document.querySelector('div.invoice-grid')) return 'C';
    return 'unknown';
  });
}

// Extract client information from the live frame. This mirrors
// extractClientInfoFromHtml but runs inside the page context. Each
// strategy attempts to be resilient against DOM instability and noisy
// layout. The result includes the chosen strategy for observability.
async function extractClientInfo(frame: Frame): Promise<ExtractionResult<string | null>> {
  return retry(async () => {
    return frame.evaluate(() => {
      // Strategy 1: ID prefix
      let el = document.querySelector('[id^="client_"]');
      if (el) return { value: el.textContent?.trim() ?? null, strategy: 'id_prefix' };

      // Strategy 2: label proximity
      const label = Array.from(document.querySelectorAll('*')).find(n => {
        const t = n.textContent ?? '';
        return /client|owner/i.test(t);
      });
      if (label && label.nextElementSibling) {
        return { value: label.nextElementSibling.textContent?.trim() ?? null, strategy: 'label_proximity' };
      }

      // Strategy 3: regex scan on body text
      const body = document.body.innerText;
      const match = body.match(/Client[:\s]+(.+)/i);
      if (match) return { value: match[1].trim(), strategy: 'body_regex' };

      return { value: null, strategy: null };
    });
  }, 'extractClientInfo');
}

// Extract invoice table from the live frame. The function prefers
// explicit selectors and falls back to heuristic picks. Recovering the
// table as a matrix of strings is important because visual noise and
// mixed layout markup can hide semantic meaning in presentation tags.
async function extractTable(frame: Frame): Promise<ExtractionResult<string[][] | null>> {
  return retry(async () => {
    return frame.evaluate(() => {
      const pickTable = (): HTMLTableElement | null => {
        // Strategy 1: known class
        let table = document.querySelector('table.weirdClass') as HTMLTableElement | null;
        if (table) return table;

        // Strategy 2: any table with > 2 rows
        table = Array.from(document.querySelectorAll('table')).find(t => {
          return t.querySelectorAll('tr').length > 2;
        }) as HTMLTableElement | null;
        if (table) return table;

        // Strategy 3: table with invoice-ish keywords
        table = Array.from(document.querySelectorAll('table')).find(t => {
          const text = (t as HTMLElement).innerText || '';
          return /qty|quantity|total|price|amount/i.test(text);
        }) as HTMLTableElement | null;

        return table ?? null;
      };

      const table = pickTable();
      if (!table) return { value: null, strategy: null };

      const trs = Array.from(table.querySelectorAll('tr'));
      const rows = trs.map(tr =>
        Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent?.trim() ?? '')
      );

      // Attempt to guess which strategy we used for observability
      let strategy = 'unknown';
      if (table.classList && table.classList.contains('weirdClass')) strategy = 'weirdClass';
      else if (trs.length > 2) strategy = 'large_table';
      else strategy = 'keyword_table';

      return { value: rows, strategy };
    });
  }, 'extractTable');
}

// Extract totals from the live frame. Totals are fragile because pages may
// render them late, float them visually, or split keys across nodes. The
// heuristics are intentionally forgiving and the return value includes the
// strategy so that downstream systems can decide whether to trust the
// numbers or fall back to manual review.
async function extractTotals(frame: Frame): Promise<ExtractionResult<TotalsRow[] | null>> {
  return retry(async () => {
    return frame.evaluate(() => {
      const collectFromContainer = (container: Element): TotalsRow[] => {
        const spans = Array.from(container.querySelectorAll('span.label'));
        if (spans.length) {
          return spans.map(label => {
            const key = label.textContent?.replace(':', '').trim() ?? '';
            const value = label.nextSibling?.textContent?.trim() ?? '';
            return { key, value };
          });
        }

        // fallback: scan lines inside container; split on first colon to
        // preserve multi word keys like "Visit Date" or "Previous Balance".
        const lines = (container.textContent ?? '').split('\n');
        return lines
          .map((l: string) => l.trim())
          .filter((l: string) => /(total|tax|subtotal)/i.test(l))
          .map((l: string) => {
            const parts = l.split(/:(.+)/);
            if (parts.length >= 2) {
              const key = parts[0].trim();
              const value = parts[1].trim();
              return { key, value };
            }
            const [key, ...rest] = l.split(/[:\s]+/);
            return { key, value: rest.join(' ').trim() };
          });
      };

      // Strategy 1: known container
      let container = document.querySelector('div[style*="text-align: right"]');
      if (container) return { value: collectFromContainer(container), strategy: 'right_aligned_container' };

      // Strategy 2: any block with totals-ish text
      container = Array.from(document.querySelectorAll('div, section')).find(n =>
        /(total|tax|subtotal)/i.test(n.textContent ?? '')
      ) as Element | null;
      if (container) return { value: collectFromContainer(container), strategy: 'block_scan' };

      // Strategy 3: body-level scan
      const body = document.body.innerText;
      const lines = body.split('\n');
      const found = lines
        .map((l: string) => l.trim())
        .filter((l: string) => /(total|tax|subtotal)/i.test(l))
        .map((l: string) => {
          const parts = l.split(/:(.+)/);
          if (parts.length >= 2) {
            return { key: parts[0].trim(), value: parts[1].trim() };
          }
          const [key, ...rest] = l.split(/[:\s]+/);
          return { key, value: rest.join(' ').trim() };
        });

      return { value: found.length ? found : null, strategy: found.length ? 'body_scan' : null };
    });
  }, 'extractTotals');
}

// Normalize a currency like string into a number. Pages may show currency
// in different locales and with non breaking spaces or zero width
// characters. This function tries to be forgiving and to guess which
// separator is the decimal point by looking at the last occurrence of dot
// or comma. If parsing fails the function returns zero so callers can
// handle missing or malformed values explicitly.
export function normalizeCurrency(value: string): number {
  if (!value) return 0;
  let s = String(value).trim().replace(/\u00A0/g, ''); // remove non breaking spaces

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;

  if (hasDot && hasComma) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(/,/g, '.');
    }
  } else if (hasComma && !hasDot) {
    s = s.replace(/,/g, '.');
  } else {
    s = s.replace(/,/g, '');
  }

  s = s.replace(/[^0-9.-]/g, '');
  const n = Number(s);
  return Number.isNaN(n) ? 0 : n;
}

// Normalize the array of totals rows into a compact object. Keys are
// matched case insensitively. The output contains only recognized fields
// so consumers can easily check for the presence of subtotal, tax and
// total. Null input returns null to make the difference between no data
// and an empty set explicit.
export function normalizeTotals(rows: TotalsRow[] | null): NormalizedTotals | null {
  if (!rows) return null;
  const out: NormalizedTotals = {};

  for (const { key, value } of rows) {
    const k = key.toLowerCase();
    if (k.includes('subtotal')) out.subtotal = normalizeCurrency(value);
    else if (k.includes('tax')) out.tax = normalizeCurrency(value);
    else if (k.includes('total')) out.total = normalizeCurrency(value);
  }

  return out;
}

// Placeholder for an LLM based repair flow. The idea is that when all
// heuristics fail we could call an external system to suggest repairs or
// extract structured data from the page HTML. This is intentionally left
// as a stub because integrating a model is optional and context specific.
async function llmRepair(html: string): Promise<any | null> {
  // Implement integration with an LLM to repair/extract structured data if needed.
  // Return null for now.
  return null;
}

// Main runtime. The function launches a headless browser, navigates to a
// local test page, locates the invoice frame and then runs the set of
// extractors. Observability is central so each result records the
// strategy used. On error the scraper saves a screenshot and the raw
// HTML to help with post mortem analysis.
async function run() {
  log('scraper_start');

  const browser = await chromium.launch({ headless: HEADLESS });
  const page = await browser.newPage();

  try {
    log('navigate', { url: 'http://localhost:3000/hostile_website.html' });
    await page.goto('http://localhost:3000/hostile_website.html', { waitUntil: 'load' });

    const frame = await getInvoiceFrame(page);

    await frame.waitForSelector('#invoice-container-inner', { timeout: FRAME_TIMEOUT }).catch(() => {
      log('warn', { message: 'invoice container did not appear' });
    });

    const layout = await detectLayout(frame);
    log('layout_detected', { layout });

    const [clientRes, tableRes, totalsRes] = await Promise.all([
      extractClientInfo(frame),
      extractTable(frame),
      extractTotals(frame),
    ]);

    const clientInfo = clientRes.value;
    const table = tableRes.value;
    const totalsRaw = totalsRes.value;

    if (clientRes.strategy) log('strategy_success', { field: 'clientInfo', strategy: clientRes.strategy });
    if (tableRes.strategy) log('strategy_success', { field: 'table', strategy: tableRes.strategy });
    if (totalsRes.strategy) log('strategy_success', { field: 'totals', strategy: totalsRes.strategy });

    const totals = normalizeTotals(totalsRaw ?? null);

    log('extraction_result', {
      clientInfo,
      table,
      totalsRaw,
      totals,
    });
  } catch (err: any) {
    // save debug artifacts
    try {
      const logsDir = path.join(process.cwd(), 'logs');
      if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
      const base = path.join(logsDir, `error-${Date.now()}`);
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
      const html = await page.content().catch(() => '');
      try { fs.writeFileSync(`${base}.html`, html); } catch (e) {}
      log('artifact_saved', { screenshot: `${base}.png`, html: `${base}.html` });
    } catch (artifactErr) {
      // ignore artifact write errors
    }

    log('scraper_error', { error: err?.message ?? String(err) });
  } finally {
    await browser.close();
    log('scraper_end');
  }
}

run().catch(err => {
  log('scraper_fatal', { error: err?.message ?? String(err) });
});
