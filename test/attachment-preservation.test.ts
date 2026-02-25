/**
 * Unit tests for attachment metadata preservation during doc rewrite.
 *
 * Run:  npx tsx --test test/attachment-preservation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

// Replicate the two helper functions from docs.ts (they're module-internal)
function collectAttachmentMeta(blocks: Y.Map<any>, blockIds: string[]): Map<string, { sourceId: string; size: number; type: string; embed: boolean }> {
  const meta = new Map<string, { sourceId: string; size: number; type: string; embed: boolean }>();
  for (const id of blockIds) {
    const b = blocks.get(id);
    if (!(b instanceof Y.Map)) continue;
    if (b.get("sys:flavour") !== "affine:attachment") continue;
    const name = b.get("prop:name");
    if (name) meta.set(name, {
      sourceId: b.get("prop:sourceId") || "",
      size: b.get("prop:size") || 0,
      type: b.get("prop:type") || "application/octet-stream",
      embed: b.get("prop:embed") || false,
    });
  }
  return meta;
}

function restoreAttachmentMeta(blocks: Y.Map<any>, newBlockIds: string[], meta: Map<string, { sourceId: string; size: number; type: string; embed: boolean }>): void {
  if (meta.size === 0) return;
  for (const id of newBlockIds) {
    const b = blocks.get(id);
    if (!(b instanceof Y.Map)) continue;
    if (b.get("sys:flavour") !== "affine:attachment") continue;
    const name = b.get("prop:name");
    const existing = name ? meta.get(name) : undefined;
    if (existing) {
      b.set("prop:sourceId", existing.sourceId);
      b.set("prop:size", existing.size);
      b.set("prop:type", existing.type);
      b.set("prop:embed", existing.embed);
    }
  }
}

// Helper: create a Y.Map block with given properties
function makeBlock(blocks: Y.Map<any>, id: string, flavour: string, props: Record<string, any>): void {
  const block = new Y.Map<any>();
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  for (const [k, v] of Object.entries(props)) block.set(k, v);
  blocks.set(id, block);
}

describe("attachment metadata preservation", () => {
  it("collectAttachmentMeta extracts metadata from attachment blocks", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    makeBlock(blocks, "a1", "affine:attachment", {
      "prop:name": "script.py",
      "prop:sourceId": "blob-abc123",
      "prop:size": 4096,
      "prop:type": "text/x-python-script",
      "prop:embed": true,
    });
    makeBlock(blocks, "p1", "affine:paragraph", { "prop:text": "hello" });

    const meta = collectAttachmentMeta(blocks, ["a1", "p1"]);
    assert.equal(meta.size, 1);
    assert.deepEqual(meta.get("script.py"), {
      sourceId: "blob-abc123",
      size: 4096,
      type: "text/x-python-script",
      embed: true,
    });
  });

  it("restoreAttachmentMeta restores properties on matching new blocks", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;

    // New block created from markdown parse — has empty properties
    makeBlock(blocks, "new1", "affine:attachment", {
      "prop:name": "script.py",
      "prop:sourceId": "",
      "prop:size": 0,
      "prop:type": "application/octet-stream",
      "prop:embed": false,
    });

    const meta = new Map([["script.py", {
      sourceId: "blob-abc123",
      size: 4096,
      type: "text/x-python-script",
      embed: true,
    }]]);

    restoreAttachmentMeta(blocks, ["new1"], meta);

    const b = blocks.get("new1") as Y.Map<any>;
    assert.equal(b.get("prop:sourceId"), "blob-abc123");
    assert.equal(b.get("prop:size"), 4096);
    assert.equal(b.get("prop:type"), "text/x-python-script");
    assert.equal(b.get("prop:embed"), true);
  });

  it("restoreAttachmentMeta skips non-attachment blocks", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    makeBlock(blocks, "p1", "affine:paragraph", { "prop:text": "hello" });

    const meta = new Map([["script.py", {
      sourceId: "blob-abc123", size: 4096,
      type: "text/x-python-script", embed: true,
    }]]);

    restoreAttachmentMeta(blocks, ["p1"], meta);
    const b = blocks.get("p1") as Y.Map<any>;
    assert.equal(b.get("prop:sourceId"), undefined);
  });

  it("restoreAttachmentMeta skips attachments with no name match", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    makeBlock(blocks, "new1", "affine:attachment", {
      "prop:name": "other.txt",
      "prop:sourceId": "",
      "prop:size": 0,
      "prop:type": "application/octet-stream",
      "prop:embed": false,
    });

    const meta = new Map([["script.py", {
      sourceId: "blob-abc123", size: 4096,
      type: "text/x-python-script", embed: true,
    }]]);

    restoreAttachmentMeta(blocks, ["new1"], meta);
    const b = blocks.get("new1") as Y.Map<any>;
    assert.equal(b.get("prop:sourceId"), ""); // unchanged
    assert.equal(b.get("prop:size"), 0);
  });

  it("collectAttachmentMeta returns empty map when no attachments", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    makeBlock(blocks, "p1", "affine:paragraph", { "prop:text": "hello" });

    const meta = collectAttachmentMeta(blocks, ["p1"]);
    assert.equal(meta.size, 0);
  });

  it("restoreAttachmentMeta is a no-op with empty meta", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    makeBlock(blocks, "new1", "affine:attachment", {
      "prop:name": "script.py",
      "prop:sourceId": "",
      "prop:size": 0,
      "prop:type": "application/octet-stream",
      "prop:embed": false,
    });

    restoreAttachmentMeta(blocks, ["new1"], new Map());
    const b = blocks.get("new1") as Y.Map<any>;
    assert.equal(b.get("prop:sourceId"), ""); // unchanged
  });

  it("round-trip: collect before remove, restore after recreate", () => {
    const doc = new Y.Doc();
    const blocks = doc.getMap("blocks") as Y.Map<any>;

    // Original attachment with real data
    makeBlock(blocks, "orig1", "affine:attachment", {
      "prop:name": "data.csv",
      "prop:sourceId": "blob-xyz789",
      "prop:size": 12345,
      "prop:type": "text/csv",
      "prop:embed": false,
    });

    // 1. Collect before removal
    const meta = collectAttachmentMeta(blocks, ["orig1"]);

    // 2. Remove original
    blocks.delete("orig1");

    // 3. Create new empty shell (simulates markdown parse)
    makeBlock(blocks, "new1", "affine:attachment", {
      "prop:name": "data.csv",
      "prop:sourceId": "",
      "prop:size": 0,
      "prop:type": "application/octet-stream",
      "prop:embed": false,
    });

    // 4. Restore
    restoreAttachmentMeta(blocks, ["new1"], meta);

    const b = blocks.get("new1") as Y.Map<any>;
    assert.equal(b.get("prop:sourceId"), "blob-xyz789");
    assert.equal(b.get("prop:size"), 12345);
    assert.equal(b.get("prop:type"), "text/csv");
    assert.equal(b.get("prop:embed"), false);
  });
});
