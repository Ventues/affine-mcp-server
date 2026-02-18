import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerUpdateTools(server, gql, defaults) {
    const deprecationNote = "DEPRECATED: Use update_block, delete_block, append_block, or write_doc_from_markdown instead.";
    const applyDocUpdatesHandler = async (parsed) => {
        console.warn(`apply_doc_updates called for doc ${parsed.docId}. ${deprecationNote}`);
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        const query = `query Apply($workspaceId:String!,$docId:String!,$op:String!,$updates:String!){ applyDocUpdates(workspaceId:$workspaceId, docId:$docId, op:$op, updates:$updates) }`;
        const data = await gql.request(query, { workspaceId, docId: parsed.docId, op: parsed.op, updates: parsed.updates });
        return text(data.applyDocUpdates);
    };
    server.registerTool("apply_doc_updates", {
        title: "Apply Document Updates",
        description: `Apply CRDT updates to a doc (advanced). ${deprecationNote}`,
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            op: z.string(),
            updates: z.string()
        }
    }, applyDocUpdatesHandler);
}
