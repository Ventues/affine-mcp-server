import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";

// Helper to create a minimal AFFiNE block structure
function createBlock(doc: Y.Doc, id: string, flavour: string, props: Record<string, any> = {}, children: string[] = []) {
  const blocks = doc.getMap("blocks");
  const block = new Y.Map<any>();
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", 1);
  block.set("sys:parent", "");
  const ch = new Y.Array<string>();
  if (children.length) ch.push(children);
  block.set("sys:children", ch);
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === "string" && k.startsWith("prop:text")) {
      const yt = new Y.Text();
      yt.insert(0, v);
      block.set(k, yt);
    } else {
      block.set(k, v);
    }
  }
  blocks.set(id, block);
  return block;
}

function getBlockIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  doc.getMap("blocks").forEach((_: any, key: string) => ids.add(key));
  return ids;
}

describe("recover_doc CRDT diffing", () => {
  it("blocks added after history point are deleted on recovery", () => {
    // Historical state: has block A
    const histDoc = new Y.Doc();
    createBlock(histDoc, "blockA", "affine:paragraph", { "prop:type": "text" });

    // Current state: has block A + block B (added later)
    const currentDoc = new Y.Doc();
    createBlock(currentDoc, "blockA", "affine:paragraph", { "prop:type": "text" });
    createBlock(currentDoc, "blockB", "affine:paragraph", { "prop:type": "text" });

    // Simulate recovery: delete blocks not in history
    const blocks = currentDoc.getMap("blocks");
    const histBlocks = histDoc.getMap("blocks");
    const histIds = new Set<string>();
    histBlocks.forEach((_: any, key: string) => histIds.add(key));

    const currentIds: string[] = [];
    blocks.forEach((_: any, key: string) => currentIds.push(key));
    for (const id of currentIds) {
      if (!histIds.has(id)) blocks.delete(id);
    }

    assert.equal(blocks.size, 1);
    assert.ok(blocks.has("blockA"));
    assert.ok(!blocks.has("blockB"));
  });

  it("blocks deleted after history point are restored on recovery", () => {
    // Historical state: has blocks A and B
    const histDoc = new Y.Doc();
    createBlock(histDoc, "blockA", "affine:paragraph", { "prop:type": "text" });
    createBlock(histDoc, "blockB", "affine:paragraph", { "prop:type": "text" });

    // Current state: only has block A (B was deleted)
    const currentDoc = new Y.Doc();
    createBlock(currentDoc, "blockA", "affine:paragraph", { "prop:type": "text" });

    // Simulate recovery: add blocks from history not in current
    const blocks = currentDoc.getMap("blocks");
    const histBlocks = histDoc.getMap("blocks");

    const currentIds = new Set<string>();
    blocks.forEach((_: any, key: string) => currentIds.add(key));

    histBlocks.forEach((histBlock: any, id: string) => {
      if (!currentIds.has(id)) {
        const newBlock = new Y.Map<any>();
        newBlock.set("sys:id", histBlock.get("sys:id"));
        newBlock.set("sys:flavour", histBlock.get("sys:flavour"));
        newBlock.set("sys:children", new Y.Array<string>());
        blocks.set(id, newBlock);
      }
    });

    assert.equal(blocks.size, 2);
    assert.ok(blocks.has("blockA"));
    assert.ok(blocks.has("blockB"));
  });

  it("block props are reverted to historical values", () => {
    // Historical state: block A with text "hello"
    const histDoc = new Y.Doc();
    createBlock(histDoc, "blockA", "affine:paragraph", { "prop:text": "hello" });

    // Current state: block A with text "goodbye"
    const currentDoc = new Y.Doc();
    createBlock(currentDoc, "blockA", "affine:paragraph", { "prop:text": "goodbye" });

    // Simulate recovery: update props
    const blocks = currentDoc.getMap("blocks");
    const histBlocks = histDoc.getMap("blocks");
    const curBlock = blocks.get("blockA") as Y.Map<any>;
    const histBlock = histBlocks.get("blockA") as Y.Map<any>;

    // Replace text prop
    const histText = histBlock.get("prop:text");
    if (histText instanceof Y.Text) {
      const yt = new Y.Text();
      yt.applyDelta(histText.toDelta());
      curBlock.set("prop:text", yt);
    }

    const resultText = curBlock.get("prop:text");
    assert.ok(resultText instanceof Y.Text);
    assert.equal(resultText.toString(), "hello");
  });

  it("children order is restored to historical state", () => {
    const histDoc = new Y.Doc();
    createBlock(histDoc, "note", "affine:note", {}, ["c", "b", "a"]);

    const currentDoc = new Y.Doc();
    createBlock(currentDoc, "note", "affine:note", {}, ["a", "b", "c", "d"]);

    const blocks = currentDoc.getMap("blocks");
    const histBlocks = histDoc.getMap("blocks");
    const curBlock = blocks.get("note") as Y.Map<any>;
    const histBlock = histBlocks.get("note") as Y.Map<any>;

    const curChildren = curBlock.get("sys:children") as Y.Array<string>;
    const histChildren = histBlock.get("sys:children") as Y.Array<string>;

    curChildren.delete(0, curChildren.length);
    curChildren.push(histChildren.toArray());

    assert.deepEqual(curChildren.toArray(), ["c", "b", "a"]);
  });

  it("throws when snapshot.missing is absent (doc not found)", () => {
    // Simulate the guard logic: snapshot = {} means doc not found
    const snapshot: { missing?: string } = {};
    assert.throws(
      () => { if (snapshot.missing === undefined) throw new Error("Document not found."); },
      /Document not found/
    );
  });

  it("does not throw when snapshot.missing is present (doc found)", () => {
    // Simulate the guard logic: snapshot.missing = base64 data means doc found
    const snapshot: { missing?: string } = { missing: "dGVzdA==" };
    assert.doesNotThrow(
      () => { if (snapshot.missing === undefined) throw new Error("Document not found."); }
    );
  });

  it("CRDT update is non-empty when states differ", () => {
    const histDoc = new Y.Doc();
    createBlock(histDoc, "blockA", "affine:paragraph", { "prop:type": "text" });

    const currentDoc = new Y.Doc();
    createBlock(currentDoc, "blockA", "affine:paragraph", { "prop:type": "text" });
    createBlock(currentDoc, "blockB", "affine:paragraph", { "prop:type": "text" });

    const prevSV = Y.encodeStateVector(currentDoc);

    // Apply recovery
    const blocks = currentDoc.getMap("blocks");
    blocks.delete("blockB");

    const delta = Y.encodeStateAsUpdate(currentDoc, prevSV);
    assert.ok(delta.length > 0, "Delta should be non-empty after block deletion");
  });
});
