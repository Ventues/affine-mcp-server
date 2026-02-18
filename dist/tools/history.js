import { text } from "../util/mcp.js";
import { z } from "zod";
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
    const recoverDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        const mutation = `mutation Recover($workspaceId:String!,$guid:String!,$timestamp:DateTime!){ recoverDoc(workspaceId:$workspaceId, guid:$guid, timestamp:$timestamp) }`;
        const data = await gql.request(mutation, { workspaceId, guid: parsed.guid, timestamp: parsed.timestamp });
        return text({ recoveredAt: data.recoverDoc });
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
