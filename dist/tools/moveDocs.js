import { z } from "zod";
import { text } from "../util/mcp.js";
import fetch from "node-fetch";
import * as Y from "yjs";
import { connectWorkspaceSocket, wsUrlFromGraphQLEndpoint, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
import { applyMarkdownToNote } from "../util/blocks.js";
import { withFoldersDoc, readAllEntries, getChildren, insertEntry, generateIndexBetween, generateNodeId, } from "./organize.js";
export async function readBlobCore(gql, workspaceId, key) {
    const baseUrl = gql.endpoint.replace(/\/graphql$/, '');
    const url = `${baseUrl}/api/workspaces/${workspaceId}/blobs/${key}`;
    const res = await fetch(url, { headers: gql.getAuthHeaders() });
    if (!res.ok)
        throw new Error(`Blob fetch failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { key, contentType: res.headers.get('content-type') || 'application/octet-stream', content: buf.toString('base64') };
}
async function getDocSourceIds(gql, workspaceId, docId) {
    const { endpoint, authHeaders } = getEndpointAndAuth(gql);
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
        await joinWorkspace(socket, workspaceId);
        const snapshot = await loadDoc(socket, workspaceId, docId);
        if (!snapshot.missing)
            return [];
        const doc = new Y.Doc();
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
        const blocks = doc.getMap("blocks");
        const result = [];
        blocks.forEach((block, id) => {
            if (!(block instanceof Y.Map))
                return;
            const flavour = block.get("sys:flavour");
            const sourceId = block.get("prop:sourceId");
            if ((flavour === "affine:image" || flavour === "affine:attachment") && sourceId) {
                result.push({ id, flavour, sourceId });
            }
        });
        return result;
    }
    finally {
        socket.disconnect();
    }
}
function getEndpointAndAuth(gql) {
    return { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
}
/** Returns ordered folder names from root down to the immediate parent of docId. */
export function getFolderPathForDoc(entries, docId) {
    const docEntry = entries.find(e => e.type === "doc" && e.data === docId);
    if (!docEntry || !docEntry.parentId)
        return [];
    const path = [];
    let current = docEntry.parentId;
    while (current) {
        const folder = entries.find(e => e.id === current && e.type === "folder");
        if (!folder)
            break;
        path.unshift(folder.data);
        current = folder.parentId;
    }
    return path;
}
/** Walks/creates folders under rootFolderId matching pathNames, returns leaf folder ID. */
export async function ensureFolderPath(gql, workspaceId, rootFolderId, pathNames) {
    if (pathNames.length === 0)
        return rootFolderId;
    let currentParentId = rootFolderId;
    for (const name of pathNames) {
        currentParentId = await withFoldersDoc(gql, workspaceId, (doc) => {
            const children = getChildren(doc, currentParentId);
            const existing = children.find(c => c.type === "folder" && c.data === name);
            if (existing)
                return existing.id;
            const lastIndex = children.length > 0 ? children[children.length - 1].index : null;
            const index = generateIndexBetween(lastIndex, null);
            const id = generateNodeId();
            insertEntry(doc, { id, parentId: currentParentId, type: "folder", data: name, index });
            return id;
        });
    }
    return currentParentId;
}
async function uploadBlobToWorkspace(gql, workspaceId, content, contentType) {
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
        headers: { ...gql.getAuthHeaders(), ...form.getHeaders() },
        body: form,
    });
    const result = await res.json();
    if (result.errors?.length)
        throw new Error(result.errors[0].message);
    return result.data?.setBlob;
}
export function registerMoveDocsTools(server, gql, defaults) {
    const moveDocsHandler = async (parsed) => {
        const { docIds, targetFolderId, targetWorkspaceId, sourceWorkspaceId, removeFromSource = true, onBlobError = "abort", preserveFolderStructure = false } = parsed;
        const isSameWorkspace = !sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId;
        if (isSameWorkspace) {
            // Delegate to existing organize tools via GraphQL
            // Use the folder doc manipulation directly
            const addDocMutation = `mutation AddDocToFolder($workspaceId: String!, $docId: String!, $folderId: String!) {
        addDocToFolder(workspaceId: $workspaceId, docId: $docId, folderId: $folderId)
      }`;
            const results = [];
            // Read source folder entries once if preserving structure
            let sourceEntries = [];
            if (preserveFolderStructure) {
                sourceEntries = await withFoldersDoc(gql, targetWorkspaceId, (doc) => readAllEntries(doc));
            }
            for (const docId of docIds) {
                try {
                    const folderId = preserveFolderStructure
                        ? await ensureFolderPath(gql, targetWorkspaceId, targetFolderId, getFolderPathForDoc(sourceEntries, docId))
                        : targetFolderId;
                    // For same-workspace, we just move the folder link
                    // Import and call moveNodeHandler would be circular, so use the organize doc approach
                    await gql.request(addDocMutation, { workspaceId: targetWorkspaceId, docId, folderId });
                    results.push({ docId, status: "success", blobsTransferred: 0, blobsFailed: 0 });
                }
                catch (err) {
                    results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, error: err.message });
                }
            }
            return text(results);
        }
        // Cross-workspace path
        // Read source folder entries once if preserving structure
        let sourceEntries = [];
        if (preserveFolderStructure) {
            sourceEntries = await withFoldersDoc(gql, sourceWorkspaceId, (doc) => readAllEntries(doc));
        }
        const results = [];
        for (const docId of docIds) {
            try {
                // 1. Read blocks to find sourceIds
                const blocks = await getDocSourceIds(gql, sourceWorkspaceId, docId);
                const sourceIds = new Set();
                for (const b of blocks) {
                    if (b.sourceId)
                        sourceIds.add(b.sourceId);
                }
                // 2. Transfer blobs with dedup
                const sourceIdMap = new Map();
                let blobsFailed = 0;
                let aborted = false;
                for (const oldKey of sourceIds) {
                    try {
                        const blob = await readBlobCore(gql, sourceWorkspaceId, oldKey);
                        const newKey = await uploadBlobToWorkspace(gql, targetWorkspaceId, blob.content, blob.contentType);
                        sourceIdMap.set(oldKey, newKey);
                    }
                    catch (err) {
                        if (onBlobError === "abort") {
                            results.push({ docId, status: "error", blobsTransferred: sourceIdMap.size, blobsFailed: sourceIds.size - sourceIdMap.size, error: `Blob transfer failed for ${oldKey}: ${err.message}` });
                            aborted = true;
                            break;
                        }
                        blobsFailed++;
                    }
                }
                if (aborted)
                    continue;
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
                    await joinWorkspace(socket, sourceWorkspaceId);
                    const snapshot = await loadDoc(socket, sourceWorkspaceId, docId);
                    if (snapshot.missing) {
                        const doc = new Y.Doc();
                        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
                        const blocks = doc.getMap("blocks");
                        // Extract title from page block
                        blocks.forEach((block) => {
                            if (!(block instanceof Y.Map))
                                return;
                            if (block.get("sys:flavour") === "affine:page") {
                                const t = block.get("prop:title");
                                title = t instanceof Y.Text ? t.toJSON() : (t || "");
                            }
                        });
                        // Build markdown by traversing sys:children in order from the note block
                        markdown = extractMarkdownOrdered(blocks, sourceIdMap);
                    }
                }
                finally {
                    socket.disconnect();
                }
                // 4. Create doc in target workspace
                const createMutation = `mutation CreateDoc($workspaceId: String!, $title: String) {
          createDoc(workspaceId: $workspaceId, title: $title) { id }
        }`;
                const createResult = await gql.request(createMutation, {
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
                            const blocks = doc.getMap("blocks");
                            const noteId = findBlockByFlavour(blocks, "affine:note");
                            if (noteId) {
                                const noteBlock = blocks.get(noteId);
                                const noteChildren = noteBlock.get("sys:children");
                                applyMarkdownToNote(markdown, noteId, blocks, noteChildren);
                                const update = Y.encodeStateAsUpdate(doc);
                                await pushDocUpdate(socket2, targetWorkspaceId, newDocId, Buffer.from(update).toString("base64"));
                            }
                        }
                    }
                    finally {
                        socket2.disconnect();
                    }
                }
                // 6. Add to target folder (best-effort via GraphQL)
                try {
                    const addMutation = `mutation AddDocToFolder($workspaceId: String!, $docId: String!, $folderId: String!) {
            addDocToFolder(workspaceId: $workspaceId, docId: $docId, folderId: $folderId)
          }`;
                    const destFolderId = preserveFolderStructure
                        ? await ensureFolderPath(gql, targetWorkspaceId, targetFolderId, getFolderPathForDoc(sourceEntries, docId))
                        : targetFolderId;
                    await gql.request(addMutation, { workspaceId: targetWorkspaceId, docId: newDocId, folderId: destFolderId });
                }
                catch { }
                // 7. Remove from source
                if (removeFromSource) {
                    try {
                        const deleteMutation = `mutation DeleteDoc($workspaceId: String!, $docId: String!) {
              deleteDoc(workspaceId: $workspaceId, docId: $docId)
            }`;
                        await gql.request(deleteMutation, { workspaceId: sourceWorkspaceId, docId });
                    }
                    catch { }
                }
                const status = blobsFailed > 0 ? "partial" : "success";
                results.push({ docId, status, newDocId, blobsTransferred: sourceIdMap.size, blobsFailed });
            }
            catch (err) {
                results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, error: err.message });
            }
        }
        return text(results);
    };
    server.registerTool("move_docs", {
        title: "Move Documents",
        description: "Move documents to a folder, optionally across workspaces. Cross-workspace moves transfer blobs and remap sourceIds.",
        inputSchema: {
            docIds: z.array(z.string()).min(1).describe("Document IDs to move"),
            targetFolderId: z.string().describe("Target folder ID"),
            targetWorkspaceId: z.string().describe("Target workspace ID"),
            sourceWorkspaceId: z.string().optional().describe("Source workspace ID (omit for same-workspace)"),
            removeFromSource: z.boolean().optional().describe("Remove from source after move (default true)"),
            onBlobError: z.enum(["abort", "skip"]).optional().describe("Blob error handling: abort (default) or skip"),
            preserveFolderStructure: z.boolean().optional().describe("Recreate source subfolder structure under targetFolderId (default false)"),
        }
    }, moveDocsHandler);
}
function findBlockByFlavour(blocks, flavour) {
    for (const [id, block] of blocks.entries()) {
        if (block instanceof Y.Map && block.get("sys:flavour") === flavour)
            return id;
    }
    return null;
}
/** Walk sys:children in order from the note block and produce markdown. */
export function extractMarkdownOrdered(blocks, sourceIdMap, indent = 0) {
    const noteId = findBlockByFlavour(blocks, "affine:note");
    if (!noteId)
        return "";
    return blockChildrenToMarkdown(noteId, blocks, sourceIdMap, indent);
}
function blockChildrenToMarkdown(parentId, blocks, sourceIdMap, indent) {
    const parent = blocks.get(parentId);
    if (!parent)
        return "";
    const children = parent.get("sys:children");
    if (!children || children.length === 0)
        return "";
    const lines = [];
    for (const childId of children.toArray()) {
        const block = blocks.get(childId);
        if (!block || !(block instanceof Y.Map))
            continue;
        const flavour = block.get("sys:flavour");
        const textProp = block.get("prop:text");
        const txt = textProp instanceof Y.Text ? textProp.toJSON() : "";
        const prefix = "  ".repeat(indent);
        if (flavour === "affine:paragraph") {
            const type = block.get("prop:type") || "text";
            if (type.startsWith("h")) {
                lines.push("#".repeat(parseInt(type.slice(1)) || 1) + " " + txt);
            }
            else {
                lines.push(prefix + txt);
            }
        }
        else if (flavour === "affine:list") {
            lines.push(prefix + "- " + txt);
        }
        else if (flavour === "affine:code") {
            const lang = block.get("prop:language") || "";
            lines.push("```" + lang + "\n" + txt + "\n```");
        }
        else if (flavour === "affine:image") {
            const sid = block.get("prop:sourceId") || "";
            lines.push(`![image](${sourceIdMap.get(sid) || sid})`);
        }
        else if (flavour === "affine:attachment") {
            const sid = block.get("prop:sourceId") || "";
            const name = block.get("prop:name") || "file";
            lines.push(`📎 [${name}](${sourceIdMap.get(sid) || sid})`);
        }
        // Recurse into nested children (e.g. nested lists)
        const nested = blockChildrenToMarkdown(childId, blocks, sourceIdMap, indent + 1);
        if (nested)
            lines.push(nested);
    }
    return lines.join("\n\n");
}
