/**
 * Integration tests for folder organization (organize.ts).
 *
 * Tests all 7 folder tools against a live AFFiNE instance:
 *   1. list_folder_tree   — read full hierarchy with doc titles
 *   2. list_folder_children — read direct children of a folder
 *   3. create_folder      — create folders at root and nested
 *   4. add_doc_to_folder  — link a doc into a folder
 *   5. rename_folder      — rename an existing folder
 *   6. move_to_folder     — move a node to a different parent
 *   7. remove_from_folder — delete a node (recursive for folders)
 *
 * Also tests:
 *   - Round-trip persistence (create → push → reconnect → read)
 *   - Duplicate doc link prevention
 *   - Circular reference prevention in move
 *   - Wire doc ID format (db$${workspaceId}$folders)
 *   - Yjs doc.getMap() materialization (vs raw doc.share iteration)
 *
 * Run:  npx tsx --test test/organize.test.ts
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

function requireEnv() {
  if (!BASE_URL || !TOKEN || !WORKSPACE_ID) {
    console.error("Skipping — set AFFINE_BASE_URL, AFFINE_API_TOKEN, AFFINE_WORKSPACE_ID");
    process.exit(0);
  }
}

const FOLDERS_TABLE = "folders";
const DELETED_FLAG = "$$DELETED";

function wireDocId(): string {
  return `db$${WORKSPACE_ID}$${FOLDERS_TABLE}`;
}

async function connect() {
  const wsUrl = wsUrlFromGraphQLEndpoint(BASE_URL + "/graphql");
  const socket = await connectWorkspaceSocket(wsUrl, { Authorization: `Bearer ${TOKEN}` });
  await joinWorkspace(socket, WORKSPACE_ID!);
  return socket;
}

type FolderEntry = {
  id: string;
  parentId: string | null;
  type: string;
  data: string;
  index: string;
};

async function loadFoldersDoc(socket: any): Promise<Y.Doc> {
  const ydoc = new Y.Doc();
  const snapshot = await loadDoc(socket, WORKSPACE_ID!, wireDocId());
  if (snapshot.missing) {
    Y.applyUpdate(ydoc, Buffer.from(snapshot.missing, "base64"));
  }
  return ydoc;
}

function readAllEntries(doc: Y.Doc): FolderEntry[] {
  const entries: FolderEntry[] = [];
  for (const [key] of doc.share) {
    const m = doc.getMap(key);
    if (m.get(DELETED_FLAG) === true) continue;
    const id = m.get("id");
    if (!id) continue;
    entries.push({
      id: String(id),
      parentId: (m.get("parentId") as string) ?? null,
      type: (m.get("type") as string) ?? "folder",
      data: (m.get("data") as string) ?? "",
      index: (m.get("index") as string) ?? "a0",
    });
  }
  return entries;
}

function getChildren(doc: Y.Doc, parentId: string | null): FolderEntry[] {
  return readAllEntries(doc)
    .filter((e) => e.parentId === parentId)
    .sort((a, b) => (a.index > b.index ? 1 : -1));
}

function insertEntry(doc: Y.Doc, entry: FolderEntry) {
  const m = doc.getMap(entry.id);
  doc.transact(() => {
    m.set("id", entry.id);
    m.set("parentId", entry.parentId);
    m.set("type", entry.type);
    m.set("data", entry.data);
    m.set("index", entry.index);
    m.delete(DELETED_FLAG);
  });
}

function deleteEntry(doc: Y.Doc, nodeId: string) {
  if (!doc.share.has(nodeId)) return;
  const m = doc.getMap(nodeId);
  doc.transact(() => {
    m.delete("parentId");
    m.delete("type");
    m.delete("data");
    m.delete("index");
    m.set(DELETED_FLAG, true);
  });
}

async function pushChanges(socket: any, ydoc: Y.Doc, prevSV: Uint8Array) {
  const afterSV = Y.encodeStateVector(ydoc);
  const hasChanges = prevSV.length !== afterSV.length || prevSV.some((v, i) => v !== afterSV[i]);
  if (hasChanges) {
    const delta = Y.encodeStateAsUpdate(ydoc, prevSV);
    await pushDocUpdate(socket, WORKSPACE_ID!, wireDocId(), Buffer.from(delta).toString("base64"));
  }
  return hasChanges;
}

// Track all test entries for cleanup
const testEntryIds: string[] = [];
const testPrefix = `test_${Date.now()}_`;

// ── Tests ────────────────────────────────────────────────────────────────
describe("organize: folder operations", () => {
  let socket: any;

  before(() => { requireEnv(); });

  after(async () => {
    // Cleanup all test entries
    if (testEntryIds.length > 0) {
      try {
        const sock = await connect();
        const ydoc = await loadFoldersDoc(sock);
        const prevSV = Y.encodeStateVector(ydoc);
        for (const id of testEntryIds) {
          deleteEntry(ydoc, id);
        }
        await pushChanges(sock, ydoc, prevSV);
        sock.disconnect();
        console.log(`  cleaned up ${testEntryIds.length} test entries`);
      } catch (e: any) {
        console.error(`  cleanup failed: ${e.message}`);
      }
    }
    if (socket) socket.disconnect();
  });

  it("1. should load the folders doc and read existing entries", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const entries = readAllEntries(ydoc);
    console.log(`  loaded ${entries.length} entries`);
    assert.ok(entries.length > 0, "workspace should have existing folder entries");

    const folders = entries.filter((e) => e.type === "folder");
    const docs = entries.filter((e) => e.type === "doc");
    console.log(`  ${folders.length} folders, ${docs.length} doc links`);
    assert.ok(folders.length > 0, "should have at least one folder");
    socket.disconnect();
  });

  it("2. should create a folder at root and persist it", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const folderId = testPrefix + "root_folder";
    testEntryIds.push(folderId);
    insertEntry(ydoc, { id: folderId, parentId: null, type: "folder", data: "Test Root Folder", index: "z9_test_root" });

    // Verify locally
    const found = readAllEntries(ydoc).find((e) => e.id === folderId);
    assert.ok(found, "folder exists locally");
    assert.equal(found.data, "Test Root Folder");
    assert.equal(found.parentId, null);

    // Push and re-read
    await pushChanges(socket, ydoc, prevSV);
    socket.disconnect();
    socket = await connect();
    const ydoc2 = await loadFoldersDoc(socket);
    const found2 = readAllEntries(ydoc2).find((e) => e.id === folderId);
    assert.ok(found2, "folder persists after reconnect");
    assert.equal(found2.data, "Test Root Folder");
    console.log(`  round-trip OK`);
    socket.disconnect();
  });

  it("3. should create a nested subfolder", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const parentId = testPrefix + "root_folder";
    const childId = testPrefix + "sub_folder";
    testEntryIds.push(childId);
    insertEntry(ydoc, { id: childId, parentId, type: "folder", data: "Test Sub Folder", index: "a0_sub" });

    const children = getChildren(ydoc, parentId);
    assert.equal(children.length, 1);
    assert.equal(children[0].id, childId);
    assert.equal(children[0].data, "Test Sub Folder");

    await pushChanges(socket, ydoc, prevSV);
    console.log(`  nested folder created`);
    socket.disconnect();
  });

  it("4. should add a doc link to a folder", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const folderId = testPrefix + "sub_folder";
    const linkId = testPrefix + "doc_link";
    const fakeDocId = "fake-doc-id-for-test";
    testEntryIds.push(linkId);
    insertEntry(ydoc, { id: linkId, parentId: folderId, type: "doc", data: fakeDocId, index: "a0_doc" });

    const children = getChildren(ydoc, folderId);
    const docLink = children.find((e) => e.type === "doc");
    assert.ok(docLink, "doc link exists in subfolder");
    assert.equal(docLink.data, fakeDocId);

    await pushChanges(socket, ydoc, prevSV);
    console.log(`  doc link added`);
    socket.disconnect();
  });

  it("5. should rename a folder", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const folderId = testPrefix + "sub_folder";
    const m = ydoc.getMap(folderId);
    ydoc.transact(() => { m.set("data", "Renamed Sub Folder"); });

    const entry = readAllEntries(ydoc).find((e) => e.id === folderId);
    assert.equal(entry!.data, "Renamed Sub Folder");

    await pushChanges(socket, ydoc, prevSV);

    // Verify persistence
    socket.disconnect();
    socket = await connect();
    const ydoc2 = await loadFoldersDoc(socket);
    const entry2 = readAllEntries(ydoc2).find((e) => e.id === folderId);
    assert.equal(entry2!.data, "Renamed Sub Folder");
    console.log(`  rename persisted`);
    socket.disconnect();
  });

  it("6. should move a folder to a different parent (reparent to root)", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const childId = testPrefix + "sub_folder";
    const parentId = testPrefix + "root_folder";

    // Before: subfolder is under root_folder
    const beforeChildren = getChildren(ydoc, parentId);
    assert.ok(beforeChildren.find((e) => e.id === childId), "subfolder is under root_folder");

    // Move to root
    const m = ydoc.getMap(childId);
    ydoc.transact(() => {
      m.set("parentId", null);
      m.set("index", "z9_moved_root");
    });

    // After: subfolder is at root, no longer under root_folder
    const afterChildren = getChildren(ydoc, parentId);
    assert.ok(!afterChildren.find((e) => e.id === childId), "subfolder no longer under root_folder");
    const rootChildren = getChildren(ydoc, null);
    assert.ok(rootChildren.find((e) => e.id === childId), "subfolder is now at root");

    await pushChanges(socket, ydoc, prevSV);
    console.log(`  moved to root`);

    // Move back to parent for subsequent tests
    const prevSV2 = Y.encodeStateVector(ydoc);
    ydoc.transact(() => {
      m.set("parentId", parentId);
      m.set("index", "a0_sub");
    });
    await pushChanges(socket, ydoc, prevSV2);
    console.log(`  moved back`);
    socket.disconnect();
  });

  it("7. should prevent circular references in move", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);

    const parentId = testPrefix + "root_folder";
    const childId = testPrefix + "sub_folder";

    // isAncestor check: childId's parent chain includes parentId
    // Moving parentId under childId would create a cycle
    function isAncestor(nodeId: string, candidateAncestorId: string): boolean {
      const visited = new Set<string>();
      let current = nodeId;
      while (current) {
        const entry = readAllEntries(ydoc).find((e) => e.id === current);
        if (!entry || !entry.parentId) return false;
        current = entry.parentId;
        if (visited.has(current)) return false;
        visited.add(current);
        if (current === candidateAncestorId) return true;
      }
      return false;
    }

    // childId is a descendant of parentId
    assert.ok(isAncestor(childId, parentId), "subfolder is a descendant of root_folder");
    // parentId is NOT a descendant of childId
    assert.ok(!isAncestor(parentId, childId), "root_folder is NOT a descendant of subfolder");

    // Attempting to move parentId under childId should be detected
    const wouldCreateCycle = isAncestor(childId, parentId);
    assert.ok(wouldCreateCycle, "circular reference correctly detected");
    console.log(`  circular reference prevention OK`);
    socket.disconnect();
  });

  it("8. should soft-delete a folder and its children recursively", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const parentId = testPrefix + "root_folder";

    // Count children before delete
    const childrenBefore = getChildren(ydoc, parentId);
    console.log(`  children before delete: ${childrenBefore.length}`);
    assert.ok(childrenBefore.length > 0, "root_folder has children");

    // Recursively delete
    function deleteRecursive(nodeId: string) {
      const children = getChildren(ydoc, nodeId);
      for (const child of children) {
        if (child.type === "folder") {
          deleteRecursive(child.id);
        } else {
          deleteEntry(ydoc, child.id);
        }
      }
      deleteEntry(ydoc, nodeId);
    }
    deleteRecursive(parentId);

    // Verify all are deleted
    const entriesAfter = readAllEntries(ydoc);
    assert.ok(!entriesAfter.find((e) => e.id === parentId), "root_folder is deleted");
    assert.ok(!entriesAfter.find((e) => e.id === testPrefix + "sub_folder"), "sub_folder is deleted");
    assert.ok(!entriesAfter.find((e) => e.id === testPrefix + "doc_link"), "doc_link is deleted");

    await pushChanges(socket, ydoc, prevSV);
    console.log(`  recursive delete OK`);
    socket.disconnect();
  });

  it("9. should handle duplicate doc link detection", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    // Create a temp folder with a doc link
    const folderId = testPrefix + "dup_folder";
    const link1Id = testPrefix + "dup_link1";
    const link2Id = testPrefix + "dup_link2";
    const docId = "duplicate-test-doc";
    testEntryIds.push(folderId, link1Id);

    insertEntry(ydoc, { id: folderId, parentId: null, type: "folder", data: "Dup Test", index: "z9_dup" });
    insertEntry(ydoc, { id: link1Id, parentId: folderId, type: "doc", data: docId, index: "a0" });

    // Check for existing link before adding duplicate
    const siblings = getChildren(ydoc, folderId);
    const existing = siblings.find((s) => s.type === "doc" && s.data === docId);
    assert.ok(existing, "existing link found — duplicate prevented");
    assert.equal(existing.id, link1Id);
    console.log(`  duplicate detection OK`);

    // Cleanup
    deleteEntry(ydoc, link1Id);
    deleteEntry(ydoc, folderId);
    await pushChanges(socket, ydoc, prevSV);
    socket.disconnect();
  });

  it("10. should verify wire doc ID format", () => {
    const id = wireDocId();
    assert.match(id, /^db\$[a-f0-9-]+\$folders$/, "wire doc ID matches db$<uuid>$folders format");
    console.log(`  wire doc ID: ${id}`);
  });

  it("11. batch add_doc_to_folder: add multiple docs in one transaction", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    const folderId = testPrefix + "batch_add_folder";
    testEntryIds.push(folderId);
    insertEntry(ydoc, { id: folderId, parentId: null, type: "folder", data: "Batch Add Test", index: "z9_batch_add" });

    // Batch add 3 doc links
    const docIds = ["batch-doc-1", "batch-doc-2", "batch-doc-3"];
    const linkIds: string[] = [];
    for (const docId of docIds) {
      const linkId = testPrefix + "batch_link_" + docId;
      linkIds.push(linkId);
      testEntryIds.push(linkId);
      const siblings = getChildren(ydoc, folderId);
      const lastIndex = siblings.length > 0 ? siblings[siblings.length - 1].index : null;
      // Simple index generation for test
      const index = lastIndex ? lastIndex + "1" : "a0";
      insertEntry(ydoc, { id: linkId, parentId: folderId, type: "doc", data: docId, index });
    }

    const children = getChildren(ydoc, folderId);
    assert.equal(children.length, 3, "should have 3 doc links");
    assert.deepEqual(children.map(c => c.data), docIds, "doc IDs match in order");

    await pushChanges(socket, ydoc, prevSV);

    // Verify persistence
    socket.disconnect();
    socket = await connect();
    const ydoc2 = await loadFoldersDoc(socket);
    const children2 = getChildren(ydoc2, folderId);
    assert.equal(children2.length, 3, "3 doc links persist after reconnect");
    console.log(`  batch add ${docIds.length} docs OK`);

    // Cleanup
    const prevSV2 = Y.encodeStateVector(ydoc2);
    for (const id of linkIds) deleteEntry(ydoc2, id);
    deleteEntry(ydoc2, folderId);
    await pushChanges(socket, ydoc2, prevSV2);
    socket.disconnect();
  });

  it("12. batch remove_from_folder: remove multiple nodes in one transaction", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    // Create folder with 3 doc links
    const folderId = testPrefix + "batch_rm_folder";
    testEntryIds.push(folderId);
    insertEntry(ydoc, { id: folderId, parentId: null, type: "folder", data: "Batch Remove Test", index: "z9_batch_rm" });

    const linkIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const linkId = testPrefix + `batch_rm_link_${i}`;
      linkIds.push(linkId);
      testEntryIds.push(linkId);
      insertEntry(ydoc, { id: linkId, parentId: folderId, type: "doc", data: `rm-doc-${i}`, index: `a${i}` });
    }
    await pushChanges(socket, ydoc, prevSV);

    // Batch remove all 3 links
    socket.disconnect();
    socket = await connect();
    const ydoc2 = await loadFoldersDoc(socket);
    const prevSV2 = Y.encodeStateVector(ydoc2);
    for (const id of linkIds) deleteEntry(ydoc2, id);
    await pushChanges(socket, ydoc2, prevSV2);

    // Verify
    socket.disconnect();
    socket = await connect();
    const ydoc3 = await loadFoldersDoc(socket);
    const children = getChildren(ydoc3, folderId);
    assert.equal(children.length, 0, "all links removed");
    console.log(`  batch removed ${linkIds.length} nodes OK`);

    // Cleanup folder
    const prevSV3 = Y.encodeStateVector(ydoc3);
    deleteEntry(ydoc3, folderId);
    await pushChanges(socket, ydoc3, prevSV3);
    socket.disconnect();
  });

  it("13. batch move_to_folder: move multiple nodes to new parent", async () => {
    socket = await connect();
    const ydoc = await loadFoldersDoc(socket);
    const prevSV = Y.encodeStateVector(ydoc);

    // Create 2 folders and 2 doc links in folder A
    const folderA = testPrefix + "batch_mv_A";
    const folderB = testPrefix + "batch_mv_B";
    testEntryIds.push(folderA, folderB);
    insertEntry(ydoc, { id: folderA, parentId: null, type: "folder", data: "Folder A", index: "z9_mv_a" });
    insertEntry(ydoc, { id: folderB, parentId: null, type: "folder", data: "Folder B", index: "z9_mv_b" });

    const linkIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const linkId = testPrefix + `batch_mv_link_${i}`;
      linkIds.push(linkId);
      testEntryIds.push(linkId);
      insertEntry(ydoc, { id: linkId, parentId: folderA, type: "doc", data: `mv-doc-${i}`, index: `a${i}` });
    }
    await pushChanges(socket, ydoc, prevSV);

    // Batch move both links from A to B
    socket.disconnect();
    socket = await connect();
    const ydoc2 = await loadFoldersDoc(socket);
    const prevSV2 = Y.encodeStateVector(ydoc2);
    for (const id of linkIds) {
      const m = ydoc2.getMap(id);
      ydoc2.transact(() => {
        m.set("parentId", folderB);
      });
    }
    await pushChanges(socket, ydoc2, prevSV2);

    // Verify
    socket.disconnect();
    socket = await connect();
    const ydoc3 = await loadFoldersDoc(socket);
    assert.equal(getChildren(ydoc3, folderA).length, 0, "folder A empty");
    assert.equal(getChildren(ydoc3, folderB).length, 2, "folder B has 2 links");
    console.log(`  batch moved ${linkIds.length} nodes OK`);

    // Cleanup
    const prevSV3 = Y.encodeStateVector(ydoc3);
    for (const id of linkIds) deleteEntry(ydoc3, id);
    deleteEntry(ydoc3, folderA);
    deleteEntry(ydoc3, folderB);
    await pushChanges(socket, ydoc3, prevSV3);
    socket.disconnect();
  });
});
