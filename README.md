# AZ Contractor Pro — sales site and payment server

The front of the funnel: the order page, Square checkout, and fulfilment.

```
az-contractor-pro.html   order form -> POST /api/create-square-checkout
payment-server.js        Square checkout, webhook, and fulfilment
```

## What happens when someone orders

1. The order form collects the business, the trade, the service area and the
   **Arizona ROC licence number**, then posts to `/api/create-square-checkout`.
   The ROC number is required and the server rejects an order without one:
   A.R.S. § 32-1124(B)(4) only lets a contractor advertise a URL in place of
   the licence number when the site displays the name and number prominently,
   so a site without it cannot do the job it is being bought for.
2. Square takes the payment and calls `/api/square-webhook`.
3. The webhook turns the order into a `ClientSpec` and posts it to the site
   engine's deploy API, which builds the full multi-page site, runs its checks
   and publishes it.
4. The customer gets an email with the live URL and a short list of what we
   still need from them: job photos, their real service list, and reviews.

This used to be step 3 and 4 only in spirit: the webhook generated a
**bolt.new prompt**, emailed it to the customer, and a person pasted it in and
built the site by hand. The trade colour and service tables that prompt was
built from were a third copy of data that also lived in `builder.html` and in
the `contractor-website-generator` skill, and the three had drifted apart.

The engine lives in **acp-backend-tucson** (`lib/`, `bin/acp.mjs`,
`netlify/functions/deploy.mjs`). See `docs/FLOW.md` there.

## Configuration

Copy `.env.example` to `.env`. Beyond the Square and SMTP settings:

| variable | |
|---|---|
| `ACP_DEPLOY_API` | the engine's deploy endpoint, e.g. `https://acp-api.netlify.app/api/deploy` |
| `ACP_BUILDER_KEY` | the shared secret the engine expects as `x-builder-key` |
| `ACP_LEAD_ENDPOINT` | Apps Script URL that generated sites post leads to |

Without `ACP_DEPLOY_API` and `ACP_BUILDER_KEY` the payment still succeeds and
the order is recorded; the customer gets a "we are building it" email instead
of a link, and the failure is logged. Fulfilment never throws, because losing
a paid order to a deploy hiccup is worse than a delayed email.

## Known inconsistency

This page sells **$250 / $120 / $370 one-time**. The live marketing site at
`azcontractorprowebsite` sells **$497 + $49/mo, $997 + $99/mo and
$1,997 + $199/mo**. Both are customer-facing and they disagree. That is a
pricing decision rather than a code one, so nothing here has changed it — but
it should be settled before either page takes another order.
