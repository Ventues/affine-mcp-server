import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerCommentTools(server, gql, defaults) {
    const listCommentsHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        const query = `query ListComments($workspaceId:String!,$docId:String!,$first:Int,$offset:Int,$after:String){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id content createdAt updatedAt resolved user{ id name avatarUrl } replies{ id content createdAt updatedAt user{ id name avatarUrl } } } } } } }`;
        const data = await gql.request(query, { workspaceId, docId: parsed.docId, first: parsed.first, offset: parsed.offset, after: parsed.after });
        return text(data.workspace.comments);
    };
    server.registerTool("list_comments", {
        title: "List Comments",
        description: "List comments of a doc (with replies).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            first: z.number().optional(),
            offset: z.number().optional(),
            after: z.string().optional()
        }
    }, listCommentsHandler);
    const createCommentHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
        const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
        const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
        const normalizedContent = typeof parsed.content === 'string' ? { text: parsed.content } : parsed.content;
        const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: parsed.mentions };
        const data = await gql.request(mutation, { input });
        return text(data.createComment);
    };
    server.registerTool("create_comment", {
        title: "Create Comment",
        description: "Create a comment on a doc.",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            docTitle: z.string().optional(),
            docMode: z.enum(["Page", "Edgeless", "page", "edgeless"]).optional(),
            content: z.any(),
            mentions: z.array(z.string()).optional()
        }
    }, createCommentHandler);
    const updateCommentHandler = async (parsed) => {
        const mutation = `mutation UpdateComment($input: CommentUpdateInput!){ updateComment(input:$input) }`;
        const data = await gql.request(mutation, { input: { id: parsed.id, content: parsed.content } });
        return text({ success: data.updateComment });
    };
    server.registerTool("update_comment", {
        title: "Update Comment",
        description: "Update a comment content.",
        inputSchema: {
            id: z.string(),
            content: z.any()
        }
    }, updateCommentHandler);
    const deleteCommentHandler = async (parsed) => {
        const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
        const data = await gql.request(mutation, { id: parsed.id });
        return text({ success: data.deleteComment });
    };
    server.registerTool("delete_comment", {
        title: "Delete Comment",
        description: "Delete a comment by id.",
        inputSchema: {
            id: z.string()
        }
    }, deleteCommentHandler);
    const resolveCommentHandler = async (parsed) => {
        const mutation = `mutation ResolveComment($input: CommentResolveInput!){ resolveComment(input:$input) }`;
        const data = await gql.request(mutation, { input: parsed });
        return text({ success: data.resolveComment });
    };
    server.registerTool("resolve_comment", {
        title: "Resolve Comment",
        description: "Resolve or unresolve a comment.",
        inputSchema: {
            id: z.string(),
            resolved: z.boolean()
        }
    }, resolveCommentHandler);
}
