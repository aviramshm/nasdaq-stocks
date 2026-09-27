const test = require('node:test');
const assert = require('node:assert');
const { simulateTrade, buildBlocks } = require('./scorecard');

const plan = { entry: 90, stop: 86, target1: 95, target2: 100 };
const b = (high, low, close = (high + low) / 2) => ({ high, low, close });

test('T1 then T2: half at 95, half at 100', () => {
    const r = simulateTrade(plan, [b(91, 89)], [b(96, 90), b(101, 94)]);
    assert.strictEqual(r.outcome, 'T2');
    assert.ok(r.hitT1);
    assert.strictEqual(+r.returnPct.toFixed(2), +(((0.5 * 95 + 0.5 * 100) / 90 - 1) * 100).toFixed(2));
    assert.strictEqual(r.daysHeld, 2);
});

test('stop on the scan day itself', () => {
    const r = simulateTrade(plan, [b(90.5, 85.5)], [b(101, 95)]);
    assert.strictEqual(r.outcome, 'stop');
    assert.strictEqual(+r.returnPct.toFixed(2), +((86 / 90 - 1) * 100).toFixed(2));
});

test('stop is checked before targets in the same bar (conservative)', () => {
    const r = simulateTrade(plan, [], [b(101, 85)]);
    assert.strictEqual(r.outcome, 'stop');
});

test('T1 then stop: half at 95, half at 86', () => {
    const r = simulateTrade(plan, [], [b(95.5, 91), b(92, 85)]);
    assert.strictEqual(r.outcome, 'T1, then stop');
    assert.strictEqual(+r.returnPct.toFixed(2), +(((0.5 * 95 + 0.5 * 86) / 90 - 1) * 100).toFixed(2));
});

test('time stop at the day-10 close', () => {
    const days = Array.from({ length: 12 }, (_, i) => b(93, 88, 91 + (i === 9 ? 1 : 0)));
    const r = simulateTrade(plan, [], days);
    assert.strictEqual(r.outcome, 'day 10');
    assert.strictEqual(r.daysHeld, 10);
    assert.strictEqual(+r.returnPct.toFixed(2), +((92 / 90 - 1) * 100).toFixed(2));
});

test('open trade: fewer than 10 days, marked to last close', () => {
    const r = simulateTrade(plan, [], [b(93, 88, 92)]);
    assert.strictEqual(r.status, 'open');
});

test('scorecard message with no finished trades', () => {
    const blocks = buildBlocks([{ status: 'open', outcome: 'open', verdict: 'WATCH' }]);
    assert.match(blocks[1].text.text, /No finished trades yet/);
});

test('scorecard groups by verdict', () => {
    const t = (verdict, returnPct, outcome = 'T2') => ({ status: 'closed', verdict, cause: 'UNKNOWN', returnPct, outcome, hitT1: true, date: '2026-10-01', symbol: 'X' });
    const text = buildBlocks([t('WATCH', 5), t('WATCH', -3, 'stop'), t('PASS', -2, 'stop')])[1].text.text;
    assert.match(text, /WATCH\*: \*2\* trades \| won 1\/2 \(50%\) \| avg \*\+1\.0%\*/);
    assert.match(text, /PASS\*: \*1\* trade \|/);
});
