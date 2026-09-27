const test = require('node:test');
const assert = require('node:assert');
const yahoo = require('./yahoo');
const { _recheckOne: recheckOne } = require('./index');

const cfg = { maxLoss: 300, maxPosition: 4000 };
const day = '2026-09-25';
const bar = (hhmm, high, low, close, volume = 1000) => ({ t: new Date(`${day}T${hhmm}:00-04:00`).getTime() / 1000, high, low, close, volume });
// Yesterday 100; fell to a 88 low in the first 30 min (range high 93)
const morning = [bar('09:30', 93, 90, 91), bar('09:40', 91, 88, 89), bar('09:55', 90, 88.5, 89.5)];
const stub = (price, extra = []) => { yahoo.chart = async () => ({ meta: { regularMarketPrice: price }, bars: [...morning, ...extra] }); };
const pending = { symbol: 'TEST', prevClose: 100, dailyVol: 1.5 };

test('waiting: still below VWAP and the 30-min high', async () => {
    stub(88.8, [bar('10:20', 89, 88.6, 88.8)]);
    assert.strictEqual((await recheckOne(pending, cfg, day)).status, 'waiting');
});

test('triggered: back above VWAP with good reward/risk', async () => {
    stub(90.6, [bar('10:35', 90.8, 89.8, 90.6)]);   // VWAP ~90.1
    const r = await recheckOne(pending, cfg, day);
    assert.strictEqual(r.status, 'triggered');
    assert.match(r.why, /VWAP/);
    assert.ok(r.plan.rewardRisk >= 1.5);
    assert.strictEqual(r.plan.stop, 87.12);           // today's low 88 - 1%
    assert.strictEqual(r.plan.rewardRisk, 2.7);       // (100 - 90.6) / (90.6 - 87.12)
});

test('above the 30-min high but too far from the low: weak, not triggered', async () => {
    stub(93.5, [bar('10:35', 93.6, 92, 93.5, 5000)]);  // reward 6.5 vs risk 6.38
    assert.strictEqual((await recheckOne(pending, cfg, day)).status, 'weak');
});

test('missed: recovered more than half of the drop', async () => {
    stub(96, [bar('10:50', 96.2, 93, 96, 5000)]);
    assert.strictEqual((await recheckOne(pending, cfg, day)).status, 'missed');
});

test('weak: triggered but the stop is too far for the reward', async () => {
    // low 80 -> stop far below, price 89 above VWAP but reward 11 vs risk ~9.8
    stub(89, [bar('10:05', 85, 80, 84, 500), bar('10:20', 89.2, 85, 89, 20000)]);
    const r = await recheckOne({ ...pending, dailyVol: 4 }, cfg, day);
    assert.strictEqual(r.status, 'weak');
});
