import { z } from "zod";
import { text } from "../util/mcp.js";
import fetch from "node-fetch";
import * as Y from "yjs";
import { connectWorkspaceSocket, wsUrlFromGraphQLEndpoint, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
import { applyMarkdownToNote } from "../util/blocks.js";
import { withFoldersDoc, readAllEntries, getChildren, insertEntry, generateIndexBetween, generateNodeId, } from "./organize.js";
const STRUCTURAL_FLAVOURS = new Set(["affine:page", "affine:surface", "affine:note"]);
export function countContentBlocks(blocks) {
    let count = 0;
    blocks.forEach((block) => {
        if (block instanceof Y.Map && !STRUCTURAL_FLAVOURS.has(block.get("sys:flavour")))
            count++;
    });
    return count;
}
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
/** Add a doc link to a folder via Yjs WebSocket (replaces dead addDocToFolder GraphQL mutation). */
async function addDocToFolderViaWs(gql, workspaceId, docId, folderId) {
    await withFoldersDoc(gql, workspaceId, (doc) => {
        const siblings = getChildren(doc, folderId);
        const existing = siblings.find(s => s.type === "doc" && s.data === docId);
        if (existing)
            return;
        const lastIndex = siblings.length > 0 ? siblings[siblings.length - 1].index : null;
        const index = generateIndexBetween(lastIndex, null);
        insertEntry(doc, { id: generateNodeId(), parentId: folderId, type: "doc", data: docId, index });
    });
}
/** Create a new doc via Yjs WebSocket (replaces dead createDoc GraphQL mutation). */
async function createDocViaWs(gql, workspaceId, title) {
    const { endpoint, authHeaders } = { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
        await joinWorkspace(socket, workspaceId);
        const docId = generateNodeId() + generateNodeId(); // ~42-char ID
        const ydoc = new Y.Doc();
        const blocks = ydoc.getMap("blocks");
        const pageId = generateNodeId();
        const page = new Y.Map();
        page.set("sys:id", pageId);
        page.set("sys:flavour", "affine:page");
        const titleText = new Y.Text();
        titleText.insert(0, title);
        page.set("prop:title", titleText);
        const pageChildren = new Y.Array();
        page.set("sys:children", pageChildren);
        blocks.set(pageId, page);
        const surfaceId = generateNodeId();
        const surface = new Y.Map();
        surface.set("sys:id", surfaceId);
        surface.set("sys:flavour", "affine:surface");
        surface.set("sys:parent", pageId);
        surface.set("sys:children", new Y.Array());
        const elements = new Y.Map();
        elements.set("type", "$blocksuite:internal:native$");
        elements.set("value", new Y.Map());
        surface.set("prop:elements", elements);
        blocks.set(surfaceId, surface);
        pageChildren.push([surfaceId]);
        const noteId = generateNodeId();
        const note = new Y.Map();
        note.set("sys:id", noteId);
        note.set("sys:flavour", "affine:note");
        note.set("sys:parent", pageId);
        note.set("sys:children", new Y.Array());
        note.set("prop:displayMode", "both");
        note.set("prop:xywh", "[0,0,800,95]");
        note.set("prop:index", "a0");
        note.set("prop:hidden", false);
        const bg = new Y.Map();
        bg.set("light", "#ffffff");
        bg.set("dark", "#252525");
        note.set("prop:background", bg);
        blocks.set(noteId, note);
        pageChildren.push([noteId]);
        const meta = ydoc.getMap("meta");
        meta.set("id", docId);
        meta.set("title", title);
        meta.set("createDate", Date.now());
        meta.set("tags", new Y.Array());
        await pushDocUpdate(socket, workspaceId, docId, Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString("base64"));
        // Register in workspace root pages list
        const wsDoc = new Y.Doc();
        const snapshot = await loadDoc(socket, workspaceId, workspaceId);
        if (snapshot.missing)
            Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
        const prevSV = Y.encodeStateVector(wsDoc);
        const wsMeta = wsDoc.getMap("meta");
        let pages = wsMeta.get("pages");
        if (!pages) {
            pages = new Y.Array();
            wsMeta.set("pages", pages);
        }
        const entry = new Y.Map();
        entry.set("id", docId);
        entry.set("title", title);
        entry.set("createDate", Date.now());
        entry.set("updatedDate", Date.now());
        entry.set("tags", new Y.Array());
        pages.push([entry]);
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(Y.encodeStateAsUpdate(wsDoc, prevSV)).toString("base64"));
        return docId;
    }
    finally {
        socket.disconnect();
    }
}
/** Trash a doc via Yjs WebSocket (replaces dead deleteDoc GraphQL mutation). */
async function deleteDocViaWs(gql, workspaceId, docId) {
    const { endpoint, authHeaders } = { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
        await joinWorkspace(socket, workspaceId);
        const wsDoc = new Y.Doc();
        const snapshot = await loadDoc(socket, workspaceId, workspaceId);
        if (snapshot.missing)
            Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
        const prevSV = Y.encodeStateVector(wsDoc);
        const pages = wsDoc.getMap("meta").get("pages");
        if (pages) {
            pages.forEach((m) => {
                if (m.get && m.get("id") === docId) {
                    m.set("trash", true);
                    m.set("trashDate", Date.now());
                }
            });
        }
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(Y.encodeStateAsUpdate(wsDoc, prevSV)).toString("base64"));
    }
    finally {
        socket.disconnect();
    }
}
export function registerMoveDocsTools(server, gql, defaults) {
    const moveDocsHandler = async (parsed) => {
        const { docIds, targetFolderId, targetWorkspaceId, sourceWorkspaceId, removeFromSource = true, onBlobError = "abort", preserveFolderStructure = false } = parsed;
        const isSameWorkspace = !sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId;
        if (isSameWorkspace) {
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
                    await addDocToFolderViaWs(gql, targetWorkspaceId, docId, folderId);
                    results.push({ docId, status: "success", blobsTransferred: 0, blobsFailed: 0, contentIntact: true });
                }
                catch (err) {
                    results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, contentIntact: false, error: err.message });
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
                            results.push({ docId, status: "error", blobsTransferred: sourceIdMap.size, blobsFailed: sourceIds.size - sourceIdMap.size, contentIntact: false, error: `Blob transfer failed for ${oldKey}: ${err.message}` });
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
                let sourceBlockCount = 0;
                try {
                    await joinWorkspace(socket, sourceWorkspaceId);
                    const snapshot = await loadDoc(socket, sourceWorkspaceId, docId);
                    if (snapshot.missing) {
                        const doc = new Y.Doc();
                        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
                        const blocks = doc.getMap("blocks");
                        sourceBlockCount = countContentBlocks(blocks);
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
                // 4. Create doc in target workspace via WebSocket
                const newDocId = await createDocViaWs(gql, targetWorkspaceId, title || "Untitled");
                // 5. Write markdown content to new doc via WebSocket
                let destBlockCount = 0;
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
                                destBlockCount = countContentBlocks(blocks);
                                const update = Y.encodeStateAsUpdate(doc);
                                await pushDocUpdate(socket2, targetWorkspaceId, newDocId, Buffer.from(update).toString("base64"));
                            }
                        }
                    }
                    finally {
                        socket2.disconnect();
                    }
                }
                // 6. Add to target folder via WebSocket
                try {
                    const destFolderId = preserveFolderStructure
                        ? await ensureFolderPath(gql, targetWorkspaceId, targetFolderId, getFolderPathForDoc(sourceEntries, docId))
                        : targetFolderId;
                    await addDocToFolderViaWs(gql, targetWorkspaceId, newDocId, destFolderId);
                }
                catch { }
                // 7. Remove from source via WebSocket
                if (removeFromSource) {
                    try {
                        await deleteDocViaWs(gql, sourceWorkspaceId, docId);
                    }
                    catch { }
                }
                const status = blobsFailed > 0 ? "partial" : "success";
                const contentIntact = sourceBlockCount === 0 || sourceBlockCount === destBlockCount;
                results.push({ docId, status, newDocId, blobsTransferred: sourceIdMap.size, blobsFailed, contentIntact });
            }
            catch (err) {
                results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, contentIntact: false, error: err.message });
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
