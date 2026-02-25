import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import fetch from "node-fetch";
import * as Y from "yjs";
import { connectWorkspaceSocket, wsUrlFromGraphQLEndpoint, joinWorkspace, loadDoc } from "../ws.js";

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

        // 4. Create doc in target workspace
        const createMutation = `mutation CreateDoc($workspaceId: String!, $title: String) {
          createDoc(workspaceId: $workspaceId, title: $title) { id }
        }`;
        const createResult = await gql.request<{ createDoc: { id: string } }>(createMutation, {
          workspaceId: targetWorkspaceId, title: title || "Untitled"
        });
        const newDocId = createResult.createDoc.id;

        // 5. Write markdown content to new doc via WebSocket
        if (markdown) {
          const socket2 = await connectWorkspaceSocket(wsUrl, authHeaders);
          try {
            await joinWorkspace(socket2, targetWorkspaceId);
            const snapshot = await loadDoc(socket2, targetWorkspaceId, newDocId);
            if (snapshot.missing) {
              const doc = new Y.Doc();
              Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
              const blocks = doc.getMap("blocks") as Y.Map<any>;
              const noteId = findBlockByFlavour(blocks, "affine:note");
              if (noteId) {
                const noteBlock = blocks.get(noteId) as Y.Map<any>;
                const children = noteBlock.get("sys:children") as Y.Array<string>;
                // Add a paragraph with the markdown content
                const blockId = `move-${Date.now()}`;
                const newBlock = new Y.Map();
                doc.transact(() => {
                  newBlock.set("sys:id", blockId);
                  newBlock.set("sys:flavour", "affine:paragraph");
                  newBlock.set("sys:children", new Y.Array());
                  newBlock.set("prop:type", "text");
                  const ytext = new Y.Text();
                  ytext.insert(0, markdown);
                  newBlock.set("prop:text", ytext);
                  blocks.set(blockId, newBlock);
                  children.push([blockId]);
                });
                const update = Y.encodeStateAsUpdate(doc);
                const { pushDocUpdate } = await import("../ws.js");
                await pushDocUpdate(socket2, targetWorkspaceId, newDocId, Buffer.from(update).toString("base64"));
              }
            }
          } finally {
            socket2.disconnect();
          }
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

function findBlockByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
  for (const [id, block] of blocks.entries()) {
    if (block instanceof Y.Map && block.get("sys:flavour") === flavour) return id;
  }
  return null;
}
