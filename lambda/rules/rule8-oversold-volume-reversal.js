/**
 * Rule 8: Oversold + Volume Reversal
 * Runs at 10 AM, 11 AM EST (watchlist) and 2 PM EST (buy signal) on live intraday data.
 *
 * For each stock, finds the largest N in [minDays..maxDays] where:
 *   - Closed lower every single day for N consecutive days (yesterday back N days)
 *   - Cumulative drop over those N days > dropThreshold%
 *   - Up > gainThreshold% today (live intraday)
 *   - Today's volume > volumeThreshold x average
 *
 * Stocks are reported once at their maximum qualifying N.
 * Slack message groups stocks by N, descending.
 *
 * event.runType: 'watchlist' (10/11 AM) or 'buysignal' (2 PM, default)
 */
const { fetchBatchStockData } = require('stock-utils/data-fetcher');
const { sendSlackAlert } = require('stock-utils/slack-notifier');
const { STOCKS_TO_MONITOR } = require('stock-utils/stock-list');

exports.handler = async (event) => {
    console.log('Rule 8: Oversold + Volume Reversal triggered');
    console.log('Event:', JSON.stringify(event));

    const enabled = process.env.RULE8_ENABLED === 'true';
    const minDays = parseInt(process.env.RULE8_MIN_DAYS || '3', 10);
    const maxDays = parseInt(process.env.RULE8_MAX_DAYS || '7', 10);
    const dropThreshold = parseFloat(process.env.RULE8_DROP_THRESHOLD || '10');
    const gainThreshold = parseFloat(process.env.RULE8_GAIN_THRESHOLD || '3');
    const volumeThreshold = parseFloat(process.env.RULE8_VOLUME_THRESHOLD || '1.5');
    const slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

    console.log(`Enabled: ${enabled} | N: ${minDays}-${maxDays} | Drop: ${dropThreshold}% | Gain: ${gainThreshold}% | Volume: ${volumeThreshold}x`);

    const forceRun = event.forceRun === true;
    const runType = event.runType || 'buysignal';
    console.log(`Run type: ${runType}`);

    if (!enabled && !forceRun) {
        console.log('Rule 8 is disabled. Exiting.');
        return { statusCode: 200, body: JSON.stringify({ message: 'Rule 8 disabled' }) };
    }

    try {
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);
        const fetchRange = `${maxDays + 5}d`;
        const stocks = await fetchBatchStockData(STOCKS_TO_MONITOR, 15, 500, fetchRange, '1d');

        // Check if NYSE is currently open (9:30 AM – 4:00 PM ET, Mon–Fri)
        const now = new Date();
        const etTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const day = etTime.getDay(); // 0=Sun, 6=Sat
        const hour = etTime.getHours();
        const minute = etTime.getMinutes();
        const minuteOfDay = hour * 60 + minute;
        const marketOpen = 9 * 60 + 30;  // 9:30 AM
        const marketClose = 16 * 60;      // 4:00 PM
        const marketIsOpen = day >= 1 && day <= 5 && minuteOfDay >= marketOpen && minuteOfDay < marketClose;
        console.log(`ET time: ${etTime.toLocaleTimeString()} | Market open: ${marketIsOpen}`);
        if (!marketIsOpen && !forceRun) {
            console.log('Market is closed — skipping Rule 8.');
            return { statusCode: 200, body: JSON.stringify({ message: 'Market closed' }) };
        }

        const matchingStocks = [];

        for (const stock of stocks) {
            const closes = (stock.closes || []).filter(c => c !== null);

            // Find the largest N this stock qualifies for
            let bestN = null;
            for (let n = maxDays; n >= minDays; n--) {
                // Need: n completed days before today + today's partial = n+2 entries minimum
                if (closes.length < n + 2) continue;

                // The n completed closes leading up to yesterday (oldest → yesterday)
                const recentCloses = closes.slice(closes.length - 1 - n, closes.length - 1);
                if (recentCloses.length < n) continue;

                // Every day must have closed lower than the day before
                let consecutive = true;
                for (let i = 1; i < recentCloses.length; i++) {
                    if (recentCloses[i] >= recentCloses[i - 1]) { consecutive = false; break; }
                }
                if (!consecutive) continue;

                // Cumulative drop: yesterday vs n days ago
                const nDaysAgoClose = recentCloses[0];
                const yesterdayClose = recentCloses[recentCloses.length - 1];
                const priorDrop = ((yesterdayClose - nDaysAgoClose) / nDaysAgoClose) * 100;
                if (priorDrop > -dropThreshold) continue;

                bestN = n;
                stock.consecutiveDays = n;
                stock.priorDrop = priorDrop;
                break;
            }

            if (bestN === null) continue;

            // Today: up > gainThreshold% and volume > volumeThreshold x avg
            if (stock.change1d === null || stock.change1d < gainThreshold) continue;
            if (stock.volumeRatio === null || stock.volumeRatio < volumeThreshold) continue;

            matchingStocks.push(stock);
        }

        matchingStocks.sort((a, b) => b.consecutiveDays - a.consecutiveDays || b.change1d - a.change1d);

        console.log(`Rule 8: Found ${matchingStocks.length} matching stocks`);

        if (matchingStocks.length > 0 && slackWebhookUrl) {
            const isWatchlist = runType === 'watchlist';
            const emoji = isWatchlist ? '👀' : '🎯';
            const title = isWatchlist ? 'Watchlist — Signal Forming' : 'Buy Signal — Place Orders Before Close';
            const descAction = isWatchlist ? 'Monitor for close' : 'Consider buying before close';

            // Group stocks by their consecutive days N
            const byN = {};
            for (const stock of matchingStocks) {
                const n = stock.consecutiveDays;
                if (!byN[n]) byN[n] = [];
                byN[n].push(stock);
            }

            const blocks = [];

            blocks.push({
                type: 'header',
                text: { type: 'plain_text', text: `${emoji} ${title}`, emoji: true }
            });

            blocks.push({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Oversold reversal* — dropped every day + >${dropThreshold}% cumulative, up >${gainThreshold}% today, volume >${volumeThreshold}x — ${descAction}:`
                }
            });

            // One section per N, descending
            for (const n of Object.keys(byN).map(Number).sort((a, b) => b - a)) {
                const stockLines = byN[n].map(stock =>
                    `• *<https://finance.yahoo.com/quote/${stock.symbol}|${stock.symbol}>* (${stock.name}): $${stock.price.toFixed(2)} | ${n}d drop: *${stock.priorDrop.toFixed(2)}%* | Today: *+${stock.change1d.toFixed(2)}%* | Vol: *${stock.volumeRatio.toFixed(1)}x*`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*${n} consecutive down days* — ${byN[n].length} stock(s):\n${stockLines}`
                        }
                    }
                );
            }

            blocks.push(
                { type: 'divider' },
                {
                    type: 'context',
                    elements: [{
                        type: 'mrkdwn',
                        text: `🕙 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`
                    }]
                }
            );

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
                    consecutiveDays: s.consecutiveDays,
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
