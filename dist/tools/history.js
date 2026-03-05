import { text } from "../util/mcp.js";
import { z } from "zod";
import * as Y from "yjs";
import { fetch } from "undici";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
export function registerHistoryTools(server, gql, defaults) {
    const listHistoriesHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        const query = `query Histories($workspaceId:String!,$guid:String!,$take:Int,$before:DateTime){ workspace(id:$workspaceId){ histories(guid:$guid, take:$take, before:$before){ id timestamp workspaceId } } }`;
        const data = await gql.request(query, { workspaceId, guid: parsed.guid, take: parsed.take, before: parsed.before });
        return text(data.workspace.histories);
    };
    server.registerTool("list_histories", {
        title: "List Histories",
        description: "List doc histories (timestamps) for a doc.",
        inputSchema: {
            workspaceId: z.string().optional(),
            guid: z.string(),
            take: z.number().optional(),
            before: z.string().optional()
        }
    }, listHistoriesHandler);
    /** Deeply clone a Y.Map's props (excluding sys: fields) into a target Y.Map */
    function cloneProps(src, dst) {
        for (const [key, val] of src.entries()) {
            if (key.startsWith("sys:"))
                continue;
            if (val instanceof Y.Text) {
                const yt = new Y.Text();
                yt.applyDelta(val.toDelta());
                dst.set(key, yt);
            }
            else if (val instanceof Y.Array) {
                const ya = new Y.Array();
                ya.push(val.toArray());
                dst.set(key, ya);
            }
            else {
                dst.set(key, val);
            }
        }
    }
    const recoverDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        // 1. Call GraphQL mutation (creates server-side history record)
        const mutation = `mutation Recover($workspaceId:String!,$guid:String!,$timestamp:DateTime!){ recoverDoc(workspaceId:$workspaceId, guid:$guid, timestamp:$timestamp) }`;
        await gql.request(mutation, { workspaceId, guid: parsed.guid, timestamp: parsed.timestamp });
        // 2. Fetch historical snapshot via REST API
        const baseUrl = gql.endpoint.replace(/\/graphql\/?$/, "");
        const historyUrl = `${baseUrl}/api/workspaces/${workspaceId}/docs/${parsed.guid}/histories/${encodeURIComponent(parsed.timestamp)}`;
        const authHeaders = gql.getAuthHeaders();
        const histRes = await fetch(historyUrl, { headers: authHeaders });
        if (!histRes.ok)
            throw new Error(`Failed to fetch history snapshot: ${histRes.status} ${histRes.statusText}`);
        const histBuf = Buffer.from(await histRes.arrayBuffer());
        // 3. Load current doc via WebSocket
        const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
            await joinWorkspace(socket, workspaceId);
            const snapshot = await loadDoc(socket, workspaceId, parsed.guid);
            if (snapshot.missing === undefined)
                throw new Error(`Document '${parsed.guid}' not found.`);
            // 4. Build historical doc to read target state
            const histDoc = new Y.Doc();
            Y.applyUpdate(histDoc, histBuf);
            const histBlocks = histDoc.getMap("blocks");
            // 5. Modify current doc to match historical state
            const currentDoc = new Y.Doc();
            Y.applyUpdate(currentDoc, Buffer.from(snapshot.missing, "base64"));
            const prevSV = Y.encodeStateVector(currentDoc);
            const blocks = currentDoc.getMap("blocks");
            // Collect block IDs from both states
            const currentIds = new Set();
            blocks.forEach((_, key) => currentIds.add(key));
            const histIds = new Set();
            histBlocks.forEach((_, key) => histIds.add(key));
            // Delete blocks that exist in current but not in historical
            for (const id of currentIds) {
                if (!histIds.has(id))
                    blocks.delete(id);
            }
            // Add/update blocks from historical state
            for (const id of histIds) {
                const histBlock = histBlocks.get(id);
                if (!histBlock)
                    continue;
                if (!currentIds.has(id)) {
                    // New block from history — create it
                    const newBlock = new Y.Map();
                    newBlock.set("sys:id", histBlock.get("sys:id"));
                    newBlock.set("sys:flavour", histBlock.get("sys:flavour"));
                    newBlock.set("sys:version", histBlock.get("sys:version"));
                    newBlock.set("sys:parent", histBlock.get("sys:parent"));
                    const histChildren = histBlock.get("sys:children");
                    if (histChildren instanceof Y.Array) {
                        const ch = new Y.Array();
                        ch.push(histChildren.toArray());
                        newBlock.set("sys:children", ch);
                    }
                    else {
                        newBlock.set("sys:children", new Y.Array());
                    }
                    cloneProps(histBlock, newBlock);
                    blocks.set(id, newBlock);
                }
                else {
                    // Existing block — update props to match historical state
                    const curBlock = blocks.get(id);
                    if (!(curBlock instanceof Y.Map))
                        continue;
                    // Update sys:children to match historical order
                    const histChildren = histBlock.get("sys:children");
                    const curChildren = curBlock.get("sys:children");
                    if (histChildren instanceof Y.Array && curChildren instanceof Y.Array) {
                        if (curChildren.length > 0)
                            curChildren.delete(0, curChildren.length);
                        curChildren.push(histChildren.toArray());
                    }
                    // Update props: remove current props not in history, set historical props
                    const histKeys = new Set();
                    for (const [key] of histBlock.entries()) {
                        if (!key.startsWith("sys:"))
                            histKeys.add(key);
                    }
                    for (const [key] of curBlock.entries()) {
                        if (!key.startsWith("sys:") && !histKeys.has(key))
                            curBlock.delete(key);
                    }
                    cloneProps(histBlock, curBlock);
                }
            }
            // 6. Push the diff
            const delta = Y.encodeStateAsUpdate(currentDoc, prevSV);
            await pushDocUpdate(socket, workspaceId, parsed.guid, Buffer.from(delta).toString("base64"));
            return text({ recovered: true, docId: parsed.guid, timestamp: parsed.timestamp });
        }
        finally {
            socket.disconnect();
        }
    };
    server.registerTool("recover_doc", {
        title: "Recover Document",
        description: "Recover a doc to a previous timestamp.",
        inputSchema: {
            workspaceId: z.string().optional(),
            guid: z.string(),
            timestamp: z.string()
        }
    }, recoverDocHandler);
}
