const { MongoClient } = require("mongodb");
const config = require("./config");

const client = new MongoClient(config.mongoUri);

let db;

async function connectDb() {
  if (db) {
    return db;
  }

  await client.connect();
  db = client.db(config.databaseName);
  return db;
}

function getDb() {
  if (!db) {
    throw new Error("Database not connected. Call connectDb() first.");
  }
  return db;
}

async function closeDb() {
  await client.close();
}

module.exports = {
  connectDb,
  getDb,
  closeDb,
};