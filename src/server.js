const express = require("express");
const { ObjectId } = require("mongodb");
const config = require("./config");
const { connectDb, getDb, closeDb } = require("./db");
const { seedDocumentsIfNeeded } = require("./seed");
const {
  slugify,
  countWords,
  parseTags,
  ensureAuthorObject,
  makeContentDiff,
} = require("./utils");

const app = express();
app.use(express.json({ limit: "2mb" }));

function withLazyAuthorMigration(doc) {
  if (!doc) {
    return doc;
  }

  const result = {
    ...doc,
    metadata: {
      ...doc.metadata,
      author: ensureAuthorObject(doc.metadata?.author),
    },
  };

  return result;
}

async function generateUniqueSlug(title) {
  const db = getDb();
  const collection = db.collection("documents");

  const base = slugify(title) || `document-${Date.now()}`;
  let candidate = base;
  let suffix = 1;

  while (await collection.findOne({ slug: candidate }, { projection: { _id: 1 } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/api/documents", async (req, res) => {
  try {
    const { title, content, tags, authorName, authorEmail } = req.body || {};

    if (!title || !content || !authorName) {
      return res.status(400).json({
        error: "title, content, and authorName are required",
      });
    }

    const db = getDb();
    const collection = db.collection("documents");

    const slug = await generateUniqueSlug(title);
    const now = new Date();
    const doc = {
      slug,
      title: String(title),
      content: String(content),
      version: 1,
      tags: parseTags(tags),
      metadata: {
        author: {
          id: new ObjectId().toHexString(),
          name: String(authorName),
          email: authorEmail ? String(authorEmail) : null,
        },
        createdAt: now,
        updatedAt: now,
        wordCount: countWords(content),
      },
      revision_history: [
        {
          version: 1,
          updatedAt: now,
          authorId: null,
          contentDiff: "Initial version created.",
        },
      ],
    };

    await collection.insertOne(doc);
    return res.status(201).json(doc);
  } catch (error) {
    if (error && error.code === 11000) {
      return res.status(409).json({ error: "A document with this slug already exists" });
    }
    return res.status(500).json({ error: "Failed to create document" });
  }
});

app.get("/api/documents/:slug", async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection("documents");

    const doc = await collection.findOne({ slug: req.params.slug });
    if (!doc) {
      return res.status(404).json({ error: "Document not found" });
    }

    return res.status(200).json(withLazyAuthorMigration(doc));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to fetch document" });
  }
});

app.delete("/api/documents/:slug", async (req, res) => {
  try {
    const db = getDb();
    const collection = db.collection("documents");

    const result = await collection.deleteOne({ slug: req.params.slug });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Document not found" });
    }

    return res.status(200).json({ deleted: true });
  } catch (_error) {
    return res.status(500).json({ error: "Failed to delete document" });
  }
});

app.put("/api/documents/:slug", async (req, res) => {
  try {
    const { title, content, version, tags } = req.body || {};
    if (!title || !content || typeof version !== "number") {
      return res.status(400).json({ error: "title, content and numeric version are required" });
    }

    const db = getDb();
    const collection = db.collection("documents");

    const existing = await collection.findOne({ slug: req.params.slug });
    if (!existing) {
      return res.status(404).json({ error: "Document not found" });
    }

    const nextVersion = version + 1;
    const now = new Date();
    const diff = makeContentDiff(existing, String(title), String(content));
    const historyEntry = {
      version: nextVersion,
      updatedAt: now,
      authorId: ensureAuthorObject(existing.metadata?.author).id,
      contentDiff: diff,
    };

    const updated = await collection.findOneAndUpdate(
      { slug: req.params.slug, version },
      {
        $set: {
          title: String(title),
          content: String(content),
          tags: tags !== undefined ? parseTags(tags) : existing.tags,
          "metadata.updatedAt": now,
          "metadata.wordCount": countWords(content),
        },
        $inc: { version: 1 },
        $push: {
          revision_history: {
            $each: [historyEntry],
            $slice: -20,
          },
        },
      },
      { returnDocument: "after", includeResultMetadata: false }
    );

    if (!updated) {
      const latest = await collection.findOne({ slug: req.params.slug });
      return res.status(409).json(withLazyAuthorMigration(latest));
    }

    return res.status(200).json(withLazyAuthorMigration(updated));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to update document" });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const q = req.query.q ? String(req.query.q).trim() : "";
    const tags = parseTags(req.query.tags);

    if (!q) {
      return res.status(400).json({ error: "Query parameter q is required" });
    }

    const db = getDb();
    const collection = db.collection("documents");

    const filter = {
      $text: { $search: q },
    };

    if (tags.length > 0) {
      filter.tags = { $all: tags };
    }

    const projection = {
      score: { $meta: "textScore" },
      slug: 1,
      title: 1,
      content: 1,
      version: 1,
      tags: 1,
      metadata: 1,
      revision_history: 1,
    };

    const results = await collection
      .find(filter, { projection })
      .sort({ score: { $meta: "textScore" } })
      .toArray();

    return res.status(200).json(results.map(withLazyAuthorMigration));
  } catch (_error) {
    return res.status(500).json({ error: "Failed to run search" });
  }
});

app.get("/api/analytics/most-edited", async (_req, res) => {
  try {
    const db = getDb();
    const collection = db.collection("documents");

    const pipeline = [
      {
        $project: {
          _id: 0,
          slug: 1,
          title: 1,
          editCount: { $size: { $ifNull: ["$revision_history", []] } },
        },
      },
      { $sort: { editCount: -1, slug: 1 } },
      { $limit: 10 },
    ];

    const results = await collection.aggregate(pipeline).toArray();
    return res.status(200).json(results);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to calculate most edited documents" });
  }
});

app.get("/api/analytics/tag-cooccurrence", async (_req, res) => {
  try {
    const db = getDb();
    const collection = db.collection("documents");

    const normalizedPipeline = [
      {
        $project: {
          uniqueTags: { $setUnion: [{ $ifNull: ["$tags", []] }, []] },
        },
      },
      {
        $project: {
          tagsA: "$uniqueTags",
          tagsB: "$uniqueTags",
        },
      },
      { $unwind: "$tagsA" },
      { $unwind: "$tagsB" },
      {
        $match: {
          $expr: { $lt: ["$tagsA", "$tagsB"] },
        },
      },
      {
        $group: {
          _id: {
            a: "$tagsA",
            b: "$tagsB",
          },
          count: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          tags: ["$_id.a", "$_id.b"],
          count: 1,
        },
      },
      { $sort: { count: -1, tags: 1 } },
    ];

    const results = await collection.aggregate(normalizedPipeline).toArray();
    return res.status(200).json(results);
  } catch (_error) {
    return res.status(500).json({ error: "Failed to calculate tag co-occurrence" });
  }
});

async function start() {
  // eslint-disable-next-line no-console
  console.log("MONGO_URI:", process.env.MONGO_URI);
  await connectDb();
  const seedResult = await seedDocumentsIfNeeded();
  if (seedResult.seeded) {
    // eslint-disable-next-line no-console
    console.log(`Seeded documents collection with ${seedResult.count} records`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`Documents collection already populated (${seedResult.count} records)`);
  }

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`API server listening on port ${config.port}`);
  });
}

start().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start server", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await closeDb();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await closeDb();
  process.exit(0);
});