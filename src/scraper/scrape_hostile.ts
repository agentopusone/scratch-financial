import { chromium, Page, Frame } from 'playwright';

async function getInvoiceFrame(page: Page): Promise<Frame> {
  const iframeHandle = await page.waitForSelector('#invoice-frame', { timeout: 8000 });
  const frame = await iframeHandle.contentFrame();
  if (!frame) throw new Error('Unable to access iframe content');
  return frame;
}

async function extractTable(frame: Frame) {
  const rows = await frame.evaluate(() => {
    const table = document.querySelector('table.weirdClass');
    if (!table) return null;

    const trs = Array.from(table.querySelectorAll('tr'));
    return trs.map(tr => {
      const cells = Array.from(tr.querySelectorAll('td, th'));
      return cells.map(c => (c as HTMLElement).innerText.trim());
    });
  });

  return rows;
}

async function extractClientInfo(frame: Frame) {
  return frame.evaluate(() => {
    const el = document.querySelector('[id^="client_"]');
    return el ? el.textContent?.trim() : null;
  });
}

async function extractTotals(frame: Frame) {
  return frame.evaluate(() => {
    const totalsContainer = document.querySelector('div[style*="text-align: right"]');
    if (!totalsContainer) return null;

    const spans = Array.from(totalsContainer.querySelectorAll('span.label'));
    return spans.map(label => {
      const key = (label as HTMLElement).innerText.replace(':', '').trim();
      const value = label.nextSibling?.textContent?.trim() ?? '';
      return { key, value };
    });
  });
}

async function run() {
  // console.log('scraper starting');
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();

  // Load hostile site
  await page.goto('http://localhost:3000/hostile_website.html');

  // Get iframe
  const frame = await getInvoiceFrame(page);

  // Wait for invoice container to appear
  await frame.waitForSelector('#invoice-container-inner', { timeout: 8000 });

  // Wait for the invoice content to be rendered inside the iframe (table and client id)
  try {
    await frame.waitForSelector('table.weirdClass', { timeout: 10000 });
  } catch (e) {
    console.warn('Timed out waiting for invoice table to appear');
  }

  try {
    await frame.waitForSelector('[id^="client_"]', { timeout: 10000 });
  } catch (e) {
    console.warn('Timed out waiting for client element to appear');
  }

  // Extract data
  let clientInfo = null;
  let table = null;
  let totals = null;

  try {
    clientInfo = await extractClientInfo(frame);
    table = await extractTable(frame);
    totals = await extractTotals(frame);
  } catch (err) {
    console.error('Error during extraction:', err);
  }

  console.log('Client Info:', clientInfo);
  console.log('Table:', table);
  console.log('Totals:', totals);

  await browser.close();
}

run().catch(err => {
  console.error('Scraper failed:', err);
});
