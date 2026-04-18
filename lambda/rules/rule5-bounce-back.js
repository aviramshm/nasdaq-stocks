/**
 * Rule 5: Bounce Back
 * Triggers when a stock dropped >X% the day before yesterday and is up >Y% yesterday.
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 5: Bounce Back triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE5_ENABLED === 'true';
    const threshold1 = parseFloat(process.env.RULE5_THRESHOLD1 || '5'); // day-before-yesterday drop
    const threshold2 = parseFloat(process.env.RULE5_THRESHOLD2 || '2'); // yesterday gain
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log('Enabled:', enabled);
    console.log('Threshold1 (day-before-yesterday drop):', threshold1);
    console.log('Threshold2 (yesterday gain):', threshold2);

    const forceRun = event.forceRun === true;
    if (!enabled && !forceRun) {
        console.log('Rule 5 is disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Rule 5 disabled' })
        };
    }

    try {
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR);

        const matchingStocks = stocks
            .filter(stock => {
                const closes = (stock.closes || []).filter(c => c !== null);
                // Need at least 4 points: closes[-4]=2 days ago open, [-3]=day-before-yesterday, [-2]=yesterday, [-1]=today
                if (closes.length < 4) return false;
                const dayBeforeYesterday = closes[closes.length - 3];
                const twoDaysAgo = closes[closes.length - 4];
                if (!dayBeforeYesterday || !twoDaysAgo) return false;
                const dayBeforeYesterdayChange = ((dayBeforeYesterday - twoDaysAgo) / twoDaysAgo) * 100;
                stock.dayBeforeYesterdayChange = dayBeforeYesterdayChange;
                return dayBeforeYesterdayChange <= -threshold1 &&
                       stock.yesterdayChange !== null &&
                       stock.yesterdayChange >= threshold2;
            })
            .sort((a, b) => b.yesterdayChange - a.yesterdayChange);

        console.log(`Rule 5: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule5',
                ruleName: 'Bounce Back',
                ruleEmoji: '↩️',
                stocks: matchingStocks,
                formatStock: (stock) => `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} | 2 days ago: ${stock.dayBeforeYesterdayChange.toFixed(2)}% | Yesterday: *+${stock.yesterdayChange.toFixed(2)}%*`,
                config: {
                    description: `*Dropped >${threshold1}% 2 days ago, UP >${threshold2}% yesterday* - ${matchingStocks.length} stock(s):`
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
                    dayBeforeYesterday: `${s.dayBeforeYesterdayChange.toFixed(2)}%`,
                    yesterday: `+${s.yesterdayChange.toFixed(2)}%`
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
