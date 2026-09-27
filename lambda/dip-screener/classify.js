/**
 * Ask Claude (with web search) why a stock dropped. Returns {cause, reason, warning} or null
 * when Claude is unavailable, so the caller can fall back to keyword matching.
 */
const Anthropic = require('@anthropic-ai/sdk');
const { CAUSE_POINTS } = require('./scoring');

const MODEL = 'claude-opus-5';
const CAUSES = Object.keys(CAUSE_POINTS);

const SYSTEM = `You classify why a US-listed stock dropped sharply today, for a short-term dip-buying screener.
Use web search to find today's news about the company if the provided headlines are not conclusive.

Causes (pick exactly one):
- MACRO_OR_SECTOR: the broad market or its sector sold off; nothing company-specific.
- SYMPATHY: a competitor's or partner's bad news dragged it down; this company reported nothing new.
- ANALYST_ACTION: an analyst downgrade or price-target cut, no new company facts.
- EARNINGS_SELL_THE_NEWS: earnings just reported, results and guidance broadly fine, stock fell anyway.
- EARNINGS_GUIDANCE_CUT: earnings/pre-announcement with lowered guidance or a clear miss on the outlook.
- LEADERSHIP_CHANGE: a CEO or senior executive departure that is NOT tied to wrongdoing (planned succession, retirement, or an unexplained exit).
- STRUCTURAL_NEGATIVE: the long-term business case changed - fraud or accounting problems, SEC/DOJ action, lost major customer, share offering/dilution, short-seller report, failed product or FDA rejection, or an executive exit tied to any of these.
- UNKNOWN: you cannot determine the cause with reasonable confidence.

Set "warning" to a short note when something needs the trader's attention (e.g. an abrupt CEO exit with no reason given); otherwise an empty string.
Finish with a single JSON object and nothing after it:
{"cause": "<one of the causes>", "reason": "<one sentence citing the specific news>", "warning": "<string>"}`;

function buildPrompt(s) {
    const pct = (x) => (x == null ? 'unknown' : `${x.toFixed(1)}%`);
    return [
        `Stock: ${s.symbol} (${s.name}), sector: ${s.sector || 'unknown'}.`,
        `Today's move: ${pct(s.drop)} vs yesterday's close. Sector ETF (${s.sectorEtf || 'n/a'}): ${pct(s.sectorMove)}. S&P 500 (SPY): ${pct(s.spyMove)}.`,
        `Earnings reported in the last 2 days: ${s.earningsRecent == null ? 'unknown' : s.earningsRecent}.`,
        `Date (New York): ${s.todayET}.`,
        s.headlines.length ? `Recent headlines:\n- ${s.headlines.join('\n- ')}` : 'No recent headlines were found.',
    ].join('\n');
}

function parseResult(text) {
    const start = text.lastIndexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) return null;
    try {
        const data = JSON.parse(text.slice(start, end + 1));
        if (!CAUSES.includes(data.cause)) return null;
        return { cause: data.cause, reason: data.reason || '', warning: data.warning || '' };
    } catch {
        return null;
    }
}

async function classifyWithClaude(s) {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    const client = new Anthropic();
    const messages = [{ role: 'user', content: buildPrompt(s) }];

    try {
        let response;
        // Server-side web search can pause long turns; resume up to twice.
        for (let turn = 0; turn < 3; turn++) {
            response = await client.beta.messages.create({
                model: MODEL,
                max_tokens: 16000,
                betas: ['server-side-fallback-2026-07-01'],
                fallbacks: 'default',
                output_config: { effort: 'medium' },
                system: SYSTEM,
                tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }],
                messages,
            });
            if (response.stop_reason !== 'pause_turn') break;
            messages.push({ role: 'assistant', content: response.content });
        }

        if (response.stop_reason === 'refusal') {
            console.warn(`Claude declined to classify ${s.symbol}:`, response.stop_details?.category);
            return null;
        }
        const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
        const result = parseResult(text);
        if (!result) console.warn(`Could not parse Claude output for ${s.symbol}:`, text.slice(-300));
        return result;
    } catch (error) {
        if (error instanceof Anthropic.RateLimitError) {
            console.warn(`Claude rate limited for ${s.symbol}`);
        } else if (error instanceof Anthropic.APIError) {
            console.warn(`Claude API error ${error.status} for ${s.symbol}:`, error.message);
        } else {
            console.warn(`Claude call failed for ${s.symbol}:`, error.message);
        }
        return null;
    }
}

module.exports = { classifyWithClaude, parseResult };
