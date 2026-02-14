import { z } from "zod";
import { text } from "../util/mcp.js";
import * as Y from "yjs";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../ws.js";
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
        let normalizedContent;
        if (typeof parsed.content === 'string') {
            const commentBlockId = `comment-${Date.now()}`;
            // Use selectedText for preview if provided, otherwise blockText, otherwise "normal"
            const preview = parsed.selectedText || (parsed.blockText ? parsed.blockText.substring(0, 50) : "normal");
            normalizedContent = {
                mode: normalizedDocMode,
                preview,
                snapshot: {
                    meta: { id: commentBlockId, tags: [], title: "", createDate: Date.now() },
                    type: "page",
                    blocks: {
                        id: commentBlockId,
                        type: "block",
                        flavour: "affine:page",
                        version: 2,
                        props: { title: { delta: [], "$blocksuite:internal:text$": true } },
                        children: [{
                                id: `note-${Date.now()}`,
                                type: "block",
                                flavour: "affine:note",
                                version: 1,
                                props: {
                                    xywh: "[0,0,498,92]",
                                    index: "a0",
                                    hidden: false,
                                    edgeless: {
                                        style: {
                                            borderSize: 4,
                                            shadowType: "--affine-note-shadow-box",
                                            borderStyle: "none",
                                            borderRadius: 8
                                        }
                                    },
                                    background: { light: "#ffffff", dark: "#252525" },
                                    displayMode: "both",
                                    lockedBySelf: false
                                },
                                children: [{
                                        id: `para-${Date.now()}`,
                                        type: "block",
                                        flavour: "affine:paragraph",
                                        version: 1,
                                        props: {
                                            type: "text",
                                            text: { delta: [{ insert: parsed.content }], "$blocksuite:internal:text$": true },
                                            collapsed: false
                                        },
                                        children: []
                                    }]
                            }]
                    }
                },
                attachments: []
            };
        }
        else {
            normalizedContent = parsed.content;
        }
        const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: parsed.mentions };
        const data = await gql.request(mutation, { input });
        const commentId = data.createComment.id;
        // If blockId and selectedText are provided, apply comment formatting to the document
        if (parsed.blockId && parsed.selectedText && parsed.blockText) {
            try {
                console.error(`Applying comment formatting: blockId=${parsed.blockId}, selectedText="${parsed.selectedText}", commentId=${commentId}`);
                await applyCommentFormatting(gql, workspaceId, parsed.docId, parsed.blockId, parsed.blockText, parsed.selectedText, commentId);
                console.error("Comment formatting applied successfully");
            }
            catch (error) {
                console.error("Failed to apply comment formatting:", error);
                // Don't fail the whole operation if formatting fails
            }
        }
        return text(data.createComment);
    };
    async function applyCommentFormatting(gql, workspaceId, docId, blockId, blockText, selectedText, commentId) {
        console.error("Starting applyCommentFormatting...");
        // Connect to workspace via WebSocket
        const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
        console.error(`Connecting to WebSocket: ${wsUrl}`);
        const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
        console.error("WebSocket connected");
        await joinWorkspace(socket, workspaceId);
        console.error(`Joined workspace: ${workspaceId}`);
        // Load the document
        const docData = await loadDoc(socket, workspaceId, docId);
        console.error(`Loaded doc, has state: ${!!docData.state}`);
        // Create Y.Doc and apply state if available
        const ydoc = new Y.Doc();
        if (docData.missing) {
            const stateUpdate = Buffer.from(docData.missing, 'base64');
            Y.applyUpdate(ydoc, stateUpdate);
            console.error("Applied doc missing data to Y.Doc");
        }
        // Find the block and its text
        const blocks = ydoc.getMap('blocks');
        console.error(`Blocks map has ${blocks.size} entries`);
        const block = blocks.get(blockId);
        if (!block) {
            socket.disconnect();
            throw new Error(`Block ${blockId} not found in blocks map`);
        }
        console.error(`Found block ${blockId}`);
        const text = block.get('prop:text');
        if (!text) {
            socket.disconnect();
            throw new Error(`Block ${blockId} has no prop:text property`);
        }
        console.error(`Found text in block, content: "${text.toString()}"`);
        // Find the selected text in the block
        const textContent = text.toString();
        const startIndex = textContent.indexOf(selectedText);
        if (startIndex === -1) {
            socket.disconnect();
            throw new Error(`Selected text "${selectedText}" not found in block text "${textContent}"`);
        }
        console.error(`Found selected text at index ${startIndex}`);
        // Apply comment formatting
        text.format(startIndex, selectedText.length, { [`comment-${commentId}`]: true });
        console.error(`Applied formatting: comment-${commentId} at ${startIndex}, length ${selectedText.length}`);
        // Push the update
        const update = Y.encodeStateAsUpdate(ydoc);
        const updateBase64 = Buffer.from(update).toString('base64');
        console.error(`Pushing update, size: ${update.length} bytes`);
        await pushDocUpdate(socket, workspaceId, docId, updateBase64);
        console.error("Update pushed successfully");
        // Close socket
        socket.disconnect();
        console.error("Socket disconnected");
    }
    server.registerTool("create_comment", {
        title: "Create Comment",
        description: "Create a comment on a doc. To anchor the comment to a specific text selection, provide blockId, blockText, and selectedText (the exact text fragment to highlight).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            docTitle: z.string().optional(),
            docMode: z.enum(["Page", "Edgeless", "page", "edgeless"]).optional(),
            content: z.any(),
            mentions: z.array(z.string()).optional(),
            blockId: z.string().optional().describe("Block ID to anchor the comment to"),
            blockText: z.string().optional().describe("Full text content of the block"),
            selectedText: z.string().optional().describe("Exact text fragment to highlight (will be used as preview)")
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
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        // Delete the comment first
        const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
        const data = await gql.request(mutation, { id: parsed.id });
        // If we have workspaceId and docId, try to remove the formatting
        if (workspaceId && parsed.docId) {
            try {
                await removeCommentFormatting(gql, workspaceId, parsed.docId, parsed.id);
            }
            catch (error) {
                console.error("Failed to remove comment formatting:", error);
                // Don't fail the delete if formatting removal fails
            }
        }
        return text({ success: data.deleteComment });
    };
    async function removeCommentFormatting(gql, workspaceId, docId, commentId) {
        const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
        await joinWorkspace(socket, workspaceId);
        const docData = await loadDoc(socket, workspaceId, docId);
        const ydoc = new Y.Doc();
        if (docData.missing) {
            Y.applyUpdate(ydoc, Buffer.from(docData.missing, 'base64'));
        }
        // Search through all blocks to find text with this comment formatting
        const blocks = ydoc.getMap('blocks');
        const commentKey = `comment-${commentId}`;
        let foundAndRemoved = false;
        blocks.forEach((block, blockId) => {
            const text = block.get('prop:text');
            if (text) {
                // Check if this text has the comment formatting
                const delta = text.toDelta();
                let hasFormatting = false;
                for (const op of delta) {
                    if (op.attributes && op.attributes[commentKey]) {
                        hasFormatting = true;
                        break;
                    }
                }
                if (hasFormatting) {
                    // Remove the formatting by iterating through and clearing it
                    let index = 0;
                    for (const op of delta) {
                        const length = typeof op.insert === 'string' ? op.insert.length : 1;
                        if (op.attributes && op.attributes[commentKey]) {
                            text.format(index, length, { [commentKey]: null });
                            foundAndRemoved = true;
                        }
                        index += length;
                    }
                }
            }
        });
        if (foundAndRemoved) {
            const update = Y.encodeStateAsUpdate(ydoc);
            const updateBase64 = Buffer.from(update).toString('base64');
            await pushDocUpdate(socket, workspaceId, docId, updateBase64);
        }
        socket.disconnect();
    }
    server.registerTool("delete_comment", {
        title: "Delete Comment",
        description: "Delete a comment by id. Optionally provide workspaceId and docId to remove text highlighting.",
        inputSchema: {
            id: z.string(),
            workspaceId: z.string().optional(),
            docId: z.string().optional()
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
