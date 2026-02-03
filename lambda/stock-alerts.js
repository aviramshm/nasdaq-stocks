/**
 * AWS Lambda Function: Stock Drop Alert
 *
 * Runs daily at 10:00 AM EST to check for stocks that dropped
 * more than the configured threshold and sends alerts to Slack.
 */

const https = require('https');

// Configuration - Set these as environment variables in AWS Lambda
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DROP_THRESHOLD = parseFloat(process.env.DROP_THRESHOLD || '5');
const ALERT_ENABLED = process.env.ALERT_ENABLED === 'true';

// Top NASDAQ stocks to monitor (you can expand this list)
const STOCKS_TO_MONITOR = [
    'NVDA', 'GOOGL', 'GOOG', 'AAPL', 'MSFT', 'AMZN', 'META', 'TSLA', 'AVGO', 'WMT',
    'ASML', 'MU', 'COST', 'AMD', 'PLTR', 'NFLX', 'CSCO', 'LRCX', 'AZN', 'AMAT',
    'QCOM', 'INTU', 'ADBE', 'TXN', 'ISRG', 'BKNG', 'VRTX', 'KLAC', 'PANW', 'SNPS',
    'CDNS', 'REGN', 'MRVL', 'PEP', 'ABNB', 'CRWD', 'MELI', 'ORLY', 'MDLZ', 'FTNT',
    'PYPL', 'SQ', 'SHOP', 'SPOT', 'ZM', 'ROKU', 'COIN', 'HOOD', 'UBER', 'RIVN',
    'ARM', 'SMCI', 'SNOW', 'DDOG', 'NET', 'MDB', 'OKTA', 'ZS', 'TEAM', 'TTD'
];

/**
 * Fetch stock data from Yahoo Finance
 */
async function fetchStockData(symbol) {
    return new Promise((resolve, reject) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1d&interval=1d`;

        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const result = json.chart.result[0];
                    const meta = result.meta;
                    const quote = result.indicators.quote[0];

                    const currentPrice = meta.regularMarketPrice;
                    const previousClose = meta.previousClose || meta.chartPreviousClose;
                    const changePercent = ((currentPrice - previousClose) / previousClose) * 100;

                    resolve({
                        symbol: symbol,
                        name: meta.shortName || symbol,
                        price: currentPrice,
                        previousClose: previousClose,
                        changePercent: changePercent,
                        change: currentPrice - previousClose
                    });
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

/**
 * Send alert to Slack
 */
async function sendSlackAlert(stocks) {
    return new Promise((resolve, reject) => {
        if (!SLACK_WEBHOOK_URL) {
            reject(new Error('Slack webhook URL not configured'));
            return;
        }

        const webhookUrl = new URL(SLACK_WEBHOOK_URL);

        // Build Slack message
        const stockBlocks = stocks.map(stock => ({
            type: 'section',
            fields: [
                {
                    type: 'mrkdwn',
                    text: `*${stock.symbol}*\n${stock.name}`
                },
                {
                    type: 'mrkdwn',
                    text: `*Price:* $${stock.price.toFixed(2)}\n*Drop:* ${stock.changePercent.toFixed(2)}%`
                }
            ]
        }));

        const message = {
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: '📉 Stock Drop Alert',
                        emoji: true
                    }
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `The following stocks dropped more than *${DROP_THRESHOLD}%* today:`
                    }
                },
                { type: 'divider' },
                ...stockBlocks,
                { type: 'divider' },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: `🕙 Alert generated at ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`
                        }
                    ]
                }
            ]
        };

        const postData = JSON.stringify(message);

        const options = {
            hostname: webhookUrl.hostname,
            path: webhookUrl.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    resolve(data);
                } else {
                    reject(new Error(`Slack API error: ${res.statusCode} - ${data}`));
                }
            });
        });

        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

/**
 * Main Lambda handler
 */
exports.handler = async (event) => {
    console.log('Stock Alert Lambda triggered');
    console.log('Alert enabled:', ALERT_ENABLED);
    console.log('Drop threshold:', DROP_THRESHOLD);

    if (!ALERT_ENABLED) {
        console.log('Alerts are disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Alerts disabled' })
        };
    }

    try {
        // Fetch data for all monitored stocks
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);

        const stockPromises = STOCKS_TO_MONITOR.map(symbol =>
            fetchStockData(symbol).catch(err => {
                console.error(`Error fetching ${symbol}:`, err.message);
                return null;
            })
        );

        const stocksData = await Promise.all(stockPromises);
        const validStocks = stocksData.filter(s => s !== null);

        console.log(`Successfully fetched ${validStocks.length} stocks`);

        // Filter stocks that dropped more than threshold
        const droppedStocks = validStocks
            .filter(stock => stock.changePercent <= -DROP_THRESHOLD)
            .sort((a, b) => a.changePercent - b.changePercent) // Sort by biggest drop
            .slice(0, 3); // Top 3 biggest drops

        console.log(`Found ${droppedStocks.length} stocks with drops > ${DROP_THRESHOLD}%`);

        if (droppedStocks.length === 0) {
            console.log('No significant drops detected. No alert sent.');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'No significant drops detected' })
            };
        }

        // Send Slack alert
        console.log('Sending Slack alert...');
        await sendSlackAlert(droppedStocks);
        console.log('Slack alert sent successfully!');

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Alert sent successfully',
                stocks: droppedStocks.map(s => ({
                    symbol: s.symbol,
                    drop: `${s.changePercent.toFixed(2)}%`
                }))
            })
        };

    } catch (error) {
        console.error('Error in Lambda handler:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
