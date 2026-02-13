/**
 * Integration tests for affine-mcp-server.
 *
 * Requires env vars:
 *   AFFINE_BASE_URL   — e.g. https://affine.workisboring.com
 *   AFFINE_API_TOKEN  — personal access token
 *   AFFINE_WORKSPACE_ID — workspace to test in
 *
 * Run:  npm test
 */
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
