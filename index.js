"use strict"

const dotenv = require("dotenv")
const express = require("express")
const cors = require("cors")
const got = require("got")
const ghost = require("@tryghost/admin-api")
const { readFile, writeFile } = require("fs-extra")
const nodemailer = require("nodemailer")
const handlebars = require("handlebars")
const whilst = require("p-whilst")
const { join } = require("path")
const { inspect } = require("util")
const { createHmac } = require("crypto")

dotenv.config()

const statsFile = join(__dirname, "stats.json")
const templateFile = join(__dirname, "template.hbs")

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

const createTransport = () => {
  if (process.env.SMTP_HOST === "localhost") {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: false,
      tls: {
        rejectUnauthorized: false,
      },
    })
  } else {
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      requireTLS: true,
      secure: false,
      auth: {
        user: process.env.SMTP_USERNAME,
        pass: process.env.SMTP_PASSWORD,
      },
    })
  }
}

const nodemailerTransport = createTransport()

const app = express()

app.enable("trust proxy")
app.disable("x-powered-by")

app.use(cors())

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf
    },
  })
)

app.post("/", async (req, res) => {
  try {
    const stripeSignature = req.headers["stripe-signature"]
    if (!stripeSignature) {
      const error = new Error("Missing Stripe webhook signature header")
      console.error(error)
      return res.status(401).send({
        error: error.message,
      })
    }
    const [result, timestamp, signature] = stripeSignature.match(
      /t=([0-9]+),v1=([a-f0-9]+)/
    )
    if (!timestamp || !signature) {
      const error = new Error("Invalid Stripe webhook signature header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    const hmac = createHmac("sha256", process.env.STRIPE_WEBHOOK_SIGNING_SECRET)
      .update(`${timestamp}.${req.rawBody}`)
      .digest("hex")
    if (hmac !== signature) {
      const error = new Error("Wrong Stripe webhook signature")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    const type = req.body.type
    if (
      [
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(type) === false
    ) {
      const error = new Error("Invalid Stripe webhook type")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const subscriptionId = req.body.data.object.id
    const subscriptionResponse = await stripeClient.get(
      `v1/subscriptions/${subscriptionId}?expand[]=customer`
    )
    const customerId = subscriptionResponse.body.customer.id
    const customerEmail = subscriptionResponse.body.customer.email
    const customerName = subscriptionResponse.body.customer.name
    const cancelAtPeriodEnd = subscriptionResponse.body.cancel_at_period_end
    const currentPeriodStart = new Date(
      subscriptionResponse.body.current_period_start * 1000
    ).toLocaleDateString("en-ca")
    const currentPeriodEnd = new Date(
      subscriptionResponse.body.current_period_end * 1000
    ).toLocaleDateString("en-ca")
    const productId = subscriptionResponse.body.plan.product
    const status = subscriptionResponse.body.status
    if (productId !== process.env.STRIPE_PRODUCT_ID) {
      const error = new Error("Invalid Stripe subscription product ID")
      console.error(error, subscriptionResponse.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const members = await ghostClient.members.browse({
      filter: `email:'${customerEmail}'`,
    })
    if (
      [
        "customer.subscription.created",
        "customer.subscription.updated",
      ].includes(type) === true &&
      status === "active"
    ) {
      if (members.length === 0) {
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
        const member = await ghostClient.members.add(
          {
            name: customerName,
            email: customerEmail,
            labels: labels,
            note: JSON.stringify(note, null, 2),
          },
          { send_email: true }
        )
        if (process.env.DEBUG === "true") {
          console.info("Member added", member)
        }
        return res.sendStatus(201)
      } else if (members.length === 1) {
        const member = members[0]
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
        const note = JSON.parse(member.note)
        note.stripe.pendingDeletion = cancelAtPeriodEnd
        note.stripe.starts = currentPeriodStart
        note.stripe.ends = currentPeriodEnd
        const updatedMember = await ghostClient.members.edit({
          id: member.id,
          labels: labels,
          note: JSON.stringify(note, null, 2),
        })
        if (process.env.DEBUG === "true") {
          console.info("Member updated", updatedMember)
        }
        return res.sendStatus(200)
      } else {
        // This should never happen but tracking edge case anyways
        throw new Error("Invalid member length")
      }
    } else if (
      type === "customer.subscription.deleted" &&
      members.length === 1
    ) {
      const member = members[0]
      await ghostClient.members.delete({
        id: member.id,
      })
      if (process.env.DEBUG === "true") {
        console.info("Member deleted", member)
      }
      return res.sendStatus(201)
    }
    return res.sendStatus(200)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.post("/stripe-customer-update", async (req, res) => {
  try {
    const member = await ghostClient.members.read({
      id: req.body.member.current.id,
    })
    if (!member) {
      const error = new Error("Could not find member")
      console.error(error, req.query)
      return res.status(404).send({
        error: error.message,
      })
    }
    const note = JSON.parse(member.note)
    if (note.stripe && note.stripe.customer) {
      const customer = note.stripe.customer
      const customerResponse = await stripeClient.post(
        `v1/customers/${customer}`,
        {
          form: {
            email: member.email,
            name: member.name,
          },
        }
      )
      if (process.env.DEBUG === "true") {
        console.info("Stripe customer updated", customerResponse.body)
      }
    }
    return res.sendStatus(200)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/portal", async (req, res) => {
  try {
    if (!req.query.email || req.query.email === "") {
      const error = new Error("Missing email")
      console.error(error, req.query)
      return res.status(400).send({
        error: error.message,
      })
    }
    const email = req.query.email
    const members = await ghostClient.members.browse({
      filter: `email:'${email}'`,
    })
    if (members.length !== 1) {
      const error = new Error("Membership required")
      console.error(error, req.query)
      return res.status(401).send({
        error: error.message,
      })
    }
    const member = members[0]
    const note = JSON.parse(member.note)
    const portalSessionResponse = await stripeClient.post(
      "v1/billing_portal/sessions",
      {
        form: {
          customer: note.stripe.customer,
        },
      }
    )
    const from = {
      name: process.env.FROM_NAME,
      email: process.env.FROM_EMAIL,
    }
    const to = {
      name: member.name,
      email: member.email,
    }
    const data = {
      from: {
        firstName: from.name.split(" ")[0],
        email: from.email,
      },
      to: {
        firstName: to.name.split(" ")[0],
        email: to.email,
      },
      message: `Go to following link to manage your membership.\n\n${portalSessionResponse.body.url}`,
    }
    const info = await nodemailerTransport.sendMail({
      from: `${from.name} <${from.email}>`,
      to: `${to.name} <${to.email}>`,
      subject: "Manage membership",
      text: template(data),
    })
    return res.redirect(process.env.GHOST_MEMBERSHIP_PAGE)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/stats", async (req, res) => {
  if (process.env.STATS_TOKEN && req.query.token !== process.env.STATS_TOKEN) {
    const error = new Error("Wrong token")
    console.error(error, req.query.token)
    return res.status(401).send({
      error: error.message,
    })
  }
  return res.status(200).send(stats)
})

app.get("/status", async (req, res) => {
  return res.sendStatus(204)
})

var stats

const syncStats = async () => {
  if (process.env.DEBUG === "true") {
    console.info("Syncing stats")
  }
  let subscriptions = []
  let more = true
  let currentObject = ""
  await whilst(
    () => {
      return more
    },
    async () => {
      let startingAfter = ""
      if (currentObject) {
        startingAfter = `&starting_after=${currentObject}`
      }
      const url = `v1/subscriptions?status=active&limit=100${startingAfter}`
      if (process.env.DEBUG === "true") {
        console.info(`Fetching ${process.env.STRIPE_API_PREFIX_URL}/${url}`)
      }
      const subscriptionsResponse = await stripeClient.get(url)
      subscriptions = subscriptions.concat(subscriptionsResponse.body.data)
      more = subscriptionsResponse.body.has_more
      if (subscriptions.length > 0) {
        currentObject = subscriptions.at(-1).id
      }
    }
  )
  let members = 0
  let revenue = 0
  subscriptions.forEach((subscription) => {
    members += 1
    revenue += subscription.plan.amount
  })
  stats = {
    members: members,
    revenue: revenue / 100,
  }
  await writeFile(statsFile, JSON.stringify(stats, null, 2))
  if (process.env.DEBUG === "true") {
    console.info("Scheduling next sync in 60 seconds")
  }
  setTimeout(syncStats, 60000)
}

var template

const loadTemplate = async () => {
  const data = await readFile(templateFile, "utf8")
  template = handlebars.compile(data)
}

const run = async () => {
  try {
    await syncStats()
    await loadTemplate()
    const server = await app.listen(process.env.PORT)
    const serverAddress = server.address()
    if (process.env.DEBUG === "true" && typeof serverAddress === "object") {
      console.info(`Server listening on port ${serverAddress.port}`)
    }
  } catch (error) {
    prettyError(error)
    process.exit(1)
  }
}

run()
