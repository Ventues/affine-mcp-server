import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import * as Y from "yjs";
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from "../ws.js";

async function touchDocTimestamp(gql: GraphQLClient, workspaceId: string, docId: string): Promise<void> {
  const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
  const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
  try {
    await joinWorkspace(socket, workspaceId);
    const wsSnapshot = await loadDoc(socket, workspaceId, workspaceId);
    const wsDoc = new Y.Doc();
    if (wsSnapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(wsSnapshot.missing, 'base64'));
    const prevSV = Y.encodeStateVector(wsDoc);
    const wsMeta = wsDoc.getMap('meta');
    const pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
    if (pages) {
      pages.forEach((entry: any) => {
        if (entry?.get && entry.get('id') === docId) {
          entry.set('updatedDate', Date.now());
        }
      });
    }
    const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
    if (delta.byteLength > 0) {
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(delta).toString('base64'));
    }
  } finally {
    socket.disconnect();
  }
}

export function registerCommentTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  const listCommentsHandler = async (parsed: { workspaceId?: string; docId: string; first?: number; offset?: number; after?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    const query = `query ListComments($workspaceId:String!,$docId:String!,$first:Int,$offset:Int,$after:String){ workspace(id:$workspaceId){ comments(docId:$docId, pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id content createdAt updatedAt resolved user{ id name avatarUrl } replies{ id content createdAt updatedAt user{ id name avatarUrl } } } } } } }`;
    const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId, first: parsed.first, offset: parsed.offset, after: parsed.after });
    return text(data.workspace.comments);
  };
  server.registerTool(
    "list_comments",
    {
      title: "List Comments",
      description: "List comments of a doc (with replies).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listCommentsHandler as any
  );

  const createCommentHandler = async (parsed: { workspaceId?: string; docId: string; docTitle?: string; docMode?: "Page"|"Edgeless"|"page"|"edgeless"; content?: any; mentions?: string[]; blockId?: string; blockText?: string; selectedText?: string; comments?: Array<{ content: any; blockId: string; blockText: string; selectedText: string; mentions?: string[] }> }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId || parsed.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    
    // Batch mode
    if (parsed.comments) {
      const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
      const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
      
      const createdComments = [];
      for (const comment of parsed.comments) {
        let normalizedContent: any;
        if (typeof comment.content === 'string') {
          const commentBlockId = `comment-${Date.now()}`;
          normalizedContent = {
            mode: normalizedDocMode,
            preview: comment.selectedText,
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
                      text: { delta: [{ insert: comment.content }], "$blocksuite:internal:text$": true },
                      collapsed: false
                    },
                    children: []
                  }]
                }]
              }
            },
            attachments: []
          };
        } else {
          normalizedContent = comment.content;
        }
        
        const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: comment.mentions };
        const data = await gql.request<{ createComment: any }>(mutation, { input });
        createdComments.push({
          id: data.createComment.id,
          blockId: comment.blockId,
          blockText: comment.blockText,
          selectedText: comment.selectedText,
          result: data.createComment
        });
      }
      
      try {
        await batchApplyCommentFormatting(gql, workspaceId, parsed.docId, createdComments);
      } catch (error) {
        console.error("Failed to apply batch comment formatting:", error);
      }
      
      try { await touchDocTimestamp(gql, workspaceId, parsed.docId); } catch {}
      
      return text({ comments: createdComments.map(c => c.result) });
    }
    
    // Single mode
    const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
    const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
    
    let normalizedContent: any;
    if (typeof parsed.content === 'string') {
      const commentBlockId = `comment-${Date.now()}`;
      const preview = parsed.selectedText!;
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
    } else {
      normalizedContent = parsed.content;
    }
    
    const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: parsed.mentions };
    const data = await gql.request<{ createComment: any }>(mutation, { input });
    const commentId = data.createComment.id;
    
    try {
      await applyCommentFormatting(gql, workspaceId, parsed.docId, parsed.blockId!, parsed.blockText!, parsed.selectedText!, commentId);
    } catch (error) {
      console.error("Failed to apply comment formatting:", error);
    }
    
    try { await touchDocTimestamp(gql, workspaceId, parsed.docId); } catch {}
    
    return text(data.createComment);
  };
  
  async function applyCommentFormatting(
    gql: GraphQLClient,
    workspaceId: string,
    docId: string,
    blockId: string,
    blockText: string,
    selectedText: string,
    commentId: string
  ): Promise<void> {
    const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
    
    await joinWorkspace(socket, workspaceId);
    
    const docData = await loadDoc(socket, workspaceId, docId);
    
    const ydoc = new Y.Doc();
    if (docData.missing) {
      const stateUpdate = Buffer.from(docData.missing, 'base64');
      Y.applyUpdate(ydoc, stateUpdate);
    }
    
    const blocks = ydoc.getMap('blocks');
    const block = blocks.get(blockId) as Y.Map<any> | undefined;
    if (!block) {
      socket.disconnect();
      throw new Error(`Block ${blockId} not found in blocks map`);
    }
    
    const text = block.get('prop:text') as Y.Text | undefined;
    if (!text) {
      socket.disconnect();
      throw new Error(`Block ${blockId} has no prop:text property`);
    }
    
    const textContent = text.toString();
    const startIndex = textContent.indexOf(selectedText);
    if (startIndex === -1) {
      socket.disconnect();
      throw new Error(`Selected text "${selectedText}" not found in block text "${textContent}"`);
    }
    
    text.format(startIndex, selectedText.length, { [`comment-${commentId}`]: true });
    
    const update = Y.encodeStateAsUpdate(ydoc);
    const updateBase64 = Buffer.from(update).toString('base64');
    await pushDocUpdate(socket, workspaceId, docId, updateBase64);
    
    socket.disconnect();
  }
  
  async function batchApplyCommentFormatting(
    gql: GraphQLClient,
    workspaceId: string,
    docId: string,
    comments: Array<{ id: string; blockId: string; blockText: string; selectedText: string }>
  ): Promise<void> {
    const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
    
    await joinWorkspace(socket, workspaceId);
    const docData = await loadDoc(socket, workspaceId, docId);
    
    const ydoc = new Y.Doc();
    if (docData.missing) {
      const stateUpdate = Buffer.from(docData.missing, 'base64');
      Y.applyUpdate(ydoc, stateUpdate);
    }
    
    const blocks = ydoc.getMap('blocks');
    
    for (const comment of comments) {
      const block = blocks.get(comment.blockId) as Y.Map<any> | undefined;
      if (!block) continue;
      
      const text = block.get('prop:text') as Y.Text | undefined;
      if (!text) continue;
      
      const textContent = text.toString();
      const startIndex = textContent.indexOf(comment.selectedText);
      if (startIndex === -1) continue;
      
      text.format(startIndex, comment.selectedText.length, { [`comment-${comment.id}`]: true });
    }
    
    const update = Y.encodeStateAsUpdate(ydoc);
    const updateBase64 = Buffer.from(update).toString('base64');
    await pushDocUpdate(socket, workspaceId, docId, updateBase64);
    
    socket.disconnect();
  }
  
  server.registerTool(
    "create_comment",
    {
      title: "Create Comment",
      description: "Create a comment (or multiple comments) on a doc. Comments must be anchored to a specific text selection. For single comment: provide content, blockId, blockText, selectedText. For batch: provide comments array. Batch mode is much faster for multiple comments.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        docTitle: z.string().optional(),
        docMode: z.enum(["Page","Edgeless","page","edgeless"]).optional(),
        content: z.any().optional().describe("Comment content (for single mode)"),
        mentions: z.array(z.string()).optional(),
        blockId: z.string().optional().describe("Block ID to anchor the comment to (for single mode)"),
        blockText: z.string().optional().describe("Full text content of the block (for single mode)"),
        selectedText: z.string().optional().describe("Exact text fragment to highlight (for single mode)"),
        comments: z.array(z.object({
          content: z.any(),
          blockId: z.string(),
          blockText: z.string(),
          selectedText: z.string(),
          mentions: z.array(z.string()).optional()
        })).optional().describe("Array of comments to create (for batch mode)")
      }
    },
    createCommentHandler as any
  );

  const updateCommentHandler = async (parsed: { id: string; content: any }) => {
    const mutation = `mutation UpdateComment($input: CommentUpdateInput!){ updateComment(input:$input) }`;
    const data = await gql.request<{ updateComment: boolean }>(mutation, { input: { id: parsed.id, content: parsed.content } });
    return text({ success: data.updateComment });
  };
  server.registerTool(
    "update_comment",
    {
      title: "Update Comment",
      description: "Update a comment content.",
      inputSchema: {
        id: z.string(),
        content: z.any()
      }
    },
    updateCommentHandler as any
  );

  const deleteCommentHandler = async (parsed: { id: string; workspaceId?: string; docId?: string; blockId?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    
    // Delete the comment first
    const mutation = `mutation DeleteComment($id:String!){ deleteComment(id:$id) }`;
    const data = await gql.request<{ deleteComment: boolean }>(mutation, { id: parsed.id });
    
    // If we have workspaceId and docId, try to remove the formatting
    if (workspaceId && parsed.docId) {
      try {
        await removeCommentFormatting(gql, workspaceId, parsed.docId, parsed.id, parsed.blockId);
      } catch (error) {
        console.error("Failed to remove comment formatting:", error);
        // Don't fail the delete if formatting removal fails
      }
    }
    
    return text({ success: data.deleteComment });
  };
  
  async function removeCommentFormatting(
    gql: GraphQLClient,
    workspaceId: string,
    docId: string,
    commentId: string,
    blockId?: string
  ): Promise<void> {
    const wsUrl = wsUrlFromGraphQLEndpoint(gql.endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
    await joinWorkspace(socket, workspaceId);
    
    const docData = await loadDoc(socket, workspaceId, docId);
    const ydoc = new Y.Doc();
    if (docData.missing) {
      Y.applyUpdate(ydoc, Buffer.from(docData.missing, 'base64'));
    }
    
    const blocks = ydoc.getMap('blocks');
    const commentKey = `comment-${commentId}`;
    let foundAndRemoved = false;
    
    // If blockId is provided, only check that block
    const blocksToCheck: Array<[string, any]> = blockId ? [[blockId, blocks.get(blockId)]] : Array.from(blocks.entries());
    
    for (const [bid, block] of blocksToCheck) {
      if (!block) continue;
      const text = block.get('prop:text') as Y.Text | undefined;
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
          
          // If blockId was provided, we can stop after finding it
          if (blockId) break;
        }
      }
    }
    
    if (foundAndRemoved) {
      const update = Y.encodeStateAsUpdate(ydoc);
      const updateBase64 = Buffer.from(update).toString('base64');
      await pushDocUpdate(socket, workspaceId, docId, updateBase64);
    }
    
    socket.disconnect();
  }
  server.registerTool(
    "delete_comment",
    {
      title: "Delete Comment",
      description: "Delete a comment by id. Optionally provide workspaceId, docId, and blockId to remove text highlighting. Providing blockId significantly speeds up formatting removal.",
      inputSchema: {
        id: z.string(),
        workspaceId: z.string().optional(),
        docId: z.string().optional(),
        blockId: z.string().optional().describe("Block ID where the comment is anchored (speeds up formatting removal)")
      }
    },
    deleteCommentHandler as any
  );

  const resolveCommentHandler = async (parsed: { id: string; resolved: boolean }) => {
    const mutation = `mutation ResolveComment($input: CommentResolveInput!){ resolveComment(input:$input) }`;
    const data = await gql.request<{ resolveComment: boolean }>(mutation, { input: parsed });
    return text({ success: data.resolveComment });
  };
  server.registerTool(
    "resolve_comment",
    {
      title: "Resolve Comment",
      description: "Resolve or unresolve a comment.",
      inputSchema: {
        id: z.string(),
        resolved: z.boolean()
      }
    },
    resolveCommentHandler as any
  );

  const replyToCommentHandler = async (parsed: { commentId: string; content: any; docMode?: "Page"|"Edgeless"|"page"|"edgeless"; docTitle?: string }) => {
    const mutation = `mutation CreateReply($input: ReplyCreateInput!){ createReply(input: $input){ id content createdAt updatedAt user{ id name avatarUrl } } }`;
    
    const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
    
    let normalizedContent: any;
    if (typeof parsed.content === 'string') {
      const commentBlockId = `comment-${Date.now()}`;
      normalizedContent = {
        mode: normalizedDocMode,
        preview: parsed.content.substring(0, 50),
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
    } else {
      normalizedContent = parsed.content;
    }
    
    const data = await gql.request<{ createReply: any }>(mutation, { 
      input: { 
        commentId: parsed.commentId, 
        content: normalizedContent,
        docMode: normalizedDocMode,
        docTitle: parsed.docTitle || ""
      } 
    });
    return text(data.createReply);
  };
  server.registerTool(
    "reply_to_comment",
    {
      title: "Reply to Comment",
      description: "Reply to an existing comment.",
      inputSchema: {
        commentId: z.string().describe("ID of the comment to reply to"),
        content: z.any().describe("Reply content (string or structured content)"),
        docMode: z.enum(["Page","Edgeless","page","edgeless"]).optional(),
        docTitle: z.string().optional()
      }
    },
    replyToCommentHandler as any
  );

  const batchCreateCommentsHandler = async (parsed: { workspaceId?: string; docId: string; docTitle?: string; docMode?: "Page"|"Edgeless"|"page"|"edgeless"; comments: Array<{ content: any; blockId: string; blockText: string; selectedText: string; mentions?: string[] }> }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId required (or set AFFINE_WORKSPACE_ID)");
    
    const normalizedDocMode = (parsed.docMode || 'page').toLowerCase() === 'edgeless' ? 'edgeless' : 'page';
    const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
    
    // Create all comments via GraphQL first
    const createdComments = [];
    for (const comment of parsed.comments) {
      let normalizedContent: any;
      if (typeof comment.content === 'string') {
        const commentBlockId = `comment-${Date.now()}`;
        normalizedContent = {
          mode: normalizedDocMode,
          preview: comment.selectedText,
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
                    text: { delta: [{ insert: comment.content }], "$blocksuite:internal:text$": true },
                    collapsed: false
                  },
                  children: []
                }]
              }]
            }
          },
          attachments: []
        };
      } else {
        normalizedContent = comment.content;
      }
      
      const input = { content: normalizedContent, docId: parsed.docId, workspaceId, docTitle: parsed.docTitle || "", docMode: normalizedDocMode, mentions: comment.mentions };
      const data = await gql.request<{ createComment: any }>(mutation, { input });
      createdComments.push({
        id: data.createComment.id,
        blockId: comment.blockId,
        blockText: comment.blockText,
        selectedText: comment.selectedText,
        result: data.createComment
      });
    }
    
    // Apply all formatting in one WebSocket session
    try {
      await batchApplyCommentFormatting(gql, workspaceId, parsed.docId, createdComments);
    } catch (error) {
      console.error("Failed to apply batch comment formatting:", error);
    }
    
    try { await touchDocTimestamp(gql, workspaceId, parsed.docId); } catch {}
    
    return text({ comments: createdComments.map(c => c.result) });
  };
  
}
