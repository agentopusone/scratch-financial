import { chromium, Page, Frame } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

type TotalsRow = { key: string; value: string };
type NormalizedTotals = { subtotal?: number; tax?: number; total?: number };
type ExtractionResult<T> = { value: T; strategy?: string | null };

function log(event: string, data: any = {}) {
  const ts = new Date().toISOString();
  console.log(JSON.stringify({ ts, event, ...data }));
}

async function retry<T>(
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

const FRAME_TIMEOUT = Number(process.env.FRAME_TIMEOUT) || 8000;
const HEADLESS = (process.env.HEADLESS || 'false') === 'true';

async function getInvoiceFrame(page: Page): Promise<Frame> {
  log('wait_for_invoice_frame');
  const iframeHandle = await page.waitForSelector('#invoice-frame', { timeout: FRAME_TIMEOUT });
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Unable to access iframe content');
  return frame;
}

async function detectLayout(frame: Frame): Promise<string> {
  return frame.evaluate(() => {
    if (document.querySelector('table.weirdClass')) return 'A';
    if (document.querySelector('table.invoiceTable')) return 'B';
    if (document.querySelector('div.invoice-grid')) return 'C';
    return 'unknown';
  });
}

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

async function extractTable(frame: Frame): Promise<ExtractionResult<string[][] | null>> {
  return retry(async () => {
    const result = await frame.evaluate(() => {
      const pickTable = (): { table: HTMLTableElement | null; strategy: string | null } => {
        // Strategy 1: known class
        let table = document.querySelector('table.weirdClass') as HTMLTableElement | null;
        if (table) return { table, strategy: 'weirdClass' };

        // Strategy 2: any table with > 2 rows
        table = Array.from(document.querySelectorAll('table')).find(t => {
          return t.querySelectorAll('tr').length > 2;
        }) as HTMLTableElement | null;
        if (table) return { table, strategy: 'large_table' };

        // Strategy 3: table with invoice-ish keywords
        table = Array.from(document.querySelectorAll('table')).find(t => {
          const text = t.innerText;
          return /qty|quantity|total|price|amount/i.test(text);
        }) as HTMLTableElement | null;

        return { table: table ?? null, strategy: table ? 'keyword_table' : null };
      };

      const picked = pickTable();
      if (!picked.table) return { value: null, strategy: null };

      const trs = Array.from(picked.table.querySelectorAll('tr'));
      const rows = trs.map(tr =>
        Array.from(tr.querySelectorAll('td, th')).map(c => c.textContent?.trim() ?? '')
      );

      return { value: rows, strategy: picked.strategy };
    });

    if (!result || result.value == null) {
      throw new Error('No table found');
    }

    return result;
  }, 'extractTable');
}

async function extractTotals(frame: Frame): Promise<ExtractionResult<TotalsRow[] | null>> {
  return retry(async () => {
    const result = await frame.evaluate(() => {
      const collectFromContainer = (container: Element): TotalsRow[] => {
        const spans = Array.from(container.querySelectorAll('span.label'));
        if (spans.length) {
          return spans.map(label => {
            const key = label.textContent?.replace(':', '').trim() ?? '';
            const value = label.nextSibling?.textContent?.trim() ?? '';
            return { key, value };
          });
        }

        // fallback: scan lines inside container; split on first colon to preserve multi-word keys
        const lines = (container.textContent ?? '').split('\n');
        return lines
          .map(l => l.trim())
          .filter(l => /(total|tax|subtotal)/i.test(l))
          .map(l => {
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
        .map(l => l.trim())
        .filter(l => /(total|tax|subtotal)/i.test(l))
        .map(l => {
          const parts = l.split(/:(.+)/);
          if (parts.length >= 2) {
            return { key: parts[0].trim(), value: parts[1].trim() };
          }
          const [key, ...rest] = l.split(/[:\s]+/);
          return { key, value: rest.join(' ').trim() };
        });

      return { value: found.length ? found : null, strategy: found.length ? 'body_scan' : null };
    });

    if (!result || result.value == null) {
      throw new Error('No totals found');
    }

    return result;
  }, 'extractTotals');
}

function normalizeCurrency(value: string): number {
  if (!value) return 0;
  let s = String(value).trim().replace(/\u00A0/g, ''); // remove non-breaking spaces

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

function normalizeTotals(rows: TotalsRow[] | null): NormalizedTotals | null {
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

// Placeholder for LLM-based repair loop. Disabled by default.
async function llmRepair(html: string): Promise<any | null> {
  // Implement integration with an LLM to repair/extract structured data if needed.
  // Return null for now.
  return null;
}

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
