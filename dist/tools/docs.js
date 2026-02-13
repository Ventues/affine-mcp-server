import { z } from "zod";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";
const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");
export function registerDocTools(server, gql, defaults) {
    // helpers
    function generateId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
        let id = '';
        for (let i = 0; i < 10; i++)
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        return id;
    }
    function getEndpointAndAuthHeaders() {
        const endpoint = gql.endpoint;
        const authHeaders = gql.getAuthHeaders();
        return { endpoint, authHeaders };
    }
    const listDocsHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
        const data = await gql.request(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
        const docs = data.workspace.docs;
        // Enrich null titles by fetching individual doc metadata via GraphQL
        const nullTitleEdges = docs.edges ? docs.edges.filter((e) => !e.node.title) : [];
        if (nullTitleEdges.length > 0) {
            const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
            const results = await Promise.allSettled(nullTitleEdges.map((edge) => gql.request(getDocQuery, { workspaceId, docId: edge.node.id })));
            results.forEach((result, i) => {
                if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
                    const doc = result.value.workspace.doc;
                    if (doc.title)
                        nullTitleEdges[i].node.title = doc.title;
                    if (doc.summary)
                        nullTitleEdges[i].node.summary = doc.summary;
                }
            });
        }
        return text(docs);
    };
    server.registerTool("list_docs", {
        title: "List Documents",
        description: "List documents in a workspace (GraphQL).",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
            first: z.number().optional(),
            offset: z.number().optional(),
            after: z.string().optional()
        }
    }, listDocsHandler);
    server.registerTool("affine_list_docs", {
        title: "List Documents",
        description: "List documents in a workspace (GraphQL).",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
            first: z.number().optional(),
            offset: z.number().optional(),
            after: z.string().optional()
        }
    }, listDocsHandler);
    const getDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
        const data = await gql.request(query, { workspaceId, docId: parsed.docId });
        return text(data.workspace.doc);
    };
    server.registerTool("get_doc", {
        title: "Get Document",
        description: "Get a document by ID (GraphQL metadata).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: DocId
        }
    }, getDocHandler);
    server.registerTool("affine_get_doc", {
        title: "Get Document",
        description: "Get a document by ID (GraphQL metadata).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: DocId
        }
    }, getDocHandler);
    const searchDocsHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        // Try server-side search first
        try {
            const query = `query SearchDocs($workspaceId:String!, $keyword:String!, $limit:Int){ workspace(id:$workspaceId){ searchDocs(input:{ keyword:$keyword, limit:$limit }){ docId title highlight createdAt updatedAt } } }`;
            const data = await gql.request(query, { workspaceId, keyword: parsed.keyword, limit: parsed.limit });
            const results = data.workspace?.searchDocs;
            if (results && results.length > 0) {
                return text(results);
            }
        }
        catch (error) {
            console.error("Server-side search unavailable, falling back to client-side search:", error.message);
        }
        // Fallback: client-side search by fetching all docs and filtering by title/summary
        try {
            const listQuery = `query ListAllDocs($workspaceId: String!){ workspace(id:$workspaceId){ docs(pagination:{first:100}){ edges{ node{ id workspaceId title summary createdAt updatedAt } } } } }`;
            const listData = await gql.request(listQuery, { workspaceId });
            const allEdges = listData.workspace.docs.edges || [];
            // Enrich null titles
            const nullTitleEdges = allEdges.filter((e) => !e.node.title);
            if (nullTitleEdges.length > 0) {
                const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
                const results = await Promise.allSettled(nullTitleEdges.map((edge) => gql.request(getDocQuery, { workspaceId, docId: edge.node.id })));
                results.forEach((result, i) => {
                    if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
                        const doc = result.value.workspace.doc;
                        if (doc.title)
                            nullTitleEdges[i].node.title = doc.title;
                        if (doc.summary)
                            nullTitleEdges[i].node.summary = doc.summary;
                    }
                });
            }
            // Search by keyword in title and summary (case-insensitive)
            const kw = parsed.keyword.toLowerCase();
            const keywords = kw.split(/\s+/);
            const matched = allEdges
                .map((e) => e.node)
                .filter((doc) => {
                const title = (doc.title || '').toLowerCase();
                const summary = (doc.summary || '').toLowerCase();
                const combined = title + ' ' + summary;
                return keywords.every((k) => combined.includes(k));
            })
                .slice(0, parsed.limit || 20)
                .map((doc) => ({
                docId: doc.id,
                title: doc.title,
                summary: doc.summary,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt
            }));
            return text(matched);
        }
        catch (fallbackError) {
            console.error("Client-side search also failed:", fallbackError.message);
            return text([]);
        }
    };
    server.registerTool("search_docs", {
        title: "Search Documents",
        description: "Search documents in a workspace.",
        inputSchema: {
            workspaceId: z.string().optional(),
            keyword: z.string().min(1),
            limit: z.number().optional()
        }
    }, searchDocsHandler);
    server.registerTool("affine_search_docs", {
        title: "Search Documents",
        description: "Search documents in a workspace.",
        inputSchema: {
            workspaceId: z.string().optional(),
            keyword: z.string().min(1),
            limit: z.number().optional()
        }
    }, searchDocsHandler);
    const recentDocsHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        // Note: AFFiNE doesn't have a separate 'recentlyUpdatedDocs' field, just use docs
        const query = `query RecentDocs($workspaceId:String!, $first:Int, $offset:Int, $after:String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
        const data = await gql.request(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
        const docs = data.workspace.docs;
        // Enrich null titles by fetching individual doc metadata via GraphQL
        const nullTitleEdges = docs.edges ? docs.edges.filter((e) => !e.node.title) : [];
        if (nullTitleEdges.length > 0) {
            const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
            const results = await Promise.allSettled(nullTitleEdges.map((edge) => gql.request(getDocQuery, { workspaceId, docId: edge.node.id })));
            results.forEach((result, i) => {
                if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
                    const doc = result.value.workspace.doc;
                    if (doc.title)
                        nullTitleEdges[i].node.title = doc.title;
                    if (doc.summary)
                        nullTitleEdges[i].node.summary = doc.summary;
                }
            });
        }
        return text(docs);
    };
    server.registerTool("recent_docs", {
        title: "Recent Documents",
        description: "List recently updated docs in a workspace.",
        inputSchema: {
            workspaceId: z.string().optional(),
            first: z.number().optional(),
            offset: z.number().optional(),
            after: z.string().optional()
        }
    }, recentDocsHandler);
    server.registerTool("affine_recent_docs", {
        title: "Recent Documents",
        description: "List recently updated docs in a workspace.",
        inputSchema: {
            workspaceId: z.string().optional(),
            first: z.number().optional(),
            offset: z.number().optional(),
            after: z.string().optional()
        }
    }, recentDocsHandler);
    const publishDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
        const data = await gql.request(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
        return text(data.publishDoc);
    };
    server.registerTool("publish_doc", {
        title: "Publish Document",
        description: "Publish a doc (make public).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            mode: z.enum(["Page", "Edgeless"]).optional()
        }
    }, publishDocHandler);
    server.registerTool("affine_publish_doc", {
        title: "Publish Document",
        description: "Publish a doc (make public).",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            mode: z.enum(["Page", "Edgeless"]).optional()
        }
    }, publishDocHandler);
    const revokeDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId) {
            throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
        }
        const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
        const data = await gql.request(mutation, { workspaceId, docId: parsed.docId });
        return text(data.revokePublicDoc);
    };
    server.registerTool("revoke_doc", {
        title: "Revoke Document",
        description: "Revoke a doc's public access.",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string()
        }
    }, revokeDocHandler);
    server.registerTool("affine_revoke_doc", {
        title: "Revoke Document",
        description: "Revoke a doc's public access.",
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string()
        }
    }, revokeDocHandler);
    // CREATE DOC (high-level)
    const createDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
        const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
            await joinWorkspace(socket, workspaceId);
            // 1) Create doc content
            const docId = generateId();
            const ydoc = new Y.Doc();
            const blocks = ydoc.getMap('blocks');
            const pageId = generateId();
            const page = new Y.Map();
            page.set('sys:id', pageId);
            page.set('sys:flavour', 'affine:page');
            const titleText = new Y.Text();
            titleText.insert(0, parsed.title || 'Untitled');
            page.set('prop:title', titleText);
            const children = new Y.Array();
            page.set('sys:children', children);
            blocks.set(pageId, page);
            const surfaceId = generateId();
            const surface = new Y.Map();
            surface.set('sys:id', surfaceId);
            surface.set('sys:flavour', 'affine:surface');
            surface.set('sys:parent', pageId);
            surface.set('sys:children', new Y.Array());
            blocks.set(surfaceId, surface);
            children.push([surfaceId]);
            const noteId = generateId();
            const note = new Y.Map();
            note.set('sys:id', noteId);
            note.set('sys:flavour', 'affine:note');
            note.set('sys:parent', pageId);
            note.set('prop:displayMode', 'DocAndEdgeless');
            note.set('prop:xywh', '[0,0,800,600]');
            note.set('prop:index', 'a0');
            note.set('prop:lockedBySelf', false);
            const noteChildren = new Y.Array();
            note.set('sys:children', noteChildren);
            blocks.set(noteId, note);
            children.push([noteId]);
            if (parsed.content) {
                const paraId = generateId();
                const para = new Y.Map();
                para.set('sys:id', paraId);
                para.set('sys:flavour', 'affine:paragraph');
                para.set('sys:parent', noteId);
                para.set('sys:children', new Y.Array());
                para.set('prop:type', 'text');
                const ptext = new Y.Text();
                ptext.insert(0, parsed.content);
                para.set('prop:text', ptext);
                blocks.set(paraId, para);
                noteChildren.push([paraId]);
            }
            const meta = ydoc.getMap('meta');
            meta.set('id', docId);
            meta.set('title', parsed.title || 'Untitled');
            meta.set('createDate', Date.now());
            meta.set('tags', new Y.Array());
            const updateFull = Y.encodeStateAsUpdate(ydoc);
            const updateBase64 = Buffer.from(updateFull).toString('base64');
            await pushDocUpdate(socket, workspaceId, docId, updateBase64);
            // 2) Update workspace root pages list
            const wsDoc = new Y.Doc();
            const snapshot = await loadDoc(socket, workspaceId, workspaceId);
            if (snapshot.missing) {
                Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
            }
            const prevSV = Y.encodeStateVector(wsDoc);
            const wsMeta = wsDoc.getMap('meta');
            let pages = wsMeta.get('pages');
            if (!pages) {
                pages = new Y.Array();
                wsMeta.set('pages', pages);
            }
            const entry = new Y.Map();
            entry.set('id', docId);
            entry.set('title', parsed.title || 'Untitled');
            entry.set('createDate', Date.now());
            entry.set('tags', new Y.Array());
            pages.push([entry]);
            const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
            const wsDeltaB64 = Buffer.from(wsDelta).toString('base64');
            await pushDocUpdate(socket, workspaceId, workspaceId, wsDeltaB64);
            return text({ docId, title: parsed.title || 'Untitled' });
        }
        finally {
            socket.disconnect();
        }
    };
    server.registerTool('create_doc', {
        title: 'Create Document',
        description: 'Create a new AFFiNE document with optional content',
        inputSchema: {
            workspaceId: z.string().optional(),
            title: z.string().optional(),
            content: z.string().optional(),
        },
    }, createDocHandler);
    server.registerTool('affine_create_doc', {
        title: 'Create Document',
        description: 'Create a new AFFiNE document with optional content',
        inputSchema: {
            workspaceId: z.string().optional(),
            title: z.string().optional(),
            content: z.string().optional(),
        },
    }, createDocHandler);
    // APPEND PARAGRAPH
    const appendParagraphHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId)
            throw new Error('workspaceId is required');
        const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
            await joinWorkspace(socket, workspaceId);
            const doc = new Y.Doc();
            const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
            if (snapshot.missing) {
                Y.applyUpdate(doc, Buffer.from(snapshot.missing, 'base64'));
            }
            const prevSV = Y.encodeStateVector(doc);
            const blocks = doc.getMap('blocks');
            // find a note block
            let noteId = null;
            for (const [key, val] of blocks) {
                const m = val;
                if (m?.get && m.get('sys:flavour') === 'affine:note') {
                    noteId = m.get('sys:id');
                    break;
                }
            }
            if (!noteId) {
                // fallback: create a note under existing page
                let pageId = null;
                for (const [key, val] of blocks) {
                    const m = val;
                    if (m?.get && m.get('sys:flavour') === 'affine:page') {
                        pageId = m.get('sys:id');
                        break;
                    }
                }
                if (!pageId)
                    throw new Error('Doc has no page block');
                const note = new Y.Map();
                noteId = generateId();
                note.set('sys:id', noteId);
                note.set('sys:flavour', 'affine:note');
                note.set('sys:parent', pageId);
                note.set('prop:displayMode', 'DocAndEdgeless');
                note.set('prop:xywh', '[0,0,800,600]');
                note.set('prop:index', 'a0');
                note.set('prop:lockedBySelf', false);
                note.set('sys:children', new Y.Array());
                blocks.set(noteId, note);
                const page = blocks.get(pageId);
                const children = page.get('sys:children');
                children.push([noteId]);
            }
            const paragraphId = generateId();
            const para = new Y.Map();
            para.set('sys:id', paragraphId);
            para.set('sys:flavour', 'affine:paragraph');
            para.set('sys:parent', noteId);
            para.set('sys:children', new Y.Array());
            para.set('prop:type', 'text');
            const ptext = new Y.Text();
            ptext.insert(0, parsed.text);
            para.set('prop:text', ptext);
            blocks.set(paragraphId, para);
            const note = blocks.get(noteId);
            const noteChildren = note.get('sys:children');
            noteChildren.push([paragraphId]);
            const delta = Y.encodeStateAsUpdate(doc, prevSV);
            const deltaB64 = Buffer.from(delta).toString('base64');
            await pushDocUpdate(socket, workspaceId, parsed.docId, deltaB64);
            return text({ appended: true, paragraphId });
        }
        finally {
            socket.disconnect();
        }
    };
    server.registerTool('append_paragraph', {
        title: 'Append Paragraph',
        description: 'Append a text paragraph block to a document',
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            text: z.string(),
        },
    }, appendParagraphHandler);
    server.registerTool('affine_append_paragraph', {
        title: 'Append Paragraph',
        description: 'Append a text paragraph block to a document',
        inputSchema: {
            workspaceId: z.string().optional(),
            docId: z.string(),
            text: z.string(),
        },
    }, appendParagraphHandler);
    // DELETE DOC
    const deleteDocHandler = async (parsed) => {
        const workspaceId = parsed.workspaceId || defaults.workspaceId;
        if (!workspaceId)
            throw new Error('workspaceId is required');
        const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
            await joinWorkspace(socket, workspaceId);
            // remove from workspace pages
            const wsDoc = new Y.Doc();
            const snapshot = await loadDoc(socket, workspaceId, workspaceId);
            if (snapshot.missing)
                Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
            const prevSV = Y.encodeStateVector(wsDoc);
            const wsMeta = wsDoc.getMap('meta');
            const pages = wsMeta.get('pages');
            if (pages) {
                // find by id
                let idx = -1;
                pages.forEach((m, i) => {
                    if (idx >= 0)
                        return;
                    if (m.get && m.get('id') === parsed.docId)
                        idx = i;
                });
                if (idx >= 0)
                    pages.delete(idx, 1);
            }
            const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
            await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString('base64'));
            // delete doc content
            wsDeleteDoc(socket, workspaceId, parsed.docId);
            return text({ deleted: true });
        }
        finally {
            socket.disconnect();
        }
    };
    server.registerTool('delete_doc', {
        title: 'Delete Document',
        description: 'Delete a document and remove from workspace list',
        inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    }, deleteDocHandler);
    server.registerTool('affine_delete_doc', {
        title: 'Delete Document',
        description: 'Delete a document and remove from workspace list',
        inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    }, deleteDocHandler);
}
