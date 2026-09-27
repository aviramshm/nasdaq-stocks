/**
 * Weekly scorecard: replay every past verdict's trade plan against what the price actually
 * did, and compare outcomes by verdict and by cause. Past verdicts come from the screener's
 * own "VERDICTS" log lines, so no extra storage is needed.
 *
 * Replay rules (same for every verdict, so they're comparable):
 * - Enter at the 10:05 price on the scan day.
 * - Walk 5-minute bars after 10:05 that day, then daily bars for the next 10 trading days.
 * - In each bar the stop is checked before the targets (conservative when both are touched).
 * - Target 1 sells half; Target 2 sells the rest; otherwise exit at the day-10 close.
 */
const yahoo = require('./yahoo');
const { etDate } = require('./scoring');

const HOLD_DAYS = 10;
const ENTRY_MINUTE = 10 * 60 + 5;

const etMinute = (t) => {
    const [h, m] = new Date(t * 1000)
        .toLocaleTimeString('en-GB', { timeZone: 'America/New_York', hour12: false }).split(':');
    return Number(h) * 60 + Number(m);
};

/**
 * @param plan {entry, stop, target1, target2}
 * @param sameDayBars 5-minute bars on the scan day after entry, ascending
 * @param laterDays daily bars after the scan day, ascending
 */
function simulateTrade(plan, sameDayBars, laterDays) {
    const { entry, stop, target1, target2 } = plan;
    let remaining = 1;
    let proceeds = 0;
    let hitT1 = false;
    let daysHeld = 0;

    const step = (bar) => {
        if (bar.low <= stop) {
            proceeds += remaining * stop;
            remaining = 0;
            return hitT1 ? 'T1, then stop' : 'stop';
        }
        if (!hitT1 && bar.high >= target1) {
            proceeds += 0.5 * target1;
            remaining = 0.5;
            hitT1 = true;
        }
        if (bar.high >= target2) {
            proceeds += remaining * target2;
            remaining = 0;
            return 'T2';
        }
        return null;
    };
    const closed = (outcome) => ({
        status: 'closed', outcome, hitT1, daysHeld, returnPct: (proceeds / entry - 1) * 100,
    });

    for (const bar of sameDayBars) {
        const outcome = step(bar);
        if (outcome) return closed(outcome);
    }
    for (const bar of laterDays.slice(0, HOLD_DAYS)) {
        daysHeld++;
        const outcome = step(bar);
        if (outcome) return closed(outcome);
    }
    if (laterDays.length >= HOLD_DAYS) {
        proceeds += remaining * laterDays[HOLD_DAYS - 1].close;
        remaining = 0;
        return closed(hitT1 ? 'T1, then day 10' : 'day 10');
    }
    const lastClose = laterDays.at(-1)?.close ?? sameDayBars.at(-1)?.close ?? entry;
    return {
        status: 'open', outcome: hitT1 ? 'T1 hit, still open' : 'open', hitT1, daysHeld,
        returnPct: ((proceeds + remaining * lastClose) / entry - 1) * 100,
    };
}

async function replay(trade) {
    const [intraday, daily] = await Promise.all([
        yahoo.chart(trade.symbol, '60d', '5m').catch(() => ({ bars: [] })),
        yahoo.chart(trade.symbol, '6mo', '1d'),
    ]);
    const sameDayBars = intraday.bars.filter(b => etDate(b.t) === trade.date && etMinute(b.t) >= ENTRY_MINUTE);
    const laterDays = daily.bars.filter(b => etDate(b.t) > trade.date);
    return { ...trade, ...simulateTrade(trade.plan, sameDayBars, laterDays) };
}

/** Past verdicts from the screener's own logs, one per (date, symbol). */
async function loadVerdicts(days = 120) {
    const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');
    const logs = new CloudWatchLogsClient({});
    const byKey = new Map();
    let nextToken;
    do {
        const page = await logs.send(new FilterLogEventsCommand({
            logGroupName: `/aws/lambda/${process.env.AWS_LAMBDA_FUNCTION_NAME}`,
            filterPattern: '"VERDICTS"',
            startTime: Date.now() - days * 86400 * 1000,
            nextToken,
        }));
        for (const e of page.events || []) {
            const json = e.message.slice(e.message.indexOf('VERDICTS ') + 'VERDICTS '.length);
            try {
                const { date, results } = JSON.parse(json);
                for (const r of results) {
                    if (r.score == null || !r.evalPlan) continue;
                    byKey.set(`${date}:${r.symbol}`, {
                        date, symbol: r.symbol, verdict: r.verdict, cause: r.cause, plan: r.evalPlan,
                    });
                }
            } catch {
                // a log line truncated by CloudWatch (256 KB limit) - skip it
            }
        }
        nextToken = page.nextToken;
    } while (nextToken);
    return [...byKey.values()];
}

function summarize(trades) {
    const n = trades.length;
    const wins = trades.filter(t => t.returnPct > 0).length;
    const avg = trades.reduce((a, t) => a + t.returnPct, 0) / (n || 1);
    const t1 = trades.filter(t => t.hitT1).length;
    const stops = trades.filter(t => t.outcome.endsWith('stop')).length;
    return { n, wins, avg, t1, stops };
}

const pct = (x) => `${x > 0 ? '+' : ''}${x.toFixed(1)}%`;
const line = (label, s) =>
    `${label}: *${s.n}* trade${s.n === 1 ? '' : 's'} | won ${s.wins}/${s.n} (${Math.round(s.wins / s.n * 100)}%) | avg *${pct(s.avg)}* | T1 hit ${s.t1}/${s.n} | stopped ${s.stops}/${s.n}`;

const VERDICT_ORDER = ['WATCH', 'MAYBE', 'PASS', 'AVOID'];
const EMOJI = { WATCH: '🟢', MAYBE: '🟡', PASS: '⚪', AVOID: '🔴' };

function buildBlocks(replayed) {
    const closed = replayed.filter(t => t.status === 'closed');
    const open = replayed.filter(t => t.status === 'open');
    const blocks = [{ type: 'header', text: { type: 'plain_text', text: '📊 Dip Screener — weekly scorecard', emoji: true } }];

    if (!closed.length) {
        blocks.push({ type: 'section', text: { type: 'mrkdwn', text:
            `No finished trades yet — each one takes up to ${HOLD_DAYS} trading days. ${open.length} trade(s) in progress.` } });
        return blocks;
    }

    const byVerdict = VERDICT_ORDER
        .map(v => [v, closed.filter(t => t.verdict === v)])
        .filter(([, ts]) => ts.length)
        .map(([v, ts]) => line(`${EMOJI[v]} *${v}*`, summarize(ts)));
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*By verdict* (finished trades)\n${byVerdict.join('\n')}` } });

    const causes = [...new Set(closed.map(t => t.cause))];
    const byCause = causes
        .map(c => [c, summarize(closed.filter(t => t.cause === c))])
        .sort((a, b) => b[1].n - a[1].n)
        .map(([c, s]) => line(c.replace(/_/g, ' ').toLowerCase(), s));
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*By cause*\n${byCause.join('\n')}`.slice(0, 2900) } });

    const recent = closed.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15)
        .map(t => `${EMOJI[t.verdict] || ''} ${t.date} *${t.symbol}* ${t.verdict}: ${t.outcome} → *${pct(t.returnPct)}*`);
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*Latest finished trades*\n${recent.join('\n')}`.slice(0, 2900) } });

    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text:
        `${open.length} trade(s) still open. Every scored stock is replayed the same way — bought at the 10:05 price, stop / T1 (half) / T2 / day-${HOLD_DAYS} exit — ` +
        'including PASS and AVOID, which are hypothetical. Real fills and the later buy-signal re-checks are not modeled.' }] });
    return blocks;
}

async function runScorecard({ mapLimit, postSlack, slackWebhookUrl }) {
    const trades = await loadVerdicts();
    const replayed = (await mapLimit(trades, 4, replay)).filter(t => t && t.status);
    await postSlack(slackWebhookUrl, buildBlocks(replayed), 'Dip Screener weekly scorecard');
    const closed = replayed.filter(t => t.status === 'closed').length;
    console.log('Scorecard:', JSON.stringify(replayed.map(t => ({ date: t.date, symbol: t.symbol, verdict: t.verdict, outcome: t.outcome, ret: +t.returnPct.toFixed(2) }))));
    return { statusCode: 200, body: JSON.stringify({ trades: replayed.length, closed }) };
}

module.exports = { simulateTrade, buildBlocks, runScorecard, replay };
