/**
 * Minimal Yahoo Finance client for the dip screener.
 * Chart and search endpoints work anonymously; quoteSummary needs a cookie + crumb.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const BASE = 'https://query1.finance.yahoo.com';

const TIMEOUT_MS = 10000; // a hung request must not stall the whole run

let session = null;

/** Call at the start of each run: warm Lambda containers keep module state between runs. */
function resetSession() {
    session = null;
}

async function getJson(url, headers = {}) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Yahoo ${res.status} for ${url.split('?')[0]}`);
    return res.json();
}

async function getSession() {
    if (session) return session;
    const r = await fetch('https://fc.yahoo.com', {
        headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const cookie = (r.headers.getSetCookie?.() || []).map(c => c.split(';')[0]).join('; ');
    const crumbRes = await fetch(`${BASE}/v1/test/getcrumb`, {
        headers: { 'User-Agent': UA, Cookie: cookie }, signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const crumb = await crumbRes.text();
    if (!crumbRes.ok || !crumb || crumb.includes('<')) throw new Error('Could not get Yahoo crumb');
    session = { cookie, crumb };
    return session;
}

const yahooSymbol = (s) => s.replace('.', '-'); // BRK.B -> BRK-B

/** Daily or intraday bars: [{t, open, high, low, close, volume}] plus meta. */
async function chart(symbol, range, interval) {
    const json = await getJson(`${BASE}/v8/finance/chart/${yahooSymbol(symbol)}?range=${range}&interval=${interval}`);
    const result = json.chart?.result?.[0];
    if (!result) throw new Error(`No chart data for ${symbol}`);
    const q = result.indicators.quote[0];
    const bars = (result.timestamp || []).map((t, i) => ({
        t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i]
    })).filter(b => b.close != null);
    return { meta: result.meta, bars };
}

async function quoteSummary(symbol, retried = false) {
    const { cookie, crumb } = await getSession();
    const modules = 'price,summaryProfile,financialData,calendarEvents';
    try {
        const json = await getJson(
            `${BASE}/v10/finance/quoteSummary/${yahooSymbol(symbol)}?modules=${modules}&crumb=${encodeURIComponent(crumb)}`,
            { Cookie: cookie }
        );
        return json.quoteSummary?.result?.[0] || {};
    } catch (error) {
        // Expired/rejected crumb: get a fresh session once and retry
        if (!retried && /Yahoo 40[13]/.test(error.message)) {
            resetSession();
            return quoteSummary(symbol, true);
        }
        throw error;
    }
}

/** Headlines from the last `hours` hours that mention the symbol. */
async function headlines(symbol, hours = 48) {
    const json = await getJson(`${BASE}/v1/finance/search?q=${yahooSymbol(symbol)}&newsCount=15&quotesCount=0`);
    const cutoff = Date.now() / 1000 - hours * 3600;
    return (json.news || [])
        .filter(n => n.providerPublishTime >= cutoff && n.title)
        .filter(n => !n.relatedTickers || n.relatedTickers.includes(yahooSymbol(symbol)))
        .map(n => n.title);
}

module.exports = { chart, quoteSummary, headlines, resetSession };
