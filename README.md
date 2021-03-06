# ghost-join

## Monetize content on Ghost without compromising on user privacy.

[Ghost](https://ghost.org/) is an amazing open source publication platform used by content creators to monetize their content.

Unfortunately, even when [self-hosting](https://ghost.org/docs/hosting/#self-hosting) Ghost, one cannot enable memberships in a privacy-conscious way given, once enabled, [Stripe.js](https://stripe.com/docs/js) is [loaded](https://github.com/TryGhost/Ghost/pull/11499#issuecomment-1016571235) on all pages (among [other privacy issues](#other-privacy-issues)).

Thankfully, one can set “Subscription access” to “Only people I invite” on `/ghost/#/settings/members` and use Stripe [payment link](https://stripe.com/docs/payments/payment-links/overview), [webhook](https://stripe.com/docs/webhooks) and [Ghost admin API](https://ghost.org/docs/admin-api/) to add or remove members programmatically when [subscriptions](https://stripe.com/docs/billing/subscriptions/overview) are created or cancelled on Stripe.

Implementing ghost-join it not straightforward… this repo was made public so other privacy-conscious technologists don’t have to go down the rabbit hole like I did.

**Want to experience ghost-join?** Check out [https://sunknudsen.com/](https://sunknudsen.com/).

## Implementation overview

### Step 1: create and configure [Stripe](https://stripe.com/) account

Go to [https://dashboard.stripe.com/settings/user](https://dashboard.stripe.com/settings/user) and configure user.

Go to [https://dashboard.stripe.com/settings/emails](https://dashboard.stripe.com/settings/emails) and configure emails.

Go to [https://dashboard.stripe.com/settings/branding](https://dashboard.stripe.com/settings/branding) and configure branding.

Go to [https://dashboard.stripe.com/settings/billing/automatic](https://dashboard.stripe.com/settings/billing/automatic) and configure automatic emails.

Go to [https://dashboard.stripe.com/settings/billing/portal](https://dashboard.stripe.com/settings/billing/portal) and configure portal (set “Default redirect link”).

### Step 2: create restricted Stripe API key

Go to [https://dashboard.stripe.com/developers](https://dashboard.stripe.com/developers) and create restricted API key with following permissions.

Customers 👉 Write

Customer portal 👉 Write

Subscriptions 👉 Read

### Step 3: create Stripe webhook

Go to [https://dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks) and create webhook with following events that points to ghost-join service.

Events to send 👉 `customer.subscription.created`, `customer.subscription.updated` and `customer.subscription.deleted`

### Step 4: add Stripe product and create payment link

Go to [https://dashboard.stripe.com/products](https://dashboard.stripe.com/products), add product (with recurrent payment) and create payment link

### Step 5: set “Subscription access” to “Only people I invite” on `/ghost/#/settings/members`

### Step 6: add ghost-join custom integration on `/ghost/#/settings/integrations` and create webhook

Create webhook named “Stripe customer update” that listens to “Member updated event and triggers `/stripe-customer-update`.

### Step 7: configure and run ghost-join

> Heads-up: set `STATS_TOKEN` in `.env` to disable public stats.

Clone [ghost-join](https://github.com/sunknudsen/ghost-join), create `.env` and `template.hbs`, run `node index.js` and point subdomain to service (complexity of step has been abstracted).

### Step 8: generate custom Ghost Portal

Clone [custom-ghost-portal](https://github.com/sunknudsen/custom-ghost-portal), run `npm install`, edit `REACT_APP_JOIN_URL` and `REACT_APP_GHOST_JOIN_PORTAL_URL` variables in `.env` and run `npm run build`.

### Step 9: add files from `custom-ghost-portal/umd` directory to `assets/built` directory of theme and configure portal

Add following to `config.production.json`.

```
"portal": {
  "url": "/assets/built/portal.min.js",
  "version": "~1.1.0"
}
```

### Step 10: create join and contact pages on `/ghost/#/pages`

### Step 11 (optional): configure privacy features (see [docs](https://ghost.org/docs/config/#privacy))

Add following to `config.production.json`.

```
"privacy": {
  "useUpdateCheck": false,
  "useGravatar": false
}
```

### Step 12: run `ghost restart`
