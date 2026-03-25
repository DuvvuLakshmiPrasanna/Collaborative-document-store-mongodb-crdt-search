const { getDb } = require("./db");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const { countWords, slugify } = require("./utils");

const BASE_TAGS = [
  "mongodb",
  "guide",
  "api",
  "architecture",
  "search",
  "analytics",
  "backend",
  "crdt",
  "concurrency",
  "schema",
  "docker",
  "performance",
];

const CONTENT_SNIPPETS = [
  "MongoDB offers a flexible document model for wiki-like systems.",
  "Optimistic concurrency control avoids lost updates in collaborative editing.",
  "Full-text search with text indexes can rank relevant content efficiently.",
  "Aggregation pipelines provide rich analytics over document datasets.",
  "Schema evolution can be handled with lazy migration and background workers.",
  "Versioning strategies are critical for maintaining data integrity.",
  "Tag co-occurrence helps discover topical relationships.",
  "Dockerized deployments make local and CI environments reproducible.",
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pickTags() {
  const count = randomInt(2, 4);
  const copy = [...BASE_TAGS];
  const selected = [];
  for (let i = 0; i < count; i += 1) {
    const idx = randomInt(0, copy.length - 1);
    selected.push(copy[idx]);
    copy.splice(idx, 1);
  }
  return selected;
}

function generateRevisionHistory(version, authorId, updatedAt) {
  const maxHistory = Math.min(5, version - 1);
  const historyLength = maxHistory > 0 ? randomInt(1, maxHistory) : 0;
  const startVersion = version - historyLength + 1;
  const history = [];

  for (let v = startVersion; v <= version; v += 1) {
    history.push({
      version: v,
      updatedAt: new Date(updatedAt.getTime() - (version - v) * 60000),
      authorId,
      contentDiff: `Auto-generated revision ${v}.`,
    });
  }

  return history;
}

function parseWikipediaStubPages() {
  const stubPath = path.join(__dirname, "..", "data", "wikipedia_stub.xml");
  if (!fs.existsSync(stubPath)) {
    return [];
  }

  const xml = fs.readFileSync(stubPath, "utf8");
  const pages = [];
  const pageRegex = /<page>([\s\S]*?)<\/page>/g;
  let pageMatch = pageRegex.exec(xml);

  while (pageMatch) {
    const pageXml = pageMatch[1];
    const titleMatch = pageXml.match(/<title>([\s\S]*?)<\/title>/);
    const textMatch = pageXml.match(/<text>([\s\S]*?)<\/text>/);

    if (titleMatch && textMatch) {
      pages.push({
        title: titleMatch[1].trim(),
        text: textMatch[1].trim(),
      });
    }

    pageMatch = pageRegex.exec(xml);
  }

  return pages;
}

function buildSeedDocument(i, sourcePage) {
  const title = sourcePage?.title || `Wiki Topic ${i + 1}`;
  const slug = `${slugify(title)}-${i + 1}`;
  const snippetA = sourcePage?.text || CONTENT_SNIPPETS[i % CONTENT_SNIPPETS.length];
  const snippetB = CONTENT_SNIPPETS[(i + 3) % CONTENT_SNIPPETS.length];
  const content = `# ${title}\n\n${snippetA}\n\n${snippetB}\n\nThis page index is ${i + 1}.`;
  const version = randomInt(2, 8);
  const tags = pickTags();
  const createdAt = new Date(Date.now() - randomInt(1, 365) * 24 * 60 * 60000);
  const updatedAt = new Date(createdAt.getTime() + randomInt(1, 50000) * 60000);
  const authorId = `seed-user-${(i % 250) + 1}`;
  const authorName = `Seed Author ${(i % 250) + 1}`;
  const authorEmail = `seed${(i % 250) + 1}@example.com`;

  const author = i % 10 === 9
    ? authorName
    : {
      id: authorId,
      name: authorName,
      email: authorEmail,
    };

  return {
    slug,
    title,
    content,
    version,
    tags,
    metadata: {
      author,
      createdAt,
      updatedAt,
      wordCount: countWords(content),
    },
    revision_history: generateRevisionHistory(version, authorId, updatedAt),
  };
}

async function ensureIndexes(collection) {
  await collection.createIndex({ slug: 1 }, { unique: true, name: "slug_unique_idx" });
  await collection.createIndex({ title: "text", content: "text" }, { name: "title_content_text_idx" });
}

async function seedDocumentsIfNeeded() {
  const db = getDb();
  const collection = db.collection("documents");

  await ensureIndexes(collection);

  const existing = await collection.estimatedDocumentCount();
  if (existing > 0) {
    return { seeded: false, count: existing };
  }

  const total = config.seedCount;
  const batchSize = config.seedBatchSize;
  const stubPages = parseWikipediaStubPages();

  for (let start = 0; start < total; start += batchSize) {
    const docs = [];
    const end = Math.min(start + batchSize, total);
    for (let i = start; i < end; i += 1) {
      const sourcePage = stubPages.length > 0 ? stubPages[i % stubPages.length] : null;
      docs.push(buildSeedDocument(i, sourcePage));
    }
    await collection.insertMany(docs, { ordered: false });
  }

  const count = await collection.estimatedDocumentCount();
  return { seeded: true, count };
}

module.exports = {
  seedDocumentsIfNeeded,
};