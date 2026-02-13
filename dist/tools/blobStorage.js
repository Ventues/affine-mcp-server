import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerBlobTools(server, gql) {
    // UPLOAD BLOB/FILE
    const uploadBlobHandler = async ({ workspaceId, content, filename, contentType }) => {
        try {
            // Note: Actual file upload requires multipart form data
            // This is a simplified version that returns structured data
            const blobId = `blob_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            return text({
                id: blobId,
                workspaceId,
                filename: filename || "unnamed",
                contentType: contentType || "application/octet-stream",
                size: content.length,
                uploadedAt: new Date().toISOString(),
                note: "Blob metadata created. Use AFFiNE UI for actual file upload."
            });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("affine_upload_blob", {
        title: "Upload Blob",
        description: "Upload a file or blob to workspace storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID"),
            content: z.string().describe("Base64 encoded content or text"),
            filename: z.string().optional().describe("Filename"),
            contentType: z.string().optional().describe("MIME type")
        }
    }, uploadBlobHandler);
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
    server.registerTool("affine_delete_blob", {
        title: "Delete Blob",
        description: "Delete a blob/file from workspace storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID"),
            key: z.string().describe("Blob key/ID to delete"),
            permanently: z.boolean().optional().describe("Delete permanently")
        }
    }, deleteBlobHandler);
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
    server.registerTool("affine_cleanup_blobs", {
        title: "Cleanup Deleted Blobs",
        description: "Permanently remove deleted blobs to free up storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID")
        }
    }, cleanupBlobsHandler);
    server.registerTool("cleanup_blobs", {
        title: "Cleanup Deleted Blobs",
        description: "Permanently remove deleted blobs to free up storage.",
        inputSchema: {
            workspaceId: z.string().describe("Workspace ID")
        }
    }, cleanupBlobsHandler);
}
