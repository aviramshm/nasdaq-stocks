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

    let verdict = scoring.verdictFor(cause, score);

    // ---- Entry trigger + plan ----------------------------------------------------
    let trigger = 'n/a';
    if (intraday) {
        const aboveVwap = price > intraday.vwap;
        const aboveOrHigh = intraday.orHigh != null && price > intraday.orHigh;
        trigger = aboveVwap || aboveOrHigh
            ? `TRIGGERED (${[aboveVwap && 'above VWAP', aboveOrHigh && 'above 30-min high'].filter(Boolean).join(', ')})`
            : `NOT YET (VWAP ${intraday.vwap.toFixed(2)}, 30-min high ${intraday.orHigh?.toFixed(2) ?? 'n/a'})`;
    }
    let plan = (verdict === 'WATCH' || verdict === 'MAYBE')
        ? scoring.tradePlan({ price, prevClose, dayLow, maxLoss: cfg.maxLoss, maxPosition: cfg.maxPosition, dailyVol: stats.dailyVol })
        : null;
    const rr = scoring.applyRewardRisk(verdict, plan);
    if (rr.note) {
        verdict = rr.verdict;
        notes.unshift(rr.note);
        if (verdict === 'PASS') plan = null;
    }

    return {
        ...out, verdict, score, cause, reason, warning, classifiedBy, trigger, plan, notes,
        triggered: trigger.startsWith('TRIGGERED'), dailyVol: stats.dailyVol,
        marketCap, sector, sectorEtf, sectorMove, headlines: heads.slice(0, 5),
    };
}

// ---- Buy-signal re-checks (every 15 min until 11:30 ET) -------------------------------
const RECHECK_EVERY_MIN = 15;
const RECHECK_LAST_MINUTE = 11 * 60 + 30;

function etClock(date) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map(x => [x.type, x.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, hh: p.hour, mm: p.minute, ss: p.second, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** Schedule the next re-check, or return false if it would be past 11:30 ET. */
async function scheduleRecheck(pending, round, functionArn, dryRun = false) {
    const next = etClock(new Date(Date.now() + RECHECK_EVERY_MIN * 60 * 1000));
    if (next.minute > RECHECK_LAST_MINUTE) return false;
    const roleArn = process.env.SCREENER_SCHEDULER_ROLE_ARN;
    if (!roleArn || !functionArn) {
        console.warn('Re-check not scheduled: missing scheduler role or function ARN');
        return false;
    }
    const { SchedulerClient, CreateScheduleCommand } = require('@aws-sdk/client-scheduler');
    const now = etClock(new Date());
    await new SchedulerClient({}).send(new CreateScheduleCommand({
        Name: `dip-screener-recheck-${now.date}-${now.hh}${now.mm}${now.ss}`,
        ScheduleExpression: `at(${next.date}T${next.hh}:${next.mm}:00)`,
        ScheduleExpressionTimezone: 'America/New_York',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: {
            Arn: functionArn.split(':').slice(0, 7).join(':'), // drop any version/alias qualifier
            RoleArn: roleArn,
            Input: JSON.stringify({ mode: 'recheck', round, date: now.date, stocks: pending, ...(dryRun && { dryRun: true }) }),
        },
    }));
    console.log(`Re-check #${round} scheduled at ${next.hh}:${next.mm} ET for ${pending.map(p => p.symbol).join(', ')}`);
    return true;
}

/** Minimal state carried between re-checks. */
const pendingEntry = (r) => ({
    symbol: r.symbol, name: r.name, verdict: r.verdict, score: r.score, cause: r.cause,
    warning: r.warning || '', prevClose: r.prevClose, dailyVol: r.dailyVol,
});

/** Re-check one pending stock: 'triggered' (with a fresh plan), 'weak', 'missed', or 'waiting'. */
async function recheckOne(p, cfg, todayET) {
    const bars5m = await yahoo.chart(p.symbol, '1d', '5m');
    const price = bars5m.meta.regularMarketPrice;
    const intraday = scoring.intradayStats(bars5m.bars, todayET);
    if (!intraday || !price) return { status: 'waiting' };
    const recovered = p.prevClose > intraday.dayLow ? (price - intraday.dayLow) / (p.prevClose - intraday.dayLow) : 1;
    if (price >= p.prevClose || recovered > 0.5) return { status: 'missed', price };

    const aboveVwap = price > intraday.vwap;
    const aboveOrHigh = intraday.orHigh != null && price > intraday.orHigh;
    if (!aboveVwap && !aboveOrHigh) return { status: 'waiting', price };

    const plan = scoring.tradePlan({
        price, prevClose: p.prevClose, dayLow: intraday.dayLow,
        maxLoss: cfg.maxLoss, maxPosition: cfg.maxPosition, dailyVol: p.dailyVol,
    });
    const why = [aboveVwap && 'above VWAP', aboveOrHigh && 'above 30-min high'].filter(Boolean).join(', ');
    if (!plan || plan.rewardRisk < scoring.MIN_REWARD_RISK) return { status: 'weak', price, plan, why };
    return { status: 'triggered', price, plan, why };
}

async function runRecheck(event, cfg, functionArn) {
    const todayET = event.date;
    const round = event.round || 1;
    const nowLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    const checked = await mapLimit(event.stocks || [], CONCURRENCY, async (p) => {
        try {
            return { p, ...(await recheckOne(p, cfg, todayET)) };
        } catch (error) {
            console.warn(`Re-check failed for ${p.symbol}, will retry:`, error.message);
            return { p, status: 'waiting' };   // transient data error: keep watching
        }
    });

    const triggered = checked.filter(c => c.status === 'triggered');
    const weak = checked.filter(c => c.status === 'weak');
    const waiting = checked.filter(c => c.status === 'waiting').map(c => c.p);

    if (triggered.length && cfg.slackWebhookUrl) {
        const blocks = [
            { type: 'header', text: { type: 'plain_text', text: '🔔 Buy signal triggered', emoji: true } },
            ...triggered.map(({ p, price, plan, why }) => {
                const link = `*<https://finance.yahoo.com/quote/${p.symbol}|${p.symbol}>*`;
                const pct = fmtPct((price / p.prevClose - 1) * 100);
                const lines = [
                    `${EMOJI[p.verdict]} ${link} ${p.name} — *${p.verdict}* (score ${p.score}/11) | ${price.toFixed(2)} (${pct}) — ${why}`,
                    `*Why it dropped:* ${p.cause.replace(/_/g, ' ').toLowerCase()}`,
                    ...(p.warning ? [`⚠️ ${p.warning}`] : []),
                    ...planLines(plan),
                ];
                return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } };
            }),
        ];
        if (weak.length) {
            blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text:
                `Also triggered but reward/risk below ${scoring.MIN_REWARD_RISK}: ${weak.map(w => `${w.p.symbol} (${w.plan ? w.plan.rewardRisk : 'n/a'})`).join(', ')}` }] });
        }
        blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Re-check #${round} | Not advice — alerts only | 🕙 ${nowLabel} ET` }] });
        await postSlack(cfg.slackWebhookUrl, blocks.slice(0, 50), 'Buy signal triggered');
    }

    const scheduled = waiting.length ? await scheduleRecheck(waiting, round + 1, functionArn, event.dryRun) : false;
    if (waiting.length && !scheduled) {
        await heartbeat(cfg.slackWebhookUrl, `⏹️ No buy signal by 11:30 ET for: ${waiting.map(w => w.symbol).join(', ')} — stopped watching`);
    }
    console.log('Recheck:', JSON.stringify(checked.map(c => ({ symbol: c.p.symbol, status: c.status, price: c.price, rr: c.plan?.rewardRisk }))));
    return { statusCode: 200, body: JSON.stringify({ round, triggered: triggered.length, weak: weak.length, waiting: waiting.length }) };
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

function planLines(p) {
    return [
        `*Plan:* buy ${p.shares} sh (${money(p.positionUsd)}, limited by ${p.limitedBy}) | T1 ${p.target1} (sell half) | T2 ${p.target2} (sell rest) | reward/risk ${p.rewardRisk} | sell after 10 days`,
        `*Stop:* ${p.stop} = today's low ${p.dayLow} − ${p.bufferPct}% (half its normal ${p.dailyMovePct}% daily move, min 1%) → −${money(p.lossIfStoppedUsd)} if hit`,
    ];
}

function stockBlock(r) {
    const link = `*<https://finance.yahoo.com/quote/${r.symbol}|${r.symbol}>*`;
    const lines = [];
    if (r.score != null) {
        lines.push(`${EMOJI[r.verdict]} ${link} ${r.name} — *${r.verdict}* (score ${r.score}/11) | ${r.price.toFixed(2)}, now ${fmtPct(r.drop)} (${fmtPct(r.scanDrop)} at 9:33)`);
        lines.push(`*Why:* ${r.cause.replace(/_/g, ' ').toLowerCase()} — ${r.reason} _(${r.classifiedBy})_`);
        if (r.warning) lines.push(`⚠️ ${r.warning}`);
        lines.push(`*Buy signal:* ${r.trigger}`);
        if (r.plan) lines.push(...planLines(r.plan));
        lines.push(`_${r.notes.join(' · ')}_`);
    } else {
        const move = r.drop != null ? ` — now ${fmtPct(r.drop)}` : '';
        lines.push(`${EMOJI[r.verdict]} ${link} ${r.name || ''} — *${r.verdict}*${move}: ${r.notes.join('; ')}`);
    }
    return { type: 'section', text: { type: 'mrkdwn', text: lines.join('\n').slice(0, 2900) } };
}

exports.handler = async (event = {}, context = {}) => {
    const cfg = settings();
    // Warm containers keep module state between runs; never reuse yesterday's market moves or token
    moveCache = new Map();
    yahoo.resetSession();
    if (event.dryRun) cfg.slackWebhookUrl = null; // test without posting to Slack
    const forceRun = event.forceRun === true;
    if (!cfg.enabled && !forceRun) return { statusCode: 200, body: JSON.stringify({ message: 'Screener disabled' }) };

    if (event.mode === 'recheck') return runRecheck(event, cfg, context.invokedFunctionArn);

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
    // Watch WATCH/MAYBE stocks whose buy signal hasn't triggered yet (real runs only, not tests)
    const pending = results.filter(r => (r.verdict === 'WATCH' || r.verdict === 'MAYBE') && r.plan && !r.triggered);
    let watching = false;
    if (pending.length && event.source === 'rule8') {
        try {
            watching = await scheduleRecheck(pending.map(pendingEntry), 1, context.invokedFunctionArn);
        } catch (error) {
            console.error('Failed to schedule re-check:', error);
        }
    }
    const watchNote = watching ? ` I'll re-check ${pending.map(r => r.symbol).join(', ')} every ${RECHECK_EVERY_MIN} min until 11:30 and alert when the buy signal triggers.` : '';
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Not advice — alerts only. Buy only if the buy signal is TRIGGERED.${watchNote} 🕙 ${nowLabel()} ET` }] });
    await postSlack(cfg.slackWebhookUrl, blocks.slice(0, 50), 'Dip Screener verdicts');
    // Tagged for the weekly scorecard: only real (Rule 8-triggered) runs count
    if (event.source === 'rule8') console.log('VERDICTS', JSON.stringify({ date: todayET, results }));
    else console.log('Results:', JSON.stringify(results));

    return {
        statusCode: 200,
        body: JSON.stringify({ scored: results.length, results: results.map(r => ({ symbol: r.symbol, verdict: r.verdict, score: r.score, cause: r.cause })) }),
    };
};

exports._recheckOne = recheckOne; // exported for testing
