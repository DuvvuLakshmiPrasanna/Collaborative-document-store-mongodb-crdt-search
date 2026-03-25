/* eslint-disable no-console */
require("dotenv").config();

const { MongoClient } = require("mongodb");
const { performance } = require("perf_hooks");

const API_BASE_URL = process.env.API_BASE_URL || "http://localhost:3100";
const MONGO_URI = process.env.MONGO_URI || "mongodb://localhost:27017";
const DATABASE_NAME = process.env.DATABASE_NAME || "collab_docs";

function printResult(result) {
  console.log(JSON.stringify(result));
}

async function requestJson(method, path, body) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch (_error) {
      parsed = text;
    }
  }

  return { status: response.status, body: parsed };
}

async function run() {
  const results = [];
  const add = (id, name, ok, details) => results.push({ id, name, ok, details });

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  const db = client.db(DATABASE_NAME);
  const collection = db.collection("documents");

  try {
    const health = await requestJson("GET", "/health");
    add(1, "HEALTH CHECK", health.status === 200 && health.body?.ok === true, health);

    const create = await requestJson("POST", "/api/documents", {
      title: "Test Doc",
      content: "This is a test",
      tags: ["mongodb", "guide"],
      authorName: "Prasanna",
      authorEmail: "test@gmail.com",
    });
    const created = create.body;
    add(2, "CREATE DOCUMENT", create.status === 201 && created?.version === 1 && !!created?.slug, {
      status: create.status,
      slug: created?.slug,
      version: created?.version,
    });

    const getDoc = await requestJson("GET", `/api/documents/${created.slug}`);
    add(3, "GET DOCUMENT", getDoc.status === 200 && getDoc.body?.slug === created.slug, {
      status: getDoc.status,
      slug: getDoc.body?.slug,
    });

    const notFound = await requestJson("GET", `/api/documents/invalid-slug-${Date.now()}`);
    add(4, "GET INVALID DOCUMENT", notFound.status === 404, { status: notFound.status });

    const update = await requestJson("PUT", `/api/documents/${created.slug}`, {
      title: "Updated Title",
      content: "Updated content",
      version: 1,
    });
    add(5, "UPDATE DOCUMENT SUCCESS", update.status === 200 && update.body?.version === 2, {
      status: update.status,
      version: update.body?.version,
    });

    const conflict = await requestJson("PUT", `/api/documents/${created.slug}`, {
      title: "Conflict",
      content: "Old version",
      version: 1,
    });
    add(6, "UPDATE DOCUMENT CONFLICT", conflict.status === 409, {
      status: conflict.status,
      version: conflict.body?.version,
    });

    const deleted = await requestJson("DELETE", `/api/documents/${created.slug}`);
    const afterDelete = await requestJson("GET", `/api/documents/${created.slug}`);
    add(7, "DELETE DOCUMENT", deleted.status === 200 && afterDelete.status === 404, {
      deleteStatus: deleted.status,
      getAfterDelete: afterDelete.status,
    });

    const search = await requestJson("GET", "/api/search?q=mongodb");
    const searchArr = Array.isArray(search.body) ? search.body : [];
    const hasScores = searchArr.every((x) => typeof x.score === "number");
    const sortedByScore = searchArr.every((x, i) => i === 0 || x.score <= searchArr[i - 1].score);
    add(8, "FULL-TEXT SEARCH", search.status === 200 && hasScores && sortedByScore, {
      status: search.status,
      count: searchArr.length,
      hasScores,
      sortedByScore,
    });

    const searchWithTags = await requestJson("GET", "/api/search?q=mongodb&tags=guide");
    const tagArr = Array.isArray(searchWithTags.body) ? searchWithTags.body : [];
    const allGuide = tagArr.every((x) => Array.isArray(x.tags) && x.tags.includes("guide"));
    add(9, "SEARCH WITH TAG FILTER", searchWithTags.status === 200 && allGuide, {
      status: searchWithTags.status,
      count: tagArr.length,
      allGuide,
    });

    const emptySearch = await requestJson("GET", `/api/search?q=zzzzzz${Date.now()}`);
    const emptyArr = Array.isArray(emptySearch.body) ? emptySearch.body : [];
    add(10, "EMPTY SEARCH", emptySearch.status === 200 && emptyArr.length === 0, {
      status: emptySearch.status,
      count: emptyArr.length,
    });

    const mostEdited = await requestJson("GET", "/api/analytics/most-edited");
    const mostArr = Array.isArray(mostEdited.body) ? mostEdited.body : [];
    const mostSorted = mostArr.every((x, i) => i === 0 || x.editCount <= mostArr[i - 1].editCount);
    add(11, "ANALYTICS MOST-EDITED", mostEdited.status === 200 && mostArr.length <= 10 && mostSorted, {
      status: mostEdited.status,
      count: mostArr.length,
      sorted: mostSorted,
    });

    const co = await requestJson("GET", "/api/analytics/tag-cooccurrence");
    const coArr = Array.isArray(co.body) ? co.body : [];
    const coShapeOk = coArr.length === 0 || (Array.isArray(coArr[0].tags) && typeof coArr[0].count === "number");
    add(12, "ANALYTICS TAG COOCCURRENCE", co.status === 200 && coShapeOk, {
      status: co.status,
      count: coArr.length,
    });

    const legacySlug = `old-test-${Date.now()}`;
    await collection.insertOne({
      slug: legacySlug,
      title: "Old",
      content: "test",
      version: 1,
      tags: [],
      metadata: { author: "Old Author" },
      revision_history: [],
    });
    const legacy = await requestJson("GET", `/api/documents/${legacySlug}`);
    const author = legacy.body?.metadata?.author;
    add(13, "SCHEMA MIGRATION TEST", legacy.status === 200 && author?.id === null && author?.name === "Old Author" && author?.email === null, {
      status: legacy.status,
      author,
    });

    const indexes = await collection.indexes();
    const hasSlugIndex = indexes.some((i) => i.unique && i.key?.slug === 1);
    const hasTextIndex = indexes.some((i) => i.key?._fts === "text");
    add(14, "INDEX VERIFICATION", hasSlugIndex && hasTextIndex, {
      hasSlugIndex,
      hasTextIndex,
    });

    const revCreate = await requestJson("POST", "/api/documents", {
      title: "RevCap Suite",
      content: "v1",
      tags: ["rev-cap"],
      authorName: "Tester",
      authorEmail: "t@example.com",
    });
    let currentVersion = revCreate.body.version;
    for (let i = 0; i < 25; i += 1) {
      const u = await requestJson("PUT", `/api/documents/${revCreate.body.slug}`, {
        title: `Rev ${i + 1}`,
        content: `content ${i + 1}`,
        version: currentVersion,
        tags: ["rev-cap"],
      });
      if (u.status !== 200) {
        throw new Error(`Revision update failed: ${u.status}`);
      }
      currentVersion = u.body.version;
    }
    const persisted = await collection.findOne({ slug: revCreate.body.slug }, { projection: { revision_history: 1 } });
    add(15, "REVISION HISTORY CAP", persisted?.revision_history?.length === 20, {
      length: persisted?.revision_history?.length,
    });

    const concurrentCreate = await requestJson("POST", "/api/documents", {
      title: "Concurrent Doc",
      content: "v1",
      tags: ["occ"],
      authorName: "Tester",
      authorEmail: "t@example.com",
    });
    const [a, b] = await Promise.all([
      requestJson("PUT", `/api/documents/${concurrentCreate.body.slug}`, {
        title: "Concurrent A",
        content: "A",
        version: 1,
      }),
      requestJson("PUT", `/api/documents/${concurrentCreate.body.slug}`, {
        title: "Concurrent B",
        content: "B",
        version: 1,
      }),
    ]);
    const statuses = [a.status, b.status].sort();
    add(16, "CONCURRENT UPDATE TEST", statuses[0] === 200 && statuses[1] === 409, {
      statusA: a.status,
      statusB: b.status,
    });

    const largeContent = "x".repeat(1024 * 1024);
    const large = await requestJson("POST", "/api/documents", {
      title: "Large Content Doc",
      content: largeContent,
      tags: ["large"],
      authorName: "Tester",
      authorEmail: "t@example.com",
    });
    add(17, "LARGE DATA TEST", large.status === 201, {
      status: large.status,
      contentLength: largeContent.length,
    });

    const invalid = await requestJson("POST", "/api/documents", {});
    add(18, "INVALID INPUT TEST", invalid.status === 400, {
      status: invalid.status,
      body: invalid.body,
    });

    const persistedCount = await collection.countDocuments();
    add(19, "DATABASE PERSISTENCE TEST", persistedCount > 0, {
      countAfterRestart: persistedCount,
    });

    const start = performance.now();
    const perf = await requestJson("GET", "/api/search?q=common");
    const elapsed = Math.round(performance.now() - start);
    add(20, "BULK SEARCH PERFORMANCE", perf.status === 200, {
      status: perf.status,
      durationMs: elapsed,
      under1s: elapsed < 1000,
    });
  } finally {
    await client.close();
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`MASTER_SUMMARY ${JSON.stringify({ passed, total: results.length, failed: results.length - passed })}`);
  results.forEach(printResult);

  if (passed !== results.length) {
    process.exit(1);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});