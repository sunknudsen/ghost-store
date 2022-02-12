"use strict"

const dotenv = require("dotenv")
const express = require("express")
const bodyParser = require("body-parser")
const { Sequelize, Model, DataTypes } = require("sequelize")
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
const templateFile = join(__dirname, "template.hbs")

const downloadLinkExpiry = process.env.DOWNLOAD_LINK_EXPIRY

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

const sendOrderConfirmationEmail = async (to, path, product) => {
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
        `${process.env.BASE_URL}/downloads/${download.filename}?token=${download.token}`
      )
    }
  }
  const links = []
  if (product.links) {
    for (const link of product.links) {
      links.push(link)
    }
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
      name: from.name,
      firstName: from.name.split(" ")[0],
      email: from.email,
    },
    to: {
      name: to.name,
      firstName: to.name.split(" ")[0],
      email: to.email,
    },
    downloads: downloads,
    links: links,
  }
  if (downloads.length > 0) {
    data.expiry = moment.duration(downloadLinkExpiry, "hours").humanize()
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
    text: template(data),
  })
  return info
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

const nodemailerTransport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT),
  requireTLS: true,
  secure: false,
  auth: {
    user: process.env.SMTP_USERNAME,
    pass: process.env.SMTP_PASSWORD,
  },
})

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
    if (type !== "checkout.session.completed") {
      const error = new Error("Invalid Stripe webhook type")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    const sessionId = req.body.data.object.id
    const session = await stripeClient.get(
      `v1/checkout/sessions/${sessionId}?expand[]=customer&expand[]=line_items`,
      {
        responseType: "json",
      }
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
      await sendOrderConfirmationEmail(to, path, product)
      orderConfirmationEmailSent = true
    }
    if (orderConfirmationEmailSent === true) {
      return res.sendStatus(201)
    } else {
      return res.sendStatus(200)
    }
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.post("/admin", async (req, res) => {
  try {
    const authorization = req.headers["authorization"]
    if (!authorization) {
      const error = new Error("Missing authorization header")
      console.error(error)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      const error = new Error("Wrong authorization header")
      console.error(error, authorization)
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
    await sendOrderConfirmationEmail(to, path, product)
    return res.sendStatus(202)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/store", async (req, res) => {
  try {
    if (!req.query.path || req.query.path === "") {
      const error = new Error("Missing path")
      console.error(error, req.query)
      return res.status(400).send({
        error: error.message,
      })
    }
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
    const path = req.query.path
    const product = store[path]
    if (!product) {
      const error = new Error("Product not found")
      console.error(error, req.headers.authorization)
      return res.status(404).send({
        error: error.message,
      })
    }
    if (product.members !== true) {
      const error = new Error("Product paid-only")
      console.error(error, req.headers.authorization)
      return res.status(403).send({
        error: error.message,
      })
    }
    const to = {
      name: member.name,
      email: member.email,
    }
    await sendOrderConfirmationEmail(to, path, product)
    return res.redirect(process.env.GHOST_CONFIRMATION_PAGE)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/downloads/:filename", async (req, res) => {
  try {
    if (!req.query.token) {
      const error = new Error("Missing token")
      console.error(error)
      return res.status(401).send({
        error: error.message,
      })
    }
    const download = await Download.findOne({
      where: { token: req.query.token },
    })
    if (!download) {
      const error = new Error("Wrong token")
      console.error(error, req.query.token)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (moment().isAfter(download.expiresOn)) {
      const error = new Error("Download expired")
      console.error(error)
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
        expiresOn: moment().add(downloadLinkExpiry, "hour").toDate(),
      })
    }
    return res
      .set("Content-Disposition", `attachment; filename="${download.filename}"`)
      .sendFile(filePath)
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
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
    if (!polls.includes(req.body.name)) {
      const error = new Error("Invalid name")
      console.error(error, req.body)
      return res.status(400).send({
        error: error.message,
      })
    }
    await Poll.create({
      name: req.body.name,
      response: req.body.response,
    })
    return res.status(201).send("Thanks! 🙌")
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/polls/:name", async (req, res) => {
  try {
    const authorization = req.headers["authorization"]
    if (!authorization) {
      const error = new Error("Missing authorization header")
      console.error(error)
      return res.status(401).send({
        error: error.message,
      })
    }
    if (authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) {
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
    if (!polls.includes(req.params.name)) {
      const error = new Error("Invalid name")
      console.error(error, req.params)
      return res.status(400).send({
        error: error.message,
      })
    }
    const rows = await Poll.findAll({
      attributes: ["name", "response"],
      where: {
        name: req.params.name,
      },
    })
    const responses = []
    rows.forEach((row) => {
      responses.push(row.response)
    })
    return res.status(200).send({
      name: req.params.name,
      responses: responses,
    })
  } catch (error) {
    prettyError(error)
    return res.sendStatus(500)
  }
})

app.get("/status", async (req, res) => {
  return res.sendStatus(204)
})

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

var template

const loadTemplate = async () => {
  const data = await readFile(templateFile, "utf8")
  template = handlebars.compile(data)
}

class Download extends Model {}
class Poll extends Model {}

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
  Poll.init(
    {
      name: {
        type: DataTypes.STRING,
        allowNull: false,
        index: true,
      },
      response: {
        type: DataTypes.STRING,
        allowNull: false,
      },
    },
    { sequelize, modelName: "polls" }
  )
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
    await loadTemplate()
    await initializeDatabase()
    await initializeServer()
  } catch (error) {
    prettyError(error)
    process.exit(1)
  }
}

run()
