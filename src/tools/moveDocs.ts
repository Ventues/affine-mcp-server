import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import fetch from "node-fetch";
import * as Y from "yjs";
import { connectWorkspaceSocket, wsUrlFromGraphQLEndpoint, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";

interface BlobResult { key: string; contentType: string; content: string }
interface BlockInfo { id: string; flavour: string; sourceId?: string }
interface MoveResult { docId: string; status: "success" | "error" | "partial"; newDocId?: string; blobsTransferred: number; blobsFailed: number; error?: string }

export async function readBlobCore(gql: GraphQLClient, workspaceId: string, key: string): Promise<BlobResult> {
  const baseUrl = gql.endpoint.replace(/\/graphql$/, '');
  const url = `${baseUrl}/api/workspaces/${workspaceId}/blobs/${key}`;
  const res = await fetch(url, { headers: gql.getAuthHeaders() as any });
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { key, contentType: res.headers.get('content-type') || 'application/octet-stream', content: buf.toString('base64') };
}

async function getDocSourceIds(gql: GraphQLClient, workspaceId: string, docId: string): Promise<BlockInfo[]> {
  const { endpoint, authHeaders } = getEndpointAndAuth(gql);
  const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
  const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
  try {
    await joinWorkspace(socket, workspaceId);
    const snapshot = await loadDoc(socket, workspaceId, docId);
    if (!snapshot.missing) return [];
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
    const blocks = doc.getMap("blocks") as Y.Map<any>;
    const result: BlockInfo[] = [];
    blocks.forEach((block: any, id: string) => {
      if (!(block instanceof Y.Map)) return;
      const flavour = block.get("sys:flavour");
      const sourceId = block.get("prop:sourceId");
      if ((flavour === "affine:image" || flavour === "affine:attachment") && sourceId) {
        result.push({ id, flavour, sourceId });
      }
    });
    return result;
  } finally {
    socket.disconnect();
  }
}

function getEndpointAndAuth(gql: GraphQLClient) {
  return { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
}

async function uploadBlobToWorkspace(gql: GraphQLClient, workspaceId: string, content: string, contentType: string): Promise<string> {
  const FormData = (await import("form-data")).default;
  const payload = Buffer.from(content, "base64");
  const form = new FormData();
  form.append("operations", JSON.stringify({
    query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) { setBlob(workspaceId: $workspaceId, blob: $blob) }`,
    variables: { workspaceId, blob: null }
  }));
  form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
  form.append("0", payload, { filename: `blob-${Date.now()}.bin`, contentType });
  const res = await fetch(gql.endpoint, {
    method: "POST",
    headers: { ...gql.getAuthHeaders(), ...form.getHeaders() } as any,
    body: form as any,
  });
  const result = await res.json() as any;
  if (result.errors?.length) throw new Error(result.errors[0].message);
  return result.data?.setBlob;
}

export function registerMoveDocsTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const moveDocsHandler = async (parsed: {
    docIds: string[];
    targetFolderId: string;
    targetWorkspaceId: string;
    sourceWorkspaceId?: string;
    removeFromSource?: boolean;
    onBlobError?: "abort" | "skip";
  }) => {
    const { docIds, targetFolderId, targetWorkspaceId, sourceWorkspaceId, removeFromSource = true, onBlobError = "abort" } = parsed;
    const isSameWorkspace = !sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId;

    if (isSameWorkspace) {
      // Delegate to existing organize tools via GraphQL
      // Use the folder doc manipulation directly
      const addDocMutation = `mutation AddDocToFolder($workspaceId: String!, $docId: String!, $folderId: String!) {
        addDocToFolder(workspaceId: $workspaceId, docId: $docId, folderId: $folderId)
      }`;
      const results: MoveResult[] = [];
      for (const docId of docIds) {
        try {
          // For same-workspace, we just move the folder link
          // Import and call moveNodeHandler would be circular, so use the organize doc approach
          await gql.request(addDocMutation, { workspaceId: targetWorkspaceId, docId, folderId: targetFolderId });
          results.push({ docId, status: "success", blobsTransferred: 0, blobsFailed: 0 });
        } catch (err: any) {
          results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, error: err.message });
        }
      }
      return text(results);
    }

    // Cross-workspace path
    const results: MoveResult[] = [];
    for (const docId of docIds) {
      try {
        // 1. Read blocks to find sourceIds
        const blocks = await getDocSourceIds(gql, sourceWorkspaceId!, docId);
        const sourceIds = new Set<string>();
        for (const b of blocks) {
          if (b.sourceId) sourceIds.add(b.sourceId);
        }

        // 2. Transfer blobs with dedup
        const sourceIdMap = new Map<string, string>();
        let blobsFailed = 0;
        let aborted = false;
        for (const oldKey of sourceIds) {
          try {
            const blob = await readBlobCore(gql, sourceWorkspaceId!, oldKey);
            const newKey = await uploadBlobToWorkspace(gql, targetWorkspaceId, blob.content, blob.contentType);
            sourceIdMap.set(oldKey, newKey);
          } catch (err: any) {
            if (onBlobError === "abort") {
              results.push({ docId, status: "error", blobsTransferred: sourceIdMap.size, blobsFailed: sourceIds.size - sourceIdMap.size, error: `Blob transfer failed for ${oldKey}: ${err.message}` });
              aborted = true;
              break;
            }
            blobsFailed++;
          }
        }
        if (aborted) continue;

        // 3. Read doc markdown from source
        const readMarkdownQuery = `query ReadDoc($workspaceId: String!, $docId: String!) {
          doc(workspaceId: $workspaceId, id: $docId) { id }
        }`;
        // Use WebSocket to read the full doc and convert to markdown
        const { endpoint, authHeaders } = getEndpointAndAuth(gql);
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        let markdown = "";
        let title = "";
        try {
          await joinWorkspace(socket, sourceWorkspaceId!);
          const snapshot = await loadDoc(socket, sourceWorkspaceId!, docId);
          if (snapshot.missing) {
            const doc = new Y.Doc();
            Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
            const blocks = doc.getMap("blocks") as Y.Map<any>;
            // Extract title from page block
            blocks.forEach((block: any, id: string) => {
              if (!(block instanceof Y.Map)) return;
              if (block.get("sys:flavour") === "affine:page") {
                const t = block.get("prop:title");
                title = t instanceof Y.Text ? t.toJSON() : (t || "");
              }
            });
            // Build simple markdown from blocks
            const lines: string[] = [];
            blocks.forEach((block: any, id: string) => {
              if (!(block instanceof Y.Map)) return;
              const flavour = block.get("sys:flavour");
              const textProp = block.get("prop:text");
              const txt = textProp instanceof Y.Text ? textProp.toJSON() : "";
              if (flavour === "affine:paragraph") {
                const type = block.get("prop:type") || "text";
                if (type.startsWith("h")) {
                  const level = parseInt(type.slice(1)) || 1;
                  lines.push("#".repeat(level) + " " + txt);
                } else {
                  lines.push(txt);
                }
              } else if (flavour === "affine:list") {
                lines.push("- " + txt);
              } else if (flavour === "affine:code") {
                const lang = block.get("prop:language") || "";
                lines.push("```" + lang + "\n" + txt + "\n```");
              } else if (flavour === "affine:image" || flavour === "affine:attachment") {
                const sid = block.get("prop:sourceId") || "";
                const remapped = sourceIdMap.get(sid) || sid;
                if (flavour === "affine:image") {
                  lines.push(`![image](${remapped})`);
                } else {
                  const name = block.get("prop:name") || "file";
                  lines.push(`📎 [${name}](${remapped})`);
                }
              }
            });
            markdown = lines.join("\n\n");
          }
        } finally {
          socket.disconnect();
        }

        // 4. Create doc in target workspace via WebSocket (no GraphQL createDoc needed)
        const newDocId = generateId();
        const socket2 = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
          await joinWorkspace(socket2, targetWorkspaceId);

          const ydoc = new Y.Doc();
          const blocks = ydoc.getMap("blocks") as Y.Map<any>;

          const pageId = generateId();
          const page = new Y.Map();
          page.set("sys:id", pageId);
          page.set("sys:flavour", "affine:page");
          page.set("sys:version", 2);
          const titleText = new Y.Text();
          titleText.insert(0, title || "Untitled");
          page.set("prop:title", titleText);
          const pageChildren = new Y.Array();
          page.set("sys:children", pageChildren);
          blocks.set(pageId, page);

          const surfaceId = generateId();
          const surface = new Y.Map();
          surface.set("sys:id", surfaceId);
          surface.set("sys:flavour", "affine:surface");
          surface.set("sys:version", 5);
          surface.set("sys:parent", pageId);
          surface.set("sys:children", new Y.Array());
          const elements = new Y.Map<any>();
          elements.set("type", "$blocksuite:internal:native$");
          elements.set("value", new Y.Map<any>());
          surface.set("prop:elements", elements);
          blocks.set(surfaceId, surface);
          pageChildren.push([surfaceId]);

          const noteId = generateId();
          const note = new Y.Map();
          note.set("sys:id", noteId);
          note.set("sys:flavour", "affine:note");
          note.set("sys:version", 1);
          note.set("sys:parent", pageId);
          note.set("prop:displayMode", "both");
          note.set("prop:xywh", "[0,0,800,95]");
          note.set("prop:index", "a0");
          note.set("prop:hidden", false);
          const background = new Y.Map<any>();
          background.set("light", "#ffffff");
          background.set("dark", "#252525");
          note.set("prop:background", background);
          const noteChildren = new Y.Array();
          note.set("sys:children", noteChildren);
          blocks.set(noteId, note);
          pageChildren.push([noteId]);

          // Add content as a paragraph block
          if (markdown) {
            const blockId = `move-${Date.now()}`;
            const newBlock = new Y.Map();
            newBlock.set("sys:id", blockId);
            newBlock.set("sys:flavour", "affine:paragraph");
            newBlock.set("sys:version", 1);
            newBlock.set("sys:children", new Y.Array());
            newBlock.set("prop:type", "text");
            const ytext = new Y.Text();
            ytext.insert(0, markdown);
            newBlock.set("prop:text", ytext);
            blocks.set(blockId, newBlock);
            noteChildren.push([blockId]);
          }

          const meta = ydoc.getMap("meta");
          meta.set("id", newDocId);
          meta.set("title", title || "Untitled");
          meta.set("createDate", Date.now());
          meta.set("tags", new Y.Array());

          // Push doc content
          const updateFull = Y.encodeStateAsUpdate(ydoc);
          await pushDocUpdate(socket2, targetWorkspaceId, newDocId, Buffer.from(updateFull).toString("base64"));

          // Register in workspace pages list
          const wsDoc = new Y.Doc();
          const wsSnapshot = await loadDoc(socket2, targetWorkspaceId, targetWorkspaceId);
          if (wsSnapshot.missing) {
            Y.applyUpdate(wsDoc, Buffer.from(wsSnapshot.missing, "base64"));
          }
          const prevSV = Y.encodeStateVector(wsDoc);
          const wsMeta = wsDoc.getMap("meta");
          let pages = wsMeta.get("pages") as Y.Array<Y.Map<any>> | undefined;
          if (!pages) {
            pages = new Y.Array();
            wsMeta.set("pages", pages);
          }
          const entry = new Y.Map();
          entry.set("id", newDocId);
          entry.set("title", title || "Untitled");
          entry.set("createDate", Date.now());
          entry.set("updatedDate", Date.now());
          entry.set("tags", new Y.Array());
          pages.push([entry as any]);
          const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
          await pushDocUpdate(socket2, targetWorkspaceId, targetWorkspaceId, Buffer.from(wsDelta).toString("base64"));
        } finally {
          socket2.disconnect();
        }

        // 6. Add to target folder (best-effort via GraphQL)
        try {
          const addMutation = `mutation AddDocToFolder($workspaceId: String!, $docId: String!, $folderId: String!) {
            addDocToFolder(workspaceId: $workspaceId, docId: $docId, folderId: $folderId)
          }`;
          await gql.request(addMutation, { workspaceId: targetWorkspaceId, docId: newDocId, folderId: targetFolderId });
        } catch {}

        // 7. Remove from source
        if (removeFromSource) {
          try {
            const deleteMutation = `mutation DeleteDoc($workspaceId: String!, $docId: String!) {
              deleteDoc(workspaceId: $workspaceId, docId: $docId)
            }`;
            await gql.request(deleteMutation, { workspaceId: sourceWorkspaceId!, docId });
          } catch {}
        }

        const status = blobsFailed > 0 ? "partial" : "success";
        results.push({ docId, status, newDocId, blobsTransferred: sourceIdMap.size, blobsFailed });
      } catch (err: any) {
        results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, error: err.message });
      }
    }
    return text(results);
  };

  server.registerTool(
    "move_docs",
    {
      title: "Move Documents",
      description: "Move documents to a folder, optionally across workspaces. Cross-workspace moves transfer blobs and remap sourceIds.",
      inputSchema: {
        docIds: z.array(z.string()).min(1).describe("Document IDs to move"),
        targetFolderId: z.string().describe("Target folder ID"),
        targetWorkspaceId: z.string().describe("Target workspace ID"),
        sourceWorkspaceId: z.string().optional().describe("Source workspace ID (omit for same-workspace)"),
        removeFromSource: z.boolean().optional().describe("Remove from source after move (default true)"),
        onBlobError: z.enum(["abort", "skip"]).optional().describe("Blob error handling: abort (default) or skip"),
      }
    },
    moveDocsHandler as any
  );
}

function generateId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  let id = '';
  for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
  return id;
}

function findBlockByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
  for (const [id, block] of blocks.entries()) {
    if (block instanceof Y.Map && block.get("sys:flavour") === flavour) return id;
  }
  return null;
}
