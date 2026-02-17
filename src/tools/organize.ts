import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import {
  wsUrlFromGraphQLEndpoint,
  connectWorkspaceSocket,
  joinWorkspace,
  loadDoc,
  pushDocUpdate,
} from "../ws.js";
import * as Y from "yjs";
import { generateKeyBetween } from "fractional-indexing";
import { randomBytes } from "node:crypto";

function generateNodeId(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";
  let id = "";
  for (let i = 0; i < 21; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

const FOLDERS_TABLE = "folders";
const DELETED_FLAG = "$$DELETED";
const RANDOM_SUFFIX_LEN = 32;

type FolderEntry = {
  id: string;
  parentId: string | null;
  type: "folder" | "doc" | "tag" | "collection";
  data: string;
  index: string;
};

// --- Fractional indexing (compatible with AFFiNE's generateFractionalIndexingKeyBetween) ---
function randomPostfix(length: number = RANDOM_SUFFIX_LEN): string {
  const chars = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const values = randomBytes(length);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(values[i] % chars.length);
  }
  return result;
}

function subkey(key: string | null): string | null {
  if (key === null) return null;
  if (key.length <= RANDOM_SUFFIX_LEN + 1) return key;
  return key.substring(0, key.length - RANDOM_SUFFIX_LEN - 1);
}

function hasSamePrefix(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a);
}

function generateIndexBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error("a should be smaller than b");
  }
  const aKey = subkey(a);
  const bKey = subkey(b);
  if (aKey === null && bKey === null) {
    return generateKeyBetween(null, null) + "0" + randomPostfix();
  } else if (aKey === null && bKey !== null) {
    return generateKeyBetween(null, bKey) + "0" + randomPostfix();
  } else if (bKey === null && aKey !== null) {
    return generateKeyBetween(aKey, null) + "0" + randomPostfix();
  } else if (aKey !== null && bKey !== null) {
    if (hasSamePrefix(aKey, bKey) && a !== null && b !== null) {
      return generateKeyBetween(a, b) + "0" + randomPostfix();
    } else {
      return generateKeyBetween(aKey, bKey) + "0" + randomPostfix();
    }
  }
  throw new Error("Never reach here");
}

// --- Yjs helpers for the folders DB doc ---

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
      type: (m.get("type") as FolderEntry["type"]) ?? "folder",
      data: (m.get("data") as string) ?? "",
      index: (m.get("index") as string) ?? "a0",
    });
  }
  return entries;
}

function getEntry(doc: Y.Doc, nodeId: string): FolderEntry | null {
  if (!doc.share.has(nodeId)) return null;
  const m = doc.getMap(nodeId);
  if (m.get(DELETED_FLAG) === true) return null;
  const id = m.get("id");
  if (!id) return null;
  return {
    id: String(id),
    parentId: (m.get("parentId") as string) ?? null,
    type: (m.get("type") as FolderEntry["type"]) ?? "folder",
    data: (m.get("data") as string) ?? "",
    index: (m.get("index") as string) ?? "a0",
  };
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

function deleteRecursive(doc: Y.Doc, nodeId: string) {
  const children = getChildren(doc, nodeId);
  for (const child of children) {
    if (child.type === "folder") {
      deleteRecursive(doc, child.id);
    } else {
      deleteEntry(doc, child.id);
    }
  }
  deleteEntry(doc, nodeId);
}

function isAncestor(doc: Y.Doc, nodeId: string, candidateAncestorId: string): boolean {
  const visited = new Set<string>();
  let current = nodeId;
  while (current) {
    const entry = getEntry(doc, current);
    if (!entry || !entry.parentId) return false;
    current = entry.parentId;
    if (visited.has(current)) return false;
    visited.add(current);
    if (current === candidateAncestorId) return true;
  }
  return false;
}

function buildTree(entries: FolderEntry[], titleMap: Map<string, string>, parentId: string | null = null): any[] {
  return entries
    .filter((e) => e.parentId === parentId)
    .sort((a, b) => (a.index > b.index ? 1 : -1))
    .map((e) => {
      const node: any = { id: e.id, type: e.type };
      if (e.type === "folder") {
        node.name = e.data;
        node.children = buildTree(entries, titleMap, e.id);
      } else if (e.type === "doc") {
        node.docId = e.data;
        node.title = titleMap.get(e.data) ?? null;
      } else {
        node.data = e.data;
      }
      return node;
    });
}

async function resolveDocTitles(gql: GraphQLClient, workspaceId: string, docIds: string[]): Promise<Map<string, string>> {
  const titleMap = new Map<string, string>();
  if (docIds.length === 0) return titleMap;
  const unique = [...new Set(docIds)];
  const query = `query GetDoc($workspaceId:String!,$docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title } } }`;
  const results = await Promise.allSettled(
    unique.map((docId) => gql.request<{ workspace: { doc: { id: string; title: string } } }>(query, { workspaceId, docId }))
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value?.workspace?.doc?.title) {
      titleMap.set(unique[i], r.value.workspace.doc.title);
    }
  }
  return titleMap;
}

// --- Socket helper ---
async function withFoldersDoc<T>(
  gql: GraphQLClient,
  workspaceId: string,
  fn: (doc: Y.Doc, prevSV: Uint8Array) => T
): Promise<T> {
  const endpoint = gql.endpoint;
  const authHeaders = gql.getAuthHeaders();
  const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
  // Wire format: db$${spaceId}$${tableName}
  const wireDocId = `db$${workspaceId}$${FOLDERS_TABLE}`;
  const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
  try {
    await joinWorkspace(socket, workspaceId);
    const ydoc = new Y.Doc();
    const snapshot = await loadDoc(socket, workspaceId, wireDocId);
    if (snapshot.missing) {
      Y.applyUpdate(ydoc, Buffer.from(snapshot.missing, "base64"));
    }
    const prevSV = Y.encodeStateVector(ydoc);
    const result = fn(ydoc, prevSV);
    const afterSV = Y.encodeStateVector(ydoc);
    // Only push if there were actual changes (state vectors differ)
    const hasChanges = prevSV.length !== afterSV.length ||
      prevSV.some((v, i) => v !== afterSV[i]);
    if (hasChanges) {
      const delta = Y.encodeStateAsUpdate(ydoc, prevSV);
      await pushDocUpdate(
        socket,
        workspaceId,
        wireDocId,
        Buffer.from(delta).toString("base64")
      );
    }
    return result;
  } finally {
    socket.disconnect();
  }
}

// --- Tool registration ---
export function registerOrganizeTools(
  server: McpServer,
  gql: GraphQLClient,
  defaults: { workspaceId?: string }
) {
  function resolveWs(parsed: { workspaceId?: string }): string {
    const ws = parsed.workspaceId || defaults.workspaceId;
    if (!ws) throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    return ws;
  }

  // LIST FOLDER TREE
  const listFolderTreeHandler = async (parsed: { workspaceId?: string }) => {
    const ws = resolveWs(parsed);
    const all = await withFoldersDoc(gql, ws, (doc) => readAllEntries(doc));
    const docIds = all.filter((e) => e.type === "doc").map((e) => e.data);
    const titleMap = await resolveDocTitles(gql, ws, docIds);
    const tree = buildTree(all, titleMap);
    return text(tree);
  };
  server.registerTool("list_folder_tree", {
    title: "List Folder Tree",
    description: "List the full folder/organization tree for a workspace. Shows folders, doc links, tags, and collections in hierarchical structure.",
    inputSchema: { workspaceId: z.string().optional() },
  }, listFolderTreeHandler as any);

  // LIST FOLDER CHILDREN
  const listFolderChildrenHandler = async (parsed: { workspaceId?: string; folderId?: string }) => {
    const ws = resolveWs(parsed);
    const children = await withFoldersDoc(gql, ws, (doc) => getChildren(doc, parsed.folderId ?? null));
    const docIds = children.filter((e) => e.type === "doc").map((e) => e.data);
    const titleMap = await resolveDocTitles(gql, ws, docIds);
    const enriched = children.map((e) => {
      if (e.type === "doc") return { id: e.id, type: e.type, docId: e.data, title: titleMap.get(e.data) ?? null };
      if (e.type === "folder") return { id: e.id, type: e.type, name: e.data };
      return { id: e.id, type: e.type, data: e.data };
    });
    return text(enriched);
  };
  server.registerTool("list_folder_children", {
    title: "List Folder Children",
    description: "List direct children of a folder (or root if no folderId). Returns sorted entries.",
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().optional().describe("Folder ID to list children of. Omit for root level."),
    },
  }, listFolderChildrenHandler as any);

  // CREATE FOLDER
  const createFolderHandler = async (parsed: { workspaceId?: string; name: string; parentId?: string }) => {
    const ws = resolveWs(parsed);
    const result = await withFoldersDoc(gql, ws, (doc) => {
      const parentId = parsed.parentId ?? null;
      if (parentId) {
        const parent = getEntry(doc, parentId);
        if (!parent || parent.type !== "folder") throw new Error("Parent folder not found");
      }
      const siblings = getChildren(doc, parentId);
      const lastIndex = siblings.length > 0 ? siblings[siblings.length - 1].index : null;
      const index = generateIndexBetween(lastIndex, null);
      const id = generateNodeId();
      insertEntry(doc, { id, parentId, type: "folder", data: parsed.name, index });
      return { id, name: parsed.name, parentId, index };
    });
    return text(result);
  };
  server.registerTool("create_folder", {
    title: "Create Folder",
    description: "Create a new folder in the workspace organize tree.",
    inputSchema: {
      workspaceId: z.string().optional(),
      name: z.string().describe("Folder name"),
      parentId: z.string().optional().describe("Parent folder ID. Omit for root level."),
    },
  }, createFolderHandler as any);

  // ADD DOC TO FOLDER (single or batch)
  const addDocToFolderHandler = async (parsed: { workspaceId?: string; folderId: string; docId?: string; docIds?: string[] }) => {
    const ws = resolveWs(parsed);
    const ids = parsed.docIds ?? (parsed.docId ? [parsed.docId] : []);
    if (ids.length === 0) throw new Error("Provide docId or docIds");
    const results = await withFoldersDoc(gql, ws, (doc) => {
      const parent = getEntry(doc, parsed.folderId);
      if (!parent || parent.type !== "folder") throw new Error("Folder not found");
      const out: any[] = [];
      for (const docId of ids) {
        const siblings = getChildren(doc, parsed.folderId);
        const existing = siblings.find((s) => s.type === "doc" && s.data === docId);
        if (existing) {
          out.push({ linkId: existing.id, folderId: parsed.folderId, docId, index: existing.index, duplicate: true });
          continue;
        }
        const lastIndex = siblings.length > 0 ? siblings[siblings.length - 1].index : null;
        const index = generateIndexBetween(lastIndex, null);
        const id = generateNodeId();
        insertEntry(doc, { id, parentId: parsed.folderId, type: "doc", data: docId, index });
        out.push({ linkId: id, folderId: parsed.folderId, docId, index });
      }
      return out;
    });
    return text(results.length === 1 ? results[0] : results);
  };
  server.registerTool("add_doc_to_folder", {
    title: "Add Doc to Folder",
    description: "Add a document link into a folder. Supports single docId or batch docIds array.",
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().describe("Target folder ID"),
      docId: z.string().optional().describe("Document ID to add"),
      docIds: z.array(z.string()).optional().describe("Array of document IDs to add (batch mode)"),
    },
  }, addDocToFolderHandler as any);

  // RENAME FOLDER
  const renameFolderHandler = async (parsed: { workspaceId?: string; folderId: string; name: string }) => {
    const ws = resolveWs(parsed);
    const result = await withFoldersDoc(gql, ws, (doc) => {
      const entry = getEntry(doc, parsed.folderId);
      if (!entry || entry.type !== "folder") throw new Error("Folder not found");
      const m = doc.getMap(parsed.folderId);
      doc.transact(() => { m.set("data", parsed.name); });
      return { id: parsed.folderId, name: parsed.name };
    });
    return text(result);
  };
  server.registerTool("rename_folder", {
    title: "Rename Folder",
    description: "Rename an existing folder.",
    inputSchema: {
      workspaceId: z.string().optional(),
      folderId: z.string().describe("Folder ID to rename"),
      name: z.string().describe("New folder name"),
    },
  }, renameFolderHandler as any);

  // MOVE NODE (single or batch — folder or link to a different parent)
  const moveNodeHandler = async (parsed: { workspaceId?: string; nodeId?: string; nodeIds?: string[]; parentId?: string }) => {
    const ws = resolveWs(parsed);
    const ids = parsed.nodeIds ?? (parsed.nodeId ? [parsed.nodeId] : []);
    if (ids.length === 0) throw new Error("Provide nodeId or nodeIds");
    const results = await withFoldersDoc(gql, ws, (doc) => {
      const newParentId = parsed.parentId ?? null;
      if (newParentId) {
        const parent = getEntry(doc, newParentId);
        if (!parent || parent.type !== "folder") throw new Error("Target parent folder not found");
      }
      const out: any[] = [];
      for (const nodeId of ids) {
        const node = getEntry(doc, nodeId);
        if (!node) { out.push({ id: nodeId, error: "Node not found" }); continue; }
        if (newParentId) {
          if (nodeId === newParentId) { out.push({ id: nodeId, error: "Cannot move a node into itself" }); continue; }
          if (isAncestor(doc, newParentId, nodeId)) { out.push({ id: nodeId, error: "Cannot move a node into its own descendant" }); continue; }
        } else if (node.type !== "folder") {
          out.push({ id: nodeId, error: "Only folders can be at root level" }); continue;
        }
        const siblings = getChildren(doc, newParentId);
        const lastIndex = siblings.length > 0 ? siblings[siblings.length - 1].index : null;
        const index = generateIndexBetween(lastIndex, null);
        const m = doc.getMap(nodeId);
        doc.transact(() => {
          m.set("parentId", newParentId);
          m.set("index", index);
        });
        out.push({ id: nodeId, parentId: newParentId, index });
      }
      return out;
    });
    return text(results.length === 1 ? results[0] : results);
  };
  server.registerTool("move_to_folder", {
    title: "Move to Folder",
    description: "Move a folder or doc link to a different parent folder (or root). Supports single nodeId or batch nodeIds array.",
    inputSchema: {
      workspaceId: z.string().optional(),
      nodeId: z.string().optional().describe("ID of the node (folder or link) to move"),
      nodeIds: z.array(z.string()).optional().describe("Array of node IDs to move (batch mode)"),
      parentId: z.string().optional().describe("Target parent folder ID. Omit to move to root."),
    },
  }, moveNodeHandler as any);

  // REMOVE FROM FOLDER (single or batch — delete links or folders recursively)
  const removeFromFolderHandler = async (parsed: { workspaceId?: string; nodeId?: string; nodeIds?: string[] }) => {
    const ws = resolveWs(parsed);
    const ids = parsed.nodeIds ?? (parsed.nodeId ? [parsed.nodeId] : []);
    if (ids.length === 0) throw new Error("Provide nodeId or nodeIds");
    const results = await withFoldersDoc(gql, ws, (doc) => {
      const out: any[] = [];
      for (const nodeId of ids) {
        const node = getEntry(doc, nodeId);
        if (!node) { out.push({ deleted: false, id: nodeId, error: "Node not found" }); continue; }
        if (node.type === "folder") {
          deleteRecursive(doc, nodeId);
        } else {
          deleteEntry(doc, nodeId);
        }
        out.push({ deleted: true, id: nodeId, type: node.type });
      }
      return out;
    });
    return text(results.length === 1 ? results[0] : results);
  };
  server.registerTool("remove_from_folder", {
    title: "Remove from Folder",
    description: "Remove a node from the folder tree. Supports single nodeId or batch nodeIds array. Folders are deleted recursively with all contents.",
    inputSchema: {
      workspaceId: z.string().optional(),
      nodeId: z.string().optional().describe("ID of the node to remove"),
      nodeIds: z.array(z.string()).optional().describe("Array of node IDs to remove (batch mode)"),
    },
  }, removeFromFolderHandler as any);
}
