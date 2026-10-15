# AZ Contractor Pro: site + payments

`az-contractor-pro.html` is the marketing site and order form. `payment-server.js` serves it, takes
payment with Stripe Checkout, emails the customer their bolt.new template and the admin a new-order
notice once Stripe confirms the payment, and reports every order to the CRM (`CRM-Az-Contractor`).

## Run it

```bash
npm install
cp .env.example .env      # add your Stripe keys, SMTP and CRM settings
npm start                 # http://localhost:3000
npm test                  # 8 tests, no network or Stripe account needed
```

## Stripe setup

1. **API key**: copy the secret key from https://dashboard.stripe.com/apikeys into `STRIPE_SECRET_KEY`
   (`sk_test_...` while testing).
2. **Webhook**: in Developers → Webhooks, add an endpoint `https://<your domain>/api/stripe-webhook`
   with these events:
   - `checkout.session.completed`
   - `checkout.session.async_payment_succeeded`
   - `checkout.session.async_payment_failed`
   - `checkout.session.expired`

   Put its signing secret (`whsec_...`) in `STRIPE_WEBHOOK_SECRET`.
3. **Test locally** with the Stripe CLI:
   ```bash
   stripe listen --forward-to localhost:3000/api/stripe-webhook   # prints a whsec_ for .env
   ```
   Then order on http://localhost:3000 with card `4242 4242 4242 4242`, any future date and any CVC.

## How an order flows

1. The form posts the customer's details and the package (`website`, `social`, `complete`) to
   `POST /api/create-checkout-session`. The server sets the price from the package ($250 / $120 / $370);
   nothing the browser sends can change it.
2. The customer pays on Stripe's hosted checkout page and lands on `/payment-success`.
3. Stripe calls `/api/stripe-webhook`. The signature is verified, and once the session is paid the two
   emails go out and the CRM gets the paid order. Card payments are paid immediately; delayed methods
   wait for `checkout.session.async_payment_succeeded`.
4. Duplicate webhook deliveries don't send duplicate emails. If sending fails, the webhook returns
   500 so Stripe retries it.

If `SMTP_USER` is empty, emails are skipped (and logged) instead of failing the webhook. If `CRM_URL`
is empty, orders aren't reported to the CRM.

## Hosting the page elsewhere

The server serves the page at `/`, so the form's `fetch('/api/create-checkout-session')` is same-origin.
If you host the HTML somewhere else (e.g. Netlify), set `API_BASE` near the bottom of
`az-contractor-pro.html` to the payment server's URL and add the page's origin to `ALLOWED_ORIGINS`.
