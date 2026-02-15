#!/usr/bin/env node
import { GraphQLClient } from './dist/graphqlClient.js';
import { connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, wsUrlFromGraphQLEndpoint } from './dist/ws.js';
import * as Y from 'yjs';

const GRAPHQL_ENDPOINT = process.env.AFFINE_BASE_URL ? `${process.env.AFFINE_BASE_URL}/graphql` : 'https://app.affine.pro/graphql';
const API_TOKEN = process.env.AFFINE_API_TOKEN;
const WORKSPACE_ID = process.env.AFFINE_WORKSPACE_ID;
const DOC_ID = 'atKRm0M2LV';
const BLOCK_ID = 'glz8cLVGWu';
const BLOCK_TEXT = 'hihi';
const SELECTED_TEXT = 'hihi';

async function timeOperation(name, fn) {
  const start = Date.now();
  const result = await fn();
  const duration = Date.now() - start;
  console.log(`${name}: ${duration}ms`);
  return result;
}

async function main() {
  const totalStart = Date.now();
  
  // Setup client with token
  const gql = new GraphQLClient({ endpoint: GRAPHQL_ENDPOINT, bearer: API_TOKEN });

  // Create comment via GraphQL
  const commentId = await timeOperation('GraphQL createComment', async () => {
    const mutation = `mutation CreateComment($input: CommentCreateInput!){ createComment(input:$input){ id content createdAt updatedAt resolved } }`;
    const content = {
      mode: 'page',
      preview: SELECTED_TEXT,
      snapshot: {
        meta: { id: `comment-${Date.now()}`, tags: [], title: "", createDate: Date.now() },
        type: "page",
        blocks: {
          id: `comment-${Date.now()}`,
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
              edgeless: { style: { borderSize: 4, shadowType: "--affine-note-shadow-box", borderStyle: "none", borderRadius: 8 } },
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
                text: { delta: [{ insert: "Timing test comment" }], "$blocksuite:internal:text$": true },
                collapsed: false
              },
              children: []
            }]
          }]
        }
      },
      attachments: []
    };
    const input = { content, docId: DOC_ID, workspaceId: WORKSPACE_ID, docTitle: "", docMode: 'page' };
    const data = await gql.request(mutation, { input });
    return data.createComment.id;
  });

  console.log(`\nApplying formatting for comment: ${commentId}`);

  // WebSocket operations
  const wsUrl = wsUrlFromGraphQLEndpoint(GRAPHQL_ENDPOINT);
  
  const socket = await timeOperation('Connect WebSocket', async () => {
    return await connectWorkspaceSocket(wsUrl, gql.getAuthHeaders());
  });

  await timeOperation('Join workspace', async () => {
    await joinWorkspace(socket, WORKSPACE_ID);
  });

  const docData = await timeOperation('Load document', async () => {
    return await loadDoc(socket, WORKSPACE_ID, DOC_ID);
  });

  const ydoc = await timeOperation('Apply Y.js updates', async () => {
    const ydoc = new Y.Doc();
    if (docData.missing) {
      const stateUpdate = Buffer.from(docData.missing, 'base64');
      Y.applyUpdate(ydoc, stateUpdate);
    }
    return ydoc;
  });

  await timeOperation('Find block and format text', async () => {
    const blocks = ydoc.getMap('blocks');
    const block = blocks.get(BLOCK_ID);
    const text = block.get('prop:text');
    const textContent = text.toString();
    const startIndex = textContent.indexOf(SELECTED_TEXT);
    text.format(startIndex, SELECTED_TEXT.length, { [`comment-${commentId}`]: true });
  });

  await timeOperation('Push update', async () => {
    const update = Y.encodeStateAsUpdate(ydoc);
    const updateBase64 = Buffer.from(update).toString('base64');
    await pushDocUpdate(socket, WORKSPACE_ID, DOC_ID, updateBase64);
  });

  socket.disconnect();

  const totalDuration = Date.now() - totalStart;
  console.log(`\n=== TOTAL TIME: ${totalDuration}ms ===`);
}

main().catch(console.error);
