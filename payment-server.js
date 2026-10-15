// Stripe Checkout backend for AZ Contractor Pro
// Creates the checkout for the order form, fulfills paid orders from Stripe webhooks
// (bolt.new template email + admin notification) and reports every order to the CRM.

'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Prices live here, never in the browser: the order form only sends which package.
const PACKAGES = {
    website: { name: 'Professional Website', price: 250 },
    social: { name: 'Social Media Setup', price: 120 },
    complete: { name: 'Complete Package (Website + Social Media)', price: 370 }
};

const TRADES = ['masonry', 'plumbing', 'electrical', 'hvac', 'roofing', 'landscaping',
    'painting', 'carpentry', 'flooring', 'general', 'other'];

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function configFromEnv(env = process.env) {
    const port = parseInt(env.PORT, 10) || 3000;
    return {
        port,
        baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/+$/, ''),
        stripeSecretKey: env.STRIPE_SECRET_KEY || '',
        stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
        allowedOrigins: (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
        smtp: {
            host: env.SMTP_HOST || 'smtp.gmail.com',
            port: parseInt(env.SMTP_PORT, 10) || 587,
            user: env.SMTP_USER || '',
            pass: env.SMTP_PASS || ''
        },
        smtpFrom: env.SMTP_FROM || 'info@azcontractorpro.com',
        adminEmail: env.ADMIN_EMAIL || 'admin@azcontractorpro.com',
        crmUrl: (env.CRM_URL || '').replace(/\/+$/, ''),
        crmKey: env.CRM_KEY || ''
    };
}

// ---------------------------------------------------------------- order validation

const FIELD_LIMITS = { businessName: 120, contactName: 80, email: 254, phone: 30, tradeType: 20, serviceArea: 200 };

/** Returns { order } or { error }. Values are trimmed and capped (Stripe metadata allows 500 chars). */
function validateOrder(body = {}) {
    const order = {};
    for (const [field, max] of Object.entries(FIELD_LIMITS)) {
        order[field] = String(body[field] ?? '').trim().slice(0, max);
        if (!order[field]) return { error: `${field} is required` };
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email)) return { error: 'Please enter a valid email address' };
    if (!TRADES.includes(order.tradeType)) return { error: 'Please choose your trade' };
    order.packageType = String(body.packageType || '');
    if (!PACKAGES[order.packageType]) return { error: 'Please choose a package' };
    return { order };
}

function orderFromSession(session) {
    const m = session.metadata || {};
    return {
        orderId: m.orderId || session.client_reference_id,
        businessName: m.businessName,
        contactName: m.contactName,
        email: m.email || session.customer_details?.email || session.customer_email,
        phone: m.phone,
        tradeType: m.tradeType,
        serviceArea: m.serviceArea,
        packageType: m.packageType,
        amount: (session.amount_total ?? 0) / 100
    };
}

// ---------------------------------------------------------------- bolt.new template

// Generate bolt.new template based on trade type
function generateBoltTemplate(orderDetails) {
    const { businessName, tradeType, serviceArea } = orderDetails;

    return `Create a professional contractor website for ${businessName}, a ${tradeType} contractor serving ${serviceArea}.

Requirements:
1. Modern, mobile-responsive design
2. Professional hero section with business name and strong call-to-action
3. Services section highlighting key ${tradeType} services
4. About section emphasizing experience and quality
5. Photo gallery section (placeholder images for now)
6. Contact section with form, phone, and email
7. Google Maps integration
8. Testimonials section
9. Arizona contractor license information section
10. Footer with business information

Design style:
- Clean, professional layout
- Use construction/contractor-appropriate color scheme
- Bold, easy-to-read typography
- High-contrast call-to-action buttons
- Trust indicators (years of experience, licensed, insured)

Colors suggestion based on trade:
${getTradeColors(tradeType)}

Key sections to include:
${getTradeServices(tradeType)}

Call-to-action buttons:
- "Get Free Estimate"
- "Call Now: [PHONE]"
- "Request Quote"
- "View Our Work"

Make it conversion-focused with multiple contact points throughout the page.`;
}

// Get color scheme based on trade type
function getTradeColors(tradeType) {
    const colorSchemes = {
        masonry: '- Primary: #d84315 (brick red)\n- Secondary: #5d4037 (brown)\n- Accent: #ff6f00 (orange)',
        plumbing: '- Primary: #1976d2 (blue)\n- Secondary: #0277bd (dark blue)\n- Accent: #00acc1 (cyan)',
        electrical: '- Primary: #ffd600 (yellow)\n- Secondary: #212121 (dark gray)\n- Accent: #ff6f00 (orange)',
        hvac: '- Primary: #1976d2 (cool blue)\n- Secondary: #d32f2f (warm red)\n- Accent: #43a047 (green)',
        roofing: '- Primary: #424242 (charcoal)\n- Secondary: #d32f2f (red)\n- Accent: #757575 (gray)',
        landscaping: '- Primary: #2e7d32 (green)\n- Secondary: #795548 (brown)\n- Accent: #8bc34a (light green)',
        painting: '- Primary: #7b1fa2 (purple)\n- Secondary: #f57c00 (orange)\n- Accent: #0288d1 (blue)',
        carpentry: '- Primary: #5d4037 (wood brown)\n- Secondary: #ff6f00 (orange)\n- Accent: #424242 (charcoal)',
        flooring: '- Primary: #6d4c41 (wood)\n- Secondary: #455a64 (slate)\n- Accent: #ff6f00 (orange)',
        general: '- Primary: #1976d2 (professional blue)\n- Secondary: #f57c00 (construction orange)\n- Accent: #424242 (charcoal)'
    };

    return colorSchemes[tradeType] || colorSchemes.general;
}

// Get services based on trade type
function getTradeServices(tradeType) {
    const services = {
        masonry: '- Block wall construction and repair\n- Stucco installation and repair\n- Stone veneer and natural stone work\n- Brick work and restoration\n- Retaining walls\n- Outdoor living spaces',
        plumbing: '- Residential plumbing repairs\n- Water heater installation\n- Leak detection and repair\n- Drain cleaning\n- Fixture installation\n- Emergency plumbing services',
        electrical: '- Electrical repairs and troubleshooting\n- Panel upgrades\n- Lighting installation\n- Outlet and switch installation\n- Ceiling fan installation\n- Safety inspections',
        hvac: '- AC installation and replacement\n- Heating system repair\n- Preventive maintenance\n- Emergency HVAC services\n- Duct cleaning\n- Thermostat installation',
        roofing: '- Roof replacement\n- Roof repairs\n- Shingle installation\n- Tile roofing\n- Flat roof systems\n- Storm damage repair',
        landscaping: '- Landscape design\n- Irrigation installation\n- Tree and shrub planting\n- Hardscaping\n- Lawn maintenance\n- Outdoor lighting',
        painting: '- Interior painting\n- Exterior painting\n- Cabinet refinishing\n- Drywall repair\n- Staining and sealing\n- Commercial painting',
        carpentry: '- Custom cabinetry\n- Deck construction\n- Door and window installation\n- Trim work\n- Framing\n- Custom woodwork',
        flooring: '- Hardwood floor installation\n- Tile installation\n- Laminate flooring\n- Vinyl plank\n- Floor refinishing\n- Carpet installation',
        general: '- Residential remodeling\n- Kitchen and bath renovation\n- Room additions\n- Home repairs\n- New construction\n- Project management'
    };

    return services[tradeType] || services.general;
}

// ---------------------------------------------------------------- emails

function customerEmailHtml(orderDetails) {
    const template = generateBoltTemplate(orderDetails);
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #d84315; color: white; padding: 20px; text-align: center; }
        .content { background: #f5f5f5; padding: 30px; }
        .template-box { background: white; padding: 20px; border-left: 4px solid #1976d2; margin: 20px 0; }
        .button { display: inline-block; background: #1976d2; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; margin: 10px 0; }
        .footer { text-align: center; padding: 20px; color: #757575; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Welcome to AZ Contractor Pro!</h1>
        </div>
        <div class="content">
            <h2>Thank You for Your Order, ${esc(orderDetails.contactName)}!</h2>
            <p>We've received your payment and are excited to build your professional contractor website.</p>

            <h3>Order Details:</h3>
            <ul>
                <li><strong>Order ID:</strong> ${esc(orderDetails.orderId)}</li>
                <li><strong>Business:</strong> ${esc(orderDetails.businessName)}</li>
                <li><strong>Package:</strong> ${esc(PACKAGES[orderDetails.packageType]?.name || orderDetails.packageType)}</li>
                <li><strong>Trade:</strong> ${esc(orderDetails.tradeType)}</li>
                <li><strong>Service Area:</strong> ${esc(orderDetails.serviceArea)}</li>
            </ul>

            <h3>🚀 Your Website Template</h3>
            <p>Below is your custom bolt.new template. You can use this to preview and customize your website:</p>

            <div class="template-box">
                <pre style="white-space: pre-wrap; font-size: 13px;">${esc(template)}</pre>
            </div>

            <a href="https://bolt.new" class="button" target="_blank">Open bolt.new</a>

            <h3>Next Steps:</h3>
            <ol>
                <li><strong>Copy the template above</strong> - This is your custom website prompt</li>
                <li><strong>Visit bolt.new</strong> - Click the button above to open bolt.new</li>
                <li><strong>Paste the template</strong> - Paste your template into bolt.new</li>
                <li><strong>We'll customize it</strong> - Our team will finalize your website within 3-5 business days</li>
                <li><strong>Go live!</strong> - We'll deploy your website and send you the final link</li>
            </ol>

            <h3>What Happens Next?</h3>
            <p>Our team is already working on your website. We'll reach out within 24 hours to:</p>
            <ul>
                <li>Gather any additional information we need</li>
                <li>Collect your photos and logo (if available)</li>
                <li>Confirm your contact information and service details</li>
                <li>Set up your domain (if needed)</li>
            </ul>

            <p><strong>Timeline:</strong> Your website will be completed and live within 3-5 business days.</p>

            <p>If you have any questions, reply to this email or call us.</p>

            <p>Thank you for choosing AZ Contractor Pro!</p>
        </div>
        <div class="footer">
            <p>AZ Contractor Pro<br>
            Professional Websites for Arizona Contractors<br>
            info@azcontractorpro.com</p>
        </div>
    </div>
</body>
</html>
    `;
}

function adminEmailHtml(orderDetails) {
    return `
<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #1976d2; color: white; padding: 20px; }
        .content { background: #f5f5f5; padding: 30px; }
        .info-box { background: white; padding: 15px; margin: 10px 0; border-left: 4px solid #d84315; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>New Order Received!</h1>
        </div>
        <div class="content">
            <h2>Order Details</h2>
            <div class="info-box">
                <p><strong>Order ID:</strong> ${esc(orderDetails.orderId)}</p>
                <p><strong>Business Name:</strong> ${esc(orderDetails.businessName)}</p>
                <p><strong>Contact Name:</strong> ${esc(orderDetails.contactName)}</p>
                <p><strong>Email:</strong> ${esc(orderDetails.email)}</p>
                <p><strong>Phone:</strong> ${esc(orderDetails.phone)}</p>
                <p><strong>Trade Type:</strong> ${esc(orderDetails.tradeType)}</p>
                <p><strong>Service Area:</strong> ${esc(orderDetails.serviceArea)}</p>
                <p><strong>Package:</strong> ${esc(orderDetails.packageType)} ($${esc(orderDetails.amount)})</p>
            </div>
            <p><strong>Action Required:</strong> Begin website development for this customer within 24 hours.</p>
        </div>
    </div>
</body>
</html>
    `;
}

function successPageHtml({ orderId, businessName }) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Payment Successful - AZ Contractor Pro</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1976d2 0%, #0d47a1 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .success-container {
            background: white;
            padding: 3rem;
            border-radius: 10px;
            box-shadow: 0 10px 40px rgba(0,0,0,0.2);
            max-width: 600px;
            text-align: center;
        }
        .checkmark {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            display: block;
            margin: 0 auto 2rem;
            background: #4caf50;
            color: white;
            font-size: 3rem;
            line-height: 80px;
        }
        h1 { color: #4caf50; margin-bottom: 1rem; }
        h2 { color: #333; margin-bottom: 1rem; }
        p { color: #666; line-height: 1.6; margin-bottom: 1rem; }
        .order-id {
            background: #f5f5f5;
            padding: 1rem;
            border-radius: 5px;
            margin: 1.5rem 0;
            font-family: monospace;
        }
        .next-steps {
            text-align: left;
            margin: 2rem 0;
            padding: 1.5rem;
            background: #f5f5f5;
            border-radius: 5px;
        }
        .next-steps h3 { margin-bottom: 1rem; color: #333; }
        .next-steps ol { margin-left: 1.5rem; }
        .next-steps li { margin-bottom: 0.8rem; }
        .button {
            display: inline-block;
            background: #1976d2;
            color: white;
            padding: 1rem 2rem;
            text-decoration: none;
            border-radius: 5px;
            margin-top: 1rem;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="success-container">
        <div class="checkmark">✓</div>
        <h1>Payment Successful!</h1>
        <h2>Thank You${businessName ? `, ${esc(businessName)}` : ''}</h2>
        <p>Your payment has been processed successfully.</p>
        ${orderId ? `<div class="order-id"><strong>Order ID:</strong> ${esc(orderId)}</div>` : ''}
        <div class="next-steps">
            <h3>What Happens Next?</h3>
            <ol>
                <li><strong>Check your email</strong> - You'll receive your custom bolt.new template within minutes</li>
                <li><strong>We'll contact you</strong> - Our team will reach out within 24 hours</li>
                <li><strong>Website development</strong> - We'll build your site in 3-5 business days</li>
                <li><strong>Go live!</strong> - Your website will be deployed and ready to get customers</li>
            </ol>
        </div>
        <p><strong>Important:</strong> Save your Order ID for reference.</p>
        <p>If you don't receive your email within 10 minutes, please check your spam folder or contact us.</p>
        <a href="/" class="button">Return to Homepage</a>
    </div>
</body>
</html>
    `;
}

// ---------------------------------------------------------------- app

/**
 * deps (all injectable for tests):
 *   stripe     Stripe client (checkout.sessions.create/retrieve, webhooks.constructEvent)
 *   mailer     nodemailer-like { sendMail }, or null to skip emails
 *   fetchImpl  used to report orders to the CRM
 */
function createApp({ config, stripe, mailer, fetchImpl = fetch, log = console }) {
    const app = express();
    app.disable('x-powered-by');

    // Fulfillment is idempotent within a process: Stripe retries webhooks and can deliver
    // checkout.session.completed more than once. In-flight promises also stop concurrent duplicates.
    const fulfilled = new Map();

    async function reportToCrm(payload) {
        if (!config.crmUrl || !config.crmKey) return;
        try {
            const res = await fetchImpl(`${config.crmUrl}/api/integrations/orders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'x-builder-key': config.crmKey },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(8000)
            });
            if (!res.ok) throw new Error(`CRM returned ${res.status}`);
        } catch (err) {
            log.error(`CRM order sync failed for ${payload.orderId}: ${err.message}`);
        }
    }

    async function sendEmails(orderDetails) {
        if (!mailer) {
            log.warn(`SMTP is not configured; skipped emails for order ${orderDetails.orderId}`);
            return;
        }
        await mailer.sendMail({
            from: config.smtpFrom,
            to: orderDetails.email,
            subject: `Your ${orderDetails.businessName} Website Template - AZ Contractor Pro`,
            html: customerEmailHtml(orderDetails)
        });
        log.log(`Bolt.new template sent to ${orderDetails.email}`);
        await mailer.sendMail({
            from: config.smtpFrom,
            to: config.adminEmail,
            subject: `New Order: ${orderDetails.businessName} - ${orderDetails.packageType}`,
            html: adminEmailHtml(orderDetails)
        });
    }

    function fulfill(session) {
        if (!fulfilled.has(session.id)) {
            const job = (async () => {
                const orderDetails = orderFromSession(session);
                await sendEmails(orderDetails);
                await reportToCrm({
                    ...orderDetails, status: 'paid',
                    paymentId: session.payment_intent || null, checkoutSessionId: session.id
                });
            })();
            fulfilled.set(session.id, job);
            // A failed attempt is forgotten so Stripe's retry can run it again
            job.catch(() => fulfilled.delete(session.id));
        }
        return fulfilled.get(session.id);
    }

    // Stripe webhook: needs the raw body for signature checks, so it is registered before express.json()
    app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
        if (!config.stripeWebhookSecret) {
            log.error('STRIPE_WEBHOOK_SECRET is not set; rejecting webhook');
            return res.status(503).send('Webhook not configured');
        }
        let event;
        try {
            event = stripe.webhooks.constructEvent(req.body, req.get('stripe-signature'), config.stripeWebhookSecret);
        } catch (err) {
            log.warn(`Webhook signature verification failed: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        const session = event.data.object;
        try {
            switch (event.type) {
                case 'checkout.session.completed':
                    // Cards are paid by now; delayed methods (e.g. ACH) arrive later as async_payment_succeeded
                    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
                        await fulfill(session);
                    } else {
                        await reportToCrm({ ...orderFromSession(session), status: 'pending', checkoutSessionId: session.id });
                    }
                    break;
                case 'checkout.session.async_payment_succeeded':
                    await fulfill(session);
                    break;
                case 'checkout.session.async_payment_failed':
                case 'checkout.session.expired':
                    await reportToCrm({ ...orderFromSession(session), status: 'canceled', checkoutSessionId: session.id });
                    break;
                default:
                    break;
            }
        } catch (err) {
            log.error(`Webhook ${event.type} for ${session?.id} failed: ${err.message}`);
            // 5xx makes Stripe retry the event later
            return res.status(500).json({ error: 'Fulfillment failed; Stripe will retry' });
        }
        res.json({ received: true });
    });

    app.use(express.json({ limit: '20kb' }));

    // Create Stripe Checkout Session for the order form
    const corsOptions = { origin: config.allowedOrigins.length ? config.allowedOrigins : true };
    app.options('/api/create-checkout-session', cors(corsOptions));
    app.post('/api/create-checkout-session', cors(corsOptions), async (req, res) => {
        const { order, error } = validateOrder(req.body);
        if (error) return res.status(400).json({ success: false, error });

        const pkg = PACKAGES[order.packageType];
        const orderId = `ACP-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
        const metadata = { orderId, ...order };

        try {
            const session = await stripe.checkout.sessions.create({
                mode: 'payment',
                line_items: [{
                    quantity: 1,
                    price_data: { currency: 'usd', unit_amount: pkg.price * 100, product_data: { name: pkg.name } }
                }],
                customer_email: order.email,
                client_reference_id: orderId,
                metadata,
                payment_intent_data: { metadata, description: `${pkg.name} - ${order.businessName}` },
                success_url: `${config.baseUrl}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                cancel_url: `${config.baseUrl}/?canceled=1#order`
            }, { idempotencyKey: orderId });

            reportToCrm({ ...metadata, amount: pkg.price, status: 'pending', checkoutSessionId: session.id });
            res.json({ success: true, checkoutUrl: session.url, orderId });
        } catch (err) {
            log.error('Stripe checkout error:', err.message);
            res.status(502).json({ success: false, error: 'Could not start checkout. Please try again or contact us.' });
        }
    });

    // Payment success page (display only; fulfillment happens in the webhook)
    app.get('/payment-success', async (req, res) => {
        const sessionId = String(req.query.session_id || '');
        let details = {};
        if (/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
            try {
                const session = await stripe.checkout.sessions.retrieve(sessionId);
                details = { orderId: session.metadata?.orderId, businessName: session.metadata?.businessName };
            } catch (err) {
                log.warn(`Could not load checkout session ${sessionId}: ${err.message}`);
            }
        }
        res.send(successPageHtml(details));
    });

    // The marketing site and order form
    app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'az-contractor-pro.html')));

    // Health check
    app.get('/health', (req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    return app;
}

if (require.main === module) {
    const config = configFromEnv();
    if (!config.stripeSecretKey) {
        console.error('STRIPE_SECRET_KEY is not set. Copy .env.example to .env and add your Stripe keys.');
        process.exit(1);
    }
    const mailer = config.smtp.user
        ? nodemailer.createTransport({
            host: config.smtp.host,
            port: config.smtp.port,
            secure: config.smtp.port === 465,
            auth: { user: config.smtp.user, pass: config.smtp.pass }
        })
        : null;
    const app = createApp({ config, stripe: new Stripe(config.stripeSecretKey), mailer });
    app.listen(config.port, () => {
        console.log(`Server running on port ${config.port}`);
        console.log(`Stripe mode: ${config.stripeSecretKey.startsWith('sk_live_') ? 'LIVE' : 'test'}`);
        if (!config.crmUrl) console.log('CRM_URL not set: orders will not be reported to the CRM');
    });
}

module.exports = { createApp, configFromEnv, validateOrder, orderFromSession, generateBoltTemplate, PACKAGES };
