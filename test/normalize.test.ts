import { normalizeCurrency, normalizeTotals } from '../src/scraper/scrape_hostile';
import * as assert from 'assert';

describe('normalizeCurrency', () => {
  const cases: Array<[string, number]> = [
    ['120.12', 120.12],
    ['$120.12', 120.12],
    ['120,12', 120.12],
    ['1,200.50', 1200.5],
    ['1.200,50', 1200.5],
    ['€ 1.234,56', 1234.56],
    ['GBP 2,345.67', 2345.67],
    ['invalid', 0],
    ['', 0],
    ['  45.00 USD ', 45.0],
  ];

  for (const [input, expected] of cases) {
    it(`parses ${input} -> ${expected}`, () => {
      const got = normalizeCurrency(input);
      assert.strictEqual(got, expected);
    });
  }
});

describe('normalizeTotals', () => {
  it('maps keys to normalized totals', () => {
    const rows = [
      { key: 'Subtotal:', value: '1,100.00' },
      { key: 'Tax', value: '100.12' },
      { key: 'Total', value: '$1,200.12' },
    ];
    const got = normalizeTotals(rows as any);
    assert.deepStrictEqual(got, { subtotal: 1100, tax: 100.12, total: 1200.12 });
  });

  it('returns null for null input', () => {
    const got = normalizeTotals(null);
    assert.strictEqual(got, null);
  });
});
