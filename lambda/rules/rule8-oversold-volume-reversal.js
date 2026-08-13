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

exports.handler = async (event) => {
    console.log('Rule 8: Gap Down Alert triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE8_ENABLED === 'true';
    const dropThreshold = parseFloat(process.env.RULE8_DROP_THRESHOLD || '18');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log(`Enabled: ${enabled} | Drop threshold: ${dropThreshold}%`);

    const forceRun = event.forceRun === true;

    if (!enabled && !forceRun) {
        console.log('Rule 8 is disabled. Exiting.');
        return { statusCode: 200, body: JSON.stringify({ message: 'Rule 8 disabled' }) };
    }

    try {
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

        const matchingStocks = stocks
            .filter(s => s.change1d !== null && s.change1d < -dropThreshold)
            .sort((a, b) => a.change1d - b.change1d);

        console.log(`Rule 8: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const stockLines = matchingStocks.map(s =>
                `• *<https://finance.yahoo.com/quote/${s.symbol}|${s.symbol}>* (${s.name}): $${s.price.toFixed(2)} | Drop: *${s.change1d.toFixed(2)}%*`
            ).join('\n');

            const blocks = [
                {
                    type: 'header',
                    text: { type: 'plain_text', text: '🔴 Gap Down Alert', emoji: true }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `*Stocks down >${dropThreshold}% at open* — potential overreaction:`
                    }
                },
                { type: 'divider' },
                {
                    type: 'section',
                    text: { type: 'mrkdwn', text: stockLines }
                },
                { type: 'divider' },
                {
                    type: 'context',
                    elements: [{
                        type: 'mrkdwn',
                        text: `🕙 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`
                    }]
                }
            ];

            await sendSlackAlert(slackWebhookUrl, blocks);
            console.log('Slack alert sent successfully!');
        } else if (matchingStocks.length === 0) {
            console.log('No matching stocks — no alert sent');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                rule: 'rule8',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({ symbol: s.symbol, drop: `${s.change1d.toFixed(2)}%` }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 8 handler:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
