/**
 * Rule 4: Near 52-Week Low
 * Triggers when a stock is within X% of its 52-week low
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 4: Near 52-Week Low triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE4_ENABLED === 'true';
    const threshold = parseFloat(process.env.RULE4_THRESHOLD || '5');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold:', threshold);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 4 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 4 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering
        const matchingStocks = stocks
            .filter(stock =>
                stock.distanceFrom52wLow !== null &&
                stock.distanceFrom52wLow >= 0 &&
                stock.distanceFrom52wLow <= threshold
            )
            .sort((a, b) => a.distanceFrom52wLow - b.distanceFrom52wLow);

        console.log(`Rule 4: Found ${matchingStocks.length} matching stocks`);

        // Send Slack alert if matches found
        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule4',
                ruleName: 'Near 52-Week Low',
                ruleEmoji: '📍',
                stocks: matchingStocks,
                formatStock: (stock) => `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | 52w Low: $${stock.fiftyTwoWeekLow.toFixed(2)} (*+${stock.distanceFrom52wLow.toFixed(2)}%* from low)`,
                config: {
                    description: `*Stocks within ${threshold}% of 52-week low* - ${matchingStocks.length} stock(s):`
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
                rule: 'rule4',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    distance: `${s.distanceFrom52wLow.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 4 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
