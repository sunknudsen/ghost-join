"use strict"

const dotenv = require("dotenv")
const got = require("got")
const ghost = require("@tryghost/admin-api")
const { inspect } = require("util")

dotenv.config()

const prettyError = (error) => {
  if (error instanceof got.HTTPError) {
    let authorization = error.response.request.options.headers.authorization
    if (authorization) {
      const [scheme, token] = authorization.split(" ")
      if (scheme && scheme === "Bearer") {
        error.response.request.options.headers.authorization = `${scheme} redacted`
      } else {
        error.response.request.options.headers.authorization = "redacted"
      }
    }
    console.error(
      inspect(
        {
          request: {
            method: error.response.request.options.method,
            url: error.response.request.options.url.href,
            headers: error.response.request.options.headers,
            json: error.response.request.options.json,
            body: error.response.request.options.body,
          },
          response: {
            statusCode: error.response.statusCode,
            body: error.response.body,
          },
        },
        false,
        4,
        true
      )
    )
  } else {
    console.error(inspect(error, false, 4, true))
  }
}

const stripeClient = got.extend({
  prefixUrl: process.env.STRIPE_API_PREFIX_URL,
  responseType: "json",
  headers: {
    authorization: `Bearer ${process.env.STRIPE_RESTRICTED_API_KEY_TOKEN}`,
  },
  retry: {
    limit: 2,
  },
})

const ghostClient = new ghost({
  url: process.env.GHOST_API_URL,
  key: process.env.GHOST_ADMIN_API_KEY,
  version: "v4",
})

const patch = async () => {
  try {
    console.log("Patching members…")
    const members = await ghostClient.members.browse({
      limit: process.env.LIMIT ?? 100,
    })
    for (const member of members) {
      const email = member.email
      const customersResponse = await stripeClient.get("v1/customers", {
        searchParams: {
          email: email,
        },
      })
      const customers = customersResponse.body.data
      if (customers.length > 1) {
        // This should never happen but tracking edge case anyways
        throw new Error("Invalid customers length")
      }
      if (customers.length === 0) {
        console.info(`Could not find customer matching ${email}`)
        continue
      }
      const customer = customers[0]
      const customerId = customer.id
      const customerResponse = await stripeClient.get(
        `v1/customers/${customerId}?expand[]=subscriptions`
      )
      const subscriptions = customerResponse.body.subscriptions.data
      if (subscriptions.length !== 1) {
        // This should never happen but tracking edge case anyways
        throw new Error("Invalid subscriptions length")
      }
      const subscription = subscriptions[0]
      const subscriptionId = subscription.id
      const currentPeriodStart = new Date(
        subscription.current_period_start * 1000
      ).toLocaleDateString("en-ca")
      const currentPeriodEnd = new Date(
        subscription.current_period_end * 1000
      ).toLocaleDateString("en-ca")
      const cancelAtPeriodEnd = subscription.cancel_at_period_end
      await stripeClient.post(`v1/customers/${customerId}`, {
        form: {
          name: member.name,
        },
      })
      const labels = [
        {
          name: "Stripe",
        },
      ]
      if (cancelAtPeriodEnd === true) {
        labels.push({
          name: "Pending deletion",
        })
      }
      const note = {
        stripe: {
          customer: customerId,
          subscription: subscriptionId,
          pendingDeletion: cancelAtPeriodEnd,
          starts: currentPeriodStart,
          ends: currentPeriodEnd,
        },
      }
      await ghostClient.members.edit({
        id: member.id,
        labels: labels,
        note: JSON.stringify(note, null, 2),
      })
      console.log(`Patched ${email}`)
    }
    console.info("Done")
    process.exit(0)
  } catch (error) {
    prettyError(error)
    process.exit(1)
  }
}

patch()
