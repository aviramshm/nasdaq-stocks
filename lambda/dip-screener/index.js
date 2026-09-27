/**
 * Dip Screener (Stage 2) - runs ~10:05 AM ET, after Rule 8's 9:33 gap-down scan.
 *
 * For each stock Rule 8 flagged today: filter out untradeable names, work out WHY it
 * dropped (Claude + web search, keyword fallback), score company quality / trend /
 * how unusual the drop is, check the entry trigger (VWAP / opening-range high), and
 * post a WATCH / MAYBE / PASS / AVOID verdict with a sized trade plan to Slack.
 */
const yahoo = require('./yahoo');
const scoring = require('./scoring');
const { classifyWithClaude } = require('./classify');

const MAX_STOCKS = 25;
const CONCURRENCY = 4;

const SECTOR_ETF = {
    'Technology': 'XLK', 'Financial Services': 'XLF', 'Healthcare': 'XLV',
    'Consumer Cyclical': 'XLY', 'Consumer Defensive': 'XLP', 'Energy': 'XLE',
    'Industrials': 'XLI', 'Basic Materials': 'XLB', 'Real Estate': 'XLRE',
    'Utilities': 'XLU', 'Communication Services': 'XLC',
};

const EMOJI = { WATCH: '🟢', MAYBE: '🟡', PASS: '⚪', AVOID: '🔴', MISSED: '⚫', SKIP: '⚫', ERROR: '⚠️' };
const ORDER = ['WATCH', 'MAYBE', 'PASS', 'AVOID', 'MISSED', 'SKIP', 'ERROR'];

function settings() {
    const num = (name, dflt) => parseFloat(process.env[name] || dflt);
    return {
        enabled: process.env.SCREENER_ENABLED === 'true',
        minMarketCap: num('SCREENER_MIN_MCAP', '500000000'),
        minDollarVolume: num('SCREENER_MIN_DOLLAR_VOL', '3000000'),
        maxPosition: num('SCREENER_MAX_POSITION', '4000'),
        maxLoss: num('SCREENER_MAX_LOSS', '300'),
        minPrice: 5,
        slackWebhookUrl: process.env.SLACK_WEBHOOK_URL,
    };
}

async function postSlack(url, blocks, text = 'Dip Screener') {
    if (!url) return;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, blocks }),
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) console.error('Slack error', res.status, await res.text());
}

const heartbeat = (url, text) => postSlack(url, [{ type: 'context', elements: [{ type: 'mrkdwn', text }] }], text);

/** % move today vs yesterday's close, for an ETF/index. Cache is reset every run. */
let moveCache = new Map();
async function todayMove(symbol, todayET) {
    if (!moveCache.has(symbol)) {
        moveCache.set(symbol, (async () => {
            try {
                const { meta, bars } = await yahoo.chart(symbol, '5d', '1d');
                const { prevClose } = scoring.splitDaily(bars, todayET);
                return prevClose ? (meta.regularMarketPrice / prevClose - 1) * 100 : null;
            } catch (error) {
                console.warn(`No move for ${symbol}:`, error.message);
                return null;
            }
        })());
    }
    return moveCache.get(symbol);
}

function earningsWithinDays(summary, todayET, days = 2) {
    const dates = summary.calendarEvents?.earnings?.earningsDate || [];
    const today = new Date(`${todayET}T12:00:00Z`).getTime();
    const hit = dates.some(d => {
        const diffDays = (today - new Date(`${scoring.etDate(d.raw)}T12:00:00Z`).getTime()) / 86400000;
        return diffDays >= 0 && diffDays <= days;
    });
    // Yahoo rolls the calendar forward right after a report, so "not found" means unknown, not "no".
    return hit ? true : null;
}

async function analyze(entry, ctx) {
    const { symbol } = entry;
    const { cfg, todayET, spyMove } = ctx;
    const base = { symbol, name: entry.name || symbol };

    const daily = await yahoo.chart(symbol, '1y', '1d');
    const { past, prevClose } = scoring.splitDaily(daily.bars, todayET);
    const price = daily.meta.regularMarketPrice;
    if (past.length < 60 || !prevClose || !price) {
        return { ...base, verdict: 'SKIP', notes: ['not enough price history'] };
    }
    const drop = (price / prevClose - 1) * 100;
    const scanDrop = entry.drop ?? drop;
    const stats = scoring.dailyStats(past);
    const out = { ...base, price, prevClose, drop, scanDrop };

    // ---- Filters -------------------------------------------------------------
    const summary = await yahoo.quoteSummary(symbol);
    out.name = summary.price?.shortName || out.name;
    const marketCap = summary.price?.marketCap?.raw || 0;
    if (marketCap < cfg.minMarketCap) {
        return { ...out, verdict: 'SKIP', notes: [`market cap $${(marketCap / 1e6).toFixed(0)}M below floor`] };
    }
    if (stats.dollarVol < cfg.minDollarVolume || price < cfg.minPrice) {
        return { ...out, verdict: 'SKIP', notes: [`too illiquid ($${(stats.dollarVol / 1e6).toFixed(1)}M/day) or price < $${cfg.minPrice}`] };
    }

    let intraday = null;
    try {
        const bars5m = await yahoo.chart(symbol, '1d', '5m');
        intraday = scoring.intradayStats(bars5m.bars, todayET);
    } catch (error) {
        console.warn(`No intraday bars for ${symbol}:`, error.message);
    }
    const dayLow = intraday?.dayLow ?? price;
    if (price >= prevClose) {
        return { ...out, verdict: 'MISSED', notes: ['already back above yesterday\'s close'] };
    }
    if (prevClose > dayLow) {
        const recovered = (price - dayLow) / (prevClose - dayLow);
        if (recovered > 0.5) {
            return { ...out, verdict: 'MISSED', notes: [`already recovered ${(recovered * 100).toFixed(0)}% of the gap`] };
        }
    }

    // ---- Scoring ---------------------------------------------------------------
    const notes = [];
    const quality = scoring.qualityScore(summary.financialData || {});
    notes.push(...quality.notes);
    let score = quality.score;

    if (prevClose > stats.sma200) { score += 2; notes.push('was above 200-day avg'); }
    else notes.push('already in downtrend');

    const sigma = stats.dailyVol ? scanDrop / stats.dailyVol : 0;
    if (sigma <= -3) { score += 1; notes.push(`${Math.abs(sigma).toFixed(1)}x normal daily move`); }

    // ---- Cause -----------------------------------------------------------------
    const sector = summary.summaryProfile?.sector;
    const sectorEtf = SECTOR_ETF[sector];
    const sectorMove = sectorEtf ? await todayMove(sectorEtf, todayET) : null;
    const share = scoring.sectorShare(drop, sectorMove);
    const sectorExplainsHalf = share >= 0.5;
    const heads = await yahoo.headlines(symbol).catch(() => []);
    const earningsRecent = earningsWithinDays(summary, todayET);

    let causeResult = await classifyWithClaude({
        symbol, name: out.name, sector, sectorEtf, sectorMove, spyMove, drop,
        earningsRecent, todayET, headlines: heads,
    });
    const classifiedBy = causeResult ? 'Claude' : 'keywords';
    causeResult = causeResult || scoring.classifyByKeywords(heads, { earningsRecent, sectorExplainsHalf });

    // Market/sector is only credited when the sector explains at least half the drop.
    let { cause, reason, warning = '' } = causeResult;
    if (cause === 'MACRO_OR_SECTOR' && !sectorExplainsHalf) {
        cause = 'UNKNOWN';
        reason = `${reason} (but ${sectorEtf || 'sector'} explains only ${(share * 100).toFixed(0)}% of the drop)`;
    } else if (cause === 'UNKNOWN' && sectorExplainsHalf) {
        cause = 'MACRO_OR_SECTOR';
        reason = `${sectorEtf} is down ${sectorMove.toFixed(1)}%, explaining ${(share * 100).toFixed(0)}% of the drop`;
    }
    score += scoring.CAUSE_POINTS[cause] || 0;

    const verdict = scoring.verdictFor(cause, score);

    // ---- Entry trigger + plan ----------------------------------------------------
    let trigger = 'n/a';
    if (intraday) {
        const aboveVwap = price > intraday.vwap;
        const aboveOrHigh = intraday.orHigh != null && price > intraday.orHigh;
        trigger = aboveVwap || aboveOrHigh
            ? `TRIGGERED (${[aboveVwap && 'above VWAP', aboveOrHigh && 'above 30-min high'].filter(Boolean).join(', ')})`
            : `NOT YET (VWAP ${intraday.vwap.toFixed(2)}, 30-min high ${intraday.orHigh?.toFixed(2) ?? 'n/a'})`;
    }
    const plan = (verdict === 'WATCH' || verdict === 'MAYBE')
        ? scoring.tradePlan({ price, prevClose, dayLow, maxLoss: cfg.maxLoss, maxPosition: cfg.maxPosition, dailyVol: stats.dailyVol })
        : null;

    return {
        ...out, verdict, score, cause, reason, warning, classifiedBy, trigger, plan, notes,
        marketCap, sector, sectorEtf, sectorMove, headlines: heads.slice(0, 5),
    };
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            try {
                results[i] = await fn(items[i]);
            } catch (error) {
                console.error(`Error analyzing ${items[i].symbol}:`, error);
                results[i] = { symbol: items[i].symbol, verdict: 'ERROR', notes: [error.message] };
            }
        }
    }));
    return results;
}

const fmtPct = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const money = (x) => `$${x.toLocaleString('en-US')}`;

function stockBlock(r) {
    const link = `*<https://finance.yahoo.com/quote/${r.symbol}|${r.symbol}>*`;
    const lines = [];
    if (r.score != null) {
        lines.push(`${EMOJI[r.verdict]} ${link} ${r.name} — *${r.verdict}* (score ${r.score}/11) | ${r.price.toFixed(2)}, now ${fmtPct(r.drop)} (${fmtPct(r.scanDrop)} at 9:33)`);
        lines.push(`*Why:* ${r.cause.replace(/_/g, ' ').toLowerCase()} — ${r.reason} _(${r.classifiedBy})_`);
        if (r.warning) lines.push(`⚠️ ${r.warning}`);
        lines.push(`*Buy signal:* ${r.trigger}`);
        if (r.plan) {
            const p = r.plan;
            lines.push(`*Plan:* buy ${p.shares} sh (${money(p.positionUsd)}, limited by ${p.limitedBy}) | T1 ${p.target1} (sell half) | T2 ${p.target2} (sell rest) | sell after 10 days`);
            lines.push(`*Stop:* ${p.stop} = today's low ${p.dayLow} − ${p.bufferPct}% (half its normal ${p.dailyMovePct}% daily move, min 1%) → −${money(p.lossIfStoppedUsd)} if hit`);
        }
        lines.push(`_${r.notes.join(' · ')}_`);
    } else {
        const move = r.drop != null ? ` — now ${fmtPct(r.drop)}` : '';
        lines.push(`${EMOJI[r.verdict]} ${link} ${r.name || ''} — *${r.verdict}*${move}: ${r.notes.join('; ')}`);
    }
    return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } };
}

exports.handler = async (event = {}) => {
    const cfg = settings();
    // Warm containers keep module state between runs; never reuse yesterday's market moves or token
    moveCache = new Map();
    yahoo.resetSession();
    if (event.dryRun) cfg.slackWebhookUrl = null; // test without posting to Slack
    const forceRun = event.forceRun === true;
    if (!cfg.enabled && !forceRun) return { statusCode: 200, body: JSON.stringify({ message: 'Screener disabled' }) };

    const todayET = event.date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const nowLabel = () => new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    // Normally invoked by Rule 8's one-time schedule: {"source": "rule8", "stocks": [{symbol, drop}], "flaggedTotal"}.
    // Test hook: {"forceRun": true, "symbols": ["NVS"], "date": "2026-09-25"} scores given tickers.
    const flagged = Array.isArray(event.symbols) && event.symbols.length
        ? event.symbols.map(s => ({ symbol: s.toUpperCase() }))
        : (event.stocks || []);
    if (!flagged.length) return { statusCode: 200, body: JSON.stringify({ scored: 0 }) };

    flagged.sort((a, b) => (a.drop ?? 0) - (b.drop ?? 0));
    const toScore = flagged.slice(0, MAX_STOCKS);
    const flaggedTotal = Math.max(event.flaggedTotal || 0, flagged.length);
    await heartbeat(cfg.slackWebhookUrl, `🧪 Dip Screener started — scoring ${toScore.length} stock(s) | ${nowLabel()} ET`);

    const spyMove = await todayMove('SPY', todayET);
    const results = await mapLimit(toScore, CONCURRENCY, (entry) => analyze(entry, { cfg, todayET, spyMove }));
    results.sort((a, b) => ORDER.indexOf(a.verdict) - ORDER.indexOf(b.verdict) || (b.score ?? -99) - (a.score ?? -99));

    const counts = ORDER.map(v => [v, results.filter(r => r.verdict === v).length]).filter(([, n]) => n);
    const blocks = [
        { type: 'header', text: { type: 'plain_text', text: '🧪 Dip Screener — verdicts', emoji: true } },
        { type: 'context', elements: [{ type: 'mrkdwn', text:
            `${counts.map(([v, n]) => `${EMOJI[v]} ${n} ${v}`).join('  ')} | S&P ${spyMove != null ? fmtPct(spyMove) : 'n/a'} | max position ${money(cfg.maxPosition)}, max loss ${money(cfg.maxLoss)}` }] },
        { type: 'divider' },
        ...results.map(stockBlock),
    ];
    if (flaggedTotal > toScore.length) {
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `+${flaggedTotal - toScore.length} more flagged stocks not scored (limit ${MAX_STOCKS})` }] });
    }
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Not advice — alerts only. Buy only if the buy signal is TRIGGERED. 🕙 ${nowLabel()} ET` }] });
    await postSlack(cfg.slackWebhookUrl, blocks.slice(0, 50), 'Dip Screener verdicts');
    console.log('Results:', JSON.stringify(results));

    return {
        statusCode: 200,
        body: JSON.stringify({ scored: results.length, results: results.map(r => ({ symbol: r.symbol, verdict: r.verdict, score: r.score, cause: r.cause })) }),
    };
};
