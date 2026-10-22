/**
 * Tools Claude can call from Slack. Everything here is read-only: quotes, today's alerts,
 * settings, and on-demand scoring (the screener runs in test mode and posts nothing).
 */
const { LambdaClient, InvokeCommand, GetFunctionConfigurationCommand } = require('@aws-sdk/client-lambda');
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
const yahoo = require('../dip-screener/yahoo');
const scoring = require('../dip-screener/scoring');

const lambda = new LambdaClient({});
const logs = new CloudWatchLogsClient({});
const SCREENER = 'stock-alert-dip-screener';
const RULE8 = 'stock-alert-rule8';

const todayET = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const round = (x, d = 2) => (x == null ? null : +x.toFixed(d));

const TOOL_DEFINITIONS = [
    {
        name: 'get_quote',
        description: 'Live quote for a US stock: price, % change vs yesterday\'s close, and today\'s intraday picture '
            + '(VWAP, 9:30-10:00 opening-range high/low, day low, % of the drop recovered) plus whether the screener\'s '
            + 'buy signal (price above VWAP or above the opening-range high) is currently triggered.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'Ticker, e.g. FCFS' } },
            required: ['symbol'],
            additionalProperties: false,
        },
    },
    {
        name: 'score_stock',
        description: 'Run the Dip Screener on one stock right now (filters, quality/trend/unusual-drop points, Claude '
            + 'cause classification with web search, verdict, buy signal, and a trade plan sized to the user\'s settings). '
            + 'Takes 20-60 seconds. Posts nothing to Slack. Use for "should I buy X" style questions.',
        input_schema: {
            type: 'object',
            properties: { symbol: { type: 'string', description: 'Ticker, e.g. FCFS' } },
            required: ['symbol'],
            additionalProperties: false,
        },
    },
    {
        name: 'get_today_activity',
        description: 'Today\'s system activity: how many stocks the 9:33 Gap Down scan flagged, the 10:05 Dip Screener '
            + 'verdicts (symbol, verdict, score, cause, buy signal, plan), and the latest buy-signal re-check statuses.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        name: 'get_settings',
        description: 'The user\'s current settings: Gap Down threshold, screener market-cap and liquidity floors, max '
            + 'position, max loss per trade, and whether each stage is enabled.',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
    },
];

async function getQuote({ symbol }) {
    symbol = symbol.toUpperCase();
    const day = todayET();
    const [daily, intra] = await Promise.all([yahoo.chart(symbol, '5d', '1d'), yahoo.chart(symbol, '1d', '5m')]);
    const { prevClose } = scoring.splitDaily(daily.bars, day);
    const price = intra.meta.regularMarketPrice ?? daily.meta.regularMarketPrice;
    const stats = scoring.intradayStats(intra.bars, day);
    const out = {
        symbol, name: daily.meta.shortName, price: round(price), yesterdayClose: round(prevClose),
        changePct: prevClose ? round((price / prevClose - 1) * 100, 1) : null,
        asOfNewYork: new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York' }),
    };
    if (stats) {
        Object.assign(out, {
            vwap: round(stats.vwap), openingRangeHigh: round(stats.orHigh), openingRangeLow: round(stats.orLow),
            dayLow: round(stats.dayLow),
            recoveredPctOfDrop: prevClose > stats.dayLow ? round((price - stats.dayLow) / (prevClose - stats.dayLow) * 100, 0) : null,
            buySignal: (price > stats.vwap || (stats.orHigh != null && price > stats.orHigh)) ? 'TRIGGERED' : 'NOT YET',
        });
    } else {
        out.note = 'No intraday bars for today (market closed or pre-market).';
    }
    return out;
}

async function scoreStock({ symbol }) {
    const res = await lambda.send(new InvokeCommand({
        FunctionName: SCREENER,
        Payload: JSON.stringify({ forceRun: true, dryRun: true, returnFull: true, symbols: [symbol.toUpperCase()] }),
    }));
    const payload = JSON.parse(Buffer.from(res.Payload).toString());
    if (res.FunctionError) throw new Error(`Screener failed: ${payload.errorMessage || res.FunctionError}`);
    const r = JSON.parse(payload.body).results?.[0];
    if (!r) return { symbol, error: 'no result' };
    // Drop bulky internals Claude doesn't need
    const { evalPlan, dailyVol, ...rest } = r;
    return rest;
}

async function readLogLines(functionName, pattern, sinceMs) {
    const out = [];
    let nextToken;
    do {
        const page = await logs.send(new FilterLogEventsCommand({
            logGroupName: `/aws/lambda/${functionName}`, filterPattern: pattern, startTime: sinceMs, nextToken,
        }));
        out.push(...(page.events || []).map(e => ({ t: e.timestamp, msg: e.message })));
        nextToken = page.nextToken;
    } while (nextToken);
    return out;
}

function parseAfter(msg, marker) {
    const i = msg.indexOf(marker);
    if (i < 0) return null;
    try {
        return JSON.parse(msg.slice(i + marker.length).trim());
    } catch {
        return null;
    }
}

async function getTodayActivity() {
    const day = todayET();
    // Midnight New York, approximately: 04:00 UTC covers both EDT and EST mornings
    const since = new Date(`${day}T04:00:00Z`).getTime();
    const [r8, verdicts, rechecks] = await Promise.all([
        readLogLines(RULE8, '"Rule 8: Found"', since),
        readLogLines(SCREENER, '"VERDICTS"', since),
        readLogLines(SCREENER, '"Recheck:"', since),
    ]);
    const lastFound = r8.at(-1)?.msg.match(/Found (\d+) matching/);
    const lastVerdicts = verdicts.length ? parseAfter(verdicts.at(-1).msg, 'VERDICTS ') : null;
    const lastRecheck = rechecks.length ? parseAfter(rechecks.at(-1).msg, 'Recheck:') : null;
    return {
        date: day,
        gapDownFlagged: lastFound ? Number(lastFound[1]) : 'no scan yet today',
        screenerVerdicts: lastVerdicts?.results?.map(r => ({
            symbol: r.symbol, verdict: r.verdict, score: r.score, cause: r.cause, classifiedBy: r.classifiedBy,
            dropPct: round(r.drop, 1), buySignalAt1005: r.trigger, notes: r.notes,
            plan: r.plan && { shares: r.plan.shares, stop: r.plan.stop, target1: r.plan.target1, target2: r.plan.target2, rewardRisk: r.plan.rewardRisk },
        })) || 'screener has not run today',
        latestRecheck: lastRecheck
            ? { at: new Date(rechecks.at(-1).t).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }), statuses: lastRecheck }
            : 'no re-checks yet today',
    };
}

async function getSettings() {
    const env = async (fn) => (await lambda.send(new GetFunctionConfigurationCommand({ FunctionName: fn }))).Environment?.Variables || {};
    const [r8, sc] = await Promise.all([env(RULE8), env(SCREENER)]);
    // Only non-secret settings are returned
    return {
        gapDownEnabled: r8.RULE8_ENABLED === 'true',
        gapDownThresholdPct: Number(r8.RULE8_DROP_THRESHOLD),
        screenerEnabled: sc.SCREENER_ENABLED === 'true',
        minMarketCapUsd: Number(sc.SCREENER_MIN_MCAP),
        minAvgDailyDollarVolumeUsd: Number(sc.SCREENER_MIN_DOLLAR_VOL),
        maxPositionUsd: Number(sc.SCREENER_MAX_POSITION),
        maxLossPerTradeUsd: Number(sc.SCREENER_MAX_LOSS),
    };
}

const HANDLERS = { get_quote: getQuote, score_stock: scoreStock, get_today_activity: getTodayActivity, get_settings: getSettings };

async function runTool(name, input) {
    const handler = HANDLERS[name];
    if (!handler) throw new Error(`Unknown tool ${name}`);
    yahoo.resetSession();
    return handler(input || {});
}

module.exports = { TOOL_DEFINITIONS, runTool };
