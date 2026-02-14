import { connectWorkspaceSocket, joinWorkspace, loadDoc, wsUrlFromGraphQLEndpoint } from "./dist/ws.js";

const WORKSPACE_ID = "2f5e4d55-7ba8-4db2-95c8-56f56da7631f";
const DOC_ID = "atKRm0M2LV";
const TOKEN = "ut_-PJ4kqIbxlddBS8ZgtqlOxg4blUipt_-Mb4ky8_qVhY";

async function test() {
  console.time("Total");
  
  console.time("Connect");
  const socket = await connectWorkspaceSocket("wss://affine.workisboring.com", {
    Authorization: `Bearer ${TOKEN}`
  });
  console.timeEnd("Connect");
  
  console.time("Join");
  await joinWorkspace(socket, WORKSPACE_ID);
  console.timeEnd("Join");
  
  console.time("Load doc");
  const docData = await loadDoc(socket, WORKSPACE_ID, DOC_ID);
  console.timeEnd("Load doc");
  
  console.log("Missing size:", docData.missing ? Buffer.from(docData.missing, 'base64').length : 0, "bytes");
  console.log("State size:", docData.state ? Buffer.from(docData.state, 'base64').length : 0, "bytes");
  
  socket.disconnect();
  console.timeEnd("Total");
}

test();
