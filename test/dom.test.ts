import * as assert from 'assert';
import {
  detectLayoutFromHtml,
  extractClientInfoFromHtml,
  extractTableFromHtml,
  extractTotalsFromHtml,
} from '../src/scraper/scrape_hostile';

describe('DOM extraction helpers', () => {
  it('detects layout A via weirdClass', () => {
    const html = `<table class="weirdClass"><tr><td>row</td></tr></table>`;
    assert.strictEqual(detectLayoutFromHtml(html), 'A');
  });

  it('extracts client info by id prefix', () => {
    const html = `<div id="client_123">John Doe</div>`;
    const res = extractClientInfoFromHtml(html);
    assert.strictEqual(res.value, 'John Doe');
    assert.strictEqual(res.strategy, 'id_prefix');
  });

  it('extracts table using large_table strategy', () => {
    const html = `<table><tr><td>h</td></tr><tr><td>r</td></tr><tr><td>c</td></tr></table>`;
    const res = extractTableFromHtml(html);
    assert.ok(Array.isArray(res.value));
    assert.strictEqual(res.strategy, 'large_table');
  });

  it('extracts totals from right aligned container', () => {
    const html = `<div style="text-align: right;"><span class="label">Total:</span> $120.12</div>`;
    const res = extractTotalsFromHtml(html);
    assert.ok(Array.isArray(res.value));
    assert.strictEqual(res.strategy, 'right_aligned_container');
  });
});
