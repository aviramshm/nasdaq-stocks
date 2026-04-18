/**
 * Rule 6: High Volume Surge
 * Triggers when a stock is up >X% with volume >Y times average
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 6: High Volume Surge triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE6_ENABLED === 'true';
    const threshold1 = parseFloat(process.env.RULE6_THRESHOLD1 || '3'); // % up
    const threshold2 = parseFloat(process.env.RULE6_THRESHOLD2 || '2'); // volume multiplier
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold1 (% up):', threshold1);
    console.log('Threshold2 (volume multiplier):', threshold2);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 6 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 6 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering — use yesterdayChange (completed trading day)
        const matchingStocks = stocks
            .filter(stock =>
                stock.volumeRatio !== null &&
                stock.yesterdayChange !== null &&
                stock.yesterdayChange >= threshold1 &&
                stock.volumeRatio >= threshold2
            )
            .sort((a, b) => b.volumeRatio - a.volumeRatio);

        console.log(`Rule 6: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule6',
                ruleName: 'High Volume Surge',
                ruleEmoji: '🔥',
                stocks: matchingStocks,
                formatStock: (stock) => `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | Yesterday: *+${stock.yesterdayChange.toFixed(2)}%* | Volume: *${stock.volumeRatio.toFixed(1)}x* avg`,
                config: {
                    description: `*Stocks up >${threshold1}% yesterday with volume >${threshold2}x average* - ${matchingStocks.length} stock(s):`
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
                rule: 'rule6',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    change: `+${s.yesterdayChange.toFixed(2)}%`,
                    volume: `${s.volumeRatio.toFixed(1)}x`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 6 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
