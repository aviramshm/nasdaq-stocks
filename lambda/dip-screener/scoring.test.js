const test = require('node:test');
const assert = require('node:assert');
const s = require('./scoring');
const { parseResult } = require('./classify');

const ts = (iso) => new Date(iso).getTime() / 1000;

test('splitDaily ignores today\'s in-progress bar', () => {
    const bars = [
        { t: ts('2026-09-24T13:30:00Z'), close: 100 },
        { t: ts('2026-09-25T13:30:00Z'), close: 88 },   // today's live bar
    ];
    assert.strictEqual(s.splitDaily(bars, '2026-09-25').prevClose, 100);
    // Before today's bar exists (pre-market), still yesterday's close
    assert.strictEqual(s.splitDaily(bars.slice(0, 1), '2026-09-25').prevClose, 100);
});

test('intradayStats: VWAP, 9:30-10:00 range, day low', () => {
    const bar = (hhmm, high, low, close, volume) => ({ t: ts(`2026-09-25T${hhmm}:00-04:00`), high, low, close, volume });
    const bars = [
        bar('09:30', 50, 44, 45, 1000),
        bar('09:55', 47, 45, 46, 1000),
        bar('10:00', 48, 43, 47, 2000),   // outside opening range, new day low
    ];
    const r = s.intradayStats(bars, '2026-09-25');
    assert.strictEqual(r.orHigh, 50);
    assert.strictEqual(r.orLow, 44);
    assert.strictEqual(r.dayLow, 43);
    const expectedVwap = ((50 + 44 + 45) / 3 * 1000 + (47 + 45 + 46) / 3 * 1000 + (48 + 43 + 47) / 3 * 2000) / 4000;
    assert.ok(Math.abs(r.vwap - expectedVwap) < 1e-9);
});

test('tradePlan: full $4,000 when stop is close', () => {
    const p = s.tradePlan({ price: 50, prevClose: 56, dayLow: 48.4848, maxLoss: 300, maxPosition: 4000 });
    assert.strictEqual(p.shares, 80);             // 4000 / 50
    assert.strictEqual(p.limitedBy, 'max position');
    assert.ok(p.lossIfStoppedUsd <= 300);
    assert.strictEqual(p.target1, 53);
    assert.strictEqual(p.target2, 56);
});

test('tradePlan: shrinks position when stop is far', () => {
    const p = s.tradePlan({ price: 50, prevClose: 60, dayLow: 40.404, maxLoss: 300, maxPosition: 4000 });
    assert.strictEqual(p.stop, 40);
    assert.strictEqual(p.shares, 30);             // 300 / 10
    assert.strictEqual(p.limitedBy, 'max loss');
    assert.strictEqual(p.lossIfStoppedUsd, 300);
});

test('tradePlan: no plan when price is at/below the stop', () => {
    assert.strictEqual(s.tradePlan({ price: 39, prevClose: 60, dayLow: 40, maxLoss: 300, maxPosition: 4000 }), null);
});

test('sectorShare: sector must explain half the drop', () => {
    assert.strictEqual(s.sectorShare(-9, -2), 2 / 9);   // mostly company-specific
    assert.ok(s.sectorShare(-6, -3.5) >= 0.5);
    assert.strictEqual(s.sectorShare(-6, 1), 0);
});

test('keywords: CEO exit is leadership change, not AVOID', () => {
    const r = s.classifyByKeywords(['Acme CEO steps down, successor named'], { earningsRecent: null, sectorExplainsHalf: false });
    assert.strictEqual(r.cause, 'LEADERSHIP_CHANGE');
});

test('keywords: offering and fraud are structural', () => {
    assert.strictEqual(s.classifyByKeywords(['Acme announces $500M public offering'], {}).cause, 'STRUCTURAL_NEGATIVE');
    assert.strictEqual(s.classifyByKeywords(['Short seller report alleges fraud at Acme'], {}).cause, 'STRUCTURAL_NEGATIVE');
});

test('keywords: guidance cut after earnings', () => {
    const r = s.classifyByKeywords(['Acme lowers guidance as demand slows'], { earningsRecent: true });
    assert.strictEqual(r.cause, 'EARNINGS_GUIDANCE_CUT');
});

test('verdict thresholds', () => {
    assert.strictEqual(s.verdictFor('STRUCTURAL_NEGATIVE', 11), 'AVOID');
    assert.strictEqual(s.verdictFor('MACRO_OR_SECTOR', 8), 'WATCH');
    assert.strictEqual(s.verdictFor('UNKNOWN', 5), 'MAYBE');
    assert.strictEqual(s.verdictFor('UNKNOWN', 4), 'PASS');
});

test('parseResult takes the final JSON object', () => {
    const text = 'Searched news. The drop follows {weak} data.\n{"cause": "ANALYST_ACTION", "reason": "Downgraded by MS", "warning": ""}';
    assert.deepStrictEqual(parseResult(text), { cause: 'ANALYST_ACTION', reason: 'Downgraded by MS', warning: '' });
    assert.strictEqual(parseResult('{"cause": "MADE_UP"}'), null);
});
