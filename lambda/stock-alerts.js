/**
 * AWS Lambda Function: Stock Drop Alert
 *
 * Runs daily at 10:00 AM EST to check for stocks that dropped
 * more than the configured threshold and sends alerts to Slack.
 */

const https = require('https');

// Configuration - Set these as environment variables in AWS Lambda
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const DROP_THRESHOLD = parseFloat(process.env.DROP_THRESHOLD || '15');
const ALERT_ENABLED = process.env.ALERT_ENABLED === 'true';

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
 */
async function fetchStockData(symbol) {
    return new Promise((resolve, reject) => {
        // Handle special symbols like BRK.B
        const encodedSymbol = symbol.replace('.', '-');

        const options = {
            hostname: 'query1.finance.yahoo.com',
            path: `/v8/finance/chart/${encodedSymbol}?range=1d&interval=1d`,
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
        });

        req.on('error', reject);
        req.end();
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

        // Build stock list for message
        const stockList = stocks.map(stock =>
            `• *${stock.symbol}* (${stock.name}): $${stock.price.toFixed(2)} → *${stock.changePercent.toFixed(2)}%*`
        ).join('\n');

        const message = {
            blocks: [
                {
                    type: 'header',
                    text: {
                        type: 'plain_text',
                        text: `📉 Stock Drop Alert (${stocks.length} stock${stocks.length > 1 ? 's' : ''})`,
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
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: stockList
                    }
                },
                { type: 'divider' },
                {
                    type: 'context',
                    elements: [
                        {
                            type: 'mrkdwn',
                            text: `🕙 ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} EST | S&P 500 + Growth Stocks`
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

    const forceRun = event.forceRun === true;

    if (!ALERT_ENABLED && !forceRun) {
        console.log('Alerts are disabled. Exiting.');
        return {
            statusCode: 200,
            body: JSON.stringify({ message: 'Alerts disabled' })
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

        // Filter ALL stocks that dropped more than threshold
        const droppedStocks = validStocks
            .filter(stock => stock.changePercent <= -DROP_THRESHOLD)
            .sort((a, b) => a.changePercent - b.changePercent); // Sort by biggest drop

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
