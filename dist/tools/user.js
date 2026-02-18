import { text } from "../util/mcp.js";
export function registerUserTools(server, gql) {
    const currentUserHandler = async () => {
        const query = `query Me { currentUser { id name email emailVerified avatarUrl disabled } }`;
        const data = await gql.request(query);
        return text(data.currentUser);
    };
    server.registerTool("current_user", {
        title: "Current User",
        description: "Get current signed-in user.",
        inputSchema: {}
    }, currentUserHandler);
}
