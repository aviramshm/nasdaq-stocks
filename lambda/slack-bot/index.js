/**
 * Slack listener -> Claude.
 *
 * Slack sends events (an @mention in a channel, or a direct message) to this function's URL.
 * Slack needs an answer within 3 seconds, so the request is verified, acknowledged, and the
 * real work is handed to an async invocation of this same function ("worker"), which runs a
 * Claude tool-use loop with the stock-system tools and replies in the message's thread.
 */
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { TOOL_DEFINITIONS, runTool } = require('./tools');

const MODEL = 'claude-opus-5';
const MAX_TURNS = 12;
const lambda = new LambdaClient({});

// ---- Slack helpers -----------------------------------------------------------------------
async function slack(method, body) {
    const res = await fetch(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
    });
    const json = await res.json();
    if (!json.ok) console.warn(`Slack ${method} failed:`, json.error);
    return json;
}

/** Slack request signing: HMAC-SHA256 of "v0:{timestamp}:{raw body}" with the signing secret. */
function verifySlackSignature(headers, rawBody) {
    const secret = process.env.SLACK_SIGNING_SECRET;
    const ts = headers['x-slack-request-timestamp'];
    const sig = headers['x-slack-signature'] || '';
    if (!secret || !ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
    const a = Buffer.from(expected), b = Buffer.from(sig);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const allowedUsers = () => (process.env.ALLOWED_SLACK_USERS || '').split(',').map(s => s.trim()).filter(Boolean);

// ---- Receiver: runs on every Slack request -----------------------------------------------
async function receive(event, context) {
    const rawBody = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '');
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return { statusCode: 400, body: 'bad request' };
    }

    // Slack checks the URL when the app is created, before the signing secret is configured here.
    if (body.type === 'url_verification') {
        return { statusCode: 200, headers: { 'Content-Type': 'text/plain' }, body: body.challenge };
    }
    if (!verifySlackSignature(headers, rawBody)) {
        console.warn('Rejected request with invalid Slack signature');
        return { statusCode: 401, body: 'invalid signature' };
    }
    // Slack retries if we were slow; the first delivery is already being handled.
    if (headers['x-slack-retry-num']) return { statusCode: 200, body: 'ok' };

    const ev = body.event || {};
    const isMention = ev.type === 'app_mention';
    const isDirectMessage = ev.type === 'message' && ev.channel_type === 'im' && !ev.subtype;
    if (!(isMention || isDirectMessage) || ev.bot_id) return { statusCode: 200, body: 'ignored' };

    const allowed = allowedUsers();
    if (allowed.length && !allowed.includes(ev.user)) {
        console.warn(`Ignoring message from non-allowed user ${ev.user}`);
        await slack('chat.postMessage', { channel: ev.channel, thread_ts: ev.thread_ts || ev.ts, text: 'Sorry, I only answer my owner.' });
        return { statusCode: 200, body: 'not allowed' };
    }
    if (!allowed.length) console.log(`No allow-list set yet; message from Slack user ${ev.user}`);

    await lambda.send(new InvokeCommand({
        FunctionName: context.invokedFunctionArn,
        InvocationType: 'Event',
        Payload: JSON.stringify({ mode: 'work', slackEvent: ev }),
    }));
    return { statusCode: 200, body: 'ok' };
}

// ---- Worker: talks to Claude and replies ---------------------------------------------------
const stripMentions = (text) => (text || '').replace(/<@[A-Z0-9]+>/g, '').trim();

/** Earlier messages in the thread become the conversation history. */
async function threadHistory(ev) {
    if (!ev.thread_ts) return [{ role: 'user', content: stripMentions(ev.text) || '(empty message)' }];
    const replies = await slack('conversations.replies', { channel: ev.channel, ts: ev.thread_ts, limit: 40 });
    const messages = [];
    for (const m of replies.messages || []) {
        const role = m.bot_id ? 'assistant' : 'user';
        const text = stripMentions(m.text);
        if (!text) continue;
        // Merge consecutive same-role messages; the conversation must start with the user
        if (messages.length && messages.at(-1).role === role) messages.at(-1).content += `\n\n${text}`;
        else if (messages.length || role === 'user') messages.push({ role, content: text });
    }
    if (!messages.length || messages.at(-1).role !== 'user') messages.push({ role: 'user', content: stripMentions(ev.text) });
    return messages;
}

function systemPrompt() {
    const ny = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const il = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' });
    return `You are the assistant for the user's personal stock-alert system, answering in Slack. Now: ${ny} New York (${il} Israel).

How the system works:
- 9:33 AM New York, weekdays: the Gap Down scan checks ~1,628 US stocks and flags any down more than the threshold from yesterday's close.
- 10:05 AM: the Dip Screener scores flagged stocks. Filters: market cap, 20-day average dollar volume, price >= $5, and MISSED if more than half the drop is already recovered. Points (max 11): profitable/FCF+ 2, gross margin >50% 1, revenue growth >10% 1, debt < 3x EBITDA 1, above 200-day average 2, drop >= 3x normal daily move 1, cause of drop -3..+3 (sector selloff/sympathy +3, analyst/earnings sell-the-news +2, leadership/unknown 0, guidance cut -3; structural = AVOID). WATCH >= 8, MAYBE 5-7, PASS < 5. Reward/risk under 1.5 downgrades one level.
- Buy signal: price above VWAP or above the 9:30-10:00 high. Plan: stop = today's low minus half the normal daily move (min 1%); T1 = halfway back to yesterday's close (sell half); T2 = yesterday's close; size = min(max position, max loss / risk per share); sell after 10 trading days.
- WATCH/MAYBE stocks not yet triggered are re-checked every 15 minutes until 11:30 New York.

How to answer:
- Use the tools for live data: get_quote, score_stock (for "should I buy X"), get_today_activity, get_settings. A verdict with classifiedBy "keywords" was scored without Claude (cause unverified) - say so, and offer score_stock to verify it. Use web search for news and verify facts against the company's own press release when it matters; say when sources disagree.
- Be direct and concrete with numbers. For buy questions give the system's verdict, the buy-signal status and trigger level, and the plan; the decision is the user's. This is information, not personal financial advice - say so briefly, once.
- Slack formatting only: *bold*, _italic_, bullet lists with "•", <url|text> links. No Markdown headers or tables. Keep it short enough to read on a phone; end with source links when you used the web.`;
}

async function askClaude(messages) {
    const client = new Anthropic({ timeout: 240 * 1000, maxRetries: 2 });
    const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }, ...TOOL_DEFINITIONS];
    for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await client.beta.messages.create({
            model: MODEL,
            max_tokens: 16000,
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default',
            output_config: { effort: 'medium' },
            system: systemPrompt(),
            tools,
            messages,
        });
        if (response.stop_reason === 'refusal') return 'Sorry, I can\'t help with that one.';
        if (response.stop_reason === 'pause_turn') {
            messages.push({ role: 'assistant', content: response.content });
            continue;
        }
        if (response.stop_reason !== 'tool_use') {
            return response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim() || '(no answer)';
        }
        messages.push({ role: 'assistant', content: response.content });
        const results = await Promise.all(response.content.filter(b => b.type === 'tool_use').map(async (b) => {
            try {
                const out = await runTool(b.name, b.input);
                return { type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) };
            } catch (error) {
                console.warn(`Tool ${b.name} failed:`, error.message);
                return { type: 'tool_result', tool_use_id: b.id, content: `Error: ${error.message}`, is_error: true };
            }
        }));
        messages.push({ role: 'user', content: results });
    }
    return 'I ran out of steps on that one — try a narrower question.';
}

async function work({ slackEvent: ev }) {
    const threadTs = ev.thread_ts || ev.ts;
    await slack('reactions.add', { channel: ev.channel, timestamp: ev.ts, name: 'eyes' });
    let text;
    try {
        text = await askClaude(await threadHistory(ev));
    } catch (error) {
        console.error('Claude failed:', error);
        text = error instanceof Anthropic.APIError && /credit balance/i.test(error.message)
            ? '⚠️ My Anthropic credit has run out — top up at https://platform.claude.com/settings/billing'
            : `⚠️ Something went wrong: ${error.message}`;
    }
    // Long answers are split on line breaks into Slack-sized messages
    const chunks = [];
    for (const line of text.split('\n')) {
        if (chunks.length && (chunks.at(-1) + '\n' + line).length <= 3500) chunks[chunks.length - 1] += '\n' + line;
        else chunks.push(line.slice(0, 3500));
    }
    for (const chunk of chunks) {
        await slack('chat.postMessage', { channel: ev.channel, thread_ts: threadTs, text: chunk, unfurl_links: false });
    }
    await slack('reactions.remove', { channel: ev.channel, timestamp: ev.ts, name: 'eyes' });
}

exports.handler = async (event, context) => {
    if (event.mode === 'work') return work(event);
    return receive(event, context);
};

exports._internals = { verifySlackSignature, stripMentions, threadHistory, askClaude }; // for tests
