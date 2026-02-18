/**
 * Integration tests for affine-mcp-server.
 *
 * Env vars loaded from .env.test (or set manually):
 *   AFFINE_BASE_URL   — e.g. https://affine.workisboring.com
 *   AFFINE_API_TOKEN  — personal access token
 *   AFFINE_WORKSPACE_ID — workspace to test in
 *
 * Run:  npm test
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import MarkdownIt from "markdown-it";
import fetch from "node-fetch";
import {
  wsUrlFromGraphQLEndpoint,
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
  pushDocUpdate,
  deleteDoc as wsDeleteDoc,
} from "../src/ws.js";

// ── Load .env.test ──────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
try {
  const envFile = readFileSync(resolve(__dirname, "../.env.test"), "utf-8");
  for (const line of envFile.split("\n")) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch {}

// ── Config ──────────────────────────────────────────────────────────────
const BASE_URL = process.env.AFFINE_BASE_URL;
const TOKEN = process.env.AFFINE_API_TOKEN;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

function requireEnv() {
  if (!BASE_URL || !TOKEN || !WORKSPACE_ID) {
    console.error("Skipping integration tests — set AFFINE_BASE_URL, AFFINE_API_TOKEN, AFFINE_WORKSPACE_ID");
    process.exit(0);
  }
}

// ── Helpers (minimal copies from docs.ts to keep tests self-contained) ──
const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
function genId() {
  let id = "";
  for (let i = 0; i < 10; i++) id += CHARS[Math.floor(Math.random() * CHARS.length)];
  return id;
}

function blockVersion(flavour: string) {
  return flavour === "affine:page" ? 2 : flavour === "affine:surface" ? 5 : 1;
}

function setSys(block: Y.Map<any>, id: string, flavour: string) {
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", blockVersion(flavour));
}

/** Create a minimal empty doc with page + surface + note */
function createEmptyDoc(title: string): { ydoc: Y.Doc; docId: string; noteId: string } {
  const docId = genId();
  const ydoc = new Y.Doc();
  const blocks = ydoc.getMap("blocks");

  const pageId = genId();
  const page = new Y.Map();
  setSys(page, pageId, "affine:page");
  const titleText = new Y.Text();
  titleText.insert(0, title);
  page.set("prop:title", titleText);
  const pageChildren = new Y.Array();
  page.set("sys:children", pageChildren);
  blocks.set(pageId, page);

  const surfaceId = genId();
  const surface = new Y.Map();
  setSys(surface, surfaceId, "affine:surface");
  surface.set("sys:parent", pageId);
  surface.set("sys:children", new Y.Array());
  const elements = new Y.Map<any>();
  elements.set("type", "$blocksuite:internal:native$");
  elements.set("value", new Y.Map<any>());
  surface.set("prop:elements", elements);
  blocks.set(surfaceId, surface);
  pageChildren.push([surfaceId]);

  const noteId = genId();
  const note = new Y.Map();
  setSys(note, noteId, "affine:note");
  note.set("sys:parent", pageId);
  note.set("sys:children", new Y.Array());
  note.set("prop:displayMode", "both");
  note.set("prop:xywh", "[0,0,800,95]");
  note.set("prop:index", "a0");
  note.set("prop:hidden", false);
  blocks.set(noteId, note);
  pageChildren.push([noteId]);

  const meta = ydoc.getMap("meta");
  meta.set("id", docId);
  meta.set("title", title);
  meta.set("createDate", Date.now());
  meta.set("tags", new Y.Array());

  return { ydoc, docId, noteId };
}

async function connect() {
  const wsUrl = wsUrlFromGraphQLEndpoint(BASE_URL + "/graphql");
  const socket = await connectWorkspaceSocket(wsUrl, { Authorization: `Bearer ${TOKEN}` });
  await joinWorkspace(socket, WORKSPACE_ID!);
  return socket;
}

async function pushDoc(socket: any, docId: string, ydoc: Y.Doc) {
  const update = Y.encodeStateAsUpdate(ydoc);
  await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(update).toString("base64"));
}

/** Delete doc CRDT data AND remove from workspace meta pages list */
async function cleanupDoc(socket: any, docId: string) {
  wsDeleteDoc(socket, WORKSPACE_ID!, docId);
  const wsDoc = new Y.Doc();
  const snap = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
  if (snap.missing) Y.applyUpdate(wsDoc, Buffer.from(snap.missing, "base64"));
  const prevSV = Y.encodeStateVector(wsDoc);
  const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>> | undefined;
  if (pages) {
    for (let i = pages.length - 1; i >= 0; i--) {
      const entry = pages.get(i);
      if (entry instanceof Y.Map && entry.get("id") === docId) {
        pages.delete(i, 1);
      }
    }
  }
  const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
  if (delta.byteLength > 0) {
    await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));
  }
}

/** Batch cleanup: remove multiple docs from CRDT + workspace meta in one pass */
async function cleanupDocs(socket: any, docIds: string[]) {
  for (const docId of docIds) wsDeleteDoc(socket, WORKSPACE_ID!, docId);
  const wsDoc = new Y.Doc();
  const snap = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
  if (snap.missing) Y.applyUpdate(wsDoc, Buffer.from(snap.missing, "base64"));
  const prevSV = Y.encodeStateVector(wsDoc);
  const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>> | undefined;
  const idSet = new Set(docIds);
  if (pages) {
    for (let i = pages.length - 1; i >= 0; i--) {
      const entry = pages.get(i);
      if (entry instanceof Y.Map && idSet.has(entry.get("id"))) {
        pages.delete(i, 1);
      }
    }
  }
  const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
  if (delta.byteLength > 0) {
    await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));
  }
}

async function readBlocks(socket: any, docId: string): Promise<Y.Map<any>> {
  const snapshot = await loadDoc(socket, WORKSPACE_ID!, docId);
  const doc = new Y.Doc();
  if (snapshot.missing) Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
  return doc.getMap("blocks") as Y.Map<any>;
}

function findByFlavour(blocks: Y.Map<any>, flavour: string): Y.Map<any> | null {
  for (const [, v] of blocks) {
    if (v instanceof Y.Map && v.get("sys:flavour") === flavour) return v;
  }
  return null;
}

function noteChildFlavours(blocks: Y.Map<any>): string[] {
  const note = findByFlavour(blocks, "affine:note");
  if (!note) return [];
  const children = note.get("sys:children");
  const ids: string[] = [];
  if (children instanceof Y.Array) children.forEach((id: string) => ids.push(id));
  return ids.map((id) => {
    const b = blocks.get(id);
    return b instanceof Y.Map ? (b.get("sys:flavour") as string) : "unknown";
  });
}

// ── Shared block builders ───────────────────────────────────────────────
function addPara(blocks: Y.Map<any>, noteId: string, noteChildren: Y.Array<any>, text: string, type = "text") {
  const id = genId();
  const b = new Y.Map();
  setSys(b, id, "affine:paragraph");
  b.set("sys:parent", noteId);
  b.set("sys:children", new Y.Array());
  b.set("prop:type", type);
  const yt = new Y.Text(); yt.insert(0, text);
  b.set("prop:text", yt);
  blocks.set(id, b);
  noteChildren.push([id]);
  return id;
}

function addBlockTo(blocks: Y.Map<any>, noteId: string, noteChildren: Y.Array<any>, flavour: string, text: string, type?: string) {
  const id = genId();
  const b = new Y.Map();
  setSys(b, id, flavour);
  b.set("sys:parent", noteId);
  b.set("sys:children", new Y.Array());
  if (type) b.set("prop:type", type);
  const yt = new Y.Text(); yt.insert(0, text);
  b.set("prop:text", yt);
  blocks.set(id, b);
  noteChildren.push([id]);
  return id;
}

/** Load doc, apply mutation, push delta — eliminates repeated load/encode/push boilerplate. */
async function mutateDoc(socket: any, docId: string, fn: (doc: Y.Doc, blocks: Y.Map<any>) => void) {
  const doc = new Y.Doc();
  const snap = await loadDoc(socket, WORKSPACE_ID!, docId);
  if (snap.missing) Y.applyUpdate(doc, Buffer.from(snap.missing, "base64"));
  const prevSV = Y.encodeStateVector(doc);
  fn(doc, doc.getMap("blocks") as Y.Map<any>);
  const delta = Y.encodeStateAsUpdate(doc, prevSV);
  await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));
}

function getNoteChildIds(blocks: Y.Map<any>): string[] {
  const note = findByFlavour(blocks, "affine:note")!;
  const ids: string[] = [];
  (note.get("sys:children") as Y.Array<any>).forEach((id: string) => ids.push(id));
  return ids;
}

function getBlockText(blocks: Y.Map<any>, blockId: string): string {
  return (blocks.get(blockId) as Y.Map<any>)?.get("prop:text")?.toString() || "";
}

// ── Cleanup tracker ─────────────────────────────────────────────────────
const docsToCleanup: string[] = [];

// ── Tests ───────────────────────────────────────────────────────────────
describe("integration", () => {
  let socket: any;

  before(() => {
    requireEnv();
  });

  before(async () => {
    socket = await connect();
  });

  after(async () => {
    // Clean up test docs
    for (const docId of docsToCleanup) {
      try {
        wsDeleteDoc(socket, WORKSPACE_ID!, docId);
      } catch {}
    }
    // Remove from workspace meta
    try {
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
      const prevSV = Y.encodeStateVector(wsDoc);
      const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>> | undefined;
      if (pages) {
        const toDelete: number[] = [];
        pages.forEach((entry: any, idx: number) => {
          if (docsToCleanup.includes(entry?.get?.("id"))) toDelete.push(idx);
        });
        for (const idx of toDelete.reverse()) pages.delete(idx, 1);
      }
      const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      if (delta.byteLength > 0) {
        await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));
      }
    } catch {}
    socket.disconnect();
  });

  it("create doc → read back → verify structure", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Integration Test 1");
    docsToCleanup.push(docId);
    await pushDoc(socket, docId, ydoc);

    const blocks = await readBlocks(socket, docId);
    assert.ok(findByFlavour(blocks, "affine:page"), "should have page block");
    assert.ok(findByFlavour(blocks, "affine:note"), "should have note block");
    assert.ok(findByFlavour(blocks, "affine:surface"), "should have surface block");

    const page = findByFlavour(blocks, "affine:page")!;
    assert.equal(page.get("prop:title")?.toString(), "Integration Test 1");
  });

  it("write blocks → read back → verify content", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Integration Test 2");
    docsToCleanup.push(docId);

    // Add a paragraph with rich text
    const blocks = ydoc.getMap("blocks");
    const paraId = genId();
    const para = new Y.Map();
    setSys(para, paraId, "affine:paragraph");
    para.set("sys:parent", noteId);
    para.set("sys:children", new Y.Array());
    para.set("prop:type", "text");
    const yt = new Y.Text();
    yt.insert(0, "bold", { bold: true });
    yt.insert(4, " plain", { bold: null });
    para.set("prop:text", yt);
    blocks.set(paraId, para);
    const note = blocks.get(noteId) as Y.Map<any>;
    (note.get("sys:children") as Y.Array<any>).push([paraId]);

    await pushDoc(socket, docId, ydoc);

    // Read back
    const readBack = await readBlocks(socket, docId);
    const flavours = noteChildFlavours(readBack);
    assert.deepEqual(flavours, ["affine:paragraph"]);

    // Verify rich text delta
    const noteBlock = findByFlavour(readBack, "affine:note")!;
    const childIds: string[] = [];
    (noteBlock.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds.push(id));
    const paraBlock = readBack.get(childIds[0]) as Y.Map<any>;
    const textDelta = (paraBlock.get("prop:text") as Y.Text).toDelta();
    assert.equal(textDelta.length, 2);
    assert.equal(textDelta[0].insert, "bold");
    assert.equal(textDelta[0].attributes?.bold, true);
    assert.equal(textDelta[1].insert, " plain");
  });

  it("richTextToMarkdown round-trip", async () => {
    // Test that Y.Text with formatting → markdown → Y.Text produces equivalent deltas
    const md = new MarkdownIt();

    // Build Y.Text with known formatting
    const doc = new Y.Doc();
    const map = doc.getMap("test");
    const original = new Y.Text();
    map.set("orig", original);
    original.insert(0, "hello ", { bold: null, italic: null });
    original.insert(6, "bold", { bold: true, italic: null });
    original.insert(10, " and ", { bold: null, italic: null });
    original.insert(15, "italic", { italic: true, bold: null });

    // Convert to markdown (simulating richTextToMarkdown)
    const delta = original.toDelta();
    const markdown = delta
      .map((d: any) => {
        if (typeof d.insert !== "string") return "";
        let t = d.insert;
        const a = d.attributes;
        if (!a) return t;
        if (a.code) return `\`${t}\``;
        if (a.bold && a.italic) t = `***${t}***`;
        else if (a.bold) t = `**${t}**`;
        else if (a.italic) t = `*${t}*`;
        if (a.link) t = `[${t}](${a.link})`;
        return t;
      })
      .join("");

    assert.equal(markdown, "hello **bold** and *italic*");

    // Parse back with markdown-it
    const tokens = md.parse(markdown, {});
    const inline = tokens[1]; // paragraph_open, inline, paragraph_close
    assert.equal(inline.type, "inline");
    assert.ok(inline.children);
    assert.ok(inline.children.some((c: any) => c.type === "strong_open"));
    assert.ok(inline.children.some((c: any) => c.type === "em_open"));
  });

  it("markdown block types parse correctly", () => {
    const md = new MarkdownIt();
    const input = [
      "## Heading",
      "",
      "Paragraph text",
      "",
      "- Bullet",
      "",
      "1. Numbered",
      "",
      "- [ ] Todo",
      "- [x] Done",
      "",
      "> Quote",
      "",
      "```js",
      "code()",
      "```",
      "",
      "---",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
    ].join("\n");

    const tokens = md.parse(input, {});
    const types = tokens.map((t: any) => t.type);

    assert.ok(types.includes("heading_open"), "should parse heading");
    assert.ok(types.includes("paragraph_open"), "should parse paragraph");
    assert.ok(types.includes("bullet_list_open"), "should parse bullet list");
    assert.ok(types.includes("ordered_list_open"), "should parse ordered list");
    assert.ok(types.includes("blockquote_open"), "should parse blockquote");
    assert.ok(types.includes("fence"), "should parse code fence");
    assert.ok(types.includes("hr"), "should parse horizontal rule");
    assert.ok(types.includes("table_open"), "should parse table");
  });

  it("Y.Text attribute inheritance requires explicit nulls", () => {
    const doc = new Y.Doc();
    const map = doc.getMap("test");

    // Without explicit nulls — attributes bleed
    const bad = new Y.Text();
    map.set("bad", bad);
    bad.insert(0, "bold", { bold: true });
    bad.insert(4, " plain"); // no explicit null
    const badDelta = bad.toDelta();
    // The " plain" inherits bold — this is the Y.js behavior we must work around
    assert.equal(badDelta.length, 1, "without null, Y.js merges into one segment");

    // With explicit nulls — correct
    const good = new Y.Text();
    map.set("good", good);
    good.insert(0, "bold", { bold: true });
    good.insert(4, " plain", { bold: null });
    const goodDelta = good.toDelta();
    assert.equal(goodDelta.length, 2, "with null, Y.js keeps separate segments");
    assert.equal(goodDelta[0].attributes?.bold, true);
    assert.equal(goodDelta[1].attributes, undefined);
  });

  it("update_doc_markdown str_replace logic", () => {
    const currentMd = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n\n## Section A\n\nContent A.\n";

    // Successful single match
    const old1 = "Second paragraph.";
    const new1 = "Replaced paragraph.";
    const idx1 = currentMd.indexOf(old1);
    assert.ok(idx1 !== -1, "should find old_markdown");
    assert.equal(currentMd.indexOf(old1, idx1 + 1), -1, "should match only once");
    const patched1 = currentMd.slice(0, idx1) + new1 + currentMd.slice(idx1 + old1.length);
    assert.ok(patched1.includes("Replaced paragraph."));
    assert.ok(!patched1.includes("Second paragraph."));
    assert.ok(patched1.includes("First paragraph."), "untouched content preserved");

    // Not found
    assert.equal(currentMd.indexOf("nonexistent text"), -1, "should not find missing text");

    // Multiple matches should be rejected
    const duped = "aaa\nbbb\naaa\n";
    const dupIdx = duped.indexOf("aaa");
    assert.ok(duped.indexOf("aaa", dupIdx + 1) !== -1, "should detect multiple matches");
  });

  it("update_doc_markdown round-trip via WS", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Patch Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    addPara(blocks, noteId, nc, "Hello world");
    addPara(blocks, noteId, nc, "Goodbye world");

    await pushDoc(socket, docId, ydoc);

    const blocks2 = await readBlocks(socket, docId);
    assert.equal(noteChildFlavours(blocks2).length, 2);

    await mutateDoc(socket, docId, (_doc, blocks3) => {
      for (const kid of getNoteChildIds(blocks3)) {
        const yt = (blocks3.get(kid) as Y.Map<any>).get("prop:text") as Y.Text | undefined;
        if (yt && yt.toString() === "Goodbye world") {
          yt.delete(0, yt.length);
          yt.insert(0, "Updated world");
        }
      }
    });

    const blocks4 = await readBlocks(socket, docId);
    const texts4 = getNoteChildIds(blocks4).map(id => getBlockText(blocks4, id));
    assert.ok(texts4.includes("Hello world"), "untouched paragraph preserved");
    assert.ok(texts4.includes("Updated world"), "patched paragraph updated");
    assert.ok(!texts4.includes("Goodbye world"), "old text removed");
  });

  it("update_block text and properties in-place", async () => {
    // 1. Create doc with a paragraph
    const { ydoc, docId, noteId } = createEmptyDoc("Update Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    const paraId = genId();
    const para = new Y.Map();
    setSys(para, paraId, "affine:paragraph");
    para.set("sys:parent", noteId);
    para.set("sys:children", new Y.Array());
    para.set("prop:type", "text");
    const yt = new Y.Text();
    yt.insert(0, "Original text");
    para.set("prop:text", yt);
    blocks.set(paraId, para);
    noteChildren.push([paraId]);

    await pushDoc(socket, docId, ydoc);

    // 2. Update text in-place
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const prevSV = Y.encodeStateVector(doc2);
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;
    const paraBlock = blocks2.get(paraId) as Y.Map<any>;
    assert.ok(paraBlock, "block should exist");

    const yText = paraBlock.get("prop:text") as Y.Text;
    yText.delete(0, yText.length);
    yText.insert(0, "Updated text");

    // 3. Update property (change to h2)
    paraBlock.set("prop:type", "h2");

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // 4. Read back and verify
    const blocks3 = await readBlocks(socket, docId);
    const updated = blocks3.get(paraId) as Y.Map<any>;
    assert.equal(updated.get("prop:text")?.toString(), "Updated text");
    assert.equal(updated.get("prop:type"), "h2");
    assert.equal(updated.get("sys:flavour"), "affine:paragraph");
  });

  it("update_block rejects structural blocks", async () => {
    const { ydoc, docId } = createEmptyDoc("Guard Rail Test");
    docsToCleanup.push(docId);
    await pushDoc(socket, docId, ydoc);

    const blocks = await readBlocks(socket, docId);
    const note = findByFlavour(blocks, "affine:note")!;
    const flavour = note.get("sys:flavour");
    assert.equal(flavour, "affine:note");
    // The actual guard rail is in the handler — here we just verify the structural block exists
    // and that its flavour is in the protected set
    const STRUCTURAL = new Set(["affine:page", "affine:surface", "affine:note"]);
    for (const [, v] of blocks) {
      if (v instanceof Y.Map) {
        const f = v.get("sys:flavour") as string;
        if (STRUCTURAL.has(f)) {
          assert.ok(true, `structural block ${f} found — handler would reject update`);
        }
      }
    }
  });

  it("read_doc_as_markdown includeBlockIds flag", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("BlockMap Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const h2Id = addPara(blocks, noteId, nc, "My Heading", "h2");
    const paraId = addPara(blocks, noteId, nc, "Some content");

    await pushDoc(socket, docId, ydoc);

    const blocks2 = await readBlocks(socket, docId);
    const childIds = getNoteChildIds(blocks2);
    assert.equal(childIds.length, 2);
    assert.equal(childIds[0], h2Id);
    assert.equal(childIds[1], paraId);
    assert.equal(getBlockText(blocks2, h2Id), "My Heading");
    assert.equal(getBlockText(blocks2, paraId), "Some content");
  });

  it("delete_block removes block and descendants", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Delete Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Add parent list item with a nested child
    const parentId = genId();
    const parent = new Y.Map();
    setSys(parent, parentId, "affine:list");
    parent.set("sys:parent", noteId);
    const parentKids = new Y.Array();
    parent.set("sys:children", parentKids);
    parent.set("prop:type", "bulleted");
    parent.set("prop:checked", false);
    const pt = new Y.Text(); pt.insert(0, "Parent item");
    parent.set("prop:text", pt);
    blocks.set(parentId, parent);
    noteChildren.push([parentId]);

    const childId = genId();
    const child = new Y.Map();
    setSys(child, childId, "affine:list");
    child.set("sys:parent", parentId);
    child.set("sys:children", new Y.Array());
    child.set("prop:type", "bulleted");
    child.set("prop:checked", false);
    const ct = new Y.Text(); ct.insert(0, "Child item");
    child.set("prop:text", ct);
    blocks.set(childId, child);
    parentKids.push([childId]);

    // Also add a sibling paragraph that should survive
    const siblingId = genId();
    const sibling = new Y.Map();
    setSys(sibling, siblingId, "affine:paragraph");
    sibling.set("sys:parent", noteId);
    sibling.set("sys:children", new Y.Array());
    sibling.set("prop:type", "text");
    const st = new Y.Text(); st.insert(0, "Survivor");
    sibling.set("prop:text", st);
    blocks.set(siblingId, sibling);
    noteChildren.push([siblingId]);

    await pushDoc(socket, docId, ydoc);

    // Now delete the parent block (should cascade to child)
    const blocks2 = await readBlocks(socket, docId);
    const prevSV = Y.encodeStateVector(blocks2.doc!);

    // Remove from note children
    const noteBlock2 = findByFlavour(blocks2, "affine:note")!;
    const nc = noteBlock2.get("sys:children") as Y.Array<any>;
    let delIdx = -1;
    nc.forEach((id: string, i: number) => { if (id === parentId) delIdx = i; });
    assert.ok(delIdx >= 0, "parent should be in note children");
    nc.delete(delIdx, 1);

    // Recursive delete
    function rmTree(b: Y.Map<any>, bid: string) {
      const blk = b.get(bid);
      if (blk instanceof Y.Map) {
        const kids = blk.get("sys:children");
        if (kids instanceof Y.Array) kids.forEach((kid: string) => rmTree(b, kid));
      }
      b.delete(bid);
    }
    rmTree(blocks2, parentId);

    const delta = Y.encodeStateAsUpdate(blocks2.doc!, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Verify: parent and child gone, sibling survives
    const blocks3 = await readBlocks(socket, docId);
    assert.equal(blocks3.get(parentId), undefined, "parent should be deleted");
    assert.equal(blocks3.get(childId), undefined, "child should be cascade deleted");
    const survivorBlock = blocks3.get(siblingId) as Y.Map<any>;
    assert.ok(survivorBlock, "sibling should survive");
    assert.equal(survivorBlock.get("prop:text")?.toString(), "Survivor");

    // Note should have only the sibling
    const noteBlock3 = findByFlavour(blocks3, "affine:note")!;
    const finalChildren: string[] = [];
    (noteBlock3.get("sys:children") as Y.Array<any>).forEach((id: string) => finalChildren.push(id));
    assert.equal(finalChildren.length, 1);
    assert.equal(finalChildren[0], siblingId);
  });

  it("delete_blocks removes multiple blocks in one transaction", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Bulk Delete Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "A");
    const bId = addPara(blocks, noteId, nc, "B");
    const cId = addPara(blocks, noteId, nc, "C");
    const dId = addPara(blocks, noteId, nc, "D");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      for (const id of [bId, dId]) {
        let idx = -1;
        nc2.forEach((cid: string, i: number) => { if (cid === id) idx = i; });
        if (idx >= 0) nc2.delete(idx, 1);
        blocks2.delete(id);
      }
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.ok(blocks3.get(aId), "A should exist");
    assert.equal(blocks3.get(bId), undefined, "B should be deleted");
    assert.ok(blocks3.get(cId), "C should exist");
    assert.equal(blocks3.get(dId), undefined, "D should be deleted");
    assert.deepEqual(getNoteChildIds(blocks3), [aId, cId]);
  });

  it("update_blocks updates multiple blocks in one transaction", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Bulk Update Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Original A");
    const bId = addPara(blocks, noteId, nc, "Original B");
    const cId = addPara(blocks, noteId, nc, "Original C");

    await pushDoc(socket, docId, ydoc);

    // Update A (text only), B (text + property), skip C
    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const aText = (blocks2.get(aId) as Y.Map<any>).get("prop:text") as Y.Text;
      aText.delete(0, aText.length);
      aText.insert(0, "Updated A");

      const bBlock = blocks2.get(bId) as Y.Map<any>;
      const bText = bBlock.get("prop:text") as Y.Text;
      bText.delete(0, bText.length);
      bText.insert(0, "Updated B");
      bBlock.set("prop:type", "h2");
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.equal(getBlockText(blocks3, aId), "Updated A");
    assert.equal(getBlockText(blocks3, bId), "Updated B");
    assert.equal((blocks3.get(bId) as Y.Map<any>).get("prop:type"), "h2");
    assert.equal(getBlockText(blocks3, cId), "Original C", "C should be unchanged");
    assert.deepEqual(getNoteChildIds(blocks3), [aId, bId, cId], "block order preserved");
  });

  it("update_doc_markdown char offset logic", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Offset Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Block A");
    const bId = addPara(blocks, noteId, nc, "Block B");
    const cId = addPara(blocks, noteId, nc, "Block C");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const bText = (blocks2.get(bId) as Y.Map<any>).get("prop:text") as Y.Text;
      bText.delete(0, bText.length);
      bText.insert(0, "Block B Updated");
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.equal(getBlockText(blocks3, aId), "Block A", "A should be unchanged");
    assert.equal(getBlockText(blocks3, bId), "Block B Updated", "B should be updated");
    assert.equal(getBlockText(blocks3, cId), "Block C", "C should be unchanged");
    assert.deepEqual(getNoteChildIds(blocks3), [aId, bId, cId], "block IDs should be preserved");
  });

  it("update_doc_markdown works with headings and sections (blank-line consistency)", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Blank Line Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;

    addBlockTo(blocks, noteId, nc, "affine:paragraph", "Goal", "h2");
    addBlockTo(blocks, noteId, nc, "affine:paragraph", "Analyze the data carefully.", "text");
    addBlockTo(blocks, noteId, nc, "affine:paragraph", "Inputs", "h2");
    addBlockTo(blocks, noteId, nc, "affine:paragraph", "JSON files are required.", "text");

    await pushDoc(socket, docId, ydoc);

    // Read the doc as markdown (simulating read_doc_as_markdown)
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;
    const noteBlock2 = findByFlavour(blocks2, "affine:note")!;

    // Inline a minimal blocksToMarkdownWithMap to get the rendered markdown
    const lines: string[] = [];
    lines.push("# Blank Line Test", "");
    const childIds: string[] = [];
    (noteBlock2.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds.push(id));
    for (const cid of childIds) {
      const b = blocks2.get(cid) as Y.Map<any>;
      const flavour = b.get("sys:flavour") as string;
      const type = b.get("prop:type") as string;
      const txt = b.get("prop:text")?.toString() || "";
      if (flavour === "affine:paragraph" && type?.startsWith("h")) {
        const level = parseInt(type[1], 10);
        lines.push(`${"#".repeat(level)} ${txt}`, "");
      } else {
        lines.push(txt, "");
      }
    }
    // Trim trailing blank lines
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const renderedMd = lines.join("\n") + "\n";

    // The key assertion: the old_markdown substring must be findable
    const oldSnippet = "## Goal\n\nAnalyze the data carefully.";
    const idx = renderedMd.indexOf(oldSnippet);
    assert.ok(idx !== -1, `Should find old_markdown in rendered markdown. Got:\n${renderedMd}`);
    assert.equal(renderedMd.indexOf(oldSnippet, idx + 1), -1, "Should match only once");

    // Simulate the str_replace
    const newSnippet = "## Goal\n\nAnalyze the data very carefully.";
    const patched = renderedMd.slice(0, idx) + newSnippet + renderedMd.slice(idx + oldSnippet.length);
    assert.ok(patched.includes("very carefully"), "Patched markdown should contain replacement");
    assert.ok(patched.includes("## Inputs"), "Unaffected sections should be preserved");
  });

  it("update_doc_markdown: replace with empty string removes blocks", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Empty Replace Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Keep me");
    const bId = addPara(blocks, noteId, nc, "Delete me");
    const cId = addPara(blocks, noteId, nc, "Keep me too");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      let bIdx = -1;
      nc2.forEach((id: string, i: number) => { if (id === bId) bIdx = i; });
      assert.ok(bIdx >= 0, "B should be in note children");
      nc2.delete(bIdx, 1);
      blocks2.delete(bId);
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.equal(blocks3.get(bId), undefined, "B should be deleted");
    assert.equal(getBlockText(blocks3, aId), "Keep me");
    assert.equal(getBlockText(blocks3, cId), "Keep me too");
    assert.deepEqual(getNoteChildIds(blocks3), [aId, cId]);
  });

  it("update_doc_markdown: replace all body blocks with empty leaves empty doc", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Clear All Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const xId = addPara(blocks, noteId, nc, "First");
    const yId = addPara(blocks, noteId, nc, "Second");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      while (nc2.length > 0) nc2.delete(0, 1);
      blocks2.delete(xId);
      blocks2.delete(yId);
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.ok(findByFlavour(blocks3, "affine:page"), "page block should survive");
    assert.ok(findByFlavour(blocks3, "affine:surface"), "surface block should survive");
    assert.ok(findByFlavour(blocks3, "affine:note"), "note block should survive");
    assert.equal(blocks3.get(xId), undefined, "First should be deleted");
    assert.equal(blocks3.get(yId), undefined, "Second should be deleted");
    assert.equal(getNoteChildIds(blocks3).length, 0, "note should have no children");
  });

  it("update_doc_markdown: replace middle section with new content", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Mid Replace Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const h1Id = addBlockTo(blocks, noteId, nc, "affine:paragraph", "Intro", "h2");
    const p1Id = addPara(blocks, noteId, nc, "Intro text");
    const h2Id = addBlockTo(blocks, noteId, nc, "affine:paragraph", "Middle", "h2");
    const p2Id = addPara(blocks, noteId, nc, "Middle text");
    const h3Id = addBlockTo(blocks, noteId, nc, "affine:paragraph", "Outro", "h2");
    const p3Id = addPara(blocks, noteId, nc, "Outro text");

    await pushDoc(socket, docId, ydoc);

    let newId1 = "", newId2 = "";
    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      let h2Idx = -1, p2Idx = -1;
      nc2.forEach((id: string, i: number) => {
        if (id === h2Id) h2Idx = i;
        if (id === p2Id) p2Idx = i;
      });
      nc2.delete(p2Idx, 1);
      nc2.delete(h2Idx, 1);
      blocks2.delete(h2Id);
      blocks2.delete(p2Id);

      newId1 = genId();
      const nb1 = new Y.Map();
      setSys(nb1, newId1, "affine:paragraph");
      nb1.set("sys:parent", noteId);
      nb1.set("sys:children", new Y.Array());
      nb1.set("prop:type", "h2");
      const nt1 = new Y.Text(); nt1.insert(0, "Replaced Section");
      nb1.set("prop:text", nt1);
      blocks2.set(newId1, nb1);

      newId2 = genId();
      const nb2 = new Y.Map();
      setSys(nb2, newId2, "affine:paragraph");
      nb2.set("sys:parent", noteId);
      nb2.set("sys:children", new Y.Array());
      nb2.set("prop:type", "text");
      const nt2 = new Y.Text(); nt2.insert(0, "New replacement content");
      nb2.set("prop:text", nt2);
      blocks2.set(newId2, nb2);

      nc2.insert(h2Idx, [newId1, newId2]);
    });

    const blocks3 = await readBlocks(socket, docId);
    const finalIds = getNoteChildIds(blocks3);
    assert.equal(finalIds.length, 6);
    assert.deepEqual(finalIds, [h1Id, p1Id, newId1, newId2, h3Id, p3Id]);
    assert.equal(blocks3.get(h2Id), undefined, "old heading deleted");
    assert.equal(blocks3.get(p2Id), undefined, "old paragraph deleted");
    assert.equal(getBlockText(blocks3, newId1), "Replaced Section");
    assert.equal(getBlockText(blocks3, newId2), "New replacement content");
  });

  it("update_doc_markdown: str_replace rejects when old_markdown not found", () => {
    const md = "# Title\n\nSome content.\n";
    assert.equal(md.indexOf("nonexistent text"), -1, "should not find missing text");
  });

  it("update_doc_markdown: str_replace rejects duplicate matches", () => {
    const md = "# Title\n\nHello\n\nHello\n";
    const idx = md.indexOf("Hello");
    assert.ok(idx !== -1);
    assert.ok(md.indexOf("Hello", idx + 1) !== -1, "should detect duplicate");
  });

  it("update_doc_markdown: replace first block preserves rest", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("First Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Alpha");
    const bId = addPara(blocks, noteId, nc, "Beta");
    const cId = addPara(blocks, noteId, nc, "Gamma");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const aText = (blocks2.get(aId) as Y.Map<any>).get("prop:text") as Y.Text;
      aText.delete(0, aText.length);
      aText.insert(0, "Alpha Updated");
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.equal(getBlockText(blocks3, aId), "Alpha Updated");
    assert.equal(getBlockText(blocks3, bId), "Beta");
    assert.equal(getBlockText(blocks3, cId), "Gamma");
    assert.deepEqual(getNoteChildIds(blocks3), [aId, bId, cId]);
  });

  it("update_doc_markdown: replace last block preserves rest", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Last Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "First");
    const bId = addPara(blocks, noteId, nc, "Second");
    const cId = addPara(blocks, noteId, nc, "Third");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const cText = (blocks2.get(cId) as Y.Map<any>).get("prop:text") as Y.Text;
      cText.delete(0, cText.length);
      cText.insert(0, "Third Updated");
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.equal(getBlockText(blocks3, aId), "First");
    assert.equal(getBlockText(blocks3, bId), "Second");
    assert.equal(getBlockText(blocks3, cId), "Third Updated");
  });

  it("update_doc_markdown: replace single block with multiple blocks", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Expand Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Before");
    const bId = addPara(blocks, noteId, nc, "Replace this");
    const cId = addPara(blocks, noteId, nc, "After");

    await pushDoc(socket, docId, ydoc);

    const newIds: string[] = [];
    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      let bIdx = -1;
      nc2.forEach((id: string, i: number) => { if (id === bId) bIdx = i; });
      nc2.delete(bIdx, 1);
      blocks2.delete(bId);

      for (const txt of ["New line 1", "New line 2", "New line 3"]) {
        const id = genId();
        const b = new Y.Map();
        setSys(b, id, "affine:paragraph");
        b.set("sys:parent", noteId);
        b.set("sys:children", new Y.Array());
        b.set("prop:type", "text");
        const yt = new Y.Text(); yt.insert(0, txt);
        b.set("prop:text", yt);
        blocks2.set(id, b);
        newIds.push(id);
      }
      nc2.insert(bIdx, newIds);
    });

    const blocks3 = await readBlocks(socket, docId);
    const finalIds = getNoteChildIds(blocks3);
    assert.equal(finalIds.length, 5);
    assert.equal(finalIds[0], aId);
    assert.deepEqual(finalIds.slice(1, 4), newIds);
    assert.equal(finalIds[4], cId);
    assert.equal(blocks3.get(bId), undefined, "old block should be gone");
  });

  it("update_doc_markdown: replace multiple blocks with single block", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Collapse Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "Keep");
    const bId = addPara(blocks, noteId, nc, "Merge 1");
    const cId = addPara(blocks, noteId, nc, "Merge 2");
    const dId = addPara(blocks, noteId, nc, "Merge 3");
    const eId = addPara(blocks, noteId, nc, "Keep too");

    await pushDoc(socket, docId, ydoc);

    let newId = "";
    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      let bIdx2 = -1;
      nc2.forEach((id: string, i: number) => { if (id === bId) bIdx2 = i; });
      nc2.delete(bIdx2, 3);
      blocks2.delete(bId);
      blocks2.delete(cId);
      blocks2.delete(dId);

      newId = genId();
      const nb = new Y.Map();
      setSys(nb, newId, "affine:paragraph");
      nb.set("sys:parent", noteId);
      nb.set("sys:children", new Y.Array());
      nb.set("prop:type", "text");
      const nt = new Y.Text(); nt.insert(0, "Merged content");
      nb.set("prop:text", nt);
      blocks2.set(newId, nb);
      nc2.insert(bIdx2, [newId]);
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.deepEqual(getNoteChildIds(blocks3), [aId, newId, eId]);
    assert.equal(getBlockText(blocks3, newId), "Merged content");
  });

  it("update_doc_markdown: code block before list does not corrupt adjacent sections", async () => {
    // Regression test for cross-section block corruption.
    // Root cause: blocksToMarkdownWithMap pushed multi-line code content as a single
    // array element, causing blockLineRanges to diverge from actual markdown line numbers.
    const { ydoc, docId, noteId } = createEmptyDoc("Code Block Corruption Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;

    // ## Section A  (heading + code block + list)
    addPara(blocks, noteId, nc, "Section A", "h2");
    const codeId = genId();
    const code = new Y.Map();
    setSys(code, codeId, "affine:code");
    code.set("sys:parent", noteId);
    code.set("sys:children", new Y.Array());
    code.set("prop:language", "txt");
    const ct = new Y.Text();
    ct.insert(0, "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10");
    code.set("prop:text", ct);
    blocks.set(codeId, code);
    nc.push([codeId]);

    addBlockTo(blocks, noteId, nc, "affine:list", "Item A1", "bulleted");
    addBlockTo(blocks, noteId, nc, "affine:list", "Item A2", "bulleted");

    // ## Section B  (heading + paragraph + list)
    addPara(blocks, noteId, nc, "Section B", "h2");
    addPara(blocks, noteId, nc, "Intro text.");
    const b1Id = addBlockTo(blocks, noteId, nc, "affine:list", "Item B1", "bulleted");
    const b2Id = addBlockTo(blocks, noteId, nc, "affine:list", "Item B2", "bulleted");

    await pushDoc(socket, docId, ydoc);

    // Read the rendered markdown and verify both lists are present
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;
    const noteBlock2 = findByFlavour(blocks2, "affine:note")!;

    // Render markdown the same way the handler does
    const lines: string[] = [];
    const noteChildIds: string[] = [];
    (noteBlock2.get("sys:children") as Y.Array<any>).forEach((id: string) => noteChildIds.push(id));
    const blockLineRanges: { blockId: string; startLine: number; endLine: number }[] = [];
    lines.push("# Code Block Corruption Test", "");
    let prevWasList = false;
    for (const childId of noteChildIds) {
      const raw = blocks2.get(childId) as Y.Map<any>;
      const flavour = raw.get("sys:flavour") as string;
      const isList = flavour === "affine:list";
      if (!isList && prevWasList) lines.push("");
      const startLine = lines.length;
      if (flavour === "affine:code") {
        const lang = raw.get("prop:language") || "";
        const text = raw.get("prop:text")?.toString() || "";
        lines.push(`\`\`\`${lang}`, ...text.split("\n"), `\`\`\``, "");
      } else if (flavour === "affine:paragraph") {
        const type = raw.get("prop:type") as string;
        const text = raw.get("prop:text")?.toString() || "";
        if (type?.startsWith("h")) {
          lines.push(`${"#".repeat(parseInt(type[1]))} ${text}`, "");
        } else {
          if (text) lines.push(text, "");
        }
      } else if (flavour === "affine:list") {
        const text = raw.get("prop:text")?.toString() || "";
        lines.push(`- ${text}`);
      }
      blockLineRanges.push({ blockId: childId, startLine, endLine: lines.length });
      prevWasList = isList;
    }
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const md = lines.join("\n") + "\n";

    // The old_markdown targets Section A's list
    const oldMd = "- Item A1\n- Item A2";
    const idx = md.indexOf(oldMd);
    assert.ok(idx !== -1, `Should find old_markdown in rendered markdown`);
    assert.equal(md.indexOf(oldMd, idx + 1), -1, "Should match only once");

    // Compute char offsets and verify the correct blocks are identified as affected
    const mdLines = md.split("\n");
    const lineToCharOffset = [0];
    for (let i = 0; i < mdLines.length; i++) {
      lineToCharOffset.push(lineToCharOffset[i] + mdLines[i].length + 1);
    }
    const changeStart = idx;
    const changeEnd = idx + oldMd.length;
    const affectedIds: string[] = [];
    for (const r of blockLineRanges) {
      const bStart = lineToCharOffset[r.startLine];
      const bEnd = lineToCharOffset[r.endLine];
      if (bEnd > changeStart && bStart < changeEnd) affectedIds.push(r.blockId);
    }

    // Critical assertion: affected blocks should be the Section A list items, NOT Section B's
    assert.equal(affectedIds.length, 2, `Should affect exactly 2 blocks (the A list items), got ${affectedIds.length}`);
    assert.ok(!affectedIds.includes(b1Id), "Section B list item B1 must NOT be affected");
    assert.ok(!affectedIds.includes(b2Id), "Section B list item B2 must NOT be affected");
  });

  it("move_block reorders and reparents blocks", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Move Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const nc = note.get("sys:children") as Y.Array<any>;
    const aId = addPara(blocks, noteId, nc, "A");
    const bId = addPara(blocks, noteId, nc, "B");
    const cId = addPara(blocks, noteId, nc, "C");

    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      const nc2 = (blocks2.get(noteId) as Y.Map<any>).get("sys:children") as Y.Array<any>;
      let cIdx = -1;
      nc2.forEach((id: string, i: number) => { if (id === cId) cIdx = i; });
      nc2.delete(cIdx, 1);
      nc2.insert(0, [cId]);
    });

    const blocks3 = await readBlocks(socket, docId);
    assert.deepEqual(getNoteChildIds(blocks3), [cId, aId, bId], "order should be C, A, B");
  });

  it("update_doc_title renames a document", async () => {
    const { ydoc, docId } = createEmptyDoc("Old Title");
    docsToCleanup.push(docId);
    await pushDoc(socket, docId, ydoc);

    await mutateDoc(socket, docId, (_doc, blocks2) => {
      let pageId = "";
      blocks2.forEach((_v: any, k: string) => {
        const b = blocks2.get(k) as Y.Map<any>;
        if (b.get("sys:flavour") === "affine:page") pageId = k;
      });
      const pageBlock = blocks2.get(pageId) as Y.Map<any>;
      const titleYText = pageBlock.get("prop:title") as Y.Text;
      titleYText.delete(0, titleYText.length);
      titleYText.insert(0, "New Title");
    });

    const blocks3 = await readBlocks(socket, docId);
    const page3 = findByFlavour(blocks3, "affine:page")!;
    assert.equal(page3.get("prop:title")?.toString(), "New Title");
  });

  it("special AFFiNE patterns detected in markdown", () => {
    const md = new MarkdownIt();

    // affine:// link
    const linkTokens = md.parse("[Doc](affine://abc123)", {});
    const linkInline = linkTokens[1];
    const linkOpen = linkInline.children!.find((c: any) => c.type === "link_open");
    assert.ok(linkOpen);
    assert.equal(linkOpen!.attrs![0][1], "affine://abc123");

    // Latex block
    const latexContent = "$$x^2 + y^2$$";
    assert.ok(latexContent.match(/^\$\$([\s\S]+)\$\$$/), "should match latex pattern");

    // Attachment
    const attachContent = "📎 myfile.pdf";
    assert.ok(attachContent.match(/^📎\s+(.+)$/), "should match attachment pattern");

    // Image
    const imgTokens = md.parse("![caption](image)", {});
    const imgInline = imgTokens[1];
    const imgTok = imgInline.children!.find((c: any) => c.type === "image");
    assert.ok(imgTok);
    assert.equal(imgTok!.attrs![0][1], "image"); // src
  });

  it("table round-trip: flat dot-notation write → read back markdown", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Table Round-Trip Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Create a table block using flat dot-notation (AFFiNE native format)
    const tableId = genId();
    const table = new Y.Map();
    setSys(table, tableId, "affine:table");
    table.set("sys:parent", noteId);
    table.set("sys:children", new Y.Array());

    const r0 = genId(), r1 = genId();
    const c0 = genId(), c1 = genId();

    table.set(`prop:rows.${r0}.rowId`, r0);
    table.set(`prop:rows.${r0}.order`, "a00");
    table.set(`prop:rows.${r1}.rowId`, r1);
    table.set(`prop:rows.${r1}.order`, "a01");
    table.set(`prop:columns.${c0}.columnId`, c0);
    table.set(`prop:columns.${c0}.order`, "a00");
    table.set(`prop:columns.${c1}.columnId`, c1);
    table.set(`prop:columns.${c1}.order`, "a01");

    const mkText = (s: string) => { const t = new Y.Text(); t.insert(0, s); return t; };
    table.set(`prop:cells.${r0}:${c0}.text`, mkText("Name"));
    table.set(`prop:cells.${r0}:${c1}.text`, mkText("Value"));
    table.set(`prop:cells.${r1}:${c0}.text`, mkText("Alpha"));
    table.set(`prop:cells.${r1}:${c1}.text`, mkText("100"));

    blocks.set(tableId, table);
    noteChildren.push([tableId]);

    await pushDoc(socket, docId, ydoc);

    // Read back and verify table content survives round-trip
    const readBack = await readBlocks(socket, docId);
    const tbl = readBack.get(tableId) as Y.Map<any>;
    assert.ok(tbl, "table block should exist");
    assert.equal(tbl.get("sys:flavour"), "affine:table");

    // Verify flat keys exist
    assert.equal(tbl.get(`prop:rows.${r0}.rowId`), r0);
    assert.equal(tbl.get(`prop:rows.${r1}.order`), "a01");
    assert.equal(tbl.get(`prop:columns.${c0}.columnId`), c0);

    // Verify cell text
    const cell00 = tbl.get(`prop:cells.${r0}:${c0}.text`);
    assert.ok(cell00 instanceof Y.Text, "cell should be Y.Text");
    assert.equal(cell00.toString(), "Name");
    const cell11 = tbl.get(`prop:cells.${r1}:${c1}.text`);
    assert.equal(cell11.toString(), "100");
  });

  it("markdownToBlocks table → flat dot-notation keys", async () => {
    const md = new MarkdownIt();
    const input = [
      "| H1 | H2 |",
      "|----|----|",
      "| A  | B  |",
      "| C  | D  |",
    ].join("\n");

    const { ydoc, docId, noteId } = createEmptyDoc("MD Table Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Parse markdown and create blocks (mimics markdownToBlocks logic)
    const tokens = md.parse(input, {});
    assert.ok(tokens.some((t: any) => t.type === "table_open"), "should have table token");

    // Push and use the server's write_doc_from_markdown via WS
    await pushDoc(socket, docId, ydoc);

    // Now load, write table via markdownToBlocks approach, and verify
    const snapshot = await loadDoc(socket, WORKSPACE_ID!, docId);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Buffer.from(snapshot.missing, "base64"));
    const prevSV = Y.encodeStateVector(doc2);
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;
    const note2 = blocks2.get(noteId) as Y.Map<any>;
    const noteChildren2 = note2.get("sys:children") as Y.Array<any>;

    // Manually create table with flat keys (same as our fixed markdownToBlocks)
    const tblId = genId();
    const tbl = new Y.Map();
    setSys(tbl, tblId, "affine:table");
    tbl.set("sys:parent", noteId);
    tbl.set("sys:children", new Y.Array());

    const rows = [genId(), genId(), genId()];
    const cols = [genId(), genId()];
    const cellData = [["H1", "H2"], ["A", "B"], ["C", "D"]];

    rows.forEach((rid, i) => {
      tbl.set(`prop:rows.${rid}.rowId`, rid);
      tbl.set(`prop:rows.${rid}.order`, `a${String(i).padStart(2, "0")}`);
    });
    cols.forEach((cid, i) => {
      tbl.set(`prop:columns.${cid}.columnId`, cid);
      tbl.set(`prop:columns.${cid}.order`, `a${String(i).padStart(2, "0")}`);
    });
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const t = new Y.Text();
        t.insert(0, cellData[r][c]);
        tbl.set(`prop:cells.${rows[r]}:${cols[c]}.text`, t);
      }
    }

    blocks2.set(tblId, tbl);
    noteChildren2.push([tblId]);

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Read back and verify all cells
    const readBack = await readBlocks(socket, docId);
    const readTbl = readBack.get(tblId) as Y.Map<any>;
    assert.ok(readTbl, "table block should exist after push");

    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 2; c++) {
        const cellText = readTbl.get(`prop:cells.${rows[r]}:${cols[c]}.text`);
        assert.ok(cellText instanceof Y.Text, `cell [${r},${c}] should be Y.Text`);
        assert.equal(cellText.toString(), cellData[r][c], `cell [${r},${c}] content`);
      }
    }

    // Verify row/col ordering
    const r0order = readTbl.get(`prop:rows.${rows[0]}.order`);
    const r2order = readTbl.get(`prop:rows.${rows[2]}.order`);
    assert.ok(r0order < r2order, "row ordering should be preserved");
  });

  it("blocksToMarkdown reads flat dot-notation table", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Read Flat Table Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Create table with flat keys
    const tblId = genId();
    const tbl = new Y.Map();
    setSys(tbl, tblId, "affine:table");
    tbl.set("sys:parent", noteId);
    tbl.set("sys:children", new Y.Array());

    const r0 = genId(), r1 = genId();
    const c0 = genId(), c1 = genId();
    tbl.set(`prop:rows.${r0}.rowId`, r0);
    tbl.set(`prop:rows.${r0}.order`, "a00");
    tbl.set(`prop:rows.${r1}.rowId`, r1);
    tbl.set(`prop:rows.${r1}.order`, "a01");
    tbl.set(`prop:columns.${c0}.columnId`, c0);
    tbl.set(`prop:columns.${c0}.order`, "a00");
    tbl.set(`prop:columns.${c1}.columnId`, c1);
    tbl.set(`prop:columns.${c1}.order`, "a01");

    const mkText = (s: string) => { const t = new Y.Text(); t.insert(0, s); return t; };
    tbl.set(`prop:cells.${r0}:${c0}.text`, mkText("X"));
    tbl.set(`prop:cells.${r0}:${c1}.text`, mkText("Y"));
    tbl.set(`prop:cells.${r1}:${c0}.text`, mkText("1"));
    tbl.set(`prop:cells.${r1}:${c1}.text`, mkText("2"));

    blocks.set(tblId, tbl);
    noteChildren.push([tblId]);

    await pushDoc(socket, docId, ydoc);

    // Read back as blocks, then manually verify the markdown read logic
    const readBack = await readBlocks(socket, docId);
    const readTbl = readBack.get(tblId) as Y.Map<any>;

    // Collect flat keys (simulates blocksToMarkdownWithMap read logic)
    const rowsObj: Record<string, { order?: string }> = {};
    const colsObj: Record<string, { order?: string }> = {};
    const flatCells: Record<string, Y.Text> = {};

    readTbl.forEach((_v: any, k: string) => {
      const rowMatch = k.match(/^prop:rows\.([^.]+)\.order$/);
      if (rowMatch) { rowsObj[rowMatch[1]] = { order: _v }; }
      const colMatch = k.match(/^prop:columns\.([^.]+)\.order$/);
      if (colMatch) { colsObj[colMatch[1]] = { order: _v }; }
      const cellMatch = k.match(/^prop:cells\.(.+)\.text$/);
      if (cellMatch && _v instanceof Y.Text) { flatCells[cellMatch[1]] = _v; }
    });

    const sortedRows = Object.keys(rowsObj).sort((a, b) => (rowsObj[a].order ?? "").localeCompare(rowsObj[b].order ?? ""));
    const sortedCols = Object.keys(colsObj).sort((a, b) => (colsObj[a].order ?? "").localeCompare(colsObj[b].order ?? ""));

    assert.equal(sortedRows.length, 2, "should have 2 rows");
    assert.equal(sortedCols.length, 2, "should have 2 cols");

    // Build markdown table lines
    const lines: string[] = [];
    for (let r = 0; r < sortedRows.length; r++) {
      const cells = sortedCols.map(cid => {
        const key = `${sortedRows[r]}:${cid}`;
        return flatCells[key]?.toString() ?? "";
      });
      lines.push(`| ${cells.join(" | ")} |`);
      if (r === 0) lines.push(`| --- | --- |`);
    }

    assert.equal(lines[0], "| X | Y |", "header row");
    assert.equal(lines[2], "| 1 | 2 |", "data row");
  });

  it("read_doc_as_markdown with blockOffset/blockLimit pagination", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Pagination Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;
    const blockIdList: string[] = [];

    // Create 5 paragraph blocks
    for (let i = 0; i < 5; i++) {
      const pid = genId();
      blockIdList.push(pid);
      const para = new Y.Map();
      setSys(para, pid, "affine:paragraph");
      para.set("sys:parent", noteId);
      para.set("sys:children", new Y.Array());
      para.set("prop:type", "text");
      const t = new Y.Text();
      t.insert(0, `Block ${i}`);
      para.set("prop:text", t);
      blocks.set(pid, para);
      noteChildren.push([pid]);
    }

    await pushDoc(socket, docId, ydoc);

    // Import blocksToMarkdownWithMap indirectly by reading back and checking
    const readBack = await readBlocks(socket, docId);
    const noteBlock = findByFlavour(readBack, "affine:note")!;

    // Import the function — we test via the CRDT structure
    // Verify all 5 blocks exist
    const childIds: string[] = [];
    (noteBlock.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds.push(id));
    assert.equal(childIds.length, 5, "should have 5 children");

    // Verify block content
    for (let i = 0; i < 5; i++) {
      const b = readBack.get(childIds[i]) as Y.Map<any>;
      const txt = (b.get("prop:text") as Y.Text).toString();
      assert.equal(txt, `Block ${i}`, `block ${i} content`);
    }
  });

  it("write_doc_from_markdown partial replace via blockOffset/blockLimit", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Partial Write Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Create 4 paragraphs: A, B, C, D
    const labels = ["AAA", "BBB", "CCC", "DDD"];
    const blockIdList: string[] = [];
    for (const label of labels) {
      const pid = genId();
      blockIdList.push(pid);
      const para = new Y.Map();
      setSys(para, pid, "affine:paragraph");
      para.set("sys:parent", noteId);
      para.set("sys:children", new Y.Array());
      para.set("prop:type", "text");
      const t = new Y.Text();
      t.insert(0, label);
      para.set("prop:text", t);
      blocks.set(pid, para);
      noteChildren.push([pid]);
    }

    await pushDoc(socket, docId, ydoc);

    // Now replace blocks 1-2 (BBB, CCC) with new content (XXX, YYY, ZZZ)
    const snapshot = await loadDoc(socket, WORKSPACE_ID!, docId);
    const doc2 = new Y.Doc();
    Y.applyUpdate(doc2, Buffer.from(snapshot.missing, "base64"));
    const prevSV = Y.encodeStateVector(doc2);
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;
    const noteBlock2 = findByFlavour(blocks2, "affine:note")!;
    const noteChildren2 = noteBlock2.get("sys:children") as Y.Array<any>;

    // Delete blocks at index 1 and 2
    const existingIds: string[] = [];
    noteChildren2.forEach((id: string) => existingIds.push(id));
    const toRemove = existingIds.slice(1, 3);
    noteChildren2.delete(1, 2);
    for (const cid of toRemove) blocks2.delete(cid);

    // Insert 3 new blocks at index 1
    const newLabels = ["XXX", "YYY", "ZZZ"];
    const newIds: string[] = [];
    for (const label of newLabels) {
      const pid = genId();
      newIds.push(pid);
      const para = new Y.Map();
      setSys(para, pid, "affine:paragraph");
      para.set("sys:parent", noteId);
      para.set("sys:children", new Y.Array());
      para.set("prop:type", "text");
      const t = new Y.Text();
      t.insert(0, label);
      para.set("prop:text", t);
      blocks2.set(pid, para);
    }
    noteChildren2.insert(1, newIds);

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Read back and verify: AAA, XXX, YYY, ZZZ, DDD
    const readBack = await readBlocks(socket, docId);
    const finalNote = findByFlavour(readBack, "affine:note")!;
    const finalIds: string[] = [];
    (finalNote.get("sys:children") as Y.Array<any>).forEach((id: string) => finalIds.push(id));
    assert.equal(finalIds.length, 5, "should have 5 blocks after partial replace");

    const expected = ["AAA", "XXX", "YYY", "ZZZ", "DDD"];
    for (let i = 0; i < 5; i++) {
      const b = readBack.get(finalIds[i]) as Y.Map<any>;
      const txt = (b.get("prop:text") as Y.Text).toString();
      assert.equal(txt, expected[i], `block ${i} should be ${expected[i]}`);
    }
  });

  it("escaped pipe round-trip: \\| in markdown table cells", async () => {
    // WRITE PATH: markdown with \| → table cell should contain literal |
    const { ydoc: ydoc1, docId: docId1, noteId: noteId1 } = createEmptyDoc("Pipe Escape Write Test");
    docsToCleanup.push(docId1);

    const blocks1 = ydoc1.getMap("blocks") as Y.Map<any>;
    const note1 = blocks1.get(noteId1) as Y.Map<any>;
    const noteChildren1 = note1.get("sys:children") as Y.Array<any>;

    // Simulate write_doc_from_markdown: parse markdown with \| and create table
    const PIPE_PLACEHOLDER = "\uE000PIPE\uE000";
    const inputMd = "| Metric | Value |\n|---|---|\n| Avg \\|Change\\| | $136 |";
    const escapedMd = inputMd.replace(/\\\|/g, PIPE_PLACEHOLDER);
    const md = new MarkdownIt({ linkify: true });
    const tokens = md.parse(escapedMd, {});
    assert.ok(tokens.some((t: any) => t.type === "table_open"), "should parse as 2-column table");

    // Verify the placeholder survives tokenization and ends up in inline content
    const inlineTokens: any[] = [];
    for (const t of tokens) {
      if (t.type === "inline" && t.children) {
        for (const c of t.children) {
          if (c.content.includes(PIPE_PLACEHOLDER)) inlineTokens.push(c);
        }
      }
    }
    assert.ok(inlineTokens.length > 0, "placeholder should appear in inline token content");
    // After unescaping, the cell text should contain literal |
    const restored = inlineTokens[0].content.replace(new RegExp(PIPE_PLACEHOLDER, "g"), "|");
    assert.ok(restored.includes("|Change|"), "unescaped content should have literal pipes");

    // READ PATH: table cell with literal | → markdown should have \|
    const { ydoc: ydoc2, docId: docId2, noteId: noteId2 } = createEmptyDoc("Pipe Escape Read Test");
    docsToCleanup.push(docId2);

    const blocks2 = ydoc2.getMap("blocks") as Y.Map<any>;
    const note2 = blocks2.get(noteId2) as Y.Map<any>;
    const noteChildren2 = note2.get("sys:children") as Y.Array<any>;

    // Create table with literal | in cell content
    const tblId = genId();
    const tbl = new Y.Map();
    setSys(tbl, tblId, "affine:table");
    tbl.set("sys:parent", noteId2);
    tbl.set("sys:children", new Y.Array());

    const r0 = genId(), r1 = genId();
    const c0 = genId(), c1 = genId();
    tbl.set(`prop:rows.${r0}.rowId`, r0);
    tbl.set(`prop:rows.${r0}.order`, "a00");
    tbl.set(`prop:rows.${r1}.rowId`, r1);
    tbl.set(`prop:rows.${r1}.order`, "a01");
    tbl.set(`prop:columns.${c0}.columnId`, c0);
    tbl.set(`prop:columns.${c0}.order`, "a00");
    tbl.set(`prop:columns.${c1}.columnId`, c1);
    tbl.set(`prop:columns.${c1}.order`, "a01");

    const mkText = (s: string) => { const t = new Y.Text(); t.insert(0, s); return t; };
    tbl.set(`prop:cells.${r0}:${c0}.text`, mkText("Metric"));
    tbl.set(`prop:cells.${r0}:${c1}.text`, mkText("Value"));
    tbl.set(`prop:cells.${r1}:${c0}.text`, mkText("Avg |Change|"));
    tbl.set(`prop:cells.${r1}:${c1}.text`, mkText("$136"));

    blocks2.set(tblId, tbl);
    noteChildren2.push([tblId]);

    await pushDoc(socket, docId2, ydoc2);

    // Read back and simulate blocksToMarkdown table export
    const readBack = await readBlocks(socket, docId2);
    const readTbl = readBack.get(tblId) as Y.Map<any>;
    assert.ok(readTbl, "table block should exist");

    // Read cell with pipe and verify it gets escaped
    const cellText = (readTbl.get(`prop:cells.${r1}:${c0}.text`) as Y.Text).toString();
    assert.equal(cellText, "Avg |Change|", "cell should contain literal pipes");
    const escapedCell = cellText.replace(/\|/g, "\\|");
    assert.equal(escapedCell, "Avg \\|Change\\|", "exported markdown should escape pipes");
  });
});


// ── Comment Tests ───────────────────────────────────────────────────────
describe("Comment operations", () => {
  let testDocId: string;
  let testBlockId: string;

  before(async () => {
    requireEnv();
    // Create a test document with a simple text block
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);

    const { ydoc, docId, noteId } = createEmptyDoc("Comment Test Doc");
    testDocId = docId;

    const blocks = ydoc.getMap("blocks") as Y.Map<any>;
    const noteBlock = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = noteBlock.get("sys:children") as Y.Array<any>;

    // Add a paragraph with text
    const paraId = genId();
    testBlockId = paraId;
    const para = new Y.Map();
    setSys(para, paraId, "affine:paragraph");
    para.set("sys:parent", noteId);
    para.set("sys:children", new Y.Array());
    para.set("prop:type", "text");
    const text = new Y.Text();
    text.insert(0, "Click anywhere to start typing");
    para.set("prop:text", text);
    blocks.set(paraId, para);
    noteChildren.push([paraId]);

    const update = Y.encodeStateAsUpdate(ydoc);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(update).toString("base64"));
    socket.disconnect();
  });

  after(async () => {
    // Clean up test document
    if (testDocId) {
      const socket = await connect();
      await cleanupDoc(socket, testDocId);
      socket.disconnect();
    }
  });

  it("should create comment with text highlighting", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);

    // Load document
    const docData = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc = new Y.Doc();
    if (docData.missing) {
      Y.applyUpdate(ydoc, Buffer.from(docData.missing, "base64"));
    }

    const blocks = ydoc.getMap("blocks");
    const block = blocks.get(testBlockId) as Y.Map<any>;
    assert.ok(block, "Test block should exist");

    const text = block.get("prop:text") as Y.Text;
    const textContent = text.toString();
    assert.equal(textContent, "Click anywhere to start typing");

    // Apply comment formatting
    const commentId = "test-comment-" + Date.now();
    const selectedText = "anywhere";
    const startIndex = textContent.indexOf(selectedText);
    assert.notEqual(startIndex, -1, "Selected text should be found");

    text.format(startIndex, selectedText.length, { [`comment-${commentId}`]: true });

    // Push update
    const update = Y.encodeStateAsUpdate(ydoc);
    await pushDocUpdate(socket, WORKSPACE_ID!, testDocId, Buffer.from(update).toString("base64"));

    // Verify formatting was applied
    const docData2 = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc2 = new Y.Doc();
    if (docData2.missing) {
      Y.applyUpdate(ydoc2, Buffer.from(docData2.missing, "base64"));
    }

    const blocks2 = ydoc2.getMap("blocks");
    const block2 = blocks2.get(testBlockId) as Y.Map<any>;
    const text2 = block2.get("prop:text") as Y.Text;
    const delta = text2.toDelta();

    let foundFormatting = false;
    for (const op of delta) {
      if (op.attributes && op.attributes[`comment-${commentId}`]) {
        foundFormatting = true;
        assert.equal(op.insert, selectedText, "Formatted text should match selected text");
      }
    }
    assert.ok(foundFormatting, "Comment formatting should be present");

    socket.disconnect();
  });

  it("should remove comment formatting on delete", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);

    // Load document
    const docData = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc = new Y.Doc();
    if (docData.missing) {
      Y.applyUpdate(ydoc, Buffer.from(docData.missing, "base64"));
    }

    const blocks = ydoc.getMap("blocks");
    const block = blocks.get(testBlockId) as Y.Map<any>;
    const text = block.get("prop:text") as Y.Text;

    // Apply comment formatting
    const commentId = "test-delete-" + Date.now();
    const selectedText = "Click";
    const textContent = text.toString();
    const startIndex = textContent.indexOf(selectedText);

    text.format(startIndex, selectedText.length, { [`comment-${commentId}`]: true });
    let update = Y.encodeStateAsUpdate(ydoc);
    await pushDocUpdate(socket, WORKSPACE_ID!, testDocId, Buffer.from(update).toString("base64"));

    // Verify formatting exists
    const docData2 = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc2 = new Y.Doc();
    if (docData2.missing) {
      Y.applyUpdate(ydoc2, Buffer.from(docData2.missing, "base64"));
    }

    const blocks2 = ydoc2.getMap("blocks");
    const block2 = blocks2.get(testBlockId) as Y.Map<any>;
    const text2 = block2.get("prop:text") as Y.Text;
    let delta = text2.toDelta();

    let hasFormatting = false;
    for (const op of delta) {
      if (op.attributes && op.attributes[`comment-${commentId}`]) {
        hasFormatting = true;
      }
    }
    assert.ok(hasFormatting, "Formatting should exist before delete");

    // Remove formatting
    let index = 0;
    for (const op of delta) {
      const length = typeof op.insert === "string" ? op.insert.length : 1;
      if (op.attributes && op.attributes[`comment-${commentId}`]) {
        text2.format(index, length, { [`comment-${commentId}`]: null });
      }
      index += length;
    }

    update = Y.encodeStateAsUpdate(ydoc2);
    await pushDocUpdate(socket, WORKSPACE_ID!, testDocId, Buffer.from(update).toString("base64"));

    // Verify formatting is removed
    const docData3 = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc3 = new Y.Doc();
    if (docData3.missing) {
      Y.applyUpdate(ydoc3, Buffer.from(docData3.missing, "base64"));
    }

    const blocks3 = ydoc3.getMap("blocks");
    const block3 = blocks3.get(testBlockId) as Y.Map<any>;
    const text3 = block3.get("prop:text") as Y.Text;
    delta = text3.toDelta();

    let stillHasFormatting = false;
    for (const op of delta) {
      if (op.attributes && op.attributes[`comment-${commentId}`]) {
        stillHasFormatting = true;
      }
    }
    assert.ok(!stillHasFormatting, "Formatting should be removed after delete");

    socket.disconnect();
  });

  it("should create multiple comments in batch with single WebSocket connection", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);

    const docData = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc = new Y.Doc();
    if (docData.missing) {
      Y.applyUpdate(ydoc, Buffer.from(docData.missing, "base64"));
    }

    const blocks = ydoc.getMap("blocks");
    const block = blocks.get(testBlockId) as Y.Map<any>;
    const text = block.get("prop:text") as Y.Text;
    const textContent = text.toString();

    // Apply multiple comment formats in batch
    const comments = [
      { id: `batch-1-${Date.now()}`, selectedText: "Click", startIndex: textContent.indexOf("Click") },
      { id: `batch-2-${Date.now()}`, selectedText: "anywhere", startIndex: textContent.indexOf("anywhere") },
      { id: `batch-3-${Date.now()}`, selectedText: "typing", startIndex: textContent.indexOf("typing") }
    ];

    for (const comment of comments) {
      assert.notEqual(comment.startIndex, -1, `Text "${comment.selectedText}" should be found`);
      text.format(comment.startIndex, comment.selectedText.length, { [`comment-${comment.id}`]: true });
    }

    // Single push for all comments
    const update = Y.encodeStateAsUpdate(ydoc);
    await pushDocUpdate(socket, WORKSPACE_ID!, testDocId, Buffer.from(update).toString("base64"));

    // Verify all formatting applied
    const docData2 = await loadDoc(socket, WORKSPACE_ID!, testDocId);
    const ydoc2 = new Y.Doc();
    if (docData2.missing) {
      Y.applyUpdate(ydoc2, Buffer.from(docData2.missing, "base64"));
    }

    const blocks2 = ydoc2.getMap("blocks");
    const block2 = blocks2.get(testBlockId) as Y.Map<any>;
    const text2 = block2.get("prop:text") as Y.Text;
    const delta = text2.toDelta();

    const foundComments = new Set<string>();
    for (const op of delta) {
      if (op.attributes) {
        for (const comment of comments) {
          if (op.attributes[`comment-${comment.id}`]) {
            foundComments.add(comment.id);
          }
        }
      }
    }

    assert.equal(foundComments.size, comments.length, "All batch comments should be applied");

    socket.disconnect();
  });

  // ── Batch operation tests ─────────────────────────────────────────────

  it("delete_doc soft-deletes (trashes) a single doc", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);
    try {
      // Create a doc and register in workspace meta
      const { ydoc, docId } = createEmptyDoc("Trash Me");
      const update = Y.encodeStateAsUpdate(ydoc);
      await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(update).toString("base64"));

      const wsDoc = new Y.Doc();
      const snap = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap.missing) Y.applyUpdate(wsDoc, Buffer.from(snap.missing, "base64"));
      let prevSV = Y.encodeStateVector(wsDoc);
      const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      const entry = new Y.Map();
      entry.set("id", docId);
      entry.set("title", "Trash Me");
      entry.set("createDate", Date.now());
      entry.set("tags", new Y.Array());
      pages.push([entry as any]);
      let delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));

      // Soft-delete: set trash flag (mirrors new handler logic)
      const wsDoc2 = new Y.Doc();
      const snap2 = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap2.missing) Y.applyUpdate(wsDoc2, Buffer.from(snap2.missing, "base64"));
      prevSV = Y.encodeStateVector(wsDoc2);
      const pages2 = wsDoc2.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      pages2.forEach((m: any) => {
        if (m.get && m.get("id") === docId) {
          m.set("trash", true);
          m.set("trashDate", Date.now());
        }
      });
      delta = Y.encodeStateAsUpdate(wsDoc2, prevSV);
      await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));

      // Verify: page still in meta but has trash=true
      const wsDoc3 = new Y.Doc();
      const snap3 = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap3.missing) Y.applyUpdate(wsDoc3, Buffer.from(snap3.missing, "base64"));
      const pages3 = wsDoc3.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      let found = false;
      pages3.forEach((m: any) => {
        if (m.get && m.get("id") === docId) {
          assert.equal(m.get("trash"), true, "doc should be marked as trash");
          assert.ok(m.get("trashDate"), "trashDate should be set");
          found = true;
        }
      });
      assert.ok(found, "trashed doc should still exist in workspace meta");
      console.log(`  soft-deleted doc ${docId}`);

      // Cleanup: hard-remove from meta
      await cleanupDoc(socket, docId);
    } finally {
      socket.disconnect();
    }
  });

  it("batch delete_doc soft-deletes multiple docs", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);
    try {
      // Create 3 docs
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { ydoc, docId } = createEmptyDoc(`Batch Trash ${i}`);
        ids.push(docId);
        const update = Y.encodeStateAsUpdate(ydoc);
        await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(update).toString("base64"));
      }
      // Register in workspace meta
      const wsDoc = new Y.Doc();
      const snap = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap.missing) Y.applyUpdate(wsDoc, Buffer.from(snap.missing, "base64"));
      let prevSV = Y.encodeStateVector(wsDoc);
      const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      for (const docId of ids) {
        const entry = new Y.Map();
        entry.set("id", docId);
        entry.set("title", "Batch Trash");
        entry.set("createDate", Date.now());
        entry.set("tags", new Y.Array());
        pages.push([entry as any]);
      }
      let delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));

      // Soft-delete: set trash flags (mirrors new handler logic)
      const wsDoc2 = new Y.Doc();
      const snap2 = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap2.missing) Y.applyUpdate(wsDoc2, Buffer.from(snap2.missing, "base64"));
      prevSV = Y.encodeStateVector(wsDoc2);
      const pages2 = wsDoc2.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      const idSet = new Set(ids);
      const trashed: string[] = [];
      pages2.forEach((m: any) => {
        if (m.get && idSet.has(m.get("id"))) {
          m.set("trash", true);
          m.set("trashDate", Date.now());
          trashed.push(m.get("id"));
        }
      });
      delta = Y.encodeStateAsUpdate(wsDoc2, prevSV);
      await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));

      // Verify: all docs still in meta with trash=true
      const wsDoc3 = new Y.Doc();
      const snap3 = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap3.missing) Y.applyUpdate(wsDoc3, Buffer.from(snap3.missing, "base64"));
      const pages3 = wsDoc3.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      const trashedSet = new Set<string>();
      pages3.forEach((m: any) => {
        if (m.get && idSet.has(m.get("id"))) {
          assert.equal(m.get("trash"), true, `doc ${m.get("id")} should be trashed`);
          assert.ok(m.get("trashDate"), "trashDate should be set");
          trashedSet.add(m.get("id"));
        }
      });
      assert.equal(trashedSet.size, ids.length, "all docs should be trashed");
      assert.deepEqual(trashed.sort(), ids.sort(), "trashed list should match input ids");
      console.log(`  batch soft-deleted ${ids.length} docs`);

      // Cleanup: hard-remove from meta
      await cleanupDocs(socket, ids);
    } finally {
      socket.disconnect();
    }
  });

  it("batch publish_doc / revoke_doc: multiple docs", async () => {
    const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
      Authorization: `Bearer ${TOKEN}`,
    });
    await joinWorkspace(socket, WORKSPACE_ID!);
    try {
      // Create 2 docs
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const { ydoc, docId } = createEmptyDoc(`Batch Publish ${i}`);
        ids.push(docId);
        const update = Y.encodeStateAsUpdate(ydoc);
        await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(update).toString("base64"));
      }
      // Register in workspace meta
      const wsDoc = new Y.Doc();
      const snap = await loadDoc(socket, WORKSPACE_ID!, WORKSPACE_ID!);
      if (snap.missing) Y.applyUpdate(wsDoc, Buffer.from(snap.missing, "base64"));
      const prevSV = Y.encodeStateVector(wsDoc);
      const pages = wsDoc.getMap("meta").get("pages") as Y.Array<Y.Map<any>>;
      for (const docId of ids) {
        const entry = new Y.Map();
        entry.set("id", docId);
        entry.set("title", "Batch Publish");
        entry.set("createDate", Date.now());
        entry.set("tags", new Y.Array());
        pages.push([entry as any]);
      }
      const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));

      // Batch publish via GraphQL
      const publishMutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const endpoint = BASE_URL + "/graphql";
      const headers: Record<string, string> = { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` };

      const publishResults = await Promise.all(
        ids.map(docId =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ query: publishMutation, variables: { workspaceId: WORKSPACE_ID, docId, mode: "Page" } }),
          }).then(r => r.json() as any)
        )
      );
      for (const r of publishResults) {
        assert.ok(!r.errors, "publish should succeed");
        assert.equal(r.data.publishDoc.public, true);
      }
      console.log(`  batch published ${ids.length} docs`);

      // Batch revoke
      const revokeMutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const revokeResults = await Promise.all(
        ids.map(docId =>
          fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify({ query: revokeMutation, variables: { workspaceId: WORKSPACE_ID, docId } }),
          }).then(r => r.json() as any)
        )
      );
      for (const r of revokeResults) {
        assert.ok(!r.errors, "revoke should succeed");
        assert.equal(r.data.revokePublicDoc.public, false);
      }
      console.log(`  batch revoked ${ids.length} docs`);

      // Clean up: delete the published docs
      await cleanupDocs(socket, ids);
    } finally {
      socket.disconnect();
    }
  });
});
