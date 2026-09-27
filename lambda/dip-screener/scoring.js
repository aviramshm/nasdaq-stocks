/**
 * Pure scoring logic for the dip screener (no network), so it can be unit tested.
 */

const CAUSE_POINTS = {
    MACRO_OR_SECTOR: 3,          // the market/sector fell, the company didn't change
    SYMPATHY: 3,                 // a competitor's bad news dragged it down
    ANALYST_ACTION: 2,           // downgrade / target cut, no new company facts
    EARNINGS_SELL_THE_NEWS: 2,   // results fine, guidance intact, stock sold anyway
    LEADERSHIP_CHANGE: 0,        // CEO/exec exit not tied to wrongdoing - neutral, flagged for review
    UNKNOWN: 0,
    EARNINGS_GUIDANCE_CUT: -3,   // tends to keep drifting lower for weeks
    STRUCTURAL_NEGATIVE: null,   // fraud, SEC/DOJ, lost customer, offering, short report... -> AVOID
};

// Headline keywords for the fallback classifier (used only when Claude is unavailable).
// Matched on word boundaries to avoid hits like "recall" inside "recalled earnings beat".
const HARD_FLAGS = [
    'fraud', 'restatement', 'restate', 'accounting irregularit', 'sec charges', 'sec probe',
    'subpoena', 'short seller', 'short report', 'bankruptcy', 'going concern', 'delist',
    'complete response letter', 'fda rejects', 'loses contract', 'contract terminated',
    'public offering', 'share offering', 'stock offering', 'convertible notes offering',
];
const GUIDANCE_WORDS = ['lowers guidance', 'cuts guidance', 'lowers outlook', 'cuts outlook',
    'lowers forecast', 'cuts forecast', 'weak guidance', 'weak outlook', 'guidance cut'];
const LEADERSHIP_WORDS = ['ceo', 'chief executive', 'steps down', 'resigns', 'departure', 'to retire'];
const ANALYST_WORDS = ['downgrade', 'price target', 'cut to', 'lowered to'];

const hasWord = (text, w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);

/** Last close dated before `todayET` (YYYY-MM-DD) - never today's in-progress bar. */
const etDate = (unixSec) => new Date(unixSec * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etMinutes = (unixSec) => {
    const [h, m] = new Date(unixSec * 1000)
        .toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).split(':');
    return Number(h) * 60 + Number(m);
};

function splitDaily(bars, todayET) {
    const past = bars.filter(b => etDate(b.t) < todayET);
    return { past, prevClose: past.length ? past[past.length - 1].close : null };
}

/** Stats from daily bars before today. */
function dailyStats(past) {
    const closes = past.map(b => b.close);
    const rets = [];
    for (let i = Math.max(1, closes.length - 60); i < closes.length; i++) {
        rets.push((closes[i] / closes[i - 1] - 1) * 100);
    }
    const mean = rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
    const dailyVol = Math.sqrt(rets.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, rets.length - 1));
    const last200 = closes.slice(-200);
    const sma200 = last200.reduce((a, b) => a + b, 0) / (last200.length || 1);
    const last20 = past.slice(-20);
    const dollarVol = last20.reduce((a, b) => a + b.close * (b.volume || 0), 0) / (last20.length || 1);
    return { dailyVol, sma200, dollarVol, historyDays: closes.length };
}

/** VWAP and opening range (9:30-10:00 ET) from today's 5-minute bars. */
function intradayStats(bars5m, todayET) {
    const today = bars5m.filter(b => etDate(b.t) === todayET && b.volume != null);
    let pv = 0, v = 0, orHigh = -Infinity, orLow = Infinity, dayLow = Infinity;
    for (const b of today) {
        const typical = (b.high + b.low + b.close) / 3;
        pv += typical * b.volume;
        v += b.volume;
        dayLow = Math.min(dayLow, b.low);
        const m = etMinutes(b.t);
        if (m >= 570 && m < 600) {             // bars starting 9:30 .. 9:55
            orHigh = Math.max(orHigh, b.high);
            orLow = Math.min(orLow, b.low);
        }
    }
    if (!today.length || !v) return null;
    return {
        vwap: pv / v,
        orHigh: isFinite(orHigh) ? orHigh : null,
        orLow: isFinite(orLow) ? orLow : null,
        dayLow: isFinite(dayLow) ? dayLow : null,
    };
}

/** Quality points (0-5) from Yahoo financialData. */
function qualityScore(fin) {
    const notes = [];
    let score = 0;
    const fcf = fin.freeCashflow?.raw, pm = fin.profitMargins?.raw;
    if ((fcf != null && fcf > 0) || (pm != null && pm > 0)) { score += 2; notes.push('profitable/FCF+'); }
    else notes.push('NOT profitable');
    const gm = fin.grossMargins?.raw;
    if (gm != null && gm > 0.5) { score += 1; notes.push(`gross margin ${(gm * 100).toFixed(0)}%`); }
    const rg = fin.revenueGrowth?.raw;
    if (rg != null && rg > 0.10) { score += 1; notes.push(`rev growth ${(rg * 100).toFixed(0)}%`); }
    const debt = fin.totalDebt?.raw || 0, ebitda = fin.ebitda?.raw || 0;
    if (debt === 0 || (ebitda > 0 && debt / ebitda < 3)) { score += 1; notes.push('debt manageable'); }
    else notes.push('HIGH debt');
    return { score, notes };
}

/** Share of the stock's drop explained by the sector (0..1+). Both moves are negative %. */
function sectorShare(stockDrop, sectorMove) {
    if (sectorMove == null || stockDrop >= 0 || sectorMove >= 0) return 0;
    return sectorMove / stockDrop;
}

function classifyByKeywords(heads, { earningsRecent, sectorExplainsHalf }) {
    const text = heads.join(' | ');
    const hard = HARD_FLAGS.find(k => hasWord(text, k));
    if (hard) return { cause: 'STRUCTURAL_NEGATIVE', reason: `headline red flag: "${hard}"` };
    if (earningsRecent === true) {
        if (GUIDANCE_WORDS.some(k => hasWord(text, k))) {
            return { cause: 'EARNINGS_GUIDANCE_CUT', reason: 'earnings + guidance-cut headline' };
        }
        return { cause: 'EARNINGS_SELL_THE_NEWS', reason: 'earnings, no guidance-cut headline found - verify' };
    }
    if (sectorExplainsHalf) return { cause: 'MACRO_OR_SECTOR', reason: 'sector explains most of the drop' };
    if (LEADERSHIP_WORDS.some(k => hasWord(text, k))) {
        return { cause: 'LEADERSHIP_CHANGE', reason: 'leadership headline - check whether the exit is planned' };
    }
    if (ANALYST_WORDS.some(k => hasWord(text, k))) return { cause: 'ANALYST_ACTION', reason: 'analyst headline' };
    return { cause: 'UNKNOWN', reason: 'no clear cause in headlines - read the news yourself' };
}

function verdictFor(cause, score) {
    if (cause === 'STRUCTURAL_NEGATIVE') return 'AVOID';
    if (score >= 8) return 'WATCH';
    if (score >= 5) return 'MAYBE';
    return 'PASS';
}

/** Stop buffer below today's low: half the stock's normal daily move, at least 1%. */
const stopBufferPct = (dailyVol) => Math.max(1, (dailyVol || 0) / 2);

/**
 * Trade plan. Stop = today's low so far minus a volatility-scaled buffer; size = the
 * smaller of max-loss sizing and max-position sizing.
 */
function tradePlan({ price, prevClose, dayLow, maxLoss, maxPosition, dailyVol }) {
    const bufferPct = stopBufferPct(dailyVol);
    const stop = +(dayLow * (1 - bufferPct / 100)).toFixed(2);
    const riskPerShare = price - stop;
    if (riskPerShare <= 0) return null;
    const byLoss = Math.floor(maxLoss / riskPerShare);
    const byPosition = Math.floor(maxPosition / price);
    const shares = Math.max(0, Math.min(byLoss, byPosition));
    return {
        entry: +price.toFixed(2),
        stop,
        dayLow: +dayLow.toFixed(2),
        bufferPct: +bufferPct.toFixed(1),
        dailyMovePct: +(dailyVol || 0).toFixed(1),
        target1: +(price + (prevClose - price) * 0.5).toFixed(2),
        target2: +prevClose.toFixed(2),
        shares,
        positionUsd: Math.round(shares * price),
        lossIfStoppedUsd: Math.round(shares * riskPerShare),
        limitedBy: byLoss < byPosition ? 'max loss' : 'max position',
        // Upside to yesterday's close per $1 of downside to the stop
        rewardRisk: +((prevClose - price) / riskPerShare).toFixed(1),
    };
}

const MIN_REWARD_RISK = 1.5;

/** A trade that can't make 1.5x what it risks is downgraded one level (WATCH -> MAYBE -> PASS). */
function applyRewardRisk(verdict, plan) {
    if (!plan || plan.rewardRisk >= MIN_REWARD_RISK) return { verdict, note: null };
    const downgraded = verdict === 'WATCH' ? 'MAYBE' : 'PASS';
    return {
        verdict: downgraded,
        note: `reward/risk only ${plan.rewardRisk} (min ${MIN_REWARD_RISK}) → ${verdict} downgraded to ${downgraded}`,
    };
}

module.exports = {
    CAUSE_POINTS, etDate, splitDaily, dailyStats, intradayStats, qualityScore,
    sectorShare, classifyByKeywords, verdictFor, tradePlan, applyRewardRisk, MIN_REWARD_RISK,
};
