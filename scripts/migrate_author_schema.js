require("dotenv").config();
const { MongoClient } = require("mongodb");

const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DATABASE_NAME = process.env.DATABASE_NAME || "collab_docs";
const BATCH_SIZE = Number(process.env.MIGRATION_BATCH_SIZE || 1000);

async function runMigration() {
  const client = new MongoClient(MONGO_URI);
  await client.connect();

  try {
    const db = client.db(DATABASE_NAME);
    const collection = db.collection("documents");

    const total = await collection.countDocuments({ "metadata.author": { $type: "string" } });
    console.log(`Found ${total} documents with old author schema.`);

    if (total === 0) {
      console.log("No migration needed.");
      return;
    }

    const cursor = collection
      .find(
        { "metadata.author": { $type: "string" } },
        { projection: { _id: 1, "metadata.author": 1 } }
      )
      .sort({ _id: 1 });

    let operations = [];
    let processed = 0;

    while (await cursor.hasNext()) {
      const doc = await cursor.next();
      const authorName = doc.metadata.author;

      operations.push({
        updateOne: {
          filter: { _id: doc._id, "metadata.author": { $type: "string" } },
          update: {
            $set: {
              "metadata.author": {
                id: null,
                name: authorName,
                email: null,
              },
            },
          },
        },
      });

      if (operations.length >= BATCH_SIZE) {
        const result = await collection.bulkWrite(operations, { ordered: false });
        processed += result.modifiedCount;
        operations = [];
        console.log(`Migrated ${processed}/${total} documents...`);
      }
    }

    if (operations.length > 0) {
      const result = await collection.bulkWrite(operations, { ordered: false });
      processed += result.modifiedCount;
      console.log(`Migrated ${processed}/${total} documents...`);
    }

    console.log("Author schema migration completed.");
  } finally {
    await client.close();
  }
}

runMigration().catch((error) => {
  console.error("Migration failed:", error);
  process.exit(1);
});