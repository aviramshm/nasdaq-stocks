/**
 * AWS Lambda Function: Stock Drop Alert
 *
 * Runs daily at 10:00 AM EST to check for stocks that dropped
 * more than the configured threshold and sends alerts to Slack.
 */

const https = require('https');

// Configuration - Set these as environment variables in AWS Lambda
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

// Rule 1: Daily drop
const RULE1_ENABLED = process.env.RULE1_ENABLED === 'true';
const RULE1_THRESHOLD = parseFloat(process.env.RULE1_THRESHOLD || '15');

// Rule 2: 2-day drop
const RULE2_ENABLED = process.env.RULE2_ENABLED === 'true';
const RULE2_THRESHOLD = parseFloat(process.env.RULE2_THRESHOLD || '20');

// Rule 3: Recovery Signal - dropped >X% in 5 days but UP >Y% today
const RULE3_ENABLED = process.env.RULE3_ENABLED === 'true';
const RULE3_THRESHOLD1 = parseFloat(process.env.RULE3_THRESHOLD1 || '10'); // 5-day drop
const RULE3_THRESHOLD2 = parseFloat(process.env.RULE3_THRESHOLD2 || '3');  // today's gain

// Rule 4: Near 52-Week Low - within X% of 52-week low
const RULE4_ENABLED = process.env.RULE4_ENABLED === 'true';
const RULE4_THRESHOLD = parseFloat(process.env.RULE4_THRESHOLD || '5');

// Rule 5: Bounce Back - dropped >X% yesterday but up >Y% today
const RULE5_ENABLED = process.env.RULE5_ENABLED === 'true';
const RULE5_THRESHOLD1 = parseFloat(process.env.RULE5_THRESHOLD1 || '5'); // yesterday drop
const RULE5_THRESHOLD2 = parseFloat(process.env.RULE5_THRESHOLD2 || '2'); // today gain

// Rule 6: High Volume Surge - up with volume >X times average
const RULE6_ENABLED = process.env.RULE6_ENABLED === 'true';
const RULE6_THRESHOLD1 = parseFloat(process.env.RULE6_THRESHOLD1 || '3'); // % up
const RULE6_THRESHOLD2 = parseFloat(process.env.RULE6_THRESHOLD2 || '2'); // volume multiplier

// S&P 500 stocks list
const STOCKS_TO_MONITOR = [
    // Technology
    'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'CSCO', 'ACN', 'ADBE', 'IBM',
    'INTC', 'QCOM', 'TXN', 'AMD', 'AMAT', 'MU', 'LRCX', 'ADI', 'KLAC', 'SNPS',
    'CDNS', 'MCHP', 'FTNT', 'PANW', 'MSI', 'TEL', 'HPQ', 'HPE', 'KEYS', 'ON',
    'NXPI', 'MPWR', 'SWKS', 'FSLR', 'TER', 'ZBRA', 'NTAP', 'WDC', 'STX', 'JNPR',
    'FFIV', 'AKAM', 'CTSH', 'IT', 'EPAM', 'GDDY', 'GEN', 'PAYC', 'PAYX', 'FICO',

    // Communication Services
    'GOOGL', 'GOOG', 'META', 'NFLX', 'DIS', 'CMCSA', 'VZ', 'TMUS', 'T', 'CHTR',
    'EA', 'TTWO', 'WBD', 'PARA', 'OMC', 'IPG', 'LYV', 'MTCH', 'FOXA', 'FOX',
    'NWSA', 'NWS',

    // Consumer Discretionary
    'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'LOW', 'SBUX', 'TJX', 'BKNG', 'CMG',
    'ORLY', 'AZO', 'MAR', 'HLT', 'GM', 'F', 'ROST', 'DHI', 'LEN', 'PHM',
    'YUM', 'EBAY', 'APTV', 'GRMN', 'POOL', 'BBY', 'DRI', 'MGM', 'WYNN', 'CZR',
    'CCL', 'RCL', 'NCLH', 'LVS', 'ULTA', 'LULU', 'NVR', 'TSCO', 'DPZ', 'DECK',
    'EXPE', 'GPC', 'LKQ', 'BWA', 'ETSY', 'TPR', 'RL', 'HAS', 'WHR', 'KMX',

    // Consumer Staples
    'WMT', 'PG', 'COST', 'KO', 'PEP', 'PM', 'MO', 'MDLZ', 'CL', 'KMB',
    'GIS', 'HSY', 'K', 'KHC', 'SYY', 'STZ', 'KDP', 'MNST', 'ADM', 'CAG',
    'CPB', 'HRL', 'MKC', 'SJM', 'CLX', 'CHD', 'EL', 'TSN', 'TAP', 'BG',
    'KR', 'WBA', 'TGT', 'DG', 'DLTR',

    // Energy
    'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'MPC', 'PSX', 'VLO', 'PXD', 'OXY',
    'WMB', 'KMI', 'HAL', 'DVN', 'HES', 'BKR', 'FANG', 'TRGP', 'OKE', 'CTRA',
    'MRO', 'APA',

    // Financials
    'BRK.B', 'JPM', 'V', 'MA', 'BAC', 'WFC', 'GS', 'MS', 'SPGI', 'BLK',
    'C', 'AXP', 'SCHW', 'CB', 'MMC', 'PGR', 'AON', 'CME', 'ICE', 'MCO',
    'USB', 'PNC', 'TFC', 'AIG', 'MET', 'PRU', 'AFL', 'ALL', 'TRV', 'COF',
    'BK', 'STT', 'FITB', 'MTB', 'HBAN', 'RF', 'CFG', 'KEY', 'NTRS', 'DFS',
    'SYF', 'CINF', 'L', 'RE', 'GL', 'WRB', 'AJG', 'MSCI', 'NDAQ', 'FDS',
    'CBOE', 'RJF', 'BRO', 'AIZ',

    // Healthcare
    'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'DHR', 'BMY',
    'AMGN', 'GILD', 'VRTX', 'MDT', 'ISRG', 'ELV', 'CI', 'CVS', 'SYK', 'BSX',
    'BDX', 'ZBH', 'HUM', 'REGN', 'MCK', 'CAH', 'HCA', 'IDXX', 'IQV', 'EW',
    'A', 'DXCM', 'MTD', 'RMD', 'ALGN', 'WST', 'BAX', 'ZTS', 'BIIB', 'MRNA',
    'MOH', 'CNC', 'HOLX', 'ILMN', 'TECH', 'CRL', 'DGX', 'LH', 'VTRS', 'CTLT',
    'HSIC', 'OGN', 'XRAY', 'DVA', 'INCY',

    // Industrials
    'CAT', 'UNP', 'HON', 'UPS', 'RTX', 'BA', 'DE', 'LMT', 'GE', 'ADP',
    'ETN', 'ITW', 'NOC', 'GD', 'WM', 'CSX', 'NSC', 'EMR', 'FDX', 'MMM',
    'JCI', 'PH', 'CTAS', 'CARR', 'TT', 'CMI', 'PCAR', 'FAST', 'OTIS', 'ROK',
    'AME', 'VRSK', 'RSG', 'CPRT', 'ODFL', 'GWW', 'PWR', 'HWM', 'LHX', 'TDG',
    'IR', 'DOV', 'PAYX', 'XYL', 'JBHT', 'DAL', 'UAL', 'LUV', 'AAL', 'EXPD',
    'CHRW', 'WAB', 'FTV', 'SWK', 'IEX', 'PNR', 'LDOS', 'J', 'MAS', 'ALLE',
    'NDSN', 'GNRC', 'SNA', 'RHI', 'BR', 'ROL', 'PAYC',

    // Materials
    'LIN', 'APD', 'SHW', 'FCX', 'ECL', 'NEM', 'NUE', 'VMC', 'MLM', 'DOW',
    'DD', 'CTVA', 'PPG', 'ALB', 'IFF', 'LYB', 'CF', 'FMC', 'MOS', 'CE',
    'PKG', 'IP', 'AVY', 'SEE', 'EMN', 'BALL', 'WRK', 'AMCR', 'STLD',

    // Real Estate
    'AMT', 'PLD', 'CCI', 'EQIX', 'PSA', 'SPG', 'O', 'WELL', 'DLR', 'VICI',
    'SBAC', 'AVB', 'EQR', 'WY', 'VTR', 'ARE', 'MAA', 'EXR', 'INVH', 'IRM',
    'ESS', 'UDR', 'KIM', 'REG', 'HST', 'BXP', 'CPT', 'PEAK', 'FRT',

    // Utilities
    'NEE', 'DUK', 'SO', 'D', 'AEP', 'SRE', 'EXC', 'XEL', 'PCG', 'WEC',
    'ED', 'PEG', 'ES', 'AWK', 'EIX', 'DTE', 'FE', 'PPL', 'ETR', 'AEE',
    'CMS', 'CNP', 'ATO', 'EVRG', 'NI', 'LNT', 'PNW', 'NRG',

    // Additional Large Caps / Popular Stocks
    'PYPL', 'SQ', 'SHOP', 'SPOT', 'ZM', 'ROKU', 'COIN', 'HOOD', 'UBER', 'LYFT',
    'ABNB', 'RIVN', 'LCID', 'ARM', 'SMCI', 'SNOW', 'DDOG', 'NET', 'MDB', 'OKTA',
    'ZS', 'CRWD', 'TEAM', 'TTD', 'PLTR', 'MELI', 'SE', 'NU', 'GRAB', 'RBLX',
    'DASH', 'PINS', 'SNAP', 'U', 'PATH', 'AFRM', 'UPST', 'SOFI', 'MSTR', 'IONQ'
];

/**
 * Fetch stock data from Yahoo Finance
 * @param {string} symbol - Stock symbol
 */
async function fetchStockData(symbol) {
    return new Promise((resolve, reject) => {
        // Handle special symbols like BRK.B
        const encodedSymbol = symbol.replace('.', '-');

        const options = {
            hostname: 'query1.finance.yahoo.com',
            path: `/v8/finance/chart/${encodedSymbol}?range=5d&interval=1d`,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (!json.chart || !json.chart.result || !json.chart.result[0]) {
                        reject(new Error(`Invalid response for ${symbol}`));
                        return;
                    }
                    const result = json.chart.result[0];
                    const meta = result.meta;
                    const quotes = result.indicators.quote[0];
                    const closes = quotes.close;
                    const volumes = quotes.volume;

                    const currentPrice = meta.regularMarketPrice;
                    const previousClose = meta.previousClose || meta.chartPreviousClose;
                    const fiftyTwoWeekLow = meta.fiftyTwoWeekLow;
                    const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh;

                    // Today's change
                    const change1d = ((currentPrice - previousClose) / previousClose) * 100;

                    // Calculate 2-day change if we have enough data
                    let change2d = null;
                    if (closes && closes.length >= 2) {
                        const twoDaysAgoClose = closes[closes.length - 2];
                        if (twoDaysAgoClose) {
                            change2d = ((currentPrice - twoDaysAgoClose) / twoDaysAgoClose) * 100;
                        }
                    }

                    // Calculate 5-day change (for recovery signal)
                    let change5d = null;
                    if (closes && closes.length >= 5) {
                        const fiveDaysAgoClose = closes[0];
                        if (fiveDaysAgoClose) {
                            change5d = ((currentPrice - fiveDaysAgoClose) / fiveDaysAgoClose) * 100;
                        }
                    }

                    // Yesterday's change (for bounce back)
                    let yesterdayChange = null;
                    if (closes && closes.length >= 3) {
                        const dayBeforeYesterday = closes[closes.length - 3];
                        const yesterday = closes[closes.length - 2];
                        if (dayBeforeYesterday && yesterday) {
                            yesterdayChange = ((yesterday - dayBeforeYesterday) / dayBeforeYesterday) * 100;
                        }
                    }

                    // Distance from 52-week low
                    let distanceFrom52wLow = null;
                    if (fiftyTwoWeekLow && fiftyTwoWeekLow > 0) {
                        distanceFrom52wLow = ((currentPrice - fiftyTwoWeekLow) / fiftyTwoWeekLow) * 100;
                    }

                    // Volume analysis (today vs average)
                    let volumeRatio = null;
                    if (volumes && volumes.length >= 2) {
                        const todayVolume = volumes[volumes.length - 1];
                        const avgVolume = volumes.slice(0, -1).reduce((a, b) => a + (b || 0), 0) / (volumes.length - 1);
                        if (avgVolume > 0 && todayVolume) {
                            volumeRatio = todayVolume / avgVolume;
                        }
                    }

                    resolve({
                        symbol: symbol,
                        name: meta.shortName || symbol,
                        price: currentPrice,
                        previousClose: previousClose,
                        change1d: change1d,
                        change2d: change2d,
                        change5d: change5d,
                        yesterdayChange: yesterdayChange,
                        fiftyTwoWeekLow: fiftyTwoWeekLow,
                        fiftyTwoWeekHigh: fiftyTwoWeekHigh,
                        distanceFrom52wLow: distanceFrom52wLow,
                        volumeRatio: volumeRatio
                    });
                } catch (e) {
                    reject(e);
                }
            });
        });

        req.on('error', reject);
        req.end();
    });
}

/**
 * Send alert to Slack
 */
async function sendSlackAlert(alerts) {
    return new Promise((resolve, reject) => {
        if (!SLACK_WEBHOOK_URL) {
            reject(new Error('Slack webhook URL not configured'));
            return;
        }

        const webhookUrl = new URL(SLACK_WEBHOOK_URL);
        const blocks = [];

        // Check if we have any downside alerts
        const hasDownside = alerts.rule1Stocks.length > 0 || alerts.rule2Stocks.length > 0;
        // Check if we have any upside alerts
        const hasUpside = alerts.rule3Stocks.length > 0 || alerts.rule4Stocks.length > 0 ||
                          alerts.rule5Stocks.length > 0 || alerts.rule6Stocks.length > 0;

        // DOWNSIDE ALERTS
        if (hasDownside) {
            blocks.push({
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: '📉 Stock Drop Alerts',
                    emoji: true
                }
            });

            // Rule 1: Daily drops
            if (alerts.rule1Stocks.length > 0) {
                const stockList = alerts.rule1Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} → *${stock.change1d.toFixed(2)}%*`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*1-Day Drop (>${RULE1_THRESHOLD}%)* - ${alerts.rule1Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }

            // Rule 2: 2-day drops
            if (alerts.rule2Stocks.length > 0) {
                const stockList = alerts.rule2Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} → *${stock.change2d.toFixed(2)}%* (2d)`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*2-Day Drop (>${RULE2_THRESHOLD}%)* - ${alerts.rule2Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }
        }

        // UPSIDE ALERTS
        if (hasUpside) {
            blocks.push({
                type: 'header',
                text: {
                    type: 'plain_text',
                    text: '📈 Upside Potential Alerts',
                    emoji: true
                }
            });

            // Rule 3: Recovery Signal
            if (alerts.rule3Stocks.length > 0) {
                const stockList = alerts.rule3Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} | 5d: ${stock.change5d.toFixed(2)}% | Today: *+${stock.change1d.toFixed(2)}%*`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*🔄 Recovery Signal* (5d drop >${RULE3_THRESHOLD1}%, today up >${RULE3_THRESHOLD2}%) - ${alerts.rule3Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }

            // Rule 4: Near 52-Week Low
            if (alerts.rule4Stocks.length > 0) {
                const stockList = alerts.rule4Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} | 52w Low: $${stock.fiftyTwoWeekLow.toFixed(2)} (*+${stock.distanceFrom52wLow.toFixed(2)}%* from low)`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*📍 Near 52-Week Low* (within ${RULE4_THRESHOLD}%) - ${alerts.rule4Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }

            // Rule 5: Bounce Back
            if (alerts.rule5Stocks.length > 0) {
                const stockList = alerts.rule5Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} | Yesterday: ${stock.yesterdayChange.toFixed(2)}% | Today: *+${stock.change1d.toFixed(2)}%*`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*↩️ Bounce Back* (yesterday drop >${RULE5_THRESHOLD1}%, today up >${RULE5_THRESHOLD2}%) - ${alerts.rule5Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }

            // Rule 6: High Volume Surge
            if (alerts.rule6Stocks.length > 0) {
                const stockList = alerts.rule6Stocks.map(stock =>
                    `• *${stock.symbol}*: $${stock.price.toFixed(2)} | Today: *+${stock.change1d.toFixed(2)}%* | Volume: *${stock.volumeRatio.toFixed(1)}x* avg`
                ).join('\n');

                blocks.push(
                    { type: 'divider' },
                    {
                        type: 'section',
                        text: {
                            type: 'mrkdwn',
                            text: `*🔥 High Volume Surge* (up >${RULE6_THRESHOLD1}%, volume >${RULE6_THRESHOLD2}x avg) - ${alerts.rule6Stocks.length} stock(s):\n${stockList}`
                        }
                    }
                );
            }
        }

        blocks.push(
            { type: 'divider' },
            {
                type: 'context',
                elements: [
                    {
                        type: 'mrkdwn',
                        text: `🕙 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST`
                    }
                ]
            }
        );

        const message = { blocks };
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
    console.log('Rule 1 (1-day drop):', RULE1_ENABLED, 'threshold:', RULE1_THRESHOLD);
    console.log('Rule 2 (2-day drop):', RULE2_ENABLED, 'threshold:', RULE2_THRESHOLD);
    console.log('Rule 3 (recovery):', RULE3_ENABLED, 'thresholds:', RULE3_THRESHOLD1, RULE3_THRESHOLD2);
    console.log('Rule 4 (52w low):', RULE4_ENABLED, 'threshold:', RULE4_THRESHOLD);
    console.log('Rule 5 (bounce):', RULE5_ENABLED, 'thresholds:', RULE5_THRESHOLD1, RULE5_THRESHOLD2);
    console.log('Rule 6 (volume):', RULE6_ENABLED, 'thresholds:', RULE6_THRESHOLD1, RULE6_THRESHOLD2);

    const forceRun = event.forceRun === true;
    const anyRuleEnabled = RULE1_ENABLED || RULE2_ENABLED || RULE3_ENABLED ||
                           RULE4_ENABLED || RULE5_ENABLED || RULE6_ENABLED;

    if (!anyRuleEnabled && !forceRun) {
        console.log('All rules are disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'All rules disabled' })
        };
    }

    if (forceRun) {
        console.log('Manual run triggered - bypassing enabled check');
    }

    try {
        // Fetch data for all monitored stocks with rate limiting
        console.log(`Fetching data for ${STOCKS_TO_MONITOR.length} stocks...`);

        const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
        const validStocks = [];

        // Process in batches of 15 with delays
        const batchSize = 15;
        for (let i = 0; i < STOCKS_TO_MONITOR.length; i += batchSize) {
            const batch = STOCKS_TO_MONITOR.slice(i, i + batchSize);

            const batchPromises = batch.map(symbol =>
                fetchStockData(symbol).catch(err => {
                    console.error(`Error fetching ${symbol}:`, err.message);
                    return null;
                })
            );

            const batchResults = await Promise.all(batchPromises);
            validStocks.push(...batchResults.filter(s => s !== null));

            // Add delay between batches to avoid rate limiting
            if (i + batchSize < STOCKS_TO_MONITOR.length) {
                await delay(500);
            }
        }

        console.log(`Successfully fetched ${validStocks.length} stocks`);

        // DOWNSIDE RULES
        // Rule 1: Stocks that dropped more than threshold in 1 day
        const rule1Stocks = (RULE1_ENABLED || forceRun) ? validStocks
            .filter(stock => stock.change1d <= -RULE1_THRESHOLD)
            .sort((a, b) => a.change1d - b.change1d) : [];

        // Rule 2: Stocks that dropped more than threshold in 2 days
        const rule2Stocks = (RULE2_ENABLED || forceRun) ? validStocks
            .filter(stock => stock.change2d !== null && stock.change2d <= -RULE2_THRESHOLD)
            .sort((a, b) => a.change2d - b.change2d) : [];

        // UPSIDE RULES
        // Rule 3: Recovery Signal - dropped >X% in 5 days but UP >Y% today
        const rule3Stocks = (RULE3_ENABLED || forceRun) ? validStocks
            .filter(stock =>
                stock.change5d !== null &&
                stock.change5d <= -RULE3_THRESHOLD1 &&
                stock.change1d >= RULE3_THRESHOLD2
            )
            .sort((a, b) => b.change1d - a.change1d) : [];

        // Rule 4: Near 52-Week Low - within X% of 52-week low
        const rule4Stocks = (RULE4_ENABLED || forceRun) ? validStocks
            .filter(stock =>
                stock.distanceFrom52wLow !== null &&
                stock.distanceFrom52wLow >= 0 &&
                stock.distanceFrom52wLow <= RULE4_THRESHOLD
            )
            .sort((a, b) => a.distanceFrom52wLow - b.distanceFrom52wLow) : [];

        // Rule 5: Bounce Back - dropped >X% yesterday but up >Y% today
        const rule5Stocks = (RULE5_ENABLED || forceRun) ? validStocks
            .filter(stock =>
                stock.yesterdayChange !== null &&
                stock.yesterdayChange <= -RULE5_THRESHOLD1 &&
                stock.change1d >= RULE5_THRESHOLD2
            )
            .sort((a, b) => b.change1d - a.change1d) : [];

        // Rule 6: High Volume Surge - up with volume >X times average
        const rule6Stocks = (RULE6_ENABLED || forceRun) ? validStocks
            .filter(stock =>
                stock.volumeRatio !== null &&
                stock.change1d >= RULE6_THRESHOLD1 &&
                stock.volumeRatio >= RULE6_THRESHOLD2
            )
            .sort((a, b) => b.volumeRatio - a.volumeRatio) : [];

        console.log(`Rule 1 (1d drop): Found ${rule1Stocks.length} stocks`);
        console.log(`Rule 2 (2d drop): Found ${rule2Stocks.length} stocks`);
        console.log(`Rule 3 (recovery): Found ${rule3Stocks.length} stocks`);
        console.log(`Rule 4 (52w low): Found ${rule4Stocks.length} stocks`);
        console.log(`Rule 5 (bounce): Found ${rule5Stocks.length} stocks`);
        console.log(`Rule 6 (volume): Found ${rule6Stocks.length} stocks`);

        const totalAlerts = rule1Stocks.length + rule2Stocks.length + rule3Stocks.length +
                           rule4Stocks.length + rule5Stocks.length + rule6Stocks.length;

        if (totalAlerts === 0) {
            console.log('No alerts to send.');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'No alerts to send' })
            };
        }

        // Send Slack alert
        console.log('Sending Slack alert...');
        await sendSlackAlert({
            rule1Stocks,
            rule2Stocks,
            rule3Stocks,
            rule4Stocks,
            rule5Stocks,
            rule6Stocks
        });
        console.log('Slack alert sent successfully!');

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Alert sent successfully',
                rule1Stocks: rule1Stocks.map(s => ({ symbol: s.symbol, drop: `${s.change1d.toFixed(2)}%` })),
                rule2Stocks: rule2Stocks.map(s => ({ symbol: s.symbol, drop: `${s.change2d.toFixed(2)}%` })),
                rule3Stocks: rule3Stocks.map(s => ({ symbol: s.symbol, change5d: `${s.change5d.toFixed(2)}%`, today: `+${s.change1d.toFixed(2)}%` })),
                rule4Stocks: rule4Stocks.map(s => ({ symbol: s.symbol, distance: `${s.distanceFrom52wLow.toFixed(2)}%` })),
                rule5Stocks: rule5Stocks.map(s => ({ symbol: s.symbol, yesterday: `${s.yesterdayChange.toFixed(2)}%`, today: `+${s.change1d.toFixed(2)}%` })),
                rule6Stocks: rule6Stocks.map(s => ({ symbol: s.symbol, change: `+${s.change1d.toFixed(2)}%`, volume: `${s.volumeRatio.toFixed(1)}x` }))
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
