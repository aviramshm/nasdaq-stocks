const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { verifySlackSignature, stripMentions } = require('./index')._internals;

test('accepts a correctly signed Slack request and rejects tampering / old timestamps', () => {
    process.env.SLACK_SIGNING_SECRET = 'test-secret';
    const body = '{"type":"event_callback"}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'v0=' + crypto.createHmac('sha256', 'test-secret').update(`v0:${ts}:${body}`).digest('hex');
    assert.ok(verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body));
    assert.ok(!verifySlackSignature({ 'x-slack-request-timestamp': ts, 'x-slack-signature': sig }, body + 'x'));
    const old = String(Math.floor(Date.now() / 1000) - 600);
    const oldSig = 'v0=' + crypto.createHmac('sha256', 'test-secret').update(`v0:${old}:${body}`).digest('hex');
    assert.ok(!verifySlackSignature({ 'x-slack-request-timestamp': old, 'x-slack-signature': oldSig }, body));
});

test('strips @mentions from the question', () => {
    assert.strictEqual(stripMentions('<@U123ABC> should I buy FCFS?'), 'should I buy FCFS?');
});
