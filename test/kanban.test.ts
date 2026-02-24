/**
 * Integration tests for Kanban MCP tools.
 *
 * Run:  npx tsx --test test/kanban.test.ts
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
  console.error("Skipping kanban tests — set AFFINE_BASE_URL, AFFINE_API_TOKEN, AFFINE_WORKSPACE_ID");
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

import { registerKanbanTools } from "../src/tools/kanban.js";
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
describe("Kanban tools", () => {
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
    registerKanbanTools(server as any, gql, { workspaceId: WORKSPACE_ID });
  });

  after(async () => {
    for (const docId of createdDocs) {
      try { await cleanupDoc(socket, docId); } catch {}
    }
    socket?.disconnect();
  });

  it("create_kanban_board creates a database block with kanban view", async () => {
    const { ydoc, docId, noteId } = createEmptyDoc("kanban-create-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const result = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Task Board",
      statuses: ["Todo", "In Progress", "Done"],
    });

    const parsed = JSON.parse(result.content[0].text);
    assert.ok(parsed.databaseBlockId, "Should return databaseBlockId");
    assert.ok(parsed.statusColumnId, "Should return statusColumnId");
    assert.ok(parsed.statusOptions.Todo, "Should return Todo option ID");
    assert.ok(parsed.statusOptions["In Progress"], "Should return In Progress option ID");
    assert.ok(parsed.statusOptions.Done, "Should return Done option ID");

    // Verify CRDT state
    const blocks = await readBlocks(socket, docId);
    const dbBlock = blocks.get(parsed.databaseBlockId) as Y.Map<any>;
    assert.ok(dbBlock, "Database block should exist");
    assert.equal(dbBlock.get("sys:flavour"), "affine:database");

    const columns = dbBlock.get("prop:columns") as Y.Array<any>;
    assert.ok(columns.length >= 1, "Should have at least Status column");
    const statusCol = columns.get(0);
    assert.equal(statusCol.name, "Status");
    assert.equal(statusCol.type, "select");
    assert.equal(statusCol.data.options.length, 3);

    const views = dbBlock.get("prop:views") as Y.Array<any>;
    assert.equal(views.length, 1);
    const view = views.get(0);
    assert.equal(view.mode, "kanban");
    assert.equal(view.groupBy.columnId, parsed.statusColumnId);
    assert.equal(view.groupProperties.length, 3);
  });

  it("create_kanban_board with assignees and priorities adds extra columns", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-extra-cols-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const result = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Full Board",
      assignees: ["engineering", "qa"],
      priorities: ["High", "Low"],
    });

    const parsed = JSON.parse(result.content[0].text);
    const blocks = await readBlocks(socket, docId);
    const dbBlock = blocks.get(parsed.databaseBlockId) as Y.Map<any>;
    const columns = dbBlock.get("prop:columns") as Y.Array<any>;
    assert.equal(columns.length, 3, "Should have Status + Assignee + Priority");

    const names = [];
    for (let i = 0; i < columns.length; i++) names.push(columns.get(i).name);
    assert.deepEqual(names, ["Status", "Assignee", "Priority"]);
  });

  it("add_kanban_card adds a card with correct cell values", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-add-card-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const board = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Card Board",
      statuses: ["Todo", "Done"],
      assignees: ["eng"],
    });
    const boardData = JSON.parse(board.content[0].text);

    const cardResult = await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Fix auth bug",
      status: "Todo",
      assignee: "eng",
    });
    const cardData = JSON.parse(cardResult.content[0].text);
    assert.ok(cardData.cardBlockId, "Should return cardBlockId");

    // Verify CRDT
    const blocks = await readBlocks(socket, docId);
    const cardBlock = blocks.get(cardData.cardBlockId) as Y.Map<any>;
    assert.ok(cardBlock, "Card block should exist");
    assert.equal(cardBlock.get("sys:flavour"), "affine:paragraph");
    assert.ok(cardBlock.get("prop:text")?.toString().includes("Fix auth bug"));

    // Verify cells use nested Y.Map structure: cells[rowId][columnId] = { columnId, value }
    const dbBlock = blocks.get(boardData.databaseBlockId) as Y.Map<any>;
    const cells = dbBlock.get("prop:cells") as Y.Map<any>;
    const columns = dbBlock.get("prop:columns") as Y.Array<any>;
    const statusCol = columns.get(0);

    // Row-level map must exist and be a Y.Map
    const rowMap = cells.get(cardData.cardBlockId);
    assert.ok(rowMap instanceof Y.Map, "cells[cardId] should be a Y.Map");

    // Cell-level map must exist and be a Y.Map
    const cellMap = rowMap.get(statusCol.id);
    assert.ok(cellMap instanceof Y.Map, "cells[cardId][colId] should be a Y.Map");
    assert.equal(cellMap.get("columnId"), statusCol.id);
    const todoOption = statusCol.data.options.find((o: any) => o.value === "Todo");
    assert.equal(cellMap.get("value"), todoOption.id);
  });

  it("move_kanban_card changes the status cell value", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-move-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const board = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Move Board",
      statuses: ["Todo", "In Progress", "Done"],
    });
    const boardData = JSON.parse(board.content[0].text);

    const card = await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Task A",
      status: "Todo",
    });
    const cardData = JSON.parse(card.content[0].text);

    // Move to "In Progress"
    const moveResult = await server.call("move_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      cardBlockId: cardData.cardBlockId,
      newStatus: "In Progress",
    });
    const moveData = JSON.parse(moveResult.content[0].text);
    assert.equal(moveData.ok, true);

    // Verify nested Y.Map structure
    const blocks = await readBlocks(socket, docId);
    const dbBlock = blocks.get(boardData.databaseBlockId) as Y.Map<any>;
    const cells = dbBlock.get("prop:cells") as Y.Map<any>;
    const columns = dbBlock.get("prop:columns") as Y.Array<any>;
    const statusCol = columns.get(0);

    const rowMap = cells.get(cardData.cardBlockId);
    assert.ok(rowMap instanceof Y.Map, "cells[cardId] should be a Y.Map");
    const cellMap = rowMap.get(statusCol.id);
    assert.ok(cellMap instanceof Y.Map, "cells[cardId][colId] should be a Y.Map");
    const inProgressOption = statusCol.data.options.find((o: any) => o.value === "In Progress");
    assert.equal(cellMap.get("value"), inProgressOption.id);
  });

  it("read_kanban_board returns structured board data", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-read-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const board = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Read Board",
      statuses: ["Todo", "Done"],
      assignees: ["eng", "qa"],
    });
    const boardData = JSON.parse(board.content[0].text);

    await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Card 1",
      status: "Todo",
      assignee: "eng",
    });
    await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Card 2",
      status: "Done",
      assignee: "qa",
    });

    const readResult = await server.call("read_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
    });
    const data = JSON.parse(readResult.content[0].text);

    assert.equal(data.title, "Read Board");
    assert.equal(data.columns.length, 2, "Status + Assignee");
    assert.equal(data.cards.length, 2);

    const card1 = data.cards.find((c: any) => c.title === "Card 1");
    assert.ok(card1);
    assert.equal(card1.cells.Status, "Todo");
    assert.equal(card1.cells.Assignee, "eng");

    const card2 = data.cards.find((c: any) => c.title === "Card 2");
    assert.ok(card2);
    assert.equal(card2.cells.Status, "Done");
    assert.equal(card2.cells.Assignee, "qa");
  });

  it("move_kanban_card throws on invalid status label", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-bad-status-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const board = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Error Board",
      statuses: ["Todo", "Done"],
    });
    const boardData = JSON.parse(board.content[0].text);

    const card = await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Task X",
      status: "Todo",
    });
    const cardData = JSON.parse(card.content[0].text);

    await assert.rejects(
      () => server.call("move_kanban_card", {
        workspaceId: WORKSPACE_ID,
        docId,
        databaseBlockId: boardData.databaseBlockId,
        cardBlockId: cardData.cardBlockId,
        newStatus: "Nonexistent",
      }),
      /not found/i,
    );
  });

  it("add_kanban_card with unknown column label is ignored gracefully", async () => {
    const { ydoc, docId } = createEmptyDoc("kanban-unknown-col-test");
    createdDocs.push(docId);
    await pushDoc(socket, docId, ydoc);

    const board = await server.call("create_kanban_board", {
      workspaceId: WORKSPACE_ID,
      docId,
      title: "Graceful Board",
      statuses: ["Todo"],
    });
    const boardData = JSON.parse(board.content[0].text);

    // assignee column doesn't exist on this board
    const cardResult = await server.call("add_kanban_card", {
      workspaceId: WORKSPACE_ID,
      docId,
      databaseBlockId: boardData.databaseBlockId,
      title: "Card OK",
      status: "Todo",
      assignee: "eng",
    });
    const cardData = JSON.parse(cardResult.content[0].text);
    assert.ok(cardData.cardBlockId, "Card should still be created");
  });
});
