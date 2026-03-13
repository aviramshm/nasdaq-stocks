/**
 * Rule 3: Recovery Signal
 * Triggers when a stock dropped >X% in 5 days but is UP >Y% today
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 3: Recovery Signal triggered');
    console.log('Event:', JSON.stringify(event));

    // Read configuration from environment variables
    const enabled = process.env.RULE3_ENABLED === 'true';
    const threshold1 = parseFloat(process.env.RULE3_THRESHOLD1 || '10'); // 5-day drop
    const threshold2 = parseFloat(process.env.RULE3_THRESHOLD2 || '3');  // today's gain
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold1 (5d drop):', threshold1);
    console.log('Threshold2 (today gain):', threshold2);

    // Check if enabled (unless forceRun)
    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 3 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 3 disabled' })
        };
    }

    try {
        // Fetch stock data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        // Apply rule-specific filtering
        const matchingStocks = stocks
            .filter(stock =>
                stock.change5d !== null &&
                stock.change5d <= -threshold1 &&
                stock.change1d >= threshold2
            )
            .sort((a, b) => b.change1d - a.change1d);

        console.log(`Rule 3: Found ${matchingStocks.length} matching stocks`);

        // Send Slack alert if matches found
        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule3',
                ruleName: 'Recovery Signal',
                ruleEmoji: '🔄',
                stocks: matchingStocks,
                formatStock: (stock) => `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | 5d: ${stock.change5d.toFixed(2)}% | Today: *+${stock.change1d.toFixed(2)}%*`,
                config: {
                    description: `*Stocks that dropped >${threshold1}% in 5 days but UP >${threshold2}% today* - ${matchingStocks.length} stock(s):`
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
                    change5d: `${s.change5d.toFixed(2)}%`,
                    change1d: `+${s.change1d.toFixed(2)}%`
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
