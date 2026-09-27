/**
 * Rule 8: Gap Down Alert
 * Runs at 4:33 PM IL (9:33 AM ET) — 3 minutes after market open.
 *
 * Detects stocks that dropped >dropThreshold% from yesterday's close.
 * Premise: a drop this large in an S&P 500 / mid-cap stock at open
 * is likely an overreaction worth buying into before recovery.
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');
const SCREENER_MAX_STOCKS = 25;

/**
 * Hand flagged stocks to the Dip Screener via a one-time schedule at 10:05 AM ET
 * (after the 9:30-10:00 opening range), or 1 minute from now if that has passed.
 * The schedule carries the list as its input and deletes itself after running.
 */
async function scheduleDipScreener(stocks, now) {
    const { SCREENER_FUNCTION_ARN, SCREENER_SCHEDULER_ROLE_ARN } = process.env;
    if (!SCREENER_FUNCTION_ARN || !SCREENER_SCHEDULER_ROLE_ARN || !stocks.length) return;
    // Loaded here so a missing SDK client can never break the gap-down alert itself.
    const { SchedulerClient, CreateScheduleCommand } = require('@aws-sdk/client-scheduler');

    const etParts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).formatToParts(now).map(p => [p.type, p.value]));
    const date = `${etParts.year}-${etParts.month}-${etParts.day}`;
    const minuteOfDay = Number(etParts.hour) * 60 + Number(etParts.minute);

    let at = `${date}T10:05:00`;
    if (minuteOfDay >= 604) {
        const later = new Date(now.getTime() + 60 * 1000);
        const l = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
        }).formatToParts(later).map(p => [p.type, p.value]));
        at = `${date}T${l.hour}:${l.minute}:00`;
    }

    const payload = {
        source: 'rule8',
        date,
        stocks: stocks.slice(0, SCREENER_MAX_STOCKS).map(s => ({ symbol: s.symbol, drop: +s.gapDown.toFixed(2) })),
        flaggedTotal: stocks.length
    };
    await new SchedulerClient({}).send(new CreateScheduleCommand({
        Name: `dip-screener-${date}-${etParts.hour}${etParts.minute}${etParts.second}`,
        ScheduleExpression: `at(${at})`,
        ScheduleExpressionTimezone: 'America/New_York',
        FlexibleTimeWindow: { Mode: 'OFF' },
        ActionAfterCompletion: 'DELETE',
        Target: { Arn: SCREENER_FUNCTION_ARN, RoleArn: SCREENER_SCHEDULER_ROLE_ARN, Input: JSON.stringify(payload) }
    }));
    console.log(`Dip Screener scheduled at ${at} ET for ${payload.stocks.length} stock(s)`);
}

/**
 * Slack blocks for the alert. A section's text is limited to 3,000 characters and a
 * message to 50 blocks, so stock lines are split across sections and capped.
 */
const MAX_LISTED = 150;
function buildGapDownBlocks(matchingStocks, dropThreshold, timeLabel, scannedCount) {
    const lines = matchingStocks.slice(0, MAX_LISTED).map(s =>
        `• *<https://finance.yahoo.com/quote/${s.symbol}|${s.symbol}>* (${s.name}): $${s.price.toFixed(2)} | Drop: *${s.gapDown.toFixed(2)}%*`
    );
    const sections = [];
    let current = '';
    for (const line of lines) {
        if (current && current.length + line.length + 1 > 2800) {
            sections.push(current);
            current = '';
        }
        current = current ? `${current}\n${line}` : line;
    }
    if (current) sections.push(current);

    const more = matchingStocks.length - lines.length;
    return [
        { type: 'header', text: { type: 'plain_text', text: '🔴 Gap Down Alert', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `*${matchingStocks.length} stocks down >${dropThreshold}% at open* — potential overreaction:` } },
        { type: 'divider' },
        ...sections.slice(0, 40).map(text => ({ type: 'section', text: { type: 'mrkdwn', text } })),
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text:
            `${more > 0 ? `+${more} more not listed | ` : ''}Scanned ${scannedCount} stocks | 🕙 ${timeLabel} ET` }] }
    ];
}

exports.buildGapDownBlocks = buildGapDownBlocks; // exported for testing

exports.handler = async (event) => {
    console.log('Rule 8: Gap Down Alert triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE8_ENABLED === 'true';
    const dropThreshold = parseFloat(process.env.RULE8_DROP_THRESHOLD || '9');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log(`Enabled: ${enabled} | Drop threshold: ${dropThreshold}%`);

    const forceRun = event.forceRun === true;

    if (!enabled && !forceRun) {
        console.log('Rule 8 is disabled. Exiting.');
        return { statusCode: 200, body: JSON.stringify({ message: 'Rule 8 disabled' }) };
    }

    try {
        const etLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
        if (slackWebhookUrl) {
            await sendSlackAlert(slackWebhookUrl, [{
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `🔍 Gap Down scan started — ${STOCKS_TO_MONITOR.length} stocks | ${etLabel} ET` }]
            }]);
        }

        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR, 25, 300, '2d', '1d');

        const now = new Date();
        const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const day = etTime.getDay();
        const minuteOfDay = etTime.getHours() * 60 + etTime.getMinutes();
        const marketIsOpen = day >= 1 && day <= 5 && minuteOfDay >= 570 && minuteOfDay < 960;

        console.log(`ET time: ${etTime.toLocaleTimeString()} | Market open: ${marketIsOpen}`);
        if (!marketIsOpen && !forceRun) {
            console.log('Market is closed — skipping Rule 8.');
            return { statusCode: 200, body: JSON.stringify({ message: 'Market closed' }) };
        }

        // Yesterday's close = last daily bar dated before today (ET).
        // - meta.previousClose can be stale after large moves.
        // - During market hours the last bar is today's, and its close is the live price.
        const etDate = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
        const todayET = etDate(now);

        const matchingStocks = [];
        for (const s of stocks) {
            let prevClose = null;
            const closes = s.closes || [];
            const timestamps = s.timestamps || [];
            for (let i = closes.length - 1; i >= 0; i--) {
                if (closes[i] == null || !timestamps[i]) continue;
                if (etDate(new Date(timestamps[i] * 1000)) < todayET) {
                    prevClose = closes[i];
                    break;
                }
            }
            if (!prevClose || !s.price) continue;
            const gapDown = ((s.price - prevClose) / prevClose) * 100;
            if (gapDown >= -dropThreshold) continue;
            s.gapDown = gapDown;
            matchingStocks.push(s);
        }
        matchingStocks.sort((a, b) => a.gapDown - b.gapDown);

        console.log(`Rule 8: Found ${matchingStocks.length} matching stocks`);

        try {
            await scheduleDipScreener(matchingStocks, now);
        } catch (error) {
            console.error('Failed to schedule Dip Screener:', error);
        }

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const timeLabel = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
            try {
                await sendSlackAlert(slackWebhookUrl, buildGapDownBlocks(matchingStocks, dropThreshold, timeLabel, stocks.length));
            } catch (error) {
                // Never lose the alert: fall back to a minimal plain message
                console.error('Full Slack alert failed, sending fallback:', error.message);
                const top = matchingStocks.slice(0, 40).map(s => `${s.symbol} ${s.gapDown.toFixed(1)}%`).join(', ');
                await sendSlackAlert(slackWebhookUrl, [{ type: 'section', text: { type: 'mrkdwn',
                    text: `🔴 *Gap Down Alert* — ${matchingStocks.length} stocks down >${dropThreshold}%: ${top}${matchingStocks.length > 40 ? ', …' : ''}` } }]);
            }
            console.log('Slack alert sent successfully!');
        } else if (matchingStocks.length === 0 && slackWebhookUrl) {
            await sendSlackAlert(slackWebhookUrl, [{
                type: 'context',
                elements: [{ type: 'mrkdwn', text: `✅ Gap Down scan complete — no stocks down >${dropThreshold}% | ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET` }]
            }]);
            console.log('No matching stocks — heartbeat sent');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                rule: 'rule8',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({ symbol: s.symbol, drop: `${s.gapDown.toFixed(2)}%` }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 8 handler:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};

exports.scheduleDipScreener = scheduleDipScreener; // exported for testing
