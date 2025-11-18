// Square Payment Integration Backend
// This Node.js/Express server handles Square payments and sends bolt.new templates

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
            amount
        } = req.body;

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
                    packageType: packageType
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
                    packageType: orderMetadata.packageType
                };

                // Update order status
                if (orders.has(orderDetails.orderId)) {
                    const order = orders.get(orderDetails.orderId);
                    order.status = 'paid';
                    order.paidAt = new Date().toISOString();
                    order.squarePaymentId = payment.id;
                }

                // Generate and send bolt.new template
                await sendBoltTemplate(orderDetails);

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

// Generate bolt.new template based on trade type
function generateBoltTemplate(orderDetails) {
    const { businessName, tradeType, serviceArea, packageType } = orderDetails;

    // Base template structure
    let template = `Create a professional contractor website for ${businessName}, a ${tradeType} contractor serving ${serviceArea}.

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

    return template;
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

// Send bolt.new template email
async function sendBoltTemplate(orderDetails) {
    const template = generateBoltTemplate(orderDetails);
    
    const emailHtml = `
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
            <h2>Thank You for Your Order, ${orderDetails.contactName}!</h2>
            <p>We've received your payment and are excited to build your professional contractor website.</p>
            
            <h3>Order Details:</h3>
            <ul>
                <li><strong>Business:</strong> ${orderDetails.businessName}</li>
                <li><strong>Package:</strong> ${orderDetails.packageType === 'website' ? 'Professional Website' : orderDetails.packageType === 'social' ? 'Social Media Setup' : 'Complete Package'}</li>
                <li><strong>Trade:</strong> ${orderDetails.tradeType}</li>
                <li><strong>Service Area:</strong> ${orderDetails.serviceArea}</li>
            </ul>

            <h3>🚀 Your Website Template</h3>
            <p>Below is your custom bolt.new template. You can use this to preview and customize your website:</p>
            
            <div class="template-box">
                <pre style="white-space: pre-wrap; font-size: 13px;">${template}</pre>
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

    await transporter.sendMail({
        from: process.env.SMTP_FROM || 'info@azcontractorpro.com',
        to: orderDetails.email,
        subject: `Your ${orderDetails.businessName} Website Template - AZ Contractor Pro`,
        html: emailHtml
    });

    console.log(`Bolt.new template sent to ${orderDetails.email}`);
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
