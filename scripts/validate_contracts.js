require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3000";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DATABASE_NAME = process.env.DATABASE_NAME || "collab_docs";

let passCount = 0;
let failCount = 0;

function pass(message) {
  passCount += 1;
  console.log(`PASS: ${message}`);
}

function fail(message) {
  failCount += 1;
  console.log(`FAIL: ${message}`);
}

function assert(condition, message) {
  if (condition) {
    pass(message);
  } else {
    fail(message);
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasRequiredTopLevelFields(doc) {
  return (
    isObject(doc) &&
    typeof doc.slug === "string" &&
    typeof doc.title === "string" &&
    typeof doc.content === "string" &&
    typeof doc.version === "number" &&
    Array.isArray(doc.tags) &&
    isObject(doc.metadata) &&
    Array.isArray(doc.revision_history)
  );
}

async function requestJson(method, pathName, body) {
  const response = await fetch(`${API_BASE_URL}${pathName}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  let parsed = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_e) {
      parsed = text;
    }
  }

  return { response, body: parsed };
}

async function main() {
  const repoRoot = path.join(__dirname, "..");

  // Contract 1 + 11 + 13: Required files exist.
  assert(fs.existsSync(path.join(repoRoot, "docker-compose.yml")), "docker-compose.yml exists at repository root");
  assert(fs.existsSync(path.join(repoRoot, "Dockerfile")), "Dockerfile exists at repository root");
  assert(fs.existsSync(path.join(repoRoot, ".env.example")), ".env.example exists at repository root");
  assert(fs.existsSync(path.join(repoRoot, "scripts", "migrate_author_schema.js")), "Background migration script exists at scripts/migrate_author_schema.js");

  const envExample = fs.readFileSync(path.join(repoRoot, ".env.example"), "utf8");
  assert(envExample.includes("MONGO_URI="), ".env.example documents MONGO_URI");
  assert(envExample.includes("DATABASE_NAME="), ".env.example documents DATABASE_NAME");
  assert(envExample.includes("PORT="), ".env.example documents PORT");

  // Connect DB for seed/index/schema checks and deterministic test fixtures.
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const collection = db.collection("documents");

  const docCount = await collection.countDocuments();
  assert(docCount >= 1000, "documents collection contains at least 1000 documents");

  const indexes = await collection.indexes();
  const hasUniqueSlugIndex = indexes.some((idx) => idx.unique && idx.key && idx.key.slug === 1);
  const hasTextIndex = indexes.some((idx) => idx.key && idx.key._fts === "text");
  assert(hasUniqueSlugIndex, "documents has unique index on slug");
  assert(hasTextIndex, "documents has text index on title/content");

  const sample = await collection.findOne({}, { projection: { slug: 1, title: 1, content: 1, version: 1, tags: 1, metadata: 1, revision_history: 1 } });
  assert(hasRequiredTopLevelFields(sample), "sample document matches required top-level schema");
  assert(isObject(sample?.metadata?.author) || typeof sample?.metadata?.author === "string", "sample metadata.author exists in expected old/new schema form");

  // Contract 3: POST /api/documents
  const createPayload = {
    title: "Contract Validation Create",
    content: "MongoDB validation content for creation endpoint.",
    tags: ["contract-test", "guide"],
    authorName: "Validator",
    authorEmail: "validator@example.com",
  };
  const createdRes = await requestJson("POST", "/api/documents", createPayload);
  assert(createdRes.response.status === 201, "POST /api/documents returns 201");
  const createdDoc = createdRes.body;
  assert(hasRequiredTopLevelFields(createdDoc), "POST response contains full document schema");
  assert(createdDoc?.version === 1, "POST response initializes version to 1");
  const persistedCreated = await collection.findOne({ slug: createdDoc?.slug });
  assert(!!persistedCreated, "Created document is persisted in MongoDB by slug");

  // Contract 4: GET /api/documents/:slug and 404 behavior
  const getExistingRes = await requestJson("GET", `/api/documents/${createdDoc.slug}`);
  assert(getExistingRes.response.status === 200, "GET /api/documents/:slug returns 200 for existing document");
  assert(getExistingRes.body?.slug === createdDoc.slug, "GET /api/documents/:slug returns expected document");

  const missingSlug = `missing-${Date.now()}`;
  const getMissingRes = await requestJson("GET", `/api/documents/${missingSlug}`);
  assert(getMissingRes.response.status === 404, "GET /api/documents/:slug returns 404 for missing document");

  // Contract 5: PUT success with OCC
  await collection.updateOne(
    { slug: createdDoc.slug },
    {
      $set: {
        version: 5,
        revision_history: [
          { version: 1, updatedAt: new Date(), authorId: "v", contentDiff: "v1" },
          { version: 2, updatedAt: new Date(), authorId: "v", contentDiff: "v2" },
          { version: 3, updatedAt: new Date(), authorId: "v", contentDiff: "v3" },
          { version: 4, updatedAt: new Date(), authorId: "v", contentDiff: "v4" },
          { version: 5, updatedAt: new Date(), authorId: "v", contentDiff: "v5" },
        ],
      },
    }
  );

  const putSuccessRes = await requestJson("PUT", `/api/documents/${createdDoc.slug}`, {
    title: "Contract Validation Create Updated",
    content: "Updated content for OCC success validation.",
    version: 5,
    tags: ["contract-test", "guide"],
  });
  assert(putSuccessRes.response.status === 200, "PUT /api/documents/:slug returns 200 when version matches");
  assert(putSuccessRes.body?.version === 6, "PUT success increments version from 5 to 6");
  const latestAfterPut = await collection.findOne({ slug: createdDoc.slug });
  assert(Array.isArray(latestAfterPut?.revision_history) && latestAfterPut.revision_history.some((r) => r.version === 6), "PUT success appends revision history entry for new version");

  // Contract 6: PUT conflict returns 409 with latest document
  const conflictRes = await requestJson("PUT", `/api/documents/${createdDoc.slug}`, {
    title: "Stale Update",
    content: "This should conflict",
    version: 4,
  });
  assert(conflictRes.response.status === 409, "PUT /api/documents/:slug returns 409 for stale version");
  const docAfterConflict = await collection.findOne({ slug: createdDoc.slug });
  assert(docAfterConflict?.version === 6, "Stale PUT does not modify persisted document");
  assert(conflictRes.body?.version === 6, "409 response contains latest persisted document");

  // Contract 7 + 8: Search by keyword and tags with score sorting.
  const uniqueKeyword = `kw-${Date.now()}`;
  const searchDocs = [
    {
      slug: `search-a-${Date.now()}`,
      title: `Search A ${uniqueKeyword}`,
      content: `${uniqueKeyword} ${uniqueKeyword} ${uniqueKeyword} alpha`,
      version: 1,
      tags: ["search-contract", "guide"],
      metadata: { author: { id: "1", name: "A", email: null }, createdAt: new Date(), updatedAt: new Date(), wordCount: 4 },
      revision_history: [{ version: 1, updatedAt: new Date(), authorId: "1", contentDiff: "init" }],
    },
    {
      slug: `search-b-${Date.now()}`,
      title: `Search B ${uniqueKeyword}`,
      content: `${uniqueKeyword} beta`,
      version: 1,
      tags: ["search-contract"],
      metadata: { author: { id: "2", name: "B", email: null }, createdAt: new Date(), updatedAt: new Date(), wordCount: 2 },
      revision_history: [{ version: 1, updatedAt: new Date(), authorId: "2", contentDiff: "init" }],
    },
    {
      slug: `search-c-${Date.now()}`,
      title: "Unrelated title",
      content: "does not include token",
      version: 1,
      tags: ["guide"],
      metadata: { author: { id: "3", name: "C", email: null }, createdAt: new Date(), updatedAt: new Date(), wordCount: 4 },
      revision_history: [{ version: 1, updatedAt: new Date(), authorId: "3", contentDiff: "init" }],
    },
  ];
  await collection.insertMany(searchDocs, { ordered: true });

  const searchRes = await requestJson("GET", `/api/search?q=${encodeURIComponent(uniqueKeyword)}`);
  assert(searchRes.response.status === 200 && Array.isArray(searchRes.body), "GET /api/search returns 200 with array response");
  const resultSlugs = new Set((searchRes.body || []).map((d) => d.slug));
  assert(resultSlugs.has(searchDocs[0].slug) && resultSlugs.has(searchDocs[1].slug), "Search returns inserted keyword fixtures");
  const scores = (searchRes.body || []).map((d) => (typeof d.score === "number" ? d.score : -Infinity));
  const sortedDesc = scores.every((score, idx) => idx === 0 || score <= scores[idx - 1]);
  assert((searchRes.body || []).every((d) => typeof d.score === "number"), "Search results include numeric score field");
  assert(sortedDesc, "Search results are sorted by descending relevance score");

  const searchWithTagsRes = await requestJson("GET", `/api/search?q=${encodeURIComponent(uniqueKeyword)}&tags=guide`);
  assert(searchWithTagsRes.response.status === 200 && Array.isArray(searchWithTagsRes.body), "GET /api/search with tags returns 200 with array response");
  const allContainGuide = (searchWithTagsRes.body || []).every((d) => Array.isArray(d.tags) && d.tags.includes("guide"));
  const taggedResultSlugs = new Set((searchWithTagsRes.body || []).map((d) => d.slug));
  assert(allContainGuide && taggedResultSlugs.has(searchDocs[0].slug) && !taggedResultSlugs.has(searchDocs[1].slug), "Search with tags returns docs matching keyword and required tag(s)");

  // Contract 9: most-edited analytics.
  const analyticsRes = await requestJson("GET", "/api/analytics/most-edited");
  assert(analyticsRes.response.status === 200 && Array.isArray(analyticsRes.body), "GET /api/analytics/most-edited returns 200 with array response");
  assert((analyticsRes.body || []).length <= 10, "most-edited response size is at most 10");
  const edits = (analyticsRes.body || []).map((d) => d.editCount);
  const editsDesc = edits.every((v, i) => i === 0 || v <= edits[i - 1]);
  assert(editsDesc, "most-edited response is sorted by editCount descending");

  // Contract 10: tag co-occurrence analytics with deterministic fixtures.
  const coTagA = `co-a-${Date.now()}`;
  const coTagB = `co-b-${Date.now()}`;
  const coTagC = `co-c-${Date.now()}`;
  const now = new Date();
  await collection.insertMany([
    {
      slug: `co-1-${Date.now()}`,
      title: "co1",
      content: "co1",
      version: 1,
      tags: [coTagA, coTagB],
      metadata: { author: { id: "co", name: "co", email: null }, createdAt: now, updatedAt: now, wordCount: 1 },
      revision_history: [{ version: 1, updatedAt: now, authorId: "co", contentDiff: "init" }],
    },
    {
      slug: `co-2-${Date.now()}`,
      title: "co2",
      content: "co2",
      version: 1,
      tags: [coTagA, coTagB, coTagC],
      metadata: { author: { id: "co", name: "co", email: null }, createdAt: now, updatedAt: now, wordCount: 1 },
      revision_history: [{ version: 1, updatedAt: now, authorId: "co", contentDiff: "init" }],
    },
  ]);

  const coRes = await requestJson("GET", "/api/analytics/tag-cooccurrence");
  assert(coRes.response.status === 200 && Array.isArray(coRes.body), "GET /api/analytics/tag-cooccurrence returns 200 with array response");
  const targetPair = (coRes.body || []).find((p) =>
    Array.isArray(p.tags) && p.tags.length === 2 && p.tags.includes(coTagA) && p.tags.includes(coTagB)
  );
  assert(!!targetPair && targetPair.count >= 2, "tag-cooccurrence includes expected known pair with correct frequency");

  // Contract 12: lazy schema upgrade on read.
  const legacySlug = `legacy-author-${Date.now()}`;
  await collection.insertOne({
    slug: legacySlug,
    title: "Legacy Author Document",
    content: "legacy",
    version: 1,
    tags: ["legacy"],
    metadata: {
      author: "Old Author Name",
      createdAt: new Date(),
      updatedAt: new Date(),
      wordCount: 2,
    },
    revision_history: [{ version: 1, updatedAt: new Date(), authorId: null, contentDiff: "init" }],
  });

  const legacyRes = await requestJson("GET", `/api/documents/${legacySlug}`);
  assert(legacyRes.response.status === 200, "GET /api/documents/:slug returns 200 for legacy-schema document");
  const transformedAuthor = legacyRes.body?.metadata?.author;
  assert(isObject(transformedAuthor), "Legacy metadata.author is transformed to object in API response");
  assert(transformedAuthor?.id === null && transformedAuthor?.name === "Old Author Name" && transformedAuthor?.email === null, "Lazy migration author object has expected {id:null,name,email:null} structure");

  await client.close();

  const total = passCount + failCount;
  console.log("\n================ Contract Validation Summary ================");
  console.log(`API_BASE_URL: ${API_BASE_URL}`);
  console.log(`DATABASE_NAME: ${DATABASE_NAME}`);
  console.log(`Total checks: ${total}`);
  console.log(`Passed: ${passCount}`);
  console.log(`Failed: ${failCount}`);

  if (failCount > 0) {
    process.exit(1);
  }
}

main().catch(async (error) => {
  fail(`Unhandled validation error: ${error.message}`);
  console.error(error);
  process.exit(1);
});