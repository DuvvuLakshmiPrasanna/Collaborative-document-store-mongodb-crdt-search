require("dotenv").config();

const config = {
  port: Number(process.env.PORT || 3000),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017",
  databaseName: process.env.DATABASE_NAME || "collab_docs",
  seedCount: Number(process.env.SEED_COUNT || 10000),
  seedBatchSize: Number(process.env.SEED_BATCH_SIZE || 1000),
};

module.exports = config;