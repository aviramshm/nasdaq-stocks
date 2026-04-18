/**
 * Rule 3: Recovery Signal
 * Triggers when a stock dropped >X% in the 5 days prior to yesterday,
 * and was UP >Y% yesterday.
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 3: Recovery Signal triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE3_ENABLED === 'true';
    const threshold1 = parseFloat(process.env.RULE3_THRESHOLD1 || '10'); // 5-day drop prior to yesterday
    const threshold2 = parseFloat(process.env.RULE3_THRESHOLD2 || '3');  // yesterday's gain
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold1 (5d drop prior to yesterday):', threshold1);
    console.log('Threshold2 (yesterday gain):', threshold2);

    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 3 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 3 disabled' })
        };
    }

    try {
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        // Need 10d range to get 7+ trading day closes (5 days prior + yesterday + today)
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR, 15, 500, '10d', '1d');

        const matchingStocks = stocks
            .filter(stock => {
                const closes = (stock.closes || []).filter(c => c !== null);
                // Need at least 7 points: closes[-7] to closes[-2] = 5 days, closes[-2] = yesterday
                if (closes.length < 7) return false;
                const yesterday = closes[closes.length - 2];
                const sixDaysAgo = closes[closes.length - 7];
                if (!yesterday || !sixDaysAgo) return false;
                const change5dPriorToYesterday = ((yesterday - sixDaysAgo) / sixDaysAgo) * 100;
                stock.change5dPriorToYesterday = change5dPriorToYesterday;
                return change5dPriorToYesterday <= -threshold1 &&
                       stock.yesterdayChange !== null &&
                       stock.yesterdayChange >= threshold2;
            })
            .sort((a, b) => b.yesterdayChange - a.yesterdayChange);

        console.log(`Rule 3: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule3',
                ruleName: 'Recovery Signal',
                ruleEmoji: '🔄',
                stocks: matchingStocks,
                formatStock: (stock) => `• *<https://finance.yahoo.com/quote/${stock.symbol}|${stock.symbol}>* (${stock.name}): $${stock.price.toFixed(2)} | 5d prior: ${stock.change5dPriorToYesterday.toFixed(2)}% | Yesterday: *+${stock.yesterdayChange.toFixed(2)}%*`,
                config: {
                    description: `*Dropped >${threshold1}% in 5 days prior to yesterday, UP >${threshold2}% yesterday* - ${matchingStocks.length} stock(s):`
                }
            });

            await sendSlackAlert(slackWebhookUrl, blocks);
            console.log('Slack alert sent successfully!');
        } else if (matchingStocks.length === 0) {
            console.log('No matching stocks - no alert sent');
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                rule: 'rule3',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    change5dPriorToYesterday: `${s.change5dPriorToYesterday.toFixed(2)}%`,
                    yesterdayChange: `+${s.yesterdayChange.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 3 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
