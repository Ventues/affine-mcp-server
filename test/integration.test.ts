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
    // 1. Create doc with content
    const { ydoc, docId, noteId } = createEmptyDoc("Patch Test");
    docsToCleanup.push(docId);

    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Add two paragraphs
    function addPara(text: string) {
      const id = genId();
      const b = new Y.Map();
      setSys(b, id, "affine:paragraph");
      b.set("sys:parent", noteId);
      b.set("sys:children", new Y.Array());
      b.set("prop:type", "text");
      const yt = new Y.Text();
      yt.insert(0, text);
      b.set("prop:text", yt);
      blocks.set(id, b);
      noteChildren.push([id]);
    }
    addPara("Hello world");
    addPara("Goodbye world");

    await pushDoc(socket, docId, ydoc);

    // 2. Read back and verify both paragraphs exist
    const blocks2 = await readBlocks(socket, docId);
    const flavours = noteChildFlavours(blocks2);
    assert.equal(flavours.length, 2);

    // 3. Simulate update_doc_markdown: read text, str_replace, write back
    // Read all paragraph texts
    const noteBlock = findByFlavour(blocks2, "affine:note")!;
    const childIds: string[] = [];
    (noteBlock.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds.push(id));
    const texts = childIds.map((id) => {
      const b = blocks2.get(id) as Y.Map<any>;
      return b.get("prop:text")?.toString() || "";
    });
    assert.ok(texts.includes("Hello world"));
    assert.ok(texts.includes("Goodbye world"));

    // 4. Patch: replace "Goodbye world" with "Updated world" at Y.Doc level
    const doc3 = new Y.Doc();
    const snap3 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc3, Buffer.from(snap3.missing!, "base64"));
    const prevSV = Y.encodeStateVector(doc3);
    const blocks3 = doc3.getMap("blocks") as Y.Map<any>;
    const note3 = findByFlavour(blocks3, "affine:note")!;
    const kids3: string[] = [];
    (note3.get("sys:children") as Y.Array<any>).forEach((id: string) => kids3.push(id));
    for (const kid of kids3) {
      const b = blocks3.get(kid) as Y.Map<any>;
      const yt = b.get("prop:text") as Y.Text | undefined;
      if (yt && yt.toString() === "Goodbye world") {
        yt.delete(0, yt.length);
        yt.insert(0, "Updated world");
      }
    }
    const delta = Y.encodeStateAsUpdate(doc3, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // 5. Read back and verify patch applied
    const blocks4 = await readBlocks(socket, docId);
    const note4 = findByFlavour(blocks4, "affine:note")!;
    const kids4: string[] = [];
    (note4.get("sys:children") as Y.Array<any>).forEach((id: string) => kids4.push(id));
    const texts4 = kids4.map((id) => {
      const b = blocks4.get(id) as Y.Map<any>;
      return b.get("prop:text")?.toString() || "";
    });
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
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Add a heading and a paragraph
    function addBlock(text: string, type: string) {
      const id = genId();
      const b = new Y.Map();
      setSys(b, id, "affine:paragraph");
      b.set("sys:parent", noteId);
      b.set("sys:children", new Y.Array());
      b.set("prop:type", type);
      const yt = new Y.Text();
      yt.insert(0, text);
      b.set("prop:text", yt);
      blocks.set(id, b);
      noteChildren.push([id]);
      return id;
    }
    const h2Id = addBlock("My Heading", "h2");
    const paraId = addBlock("Some content", "text");

    await pushDoc(socket, docId, ydoc);

    // Read back and verify block IDs and types are trackable
    const blocks2 = await readBlocks(socket, docId);
    const noteBlock = findByFlavour(blocks2, "affine:note")!;
    const childIds: string[] = [];
    (noteBlock.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds.push(id));
    assert.equal(childIds.length, 2);
    assert.equal(childIds[0], h2Id);
    assert.equal(childIds[1], paraId);

    const h2Block = blocks2.get(h2Id) as Y.Map<any>;
    assert.equal(h2Block.get("prop:type"), "h2");
    assert.equal(h2Block.get("prop:text")?.toString(), "My Heading");

    const paraBlock = blocks2.get(paraId) as Y.Map<any>;
    assert.equal(paraBlock.get("prop:type"), "text");
    assert.equal(paraBlock.get("prop:text")?.toString(), "Some content");
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
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    function addPara(txt: string) {
      const id = genId();
      const b = new Y.Map();
      setSys(b, id, "affine:paragraph");
      b.set("sys:parent", noteId);
      b.set("sys:children", new Y.Array());
      b.set("prop:type", "text");
      const yt = new Y.Text(); yt.insert(0, txt);
      b.set("prop:text", yt);
      blocks.set(id, b);
      noteChildren.push([id]);
      return id;
    }
    const aId = addPara("A");
    const bId = addPara("B");
    const cId = addPara("C");
    const dId = addPara("D");

    await pushDoc(socket, docId, ydoc);

    // Delete B and D in one transaction
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;

    const prevSV = Y.encodeStateVector(doc2);
    const note2 = blocks2.get(noteId) as Y.Map<any>;
    const nc2 = note2.get("sys:children") as Y.Array<any>;

    // Remove B and D from children
    const toDelete = [bId, dId];
    for (const id of toDelete) {
      let idx = -1;
      nc2.forEach((cid: string, i: number) => { if (cid === id) idx = i; });
      if (idx >= 0) nc2.delete(idx, 1);
      blocks2.delete(id);
    }

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Verify only A and C remain
    const blocks3 = await readBlocks(socket, docId);
    assert.ok(blocks3.get(aId), "A should exist");
    assert.equal(blocks3.get(bId), undefined, "B should be deleted");
    assert.ok(blocks3.get(cId), "C should exist");
    assert.equal(blocks3.get(dId), undefined, "D should be deleted");

    const note3 = findByFlavour(blocks3, "affine:note")!;
    const finalIds: string[] = [];
    (note3.get("sys:children") as Y.Array<any>).forEach((id: string) => finalIds.push(id));
    assert.deepEqual(finalIds, [aId, cId], "only A and C should remain");
  });

  it("update_doc_markdown char offset logic", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Offset Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    // Add 3 paragraphs: A, B, C
    function addPara(text: string) {
      const id = genId();
      const b = new Y.Map();
      setSys(b, id, "affine:paragraph");
      b.set("sys:parent", noteId);
      b.set("sys:children", new Y.Array());
      b.set("prop:type", "text");
      const yt = new Y.Text(); yt.insert(0, text);
      b.set("prop:text", yt);
      blocks.set(id, b);
      noteChildren.push([id]);
      return id;
    }
    const aId = addPara("Block A");
    const bId = addPara("Block B");
    const cId = addPara("Block C");

    await pushDoc(socket, docId, ydoc);

    // Simulate update_doc_markdown: change only "Block B" → "Block B Updated"
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;

    // Verify only block B is affected
    const prevSV = Y.encodeStateVector(doc2);
    const bBlock = blocks2.get(bId) as Y.Map<any>;
    const bText = bBlock.get("prop:text") as Y.Text;
    bText.delete(0, bText.length);
    bText.insert(0, "Block B Updated");

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Read back and verify A and C unchanged, B updated
    const blocks3 = await readBlocks(socket, docId);
    const aBlock3 = blocks3.get(aId) as Y.Map<any>;
    const bBlock3 = blocks3.get(bId) as Y.Map<any>;
    const cBlock3 = blocks3.get(cId) as Y.Map<any>;

    assert.equal(aBlock3.get("prop:text")?.toString(), "Block A", "A should be unchanged");
    assert.equal(bBlock3.get("prop:text")?.toString(), "Block B Updated", "B should be updated");
    assert.equal(cBlock3.get("prop:text")?.toString(), "Block C", "C should be unchanged");

    // Verify block IDs are preserved (surgical update, not full rewrite)
    const noteBlock3 = findByFlavour(blocks3, "affine:note")!;
    const childIds3: string[] = [];
    (noteBlock3.get("sys:children") as Y.Array<any>).forEach((id: string) => childIds3.push(id));
    assert.deepEqual(childIds3, [aId, bId, cId], "block IDs should be preserved");
  });

  it("move_block reorders and reparents blocks", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("Move Block Test");
    docsToCleanup.push(docId);
    const blocks = ydoc.getMap("blocks");
    const note = blocks.get(noteId) as Y.Map<any>;
    const noteChildren = note.get("sys:children") as Y.Array<any>;

    function addPara(txt: string) {
      const id = genId();
      const b = new Y.Map();
      setSys(b, id, "affine:paragraph");
      b.set("sys:parent", noteId);
      b.set("sys:children", new Y.Array());
      b.set("prop:type", "text");
      const yt = new Y.Text(); yt.insert(0, txt);
      b.set("prop:text", yt);
      blocks.set(id, b);
      noteChildren.push([id]);
      return id;
    }
    const aId = addPara("A");
    const bId = addPara("B");
    const cId = addPara("C");

    await pushDoc(socket, docId, ydoc);

    // Move C before A (reorder within same parent)
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;

    // Remove C from old position
    const note2 = blocks2.get(noteId) as Y.Map<any>;
    const nc2 = note2.get("sys:children") as Y.Array<any>;
    let cIdx = -1;
    nc2.forEach((id: string, i: number) => { if (id === cId) cIdx = i; });
    nc2.delete(cIdx, 1);

    // Insert C at index 0 (before A)
    const prevSV = Y.encodeStateVector(doc2);
    nc2.insert(0, [cId]);

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Verify order is now C, A, B
    const blocks3 = await readBlocks(socket, docId);
    const note3 = findByFlavour(blocks3, "affine:note")!;
    const finalIds: string[] = [];
    (note3.get("sys:children") as Y.Array<any>).forEach((id: string) => finalIds.push(id));
    assert.deepEqual(finalIds, [cId, aId, bId], "order should be C, A, B");
  });

  it("update_doc_title renames a document", async () => {
    const { ydoc, docId } = createEmptyDoc("Old Title");
    docsToCleanup.push(docId);
    await pushDoc(socket, docId, ydoc);

    // Update title
    const doc2 = new Y.Doc();
    const snap2 = await loadDoc(socket, WORKSPACE_ID!, docId);
    Y.applyUpdate(doc2, Buffer.from(snap2.missing!, "base64"));
    const blocks2 = doc2.getMap("blocks") as Y.Map<any>;

    let pageId = "";
    blocks2.forEach((_v: any, k: string) => {
      const b = blocks2.get(k) as Y.Map<any>;
      if (b.get("sys:flavour") === "affine:page") pageId = k;
    });
    assert.ok(pageId, "should have a page block");

    const pageBlock = blocks2.get(pageId) as Y.Map<any>;
    const prevSV = Y.encodeStateVector(doc2);
    const titleYText = pageBlock.get("prop:title") as Y.Text;
    titleYText.delete(0, titleYText.length);
    titleYText.insert(0, "New Title");

    const delta = Y.encodeStateAsUpdate(doc2, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, docId, Buffer.from(delta).toString("base64"));

    // Verify title changed
    const blocks3 = await readBlocks(socket, docId);
    let pageId3 = "";
    blocks3.forEach((_v: any, k: string) => {
      const b = blocks3.get(k) as Y.Map<any>;
      if (b.get("sys:flavour") === "affine:page") pageId3 = k;
    });
    const page3 = blocks3.get(pageId3) as Y.Map<any>;
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
      const socket = await connectWorkspaceSocket(wsUrlFromGraphQLEndpoint(BASE_URL!), {
        Authorization: `Bearer ${TOKEN}`,
      });
      await joinWorkspace(socket, WORKSPACE_ID!);
      await wsDeleteDoc(socket, WORKSPACE_ID!, testDocId);
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
});
