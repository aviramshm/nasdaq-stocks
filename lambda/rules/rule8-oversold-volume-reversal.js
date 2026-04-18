/**
 * Rule 8: Oversold + Volume Reversal
 * Runs at 2 PM EST (watchlist/heads-up) and 3 PM EST (buy signal) on live intraday data.
 *
 * Triggers when:
 *   - Stock dropped >X% cumulatively over the last N trading days (yesterday close vs N days ago close)
 *   - Up >Y% today vs yesterday's close (live intraday)
 *   - Today's volume already >Z times the daily average
 *
 * event.runType: 'watchlist' (2 PM) or 'buysignal' (3 PM, default)
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert, formatSingleRuleBlocks } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 8: Oversold + Volume Reversal triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE8_ENABLED === 'true';
    const days = parseInt(process.env.RULE8_DAYS || '5', 10);
    const dropThreshold = parseFloat(process.env.RULE8_DROP_THRESHOLD || '10');
    const gainThreshold = parseFloat(process.env.RULE8_GAIN_THRESHOLD || '3');
    const volumeThreshold = parseFloat(process.env.RULE8_VOLUME_THRESHOLD || '1.5');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log(`Enabled: ${enabled} | Days: ${days} | Drop: ${dropThreshold}% | Gain: ${gainThreshold}% | Volume: ${volumeThreshold}x`);

    const forceRun = event.forceRun === true;
    const runType = event.runType || 'buysignal'; // 'watchlist' (2 PM) or 'buysignal' (3 PM)
    console.log(`Run type: ${runType}`);

    if (!enabled && !forceRun) {
        console.log('Rule 8 is disabled. Exiting.');
        return { statusCode: 200, body: JSON.stringify({ message: 'Rule 8 disabled' }) };
    }

    try {
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        // Need enough range for N prior trading days + buffer
        const fetchRange = `${days + 5}d`;
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR, 15, 500, fetchRange, '1d');

        const matchingStocks = stocks
            .filter(stock => {
                const closes = (stock.closes || []).filter(c => c !== null);
                // closes[-1]=today(partial), closes[-2]=yesterday, closes[-1-N]=N days ago
                if (closes.length < days + 2) return false;

                const yesterdayClose = closes[closes.length - 2];
                const nDaysAgoClose = closes[closes.length - 1 - days];
                if (!yesterdayClose || !nDaysAgoClose) return false;

                const priorDrop = ((yesterdayClose - nDaysAgoClose) / nDaysAgoClose) * 100;
                stock.priorDrop = priorDrop;

                return priorDrop <= -dropThreshold &&
                       stock.change1d !== null && stock.change1d >= gainThreshold &&
                       stock.volumeRatio !== null && stock.volumeRatio >= volumeThreshold;
            })
            .sort((a, b) => b.change1d - a.change1d);

        console.log(`Rule 8: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const isWatchlist = runType === 'watchlist';
            const ruleName = isWatchlist ? 'Watchlist — Signal Forming' : 'Buy Signal — Place Orders Before Close';
            const ruleEmoji = isWatchlist ? '👀' : '🎯';
            const descAction = isWatchlist
                ? 'Signal forming — monitor for close:'
                : 'Consider buying before close:';

            const blocks = formatSingleRuleBlocks({
                ruleId: 'rule8',
                ruleName,
                ruleEmoji,
                stocks: matchingStocks,
                formatStock: (stock) =>
                    `• *<https://finance.yahoo.com/quote/${stock.symbol}|${stock.symbol}>* (${stock.name}): $${stock.price.toFixed(2)} | ${days}d drop: *${stock.priorDrop.toFixed(2)}%* | Today: *+${stock.change1d.toFixed(2)}%* | Vol: *${stock.volumeRatio.toFixed(1)}x*`,
                config: {
                    description: `*Oversold (>${dropThreshold}% over ${days} days) + up >${gainThreshold}% today + volume >${volumeThreshold}x* — ${descAction}\n${matchingStocks.length} stock(s):`
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
                rule: 'rule8',
                matches: matchingStocks.length,
                stocks: matchingStocks.map(s => ({
                    symbol: s.symbol,
                    priorDrop: `${s.priorDrop.toFixed(2)}%`,
                    todayGain: `+${s.change1d.toFixed(2)}%`,
                    volume: `${s.volumeRatio.toFixed(1)}x`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Rule 8 handler:', error);
        return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }
};
