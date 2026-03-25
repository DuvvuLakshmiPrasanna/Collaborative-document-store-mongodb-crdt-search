function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function countWords(text) {
  if (!text || typeof text !== "string") {
    return 0;
  }
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function parseTags(tagsInput) {
  if (!tagsInput) {
    return [];
  }
  if (Array.isArray(tagsInput)) {
    return tagsInput.map(String).map((tag) => tag.trim()).filter(Boolean);
  }
  return String(tagsInput)
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function ensureAuthorObject(authorValue) {
  if (authorValue && typeof authorValue === "object" && !Array.isArray(authorValue)) {
    return {
      id: authorValue.id ?? null,
      name: authorValue.name ?? null,
      email: authorValue.email ?? null,
    };
  }

  return {
    id: null,
    name: typeof authorValue === "string" ? authorValue : null,
    email: null,
  };
}

function makeContentDiff(oldDoc, newTitle, newContent) {
  const changes = [];
  if (oldDoc.title !== newTitle) {
    changes.push("title");
  }
  if (oldDoc.content !== newContent) {
    changes.push("content");
  }

  if (changes.length === 0) {
    return "No meaningful changes.";
  }

  return `Edited ${changes.join(" and ")}.`;
}

module.exports = {
  slugify,
  countWords,
  parseTags,
  ensureAuthorObject,
  makeContentDiff,
};