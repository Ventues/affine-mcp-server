import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerUserCRUDTools(server, gql) {
    // UPDATE PROFILE
    const updateProfileHandler = async ({ name, avatarUrl }) => {
        try {
            const mutation = `
        mutation UpdateProfile($input: UpdateUserInput!) {
          updateProfile(input: $input) {
            id
            name
            avatarUrl
            email
          }
        }
      `;
            const input = {};
            if (name !== undefined)
                input.name = name;
            if (avatarUrl !== undefined)
                input.avatarUrl = avatarUrl;
            const data = await gql.request(mutation, { input });
            return text(data.updateProfile);
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("update_profile", {
        title: "Update Profile",
        description: "Update current user's profile information.",
        inputSchema: {
            name: z.string().optional().describe("Display name"),
            avatarUrl: z.string().optional().describe("Avatar URL")
        }
    }, updateProfileHandler);
    // UPDATE SETTINGS
    const updateSettingsHandler = async ({ settings }) => {
        try {
            const mutation = `
        mutation UpdateSettings($input: UpdateUserSettingsInput!) {
          updateSettings(input: $input) {
            success
          }
        }
      `;
            const data = await gql.request(mutation, {
                input: settings
            });
            return text(data.updateSettings);
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("update_settings", {
        title: "Update Settings",
        description: "Update user settings and preferences.",
        inputSchema: {
            settings: z.record(z.any()).describe("Settings object with key-value pairs")
        }
    }, updateSettingsHandler);
}
