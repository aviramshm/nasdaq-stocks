/**
 * Rule 5: Bounce Back
 * Triggers when a stock dropped >X% yesterday but is up >Y% today
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 5: Bounce Back triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE5_ENABLED === 'true';
    const threshold1 = parseFloat(process.env.RULE5_THRESHOLD1 || '5'); // yesterday drop
    const threshold2 = parseFloat(process.env.RULE5_THRESHOLD2 || '2'); // today gain
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold1 (yesterday drop):', threshold1);
    console.log('Threshold2 (today gain):', threshold2);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 5 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 5 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering
        const matchingStocks = stocks
            .filter(stock =>
                stock.yesterdayChange !== null &&
                stock.yesterdayChange <= -threshold1 &&
                stock.change1d >= threshold2
            )
            .sort((a, b) => b.change1d - a.change1d);

        console.log(`Rule 5: Found ${matchingStocks.length} matching stocks`);

        // Send Slack alert if matches found
        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule5',
                ruleName: 'Bounce Back',
                ruleEmoji: '↩️',
                stocks: matchingStocks,
                formatStock: (stock) => `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | Yesterday: ${stock.yesterdayChange.toFixed(2)}% | Today: *+${stock.change1d.toFixed(2)}%*`,
                config: {
                    description: `*Stocks that dropped >${threshold1}% yesterday but UP >${threshold2}% today* - ${matchingStocks.length} stock(s):`
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
                rule: 'rule5',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    yesterday: `${s.yesterdayChange.toFixed(2)}%`,
                    today: `+${s.change1d.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 5 handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
