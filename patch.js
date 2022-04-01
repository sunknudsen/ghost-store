"use strict"

const dotenv = require("dotenv")
const { Sequelize, DataTypes } = require("sequelize")

dotenv.config()

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

const patch = async () => {
  await sequelize.query("ALTER TABLE polls MODIFY response VARCHAR(1024)")
  console.log("Done")
  process.exit(0)
}

patch()
