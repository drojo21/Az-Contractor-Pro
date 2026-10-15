'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Stripe = require('stripe');
const { createApp, configFromEnv } = require('../payment-server');

const WEBHOOK_SECRET = 'whsec_test_secret';
const realStripe = new Stripe('sk_test_dummy');
const silent = { log() {}, warn() {}, error() {} };

const ORDER = {
    businessName: "Luis Rojo's Masonry", contactName: 'Luis Rojo', email: 'luis@example.com',
    phone: '520-481-7579', tradeType: 'masonry', serviceArea: 'Tucson, Marana', packageType: 'complete'
};

function fakeStripe() {
    const created = [];
    return {
        created,
        // Real signature checking; only the network calls are faked
        webhooks: realStripe.webhooks,
        checkout: {
            sessions: {
                async create(params, options) {
                    created.push({ params, options });
                    return { id: 'cs_test_123', url: 'https://checkout.stripe.com/c/pay/cs_test_123' };
                },
                async retrieve(id) {
                    return { id, metadata: { orderId: 'ACP-1-abc', businessName: '<script>alert(1)</script>' } };
                }
            }
        }
    };
}

async function start({ crm = true } = {}) {
    const sent = [];
    const crmCalls = [];
    const stripe = fakeStripe();
    const config = {
        ...configFromEnv({}),
        baseUrl: 'https://azcontractorpro.test',
        stripeWebhookSecret: WEBHOOK_SECRET,
        crmUrl: crm ? 'https://crm.test' : '',
        crmKey: crm ? 'acp_key' : ''
    };
    const app = createApp({
        config, stripe, log: silent,
        mailer: { sendMail: async m => { sent.push(m); return { messageId: 'm' }; } },
        fetchImpl: async (url, init) => { crmCalls.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status: 201 }); }
    });
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    return { base, sent, crmCalls, stripe, close: () => new Promise(r => server.close(r)) };
}

function webhook(base, event, { secret = WEBHOOK_SECRET } = {}) {
    const payload = JSON.stringify(event);
    const header = realStripe.webhooks.generateTestHeaderString({ payload, secret });
    return fetch(`${base}/api/stripe-webhook`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload
    });
}

const sessionEvent = (type, overrides = {}) => ({
    id: `evt_${Math.random().toString(36).slice(2)}`, type,
    data: {
        object: {
            id: 'cs_test_123', object: 'checkout.session', payment_status: 'paid', amount_total: 37000,
            payment_intent: 'pi_123', client_reference_id: 'ACP-1-abc',
            metadata: { orderId: 'ACP-1-abc', ...ORDER }, ...overrides
        }
    }
});

const flush = () => new Promise(r => setTimeout(r, 20));

test('checkout: price comes from the package on the server, not the browser', async () => {
    const t = await start();
    try {
        const res = await fetch(`${t.base}/api/create-checkout-session`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ...ORDER, amount: 1 })
        });
        const body = await res.json();
        assert.equal(res.status, 200, JSON.stringify(body));
        assert.equal(body.checkoutUrl, 'https://checkout.stripe.com/c/pay/cs_test_123');
        assert.match(body.orderId, /^ACP-\d+-[0-9a-f]{8}$/);

        const { params, options } = t.stripe.created[0];
        assert.equal(params.mode, 'payment');
        assert.equal(params.line_items[0].price_data.unit_amount, 37000);
        assert.equal(params.line_items[0].price_data.currency, 'usd');
        assert.equal(params.customer_email, 'luis@example.com');
        assert.equal(params.metadata.businessName, "Luis Rojo's Masonry");
        assert.equal(params.metadata.orderId, body.orderId);
        assert.equal(params.success_url, 'https://azcontractorpro.test/payment-success?session_id={CHECKOUT_SESSION_ID}');
        assert.equal(options.idempotencyKey, body.orderId);

        await flush();
        assert.equal(t.crmCalls.length, 1);
        assert.equal(t.crmCalls[0].url, 'https://crm.test/api/integrations/orders');
        assert.equal(t.crmCalls[0].init.headers['x-builder-key'], 'acp_key');
        assert.equal(t.crmCalls[0].body.status, 'pending');
        assert.equal(t.crmCalls[0].body.amount, 370);
    } finally {
        await t.close();
    }
});

test('checkout: rejects bad input before calling Stripe', async () => {
    const t = await start();
    try {
        for (const bad of [{ ...ORDER, packageType: 'free' }, { ...ORDER, email: 'nope' }, { ...ORDER, tradeType: 'x' }, { ...ORDER, businessName: '' }]) {
            const res = await fetch(`${t.base}/api/create-checkout-session`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad)
            });
            assert.equal(res.status, 400);
        }
        assert.equal(t.stripe.created.length, 0);
    } finally {
        await t.close();
    }
});

test('webhook: rejects a bad signature', async () => {
    const t = await start();
    try {
        const res = await webhook(t.base, sessionEvent('checkout.session.completed'), { secret: 'whsec_wrong' });
        assert.equal(res.status, 400);
        assert.equal(t.sent.length, 0);
    } finally {
        await t.close();
    }
});

test('webhook: paid checkout sends both emails and reports the payment to the CRM, once', async () => {
    const t = await start();
    try {
        const res = await webhook(t.base, sessionEvent('checkout.session.completed'));
        assert.equal(res.status, 200);
        assert.equal(t.sent.length, 2);
        assert.equal(t.sent[0].to, 'luis@example.com');
        assert.match(t.sent[0].html, /bolt\.new/);
        assert.match(t.sent[0].html, /Luis Rojo&#39;s Masonry/);
        assert.equal(t.sent[1].to, 'admin@azcontractorpro.com');
        const crm = t.crmCalls.at(-1).body;
        assert.equal(crm.status, 'paid');
        assert.equal(crm.paymentId, 'pi_123');
        assert.equal(crm.checkoutSessionId, 'cs_test_123');
        assert.equal(crm.orderId, 'ACP-1-abc');
        assert.equal(crm.amount, 370);

        // Stripe retries / duplicate delivery: no second round of emails
        await webhook(t.base, sessionEvent('checkout.session.completed'));
        assert.equal(t.sent.length, 2);
    } finally {
        await t.close();
    }
});

test('webhook: delayed payment methods wait for async_payment_succeeded', async () => {
    const t = await start();
    try {
        await webhook(t.base, sessionEvent('checkout.session.completed', { payment_status: 'unpaid' }));
        assert.equal(t.sent.length, 0);
        assert.equal(t.crmCalls.at(-1).body.status, 'pending');

        await webhook(t.base, sessionEvent('checkout.session.async_payment_succeeded'));
        assert.equal(t.sent.length, 2);
        assert.equal(t.crmCalls.at(-1).body.status, 'paid');

        await webhook(t.base, sessionEvent('checkout.session.async_payment_failed', { id: 'cs_test_other', payment_status: 'unpaid' }));
        assert.equal(t.crmCalls.at(-1).body.status, 'canceled');
    } finally {
        await t.close();
    }
});

test('webhook: email failure returns 500 so Stripe retries, and the retry succeeds', async () => {
    let fail = true;
    const t = await start();
    try {
        // swap in a mailer that fails the first time
        const sent = [];
        const config = { ...configFromEnv({}), stripeWebhookSecret: WEBHOOK_SECRET };
        const app = createApp({
            config, stripe: fakeStripe(), log: silent, fetchImpl: async () => new Response('{}'),
            mailer: { sendMail: async m => { if (fail) throw new Error('SMTP down'); sent.push(m); } }
        });
        const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
        const base = `http://127.0.0.1:${server.address().port}`;
        const first = await webhook(base, sessionEvent('checkout.session.completed'));
        assert.equal(first.status, 500);
        fail = false;
        const retry = await webhook(base, sessionEvent('checkout.session.completed'));
        assert.equal(retry.status, 200);
        assert.equal(sent.length, 2);
        await new Promise(r => server.close(r));
    } finally {
        await t.close();
    }
});

test('success page escapes session data; homepage serves the order form', async () => {
    const t = await start();
    try {
        const page = await (await fetch(`${t.base}/payment-success?session_id=cs_test_123`)).text();
        assert.match(page, /ACP-1-abc/);
        assert.equal(page.includes('<script>alert(1)</script>'), false);
        assert.ok(page.includes('&lt;script&gt;'));

        const injected = await (await fetch(`${t.base}/payment-success?session_id=<img src=x>`)).text();
        assert.equal(injected.includes('<img src=x>'), false);

        const home = await fetch(`${t.base}/`);
        assert.equal(home.status, 200);
        assert.match(await home.text(), /create-checkout-session/);
    } finally {
        await t.close();
    }
});

test('orders are not reported when the CRM is not configured', async () => {
    const t = await start({ crm: false });
    try {
        await webhook(t.base, sessionEvent('checkout.session.completed'));
        assert.equal(t.sent.length, 2);
        assert.equal(t.crmCalls.length, 0);
    } finally {
        await t.close();
    }
});
