// Square Payment Integration Backend
// This Node.js/Express server handles Square payments and, once paid, posts the
// order to the site engine's deploy API so the contractor's site is built and
// published automatically.

const express = require('express');
const cors = require('cors');
const { Client, Environment } = require('square');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize Square client
const squareClient = new Client({
    accessToken: process.env.SQUARE_ACCESS_TOKEN,
    environment: process.env.SQUARE_ENVIRONMENT === 'production' 
        ? Environment.Production 
        : Environment.Sandbox
});

// Email transporter (configure with your email service)
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: process.env.SMTP_PORT || 587,
    secure: false,
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
});

// Store orders temporarily (in production, use a database)
const orders = new Map();

// Create Square Checkout
app.post('/api/create-square-checkout', async (req, res) => {
    try {
        const {
            businessName,
            contactName,
            email,
            phone,
            tradeType,
            serviceArea,
            packageType,
            amount,
            rocNumber,
            licenseClass,
            zip
        } = req.body;

        // Without an ROC number we cannot build a site that satisfies
        // A.R.S. 32-1124(B)(4), so do not take the money for one.
        if (!rocNumber || !String(rocNumber).replace(/[^0-9]/g, '')) {
            return res.status(400).json({
                success: false,
                error: 'An Arizona ROC license number is required. Arizona law requires it to be displayed on the site.'
            });
        }

        // Create unique order ID
        const orderId = `ACW-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        // Determine package name
        let packageName = '';
        switch(packageType) {
            case 'website':
                packageName = 'Professional Website';
                break;
            case 'social':
                packageName = 'Social Media Setup';
                break;
            case 'complete':
                packageName = 'Complete Package (Website + Social Media)';
                break;
        }

        // Create Square checkout
        const checkoutResponse = await squareClient.checkoutApi.createPaymentLink({
            idempotencyKey: orderId,
            order: {
                locationId: process.env.SQUARE_LOCATION_ID,
                lineItems: [
                    {
                        name: packageName,
                        quantity: '1',
                        basePriceMoney: {
                            amount: BigInt(amount * 100), // Amount in cents
                            currency: 'USD'
                        }
                    }
                ],
                metadata: {
                    orderId: orderId,
                    businessName: businessName,
                    contactName: contactName,
                    email: email,
                    phone: phone,
                    tradeType: tradeType,
                    serviceArea: serviceArea,
                    packageType: packageType,
                    rocNumber: String(rocNumber).replace(/[^0-9]/g, ''),
                    licenseClass: licenseClass || '',
                    zip: zip || ''
                }
            },
            checkoutOptions: {
                redirectUrl: `${process.env.BASE_URL}/payment-success?orderId=${orderId}`,
                askForShippingAddress: false
            },
            prePopulatedData: {
                buyerEmail: email,
                buyerPhoneNumber: phone
            }
        });

        // Store order details
        orders.set(orderId, {
            orderId,
            businessName,
            contactName,
            email,
            phone,
            tradeType,
            serviceArea,
            packageType,
            amount,
            rocNumber: String(rocNumber).replace(/[^0-9]/g, ''),
            licenseClass: licenseClass || '',
            zip: zip || '',
            status: 'pending',
            createdAt: new Date().toISOString()
        });

        res.json({
            success: true,
            checkoutUrl: checkoutResponse.result.paymentLink.url,
            orderId: orderId
        });

    } catch (error) {
        console.error('Square checkout error:', error);
        res.status(500).json({
            success: false,
            error: 'Failed to create checkout session',
            details: error.message
        });
    }
});

// Square Webhook - Payment completed
app.post('/api/square-webhook', async (req, res) => {
    try {
        const { type, data } = req.body;

        // Handle payment completed event
        if (type === 'payment.created' || type === 'payment.updated') {
            const payment = data.object.payment;
            const orderId = payment.orderId;
            const orderMetadata = payment.order?.metadata;

            if (payment.status === 'COMPLETED' && orderMetadata) {
                // Get order details from metadata
                const orderDetails = {
                    orderId: orderMetadata.orderId,
                    businessName: orderMetadata.businessName,
                    contactName: orderMetadata.contactName,
                    email: orderMetadata.email,
                    phone: orderMetadata.phone,
                    tradeType: orderMetadata.tradeType,
                    serviceArea: orderMetadata.serviceArea,
                    packageType: orderMetadata.packageType,
                    rocNumber: orderMetadata.rocNumber,
                    licenseClass: orderMetadata.licenseClass,
                    zip: orderMetadata.zip
                };

                // Update order status
                if (orders.has(orderDetails.orderId)) {
                    const order = orders.get(orderDetails.orderId);
                    order.status = 'paid';
                    order.paidAt = new Date().toISOString();
                    order.squarePaymentId = payment.id;
                }

                // Build and publish the site, then send the customer its URL.
                const published = await fulfilOrder(orderDetails);
                if (orders.has(orderDetails.orderId)) {
                    Object.assign(orders.get(orderDetails.orderId), {
                        siteUrl: published.url || null,
                        siteId: published.siteId || null,
                        fulfilledAt: new Date().toISOString(),
                        fulfilmentError: published.error || null
                    });
                }
                await sendSiteEmail(orderDetails, published);

                // Send confirmation email to admin
                await sendAdminNotification(orderDetails);
            }
        }

        res.json({ success: true });

    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ---------------------------------------------------------------------------
// Fulfilment
//
// This used to generate a bolt.new PROMPT, email it to the customer, and leave
// a human to paste it in and build the site by hand. The trade colour table
// and the per-trade service lists it carried were a third copy of data that
// also lived in builder.html and in the contractor-website-generator skill,
// and the three had already drifted apart.
//
// Now a paid order posts a ClientSpec to the site engine's deploy API, which
// builds the whole multi-page site, runs the Arizona ROC and quality checks,
// and publishes it. The customer gets a URL instead of a prompt.
//
// Env: ACP_DEPLOY_API (e.g. https://acp-api.netlify.app/api/deploy)
//      ACP_BUILDER_KEY (the same shared secret the engine expects)
// ---------------------------------------------------------------------------

/** Turn a paid order into the engine's ClientSpec shape. */
function orderToSpec(orderDetails) {
    const cities = String(orderDetails.serviceArea || '')
        .split(',').map(c => c.trim()).filter(Boolean);

    return {
        business: {
            name: orderDetails.businessName,
            owner: orderDetails.contactName,
            trade: orderDetails.tradeType,
            targetCustomer: 'both',
            tagline: 'auto'
        },
        license: {
            rocNumber: orderDetails.rocNumber,
            class: orderDetails.licenseClass || '',
            status: 'Active',
            bonded: true,
            insured: true
        },
        contact: {
            phone: orderDetails.phone,
            email: orderDetails.email,
            address: { city: cities[0] || 'Phoenix', state: 'AZ', zip: orderDetails.zip || '' }
        },
        serviceArea: { cities },
        // Services are left empty on purpose: the engine fills in the standard
        // set for the trade, which is a better starting point than anything we
        // could infer from an order form. They get edited before launch.
        services: [],
        proof: { reviews: [], gallery: [] },
        offers: { freeEstimates: true },
        integrations: {
            // Without this the generated form shows its success message and
            // stores nothing, which is the most expensive thing to get wrong:
            // the site looks finished and silently drops every enquiry.
            leadEndpoint: process.env.ACP_LEAD_ENDPOINT || '',
            notificationEmail: process.env.ADMIN_EMAIL || orderDetails.email
        },
        site: {
            pages: { servicePages: true, areaPages: true, gallery: false, reviews: true, faq: true, about: true, contact: true },
            theme: { primary: 'auto', accent: 'auto' }
        }
    };
}

/** Build and publish. Never throws: a failure here must not lose the order. */
async function fulfilOrder(orderDetails) {
    const api = process.env.ACP_DEPLOY_API;
    const key = process.env.ACP_BUILDER_KEY;

    if (!api || !key) {
        const error = 'ACP_DEPLOY_API or ACP_BUILDER_KEY is not configured, so the site was not built.';
        console.error('Fulfilment skipped:', error);
        return { error };
    }

    try {
        const res = await fetch(api, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-builder-key': key },
            body: JSON.stringify({ spec: orderToSpec(orderDetails) })
        });
        const out = await res.json().catch(() => ({ error: 'The deploy API returned a non-JSON response.' }));
        if (!res.ok) {
            console.error('Deploy API error:', out);
            return { error: out.error || `Deploy API returned ${res.status}`, checks: out.checks };
        }
        console.log(`Published ${orderDetails.businessName}: ${out.url}`);
        return out;
    } catch (err) {
        console.error('Fulfilment failed:', err);
        return { error: err.message };
    }
}

/** Email the customer their live site, or tell them we are on it. */
async function sendSiteEmail(orderDetails, published) {
    const packageName = orderDetails.packageType === 'website' ? 'Professional Website'
        : orderDetails.packageType === 'social' ? 'Social Media Setup'
        : 'Complete Package';

    const built = !published.error && published.url;

    const body = built ? `
            <h2>Your site is live, ${esc(orderDetails.contactName)}.</h2>
            <p>We built it from the details on your order. Have a look, then tell us what to change.</p>
            <p style="margin:28px 0"><a class="button" href="${esc(published.url)}">${esc(published.url)}</a></p>
            <p>It has ${published.manifest ? published.manifest.pageCount : 'a'} pages: a home page, one for each
            service, one for each city you serve, plus about, reviews, FAQ and contact. Your ROC number
            ${esc(orderDetails.rocNumber)} is in the header of every page, linked to the Registrar's lookup,
            which is what Arizona law asks for.</p>

            <h3>What we need from you</h3>
            <ul>
              <li><strong>Job photos.</strong> Six to ten of your own work. Real photos beat stock every time,
                  and right now the site has none rather than something generic.</li>
              <li><strong>Your service list.</strong> We started with the standard set for ${esc(orderDetails.tradeType)}.
                  Tell us what to add, cut or rename.</li>
              <li><strong>Reviews.</strong> We do not write these. Send us real ones, or we will set up a
                  review link you can text to customers.</li>
              <li><strong>Your domain</strong>, if you have one.</li>
            </ul>
    ` : `
            <h2>Thanks, ${esc(orderDetails.contactName)}. We have your order.</h2>
            <p>Your payment went through and we are building your site now. You will get the link shortly.</p>
            <p style="color:#757575;font-size:13px">If you need anything in the meantime, just reply to this email.</p>
    `;

    const emailHtml = `<!DOCTYPE html>
<html>
<head>
    <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: #d84315; color: white; padding: 20px; text-align: center; }
        .content { background: #f5f5f5; padding: 30px; }
        .button { display: inline-block; background: #1976d2; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; }
        .footer { text-align: center; padding: 20px; color: #757575; font-size: 14px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header"><h1>AZ Contractor Pro</h1></div>
        <div class="content">
            ${body}
            <h3>Your order</h3>
            <ul>
                <li><strong>Business:</strong> ${esc(orderDetails.businessName)}</li>
                <li><strong>Package:</strong> ${esc(packageName)}</li>
                <li><strong>Trade:</strong> ${esc(orderDetails.tradeType)}</li>
                <li><strong>Service area:</strong> ${esc(orderDetails.serviceArea)}</li>
                <li><strong>ROC:</strong> #${esc(orderDetails.rocNumber)}</li>
                <li><strong>Order:</strong> ${esc(orderDetails.orderId)}</li>
            </ul>
        </div>
        <div class="footer">
            <p>AZ Contractor Pro &middot; <a href="mailto:${esc(process.env.SMTP_FROM || 'info@azcontractorpro.com')}">${esc(process.env.SMTP_FROM || 'info@azcontractorpro.com')}</a></p>
        </div>
    </div>
</body>
</html>`;

    try {
        await transporter.sendMail({
            from: process.env.SMTP_FROM || 'info@azcontractorpro.com',
            to: orderDetails.email,
            subject: built ? `Your site is live: ${orderDetails.businessName}` : `We have your order, ${orderDetails.contactName}`,
            html: emailHtml
        });
    } catch (err) {
        console.error('Could not send the customer email:', err);
    }
}

/** Minimal escaping so a business name cannot inject markup into the email. */
function esc(v) {
    return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Send admin notification
async function sendAdminNotification(orderDetails) {
    const emailHtml = `
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
                <p><strong>Order ID:</strong> ${orderDetails.orderId}</p>
                <p><strong>Business Name:</strong> ${orderDetails.businessName}</p>
                <p><strong>Contact Name:</strong> ${orderDetails.contactName}</p>
                <p><strong>Email:</strong> ${orderDetails.email}</p>
                <p><strong>Phone:</strong> ${orderDetails.phone}</p>
                <p><strong>Trade Type:</strong> ${orderDetails.tradeType}</p>
                <p><strong>Service Area:</strong> ${orderDetails.serviceArea}</p>
                <p><strong>Package:</strong> ${orderDetails.packageType}</p>
            </div>
            <p><strong>Action Required:</strong> Begin website development for this customer within 24 hours.</p>
        </div>
    </div>
</body>
</html>
    `;

    await transporter.sendMail({
        from: process.env.SMTP_FROM || 'info@azcontractorpro.com',
        to: process.env.ADMIN_EMAIL || 'admin@arizonacontractorwebs.com',
        subject: `New Order: ${orderDetails.businessName} - ${orderDetails.packageType}`,
        html: emailHtml
    });
}

// Payment success page
app.get('/payment-success', (req, res) => {
    const orderId = req.query.orderId;
    res.send(`
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
        <h2>Thank You for Your Order</h2>
        <p>Your payment has been processed successfully.</p>
        <div class="order-id">
            <strong>Order ID:</strong> ${orderId}
        </div>
        <div class="next-steps">
            <h3>What Happens Next?</h3>
            <ol>
                <li><strong>Your site gets built</strong> - automatically, within a few minutes</li>
                <li><strong>Check your email</strong> - we send you the live link as soon as it is up</li>
                <li><strong>Send us your job photos</strong> - real photos of your work, and your service list if you want it changed</li>
                <li><strong>We point it at your domain</strong> - and you are live</li>
            </ol>
        </div>
        <p><strong>Important:</strong> Save your Order ID for reference.</p>
        <p>If you don't receive your email within 15 minutes, please check your spam folder or contact us.</p>
        <a href="/" class="button">Return to Homepage</a>
    </div>
</body>
</html>
    `);
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Environment: ${process.env.SQUARE_ENVIRONMENT || 'sandbox'}`);
});

module.exports = app;
