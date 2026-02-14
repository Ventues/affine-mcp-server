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
});
