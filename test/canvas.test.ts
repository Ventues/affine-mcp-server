/**
 * Integration tests for Edgeless Canvas MCP tools.
 *
 * Run:  npx tsx --test test/canvas.test.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
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

const BASE_URL = process.env.AFFINE_BASE_URL;
const TOKEN = process.env.AFFINE_API_TOKEN;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;

if (!BASE_URL || !TOKEN || !WORKSPACE_ID) {
  console.error("Skipping canvas tests — set AFFINE_BASE_URL, AFFINE_API_TOKEN, AFFINE_WORKSPACE_ID");
  process.exit(0);
}

// ── Helpers ─────────────────────────────────────────────────────────────
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

function createEmptyDoc(title: string) {
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

  return { ydoc, docId, surfaceId };
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

function getSurfaceElements(blocks: Y.Map<any>): Y.Map<any> | null {
  for (const [, block] of blocks) {
    if (block instanceof Y.Map && block.get("sys:flavour") === "affine:surface") {
      const outer = block.get("prop:elements") as Y.Map<any>;
      return outer?.get("value") as Y.Map<any> || null;
    }
  }
  return null;
}

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
      if (entry instanceof Y.Map && entry.get("id") === docId) pages.delete(i, 1);
    }
  }
  const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
  if (delta.byteLength > 0) {
    await pushDocUpdate(socket, WORKSPACE_ID!, WORKSPACE_ID!, Buffer.from(delta).toString("base64"));
  }
}

// ── Import canvas tools (test via CRDT, same as integration.test.ts pattern) ──
// We test by calling the tool functions indirectly through the registerCanvasTools
// registration, but since the tools operate on CRDT, we can also verify by
// directly manipulating and reading the Y.Doc.

import { registerCanvasTools } from "../src/tools/canvas.js";
import { GraphQLClient } from "../src/graphqlClient.js";

function makeMockServer() {
  const tools: Record<string, { meta: any; handler: Function }> = {};
  return {
    registerTool(name: string, meta: any, handler: Function) {
      tools[name] = { meta, handler };
    },
    call(name: string, args: any) {
      return tools[name].handler(args);
    },
    tools,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────
describe("Canvas tools", () => {
  let socket: any;
  let server: ReturnType<typeof makeMockServer>;
  const createdDocs: string[] = [];

  before(async () => {
    socket = await connect();
    server = makeMockServer();
    const gql = new GraphQLClient({
      endpoint: `${BASE_URL}/graphql`,
      bearer: TOKEN,
    });
    registerCanvasTools(server as any, gql, { workspaceId: WORKSPACE_ID });
  });

  after(async () => {
    for (const docId of createdDocs) {
      try { await cleanupDoc(socket, docId); } catch {}
    }
    socket?.disconnect();
  });

  it("add_shape creates a shape element on the canvas", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-shape-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const result = await server.call("add_shape", {
      workspaceId: WORKSPACE_ID,
      docId,
      shapeType: "rect",
      x: 100, y: 200, width: 150, height: 80,
      text: "Hello Shape",
    });

    // Verify the shape was created in CRDT
    const blocks = await readBlocks(socket, docId);
    const elements = getSurfaceElements(blocks);
    assert.ok(elements, "Surface elements map should exist");
    assert.ok(elements.size > 0, "Should have at least one element");

    let found = false;
    for (const [, el] of elements) {
      if (el instanceof Y.Map && el.get("type") === "shape") {
        assert.equal(el.get("shapeType"), "rect");
        assert.equal(el.get("xywh"), "[100,200,150,80]");
        assert.ok(el.get("text")?.toString().includes("Hello Shape"));
        found = true;
      }
    }
    assert.ok(found, "Shape element should exist in surface elements");
  });

  it("add_connector connects two shapes", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-connector-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    // Create two shapes first
    await server.call("add_shape", {
      workspaceId: WORKSPACE_ID, docId,
      shapeType: "rect", x: 0, y: 0, width: 100, height: 60, text: "A",
    });
    await server.call("add_shape", {
      workspaceId: WORKSPACE_ID, docId,
      shapeType: "rect", x: 300, y: 0, width: 100, height: 60, text: "B",
    });

    // Get the shape IDs
    const blocks = await readBlocks(socket, docId);
    const elements = getSurfaceElements(blocks)!;
    const shapeIds: string[] = [];
    for (const [id, el] of elements) {
      if (el instanceof Y.Map && el.get("type") === "shape") shapeIds.push(id);
    }
    assert.equal(shapeIds.length, 2, "Should have 2 shapes");

    // Connect them
    await server.call("add_connector", {
      workspaceId: WORKSPACE_ID, docId,
      sourceId: shapeIds[0], targetId: shapeIds[1],
      mode: 0,
    });

    // Verify connector
    const blocks2 = await readBlocks(socket, docId);
    const elements2 = getSurfaceElements(blocks2)!;
    let connectorFound = false;
    for (const [, el] of elements2) {
      if (el instanceof Y.Map && el.get("type") === "connector") {
        const src = el.get("source");
        const tgt = el.get("target");
        assert.equal(src?.id || src, shapeIds[0]);
        assert.equal(tgt?.id || tgt, shapeIds[1]);
        connectorFound = true;
      }
    }
    assert.ok(connectorFound, "Connector should exist");
  });

  it("add_canvas_text creates a text element", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-text-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    await server.call("add_canvas_text", {
      workspaceId: WORKSPACE_ID, docId,
      x: 50, y: 50, width: 200, height: 40,
      text: "Canvas Text",
    });

    const blocks = await readBlocks(socket, docId);
    const elements = getSurfaceElements(blocks)!;
    let found = false;
    for (const [, el] of elements) {
      if (el instanceof Y.Map && el.get("type") === "text") {
        assert.ok(el.get("text")?.toString().includes("Canvas Text"));
        assert.equal(el.get("xywh"), "[50,50,200,40]");
        found = true;
      }
    }
    assert.ok(found, "Text element should exist");
  });

  it("list_canvas_elements returns all elements", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-list-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    await server.call("add_shape", {
      workspaceId: WORKSPACE_ID, docId,
      shapeType: "ellipse", x: 10, y: 10, width: 80, height: 80,
    });
    await server.call("add_canvas_text", {
      workspaceId: WORKSPACE_ID, docId,
      x: 200, y: 200, width: 100, height: 30, text: "Label",
    });

    const result = await server.call("list_canvas_elements", {
      workspaceId: WORKSPACE_ID, docId,
    });

    // Result is { content: [{ text: "..." }] } from the text() helper
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.length, 2, "Should list 2 elements");
    const types = parsed.map((e: any) => e.type).sort();
    assert.deepEqual(types, ["shape", "text"]);
  });

  it("build_graph creates nodes and edges in one call", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-graph-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    await server.call("build_graph", {
      workspaceId: WORKSPACE_ID, docId,
      nodes: [
        { text: "Start", shapeType: "rect" },
        { text: "Process", shapeType: "rect" },
        { text: "End", shapeType: "ellipse" },
      ],
      edges: [
        { from: 0, to: 1 },
        { from: 1, to: 2, text: "done" },
      ],
    });

    const blocks = await readBlocks(socket, docId);
    const elements = getSurfaceElements(blocks)!;

    let shapes = 0, connectors = 0;
    for (const [, el] of elements) {
      if (el instanceof Y.Map) {
        if (el.get("type") === "shape") shapes++;
        if (el.get("type") === "connector") connectors++;
      }
    }
    assert.equal(shapes, 3, "Should have 3 shape nodes");
    assert.equal(connectors, 2, "Should have 2 connector edges");
  });

  it("build_graph auto-layout positions nodes in a grid", async () => {
    const { ydoc, docId } = createEmptyDoc("canvas-layout-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    await server.call("build_graph", {
      workspaceId: WORKSPACE_ID, docId,
      nodes: [{ text: "A" }, { text: "B" }, { text: "C" }, { text: "D" }],
      edges: [],
    });

    const blocks = await readBlocks(socket, docId);
    const elements = getSurfaceElements(blocks)!;
    const positions: string[] = [];
    for (const [, el] of elements) {
      if (el instanceof Y.Map && el.get("type") === "shape") {
        positions.push(el.get("xywh"));
      }
    }
    assert.equal(positions.length, 4);
    // All positions should be different (grid layout)
    const unique = new Set(positions);
    assert.equal(unique.size, 4, "All nodes should have unique positions");
  });
});
