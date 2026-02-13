import { z } from "zod";
import { text } from "../util/mcp.js";
import FormData from "form-data";
import fetch from "node-fetch";
function decodeBlobContent(content) {
    const normalized = content.trim().replace(/\s+/g, "");
    const base64Like = normalized.length > 0 && normalized.length % 4 === 0 && /^[A-Za-z0-9+/=]+$/.test(normalized);
    if (base64Like) {
        try {
            const decoded = Buffer.from(normalized, "base64");
            if (decoded.length > 0) {
                return decoded;
            }
        }
        catch {
            // Fallback to UTF-8 text below.
        }
    }
    return Buffer.from(content, "utf8");
}
export function registerBlobTools(server, gql) {
    // UPLOAD BLOB/FILE
    const uploadBlobHandler = async ({ workspaceId, content, filename, contentType }) => {
        try {
            const endpoint = gql.endpoint;
            const authHeaders = gql.getAuthHeaders();
            const payload = decodeBlobContent(content);
            const safeFilename = filename || `blob-${Date.now()}.bin`;
            const mime = contentType || "application/octet-stream";
            const form = new FormData();
            form.append("operations", JSON.stringify({
                query: `mutation SetBlob($workspaceId: String!, $blob: Upload!) {
          setBlob(workspaceId: $workspaceId, blob: $blob)
        }`,
                variables: {
                    workspaceId,
                    blob: null
                }
            }));
            form.append("map", JSON.stringify({ "0": ["variables.blob"] }));
            form.append("0", payload, { filename: safeFilename, contentType: mime });
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    ...authHeaders,
                    ...form.getHeaders(),
                },
                body: form,
            });
            const result = await response.json();
            if (result.errors?.length) {
                throw new Error(result.errors[0].message);
            }
            const blobKey = result.data?.setBlob;
            if (!blobKey) {
                throw new Error("Upload succeeded but no blob key was returned.");
            }
            return text({
                id: blobKey,
                key: blobKey,
                workspaceId,
                filename: safeFilename,
                contentType: mime,
                size: payload.length,
                uploadedAt: new Date().toISOString()
            });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("upload_blob", {
        title: "Upload Blob",
        description: "Upload a file or blob to workspace storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID"),
            content: z.string().describe("Base64 encoded content or text"),
            filename: z.string().optional().describe("Filename"),
            contentType: z.string().optional().describe("MIME type")
        }
    }, uploadBlobHandler);
    // DELETE BLOB
    const deleteBlobHandler = async ({ workspaceId, key, permanently = false }) => {
        try {
            const mutation = `
        mutation DeleteBlob($workspaceId: String!, $key: String!, $permanently: Boolean) {
          deleteBlob(workspaceId: $workspaceId, key: $key, permanently: $permanently)
        }
      `;
            const data = await gql.request(mutation, {
                workspaceId,
                key,
                permanently
            });
            return text({ success: data.deleteBlob, key, workspaceId, permanently });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("delete_blob", {
        title: "Delete Blob",
        description: "Delete a blob/file from workspace storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID"),
            key: z.string().describe("Blob key/ID to delete"),
            permanently: z.boolean().optional().describe("Delete permanently")
        }
    }, deleteBlobHandler);
    // RELEASE DELETED BLOBS
    const cleanupBlobsHandler = async ({ workspaceId }) => {
        try {
            const mutation = `
        mutation ReleaseDeletedBlobs($workspaceId: String!) {
          releaseDeletedBlobs(workspaceId: $workspaceId)
        }
      `;
            const data = await gql.request(mutation, {
                workspaceId
            });
            return text({ success: true, workspaceId, blobsReleased: data.releaseDeletedBlobs });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("cleanup_blobs", {
        title: "Cleanup Deleted Blobs",
        description: "Permanently remove deleted blobs to free up storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID")
        }
    }, cleanupBlobsHandler);
}
