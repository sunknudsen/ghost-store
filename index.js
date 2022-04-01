"use strict"

const dotenv = require("dotenv")
const express = require("express")
const bodyParser = require("body-parser")
const cookieParser = require("cookie-parser")
const { Sequelize, Model, DataTypes, Op } = require("sequelize")
const got = require("got")
const ghost = require("@tryghost/admin-api")
const moment = require("moment")
const nodemailer = require("nodemailer")
const handlebars = require("handlebars")
const { pathExists, readFile, writeFile } = require("fs-extra")
const { join } = require("path")
const { inspect } = require("util")
const { createHmac, randomBytes } = require("crypto")

dotenv.config()

const pollsFile = join(__dirname, "polls.json")
const storeFile = join(__dirname, "store.json")
const defaultTemplateFile = join(__dirname, "default-template.hbs")
const orderConfirmationTemplateFile = join(
  __dirname,
  "order-confirmation-template.hbs"
)

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

const getProductById = (id) => {
  for (const [path, product] of Object.entries(store)) {
    if (product.id === id) {
      return {
        path: path,
        product: product,
      }
    }
  }
  return null
}

const generateToken = (size = 24) => {
  return randomBytes(size).toString("hex").slice(0, size)
}

const sendOrderConfirmationEmail = async (req, to, path, product) => {
  const downloads = []
  if (product.files) {
    const filenames = Object.keys(product.files)
    for (const filename of filenames) {
      const download = await Download.create({
        path: path,
        filename: filename,
        token: generateToken(),
      })
      downloads.push(
        `${req.protocol}://${req.headers.host}/downloads/${download.filename}?token=${download.token}`
      )
    }
  }
  const links = []
  if (product.links) {
    for (const link of product.links) {
      links.push(link)
    }
  }
  if (product.cdn) {
    const emailHmac = createHmac("sha256", process.env.HMAC_SECRET)
      .update(to.email.toLowerCase().trim())
      .digest("hex")
    const token = generateToken()
    const [user, created] = await User.upsert(
      {
        emailHmac: emailHmac,
        token: token,
      },
      { returning: true }
    )
    const authorization = await Authorization.findOne({
      where: { path: path, userId: user.id },
    })
    if (authorization) {
      await authorization.update({
        expiresOn: moment()
          .add(product.cdn.expiry.amount, product.cdn.expiry.unit)
          .toDate(),
      })
    } else {
      await Authorization.create({
        path: path,
        expiresOn: moment()
          .add(product.cdn.expiry.amount, product.cdn.expiry.unit)
          .toDate(),
        userId: user.id,
      })
    }
    links.push(
      `${req.protocol}://${req.headers.host}/login?emailhmac=${emailHmac}&token=${token}&redirect=${product.cdn.redirect}`
    )
  }
  if (downloads.length === 0 && links.length === 0) {
    throw new Error("Invalid email payload")
  }
  const from = {
    name: process.env.FROM_NAME,
    email: process.env.FROM_EMAIL,
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
    downloads: downloads,
    links: links,
  }
  if (downloads.length > 0) {
    data.expiry = moment
      .duration(process.env.DOWNLOAD_LINK_EXPIRY, "hours")
      .humanize()
  }
  if (product.eventOn && product.eventOn !== "") {
    data.eventOn = moment(product.eventOn).format(
      "dddd, MMMM Do YYYY [at] h:mmA [EST]"
    )
  }
  const info = await nodemailerTransport.sendMail({
    from: `${from.name} <${from.email}>`,
    to: `${to.name} <${to.email}>`,
    subject: product.name,
    text: orderConfirmationTemplate(data),
  })
  return info
}

const isEmail = (string) => {
  if (/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/.test(string)) {
    return true
  }
  return false
}

const wait = (delay) => new Promise((resolve) => setTimeout(resolve, delay))

const between = (min, max) => {
  return Math.floor(Math.random() * (max - min) + min)
}

const sequelizeOptions = {
  host: "localhost",
  dialect: "mysql",
}

if (process.env.DEBUG === "false") {
  sequelizeOptions.logging = false
}

const sequelize = new Sequelize(
  process.env.MYSQL_DATABASE,
  process.env.MYSQL_USERNAME,
  process.env.MYSQL_PASSWORD,
  sequelizeOptions
)

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

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf
    },
  })
)

app.use(bodyParser.json())

app.use(bodyParser.urlencoded({ extended: true }))

app.use(cookieParser())

app.post("/", async (req, res) => {
  try {
    const stripeSignature = req.headers["stripe-signature"]
    if (!stripeSignature) {
      const error = new Error("Missing Stripe webhook signature header")
      console.error(error, req.headers)
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
    if (type !== "checkout.session.completed") {
      const error = new Error("Invalid Stripe webhook type")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const sessionId = req.body.data.object.id
    const session = await stripeClient.get(
      `v1/checkout/sessions/${sessionId}?expand[]=customer&expand[]=line_items`
    )
    if (session.body.payment_status !== "paid") {
      logger.captureException(
        new Error("Invalid Stripe session payment status"),
        null,
        {
          paymentStatus: session.body.payment_status,
        }
      )
      return res.sendStatus(400)
    }
    const to = {
      name: session.body.customer.name,
      email: session.body.customer.email,
    }
    const lineItems = session.body.line_items.data
    let orderConfirmationEmailSent = false
    for (const lineItem of lineItems) {
      const productId = lineItem.price.product
      // Skip ghost-join subscriptions
      if (productId === process.env.STRIPE_GHOST_JOIN_PRODUCT_ID) {
        continue
      }
      const { path, product } = getProductById(productId)
      if (!product) {
        const error = new Error("Product not found")
        console.error(error, productId)
        return res.status(404).send({
          error: error.message,
        })
      }
      await sendOrderConfirmationEmail(req, to, path, product)
      orderConfirmationEmailSent = true
    }
    if (orderConfirmationEmailSent === true) {
      return res.sendStatus(201)
    } else {
      return res.sendStatus(200)
    }
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/admin", async (req, res) => {
  try {
    const authorizationHeader = req.headers["authorization"]
    if (!authorizationHeader) {
      const error = new Error("Missing authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorizationHeader !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      const error = new Error("Wrong authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (!req.body.name || req.body.name === "") {
      const error = new Error("Missing name")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.email || req.body.email === "") {
      const error = new Error("Missing email")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.path || req.body.path === "") {
      const error = new Error("Missing path")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const path = req.body.path
    const product = store[path]
    if (!product) {
      const error = new Error("Product not found")
      console.error(error, req.body)
      return res.status(404).send({
        error: error.message,
      })
    }
    const to = {
      name: req.body.name,
      email: req.body.email,
    }
    await sendOrderConfirmationEmail(req, to, path, product)
    return res.status(200).send({
      sent: true,
    })
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/store", async (req, res) => {
  try {
    if (!req.body.path || req.body.path === "") {
      const error = new Error("Missing path")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.email || req.body.email === "") {
      const error = new Error("Missing email")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const email = req.body.email
    const members = await ghostClient.members.browse({
      filter: `email:'${email}'`,
    })
    if (members.length !== 1) {
      const error = new Error("Membership required")
      console.error(error, req.body)
      return res.status(401).send({
        error: error.message,
      })
    }
    const member = members[0]
    const path = req.body.path
    const product = store[path]
    if (!product) {
      const error = new Error("Product not found")
      console.error(error, req.body)
      return res.status(404).send({
        error: error.message,
      })
    }
    if (product.members !== true) {
      const error = new Error("Product paid-only")
      console.error(error, req.body)
      return res.status(403).send({
        error: error.message,
      })
    }
    const to = {
      name: member.name,
      email: member.email,
    }
    await sendOrderConfirmationEmail(req, to, path, product)
    return res.redirect(process.env.GHOST_STORE_CONFIRMATION_PAGE)
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.get("/downloads/:filename", async (req, res) => {
  try {
    if (!req.query.token || req.query.token === "") {
      const error = new Error("Missing token")
      console.error(error, req.query)
      return res.status(401).send({
        error: error.message,
      })
    }
    const download = await Download.findOne({
      where: { token: req.query.token },
    })
    if (!download) {
      const error = new Error("Wrong token")
      console.error(error, req.query)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (moment().isAfter(download.expiresOn)) {
      const error = new Error("Download expired")
      console.error(error, download)
      return res.status(403).send({
        error: error.message,
      })
    }
    const product = store[download.path]
    if (!product) {
      const error = new Error("Product not found")
      console.error(error, store, download.path)
      return res.status(404).send({
        error: error.message,
      })
    }
    const file = product.files[download.filename]
    if (!file) {
      const error = new Error("Invalid filename")
      console.error(error, product, download.filename)
      return res.status(404).send({
        error: error.message,
      })
    }
    const filePath = join(__dirname, "downloads", file)
    if (download.expiresOn === null) {
      download.update({
        expiresOn: moment()
          .add(process.env.DOWNLOAD_LINK_EXPIRY, "hour")
          .toDate(),
      })
    }
    return res
      .set("Content-Disposition", `attachment; filename="${download.filename}"`)
      .sendFile(filePath)
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/polls", async (req, res) => {
  try {
    if (!req.body.name || req.body.name === "") {
      const error = new Error("Missing name")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.response || req.body.response === "") {
      const error = new Error("Missing response")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const name = req.body.name
    const response = req.body.response.trim()
    const poll = polls[name]
    if (!poll) {
      const error = new Error("Invalid name")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (poll.type === "email" && isEmail(response) !== true) {
      const error = new Error("Invalid email")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    } else if (poll.type === "text" && response.length > 1024) {
      const error = new Error("Invalid response (too long)")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    var duplicate = false
    if (poll.unique === true) {
      const rows = await Poll.findAll({
        attributes: ["id"],
        where: {
          name: name,
          response: response,
        },
      })
      if (rows.length !== 0) {
        duplicate = true
      }
    }
    if (duplicate !== true) {
      await Poll.create({
        name: name,
        response: response,
      })
    }
    return res.redirect(process.env.GHOST_POLLS_CONFIRMATION_PAGE)
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.get("/polls/:name", async (req, res) => {
  try {
    const authorizationHeader = req.headers["authorization"]
    if (!authorizationHeader) {
      const error = new Error("Missing authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorizationHeader !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      const error = new Error("Wrong authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (!req.params.name || req.params.name === "") {
      const error = new Error("Missing name")
      console.error(error, req.params)
      return res.status(400).send({
        error: error.message,
      })
    }
    const name = req.params.name
    const poll = polls[name]
    if (!poll) {
      const error = new Error("Invalid name")
      console.error(error, req.params)
      return res.status(400).send({
        error: error.message,
      })
    }
    const rows = await Poll.findAll({
      attributes: ["response"],
      where: {
        name: name,
      },
    })
    const responses = []
    rows.forEach((row) => {
      responses.push(row.response)
    })
    return res.status(200).send({
      name: name,
      data: responses,
      responses: rows.length,
    })
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/polls/:name/sendmail", async (req, res) => {
  try {
    const authorizationHeader = req.headers["authorization"]
    if (!authorizationHeader) {
      const error = new Error("Missing authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorizationHeader !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      const error = new Error("Wrong authorization header")
      console.error(error, authorization)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (!req.params.name || req.params.name === "") {
      const error = new Error("Missing name")
      console.error(error, req.params)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.subject || req.body.subject === "") {
      const error = new Error("Missing subject")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.body || req.body.body === "") {
      const error = new Error("Missing body")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const name = req.params.name
    const poll = polls[name]
    if (!poll) {
      const error = new Error("Invalid name")
      console.error(error, req.params)
      return res.status(400).send({
        error: error.message,
      })
    }
    const preview = req.body.preview ? true : false
    const rows = await Poll.findAll({
      attributes: ["response"],
      where: {
        name: name,
      },
    })
    const from = {
      name: process.env.FROM_NAME,
      email: process.env.FROM_EMAIL,
    }
    const recipients = []
    if (preview === true) {
      recipients.push(from.email)
    } else {
      rows.forEach((row) => {
        if (isEmail(row.response) === true) {
          recipients.push(row.response)
        }
      })
    }
    const subject = req.body.subject
    const body = req.body.body
    for (const recipient of recipients) {
      if (process.env.SMTP_HOST === "localhost") {
        // Delay used to throttle outbound emails attempting to prevent being
        // flagged as SPAM when self-hosting SMTP server.
        await wait(between(500, 2000))
      }
      await nodemailerTransport.sendMail({
        from: `${from.name} <${from.email}>`,
        to: recipient,
        subject: subject,
        text: body,
      })
    }
    return res.status(200).send({
      preview: preview,
      recipients: recipients,
      sent: true,
    })
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.get("/login", async (req, res, next) => {
  try {
    if (req.query.emailhmac && req.query.token && req.query.redirect) {
      const emailHmac = req.query.emailhmac
      const token = req.query.token
      const user = await User.findOne({
        where: { emailHmac: emailHmac },
      })
      if (!user) {
        const error = new Error("Could not find user")
        console.error(error, req.query)
        return res.status(404).send({
          error: error.message,
        })
      }
      if (user.token !== token) {
        const error = new Error("Wrong token")
        console.error(error, req.query)
        return res.redirect(
          302,
          `${req.protocol}://${req.headers.host}${req.path}?error=invalid-token&redirect=${req.query.redirect}`
        )
      }
      user.update({
        token: null,
      })
      const sessions = await Session.findAll({
        attributes: ["id"],
        limit: parseInt(process.env.SESSION_CONCURRENCY) - 1,
        order: [["createdAt", "DESC"]],
        where: { userId: user.id },
      })
      const ids = []
      sessions.forEach((session) => {
        ids.push(session.id)
      })
      await Session.update(
        {
          valid: false,
        },
        {
          where: { id: { [Op.notIn]: ids } },
        }
      )
      const sessionToken = generateToken()
      const sessionSalt = generateToken()
      const sessionHmac = createHmac("sha256", process.env.HMAC_SECRET)
        .update(sessionSalt.concat(req.ip))
        .digest("hex")
      await Session.create({
        token: sessionToken,
        hmac: sessionHmac,
        userId: user.id,
      })
      const domain =
        req.hostname === "localhost"
          ? "localhost"
          : `.${req.hostname
              .split(".")
              .reverse()
              .splice(0, 2)
              .reverse()
              .join(".")}`
      res.cookie("session-salt", sessionSalt, {
        domain: domain,
      })
      res.cookie("session-token", sessionToken, {
        domain: domain,
      })
      res.redirect(302, req.query.redirect)
    } else {
      next()
    }
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/login", async (req, res) => {
  try {
    if (!req.body.email || req.body.email === "") {
      const error = new Error("Missing email")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!req.body.redirect || req.body.redirect === "") {
      const error = new Error("Missing redirect")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const email = req.body.email
    const emailHmac = createHmac("sha256", process.env.HMAC_SECRET)
      .update(email.toLowerCase().trim())
      .digest("hex")
    const user = await User.findOne({
      where: { emailHmac: emailHmac },
    })
    if (!user) {
      const error = new Error("Wrong credentials")
      console.error(error, req.body)
      return res.status(401).send({
        error: error.message,
      })
    }
    const token = generateToken()
    await user.update({
      token: token,
    })
    const from = {
      name: process.env.FROM_NAME,
      email: process.env.FROM_EMAIL,
    }
    const data = {
      from: {
        firstName: from.name.split(" ")[0],
        email: from.email,
      },
      to: {
        email: email,
      },
      message: `Please click following magic link to log in.\n\n${req.protocol}://${req.headers.host}${req.path}?emailhmac=${emailHmac}&token=${token}&redirect=${req.body.redirect}`,
    }
    await nodemailerTransport.sendMail({
      from: `${from.name} <${from.email}>`,
      to: email,
      subject: "Magic link",
      text: defaultTemplate(data),
    })
    return res.send({
      message: "Check your emails",
    })
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.post("/authorize", async (req, res) => {
  try {
    const authorizationHeader = req.headers["authorization"]
    if (!authorizationHeader) {
      const error = new Error("Missing authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorizationHeader !== `Bearer ${process.env.AUTH_TOKEN}`) {
      const error = new Error("Wrong authorization header")
      console.error(error, req.headers)
      return res.status(401).send({
        error: error.message,
      })
    }
    const sessionSalt = req.body.sessionSalt
    const sessionToken = req.body.sessionToken
    const path = req.body.path
    if (!sessionSalt || sessionSalt === "") {
      const error = new Error("Missing session salt")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!sessionToken || sessionToken === "") {
      const error = new Error("Missing session token")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    if (!path || path === "") {
      const error = new Error("Missing path")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const session = await Session.findOne({
      where: { token: sessionToken },
    })
    if (!session) {
      const error = new Error("Session not found")
      console.error(error, req.body)
      return res.status(404).send({
        error: error.message,
      })
    }
    if (session.valid !== true) {
      const error = new Error("Session expired")
      console.error(error, req.body)
      return res.status(401).send({
        error: error.message,
      })
    }
    const authorization = await Authorization.findOne({
      where: {
        path: path,
        userId: session.userId,
      },
    })
    if (!authorization) {
      const error = new Error("Authorization not found")
      console.error(error, req.body)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (moment().isAfter(authorization.expiresOn)) {
      const error = new Error("Authorization expired")
      console.error(error, req.body)
      return res.status(403).send({
        error: error.message,
      })
    }
    return res.send({ authorized: true })
  } catch (error) {
    prettyError(error)
    return res.status(500).send({
      error: "Could not handle request",
    })
  }
})

app.get("/status", async (req, res) => {
  return res.sendStatus(204)
})

app.use(
  express.static("public", {
    dotfiles: "ignore",
  })
)

var polls

const loadPolls = async () => {
  const exists = await pathExists(pollsFile)
  if (exists === false) {
    polls = []
    await writeFile(pollsFile, JSON.stringify(polls, null, 2))
  } else {
    const data = await readFile(pollsFile, "utf8")
    polls = JSON.parse(data)
  }
}

var store

const loadStore = async () => {
  const exists = await pathExists(storeFile)
  if (exists === false) {
    store = {}
    await writeFile(storeFile, JSON.stringify(store, null, 2))
  } else {
    const data = await readFile(storeFile, "utf8")
    store = JSON.parse(data)
  }
}

var defaultTemplate
var orderConfirmationTemplate

const loadTemplates = async () => {
  const defaultTemplateData = await readFile(defaultTemplateFile, "utf8")
  defaultTemplate = handlebars.compile(defaultTemplateData)
  const orderConfirmationTemplateData = await readFile(
    orderConfirmationTemplateFile,
    "utf8"
  )
  orderConfirmationTemplate = handlebars.compile(orderConfirmationTemplateData)
}

class Download extends Model {}
class Authorization extends Model {}
class Poll extends Model {}
class Session extends Model {}
class User extends Model {}

const initializeDatabase = async () => {
  Download.init(
    {
      path: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      filename: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      token: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      expiresOn: {
        type: DataTypes.DATE,
      },
    },
    { sequelize, modelName: "downloads" }
  )
  Authorization.init(
    {
      path: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      expiresOn: {
        type: DataTypes.DATE,
      },
    },
    { sequelize, modelName: "authorizations" }
  )
  Poll.init(
    {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true,
      },
      response: {
        type: DataTypes.STRING(1024),
        allowNull: false,
      },
    },
    { sequelize, modelName: "polls" }
  )
  Session.init(
    {
      token: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      hmac: {
        type: DataTypes.STRING,
        allowNull: false,
      },
      valid: {
        type: DataTypes.BOOLEAN,
        defaultValue: true,
      },
    },
    { sequelize, modelName: "sessions" }
  )
  User.init(
    {
      emailHmac: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true,
      },
      token: {
        type: DataTypes.STRING,
        allowNull: true,
      },
    },
    { sequelize, modelName: "users" }
  )
  User.hasMany(Authorization, {
    foreignKey: {
      name: "userId",
      allowNull: false,
    },
    onDelete: "CASCADE",
  })
  User.hasMany(Session, {
    foreignKey: {
      name: "userId",
      allowNull: false,
    },
    onDelete: "CASCADE",
  })
  await sequelize.sync()
  if (process.env.DEBUG === "true") {
    console.info("Database synched")
  }
}

const initializeServer = async () => {
  const server = await app.listen(process.env.PORT)
  const serverAddress = server.address()
  if (process.env.DEBUG === "true" && typeof serverAddress === "object") {
    console.info(`Server listening on port ${serverAddress.port}`)
  }
}

const run = async () => {
  try {
    await loadPolls()
    await loadStore()
    await loadTemplates()
    await initializeDatabase()
    await initializeServer()
  } catch (error) {
    prettyError(error)
    process.exit(1)
  }
}

run()
