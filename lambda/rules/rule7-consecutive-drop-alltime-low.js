/**
 * Rule 7: Consecutive Drop + All-Time Low
 * Triggers when a stock has dropped every day for the last X days
 * and is at or near its all-time low (verified via full price history).
 */
const { fetchBatchStockData, fetchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 7: Consecutive Drop + All-Time Low triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE7_ENABLED === 'true';
    const days = parseInt(process.env.RULE7_DAYS || '3', 10);
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled, '| Days:', days);

    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 7 is disabled. Exiting.');
        return { statusCode: 200, body: JSON.stringify({ message: 'Rule 7 disabled' }) };
    }

    try {
        // Fetch enough daily history to check X consecutive drops (need X+1 closes)
        const fetchRange = `${days + 3}d`; // +3 buffer for weekends/holidays
        console.log(`Fetching ${STOCKS_TO_MONITOR.length} stocks with range=${fetchRange}...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR, 15, 500, fetchRange, '1d');

        // Pass 1: filter stocks with X consecutive daily drops
        const consecutiveDroppers = stocks.filter(stock => {
            const closes = stock.closes;
            if (!closes || closes.length < days + 1) return false;
            const recent = closes.filter(c => c !== null).slice(-(days + 1));
            if (recent.length < days + 1) return false;
            for (let i = 1; i < recent.length; i++) {
                if (recent[i] >= recent[i - 1]) return false;
            }
            return true;
        });

        console.log(`Pass 1: ${consecutiveDroppers.length} stocks with ${days} consecutive drops`);

        if (consecutiveDroppers.length === 0) {
            console.log('No consecutive droppers — no alert sent');
            return { statusCode: 200, body: JSON.stringify({ rule: 'rule7', matches: 0 }) };
        }

        // Pass 2: for each consecutive dropper, fetch full history to find all-time low
        const matchingStocks = (await Promise.all(
            consecutiveDroppers.map(async stock => {
                try {
                    const history = await fetchStockData(stock.symbol, 'max', '1mo');
                    const allCloses = (history.closes || []).filter(c => c !== null && c > 0);
                    if (allCloses.length === 0) return null;

                    const allTimeLow = Math.min(...allCloses);
                    // Trigger if current price is within 1% of all-time low
                    if (stock.price <= allTimeLow * 1.01) {
                        return { ...stock, allTimeLow };
                    }
                    return null;
                } catch (err) {
                    console.error(`Error fetching history for ${stock.symbol}:`, err.message);
                    return null;
                }
            })
        )).filter(s => s !== null);

        console.log(`Rule 7: ${matchingStocks.length} stocks at all-time low after ${days} consecutive drops`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule7',
                ruleName: `${days}-Day Drop + All-Time Low`,
                ruleEmoji: '📉',
                stocks: matchingStocks,
                formatStock: (stock) =>
                    `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | All-Time Low: $${stock.allTimeLow.toFixed(2)} | ${days}-day drop: ${stock.change1d.toFixed(2)}% today`,
                config: {
                    description: `*Dropped every day for ${days} days and at all-time low* — ${matchingStocks.length} stock(s):`
                }
            });

            await sendSlackAlert(slackWebhookUrl, blocks);
            console.log('Slack alert sent successfully!');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                rule: 'rule7',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    price: s.price,
                    allTimeLow: s.allTimeLow
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 7 handler:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
