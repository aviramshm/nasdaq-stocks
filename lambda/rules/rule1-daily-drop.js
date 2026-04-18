/**
 * Rule 1: Daily Drop Alert
 * Triggers when a stock dropped more than threshold % yesterday (completed trading day)
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 1: Daily Drop Alert triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE1_ENABLED === 'true';
    const threshold = parseFloat(process.env.RULE1_THRESHOLD || '15');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold:', threshold);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 1 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 1 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering — use yesterdayChange (completed trading day)
        const matchingStocks = stocks
            .filter(stock => stock.yesterdayChange !== null && stock.yesterdayChange <= -threshold)
            .sort((a, b) => a.yesterdayChange - b.yesterdayChange);

        console.log(`Rule 1: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule1',
                ruleName: '1-Day Drop Alert',
                ruleEmoji: '📉',
                stocks: matchingStocks,
                formatStock: (stock) => `• *<https://finance.yahoo.com/quote/${stock.symbol}|${stock.symbol}>* (${stock.name}): $${stock.price.toFixed(2)} → *${stock.yesterdayChange.toFixed(2)}%* yesterday`,
                config: {
                    description: `*Stocks that dropped more than ${threshold}% yesterday* - ${matchingStocks.length} stock(s):`
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
                rule: 'rule1',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    change: `${s.yesterdayChange.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 1 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
