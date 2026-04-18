/**
 * Rule 2: 2-Day Drop Alert
 * Triggers when a stock dropped more than threshold % over the last 2 completed trading days
 * (yesterday's close vs 3 days ago close)
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 2: 2-Day Drop Alert triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE2_ENABLED === 'true';
    const threshold = parseFloat(process.env.RULE2_THRESHOLD || '20');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold:', threshold);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 2 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 2 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering — yesterday vs 3 days ago (2 completed trading days)
        const matchingStocks = stocks
            .filter(stock => {
                const closes = (stock.closes || []).filter(c => c !== null);
                if (closes.length < 4) return false;
                const yesterday = closes[closes.length - 2];
                const threeDaysAgo = closes[closes.length - 4];
                if (!yesterday || !threeDaysAgo) return false;
                stock.change2dCompleted = ((yesterday - threeDaysAgo) / threeDaysAgo) * 100;
                return stock.change2dCompleted <= -threshold;
            })
            .sort((a, b) => a.change2dCompleted - b.change2dCompleted);

        console.log(`Rule 2: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule2',
                ruleName: '2-Day Drop Alert',
                ruleEmoji: '📉',
                stocks: matchingStocks,
                formatStock: (stock) => `• *<https://finance.yahoo.com/quote/${stock.symbol}|${stock.symbol}>* (${stock.name}): $${stock.price.toFixed(2)} → *${stock.change2dCompleted.toFixed(2)}%* (2d)`,
                config: {
                    description: `*Stocks that dropped more than ${threshold}% over the last 2 days* - ${matchingStocks.length} stock(s):`
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
                rule: 'rule2',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    change: `${s.change2dCompleted.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 2 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
