import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerAccessTokenTools(server, gql) {
    const listAccessTokensHandler = async () => {
        try {
            const query = `query { currentUser { accessTokens { id name createdAt expiresAt } } }`;
            const data = await gql.request(query);
            return text(data.currentUser?.accessTokens || []);
        }
        catch (error) {
            console.error("List access tokens error:", error.message);
            return text({ error: error.message });
        }
    };
    server.registerTool("list_access_tokens", {
        title: "List Access Tokens",
        description: "List personal access tokens (metadata).",
        inputSchema: {}
    }, listAccessTokensHandler);
    const generateAccessTokenHandler = async (parsed) => {
        const mutation = `mutation($input: GenerateAccessTokenInput!){ generateUserAccessToken(input:$input){ id name createdAt expiresAt token } }`;
        const data = await gql.request(mutation, { input: { name: parsed.name, expiresAt: parsed.expiresAt ?? null } });
        return text(data.generateUserAccessToken);
    };
    server.registerTool("generate_access_token", {
        title: "Generate Access Token",
        description: "Generate a personal access token (returns token).",
        inputSchema: {
            name: z.string(),
            expiresAt: z.string().optional()
        }
    }, generateAccessTokenHandler);
    const revokeAccessTokenHandler = async (parsed) => {
        const mutation = `mutation($id:String!){ revokeUserAccessToken(id:$id) }`;
        const data = await gql.request(mutation, { id: parsed.id });
        return text({ success: data.revokeUserAccessToken });
    };
    server.registerTool("revoke_access_token", {
        title: "Revoke Access Token",
        description: "Revoke a personal access token by id.",
        inputSchema: {
            id: z.string()
        }
    }, revokeAccessTokenHandler);
}
