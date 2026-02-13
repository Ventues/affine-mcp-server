import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerNotificationTools(server, gql) {
    // LIST NOTIFICATIONS
    const listNotificationsHandler = async ({ first = 20, offset, after, unreadOnly = false }) => {
        try {
            const query = `
        query GetNotifications($pagination: PaginationInput!) {
          currentUser {
            notifications(pagination: $pagination) {
              edges {
                cursor
                node {
                  id
                  type
                  body
                  read
                  level
                  createdAt
                  updatedAt
                }
              }
              totalCount
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      `;
            const data = await gql.request(query, {
                pagination: {
                    first,
                    offset,
                    after
                }
            });
            let notifications = (data.currentUser?.notifications?.edges || []).map((edge) => edge.node);
            if (unreadOnly) {
                notifications = notifications.filter((n) => !n.read);
            }
            return text(notifications);
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("list_notifications", {
        title: "List Notifications",
        description: "Get user notifications.",
        inputSchema: {
            first: z.number().optional().describe("Number of notifications to fetch"),
            offset: z.number().optional().describe("Offset for pagination"),
            after: z.string().optional().describe("Cursor for pagination"),
            unreadOnly: z.boolean().optional().describe("Show only unread notifications")
        }
    }, listNotificationsHandler);
    // MARK ALL NOTIFICATIONS READ
    const readAllNotificationsHandler = async () => {
        try {
            const mutation = `
        mutation ReadAllNotifications {
          readAllNotifications
        }
      `;
            const data = await gql.request(mutation);
            return text({ success: data.readAllNotifications, message: "All notifications marked as read" });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("read_all_notifications", {
        title: "Mark All Notifications Read",
        description: "Mark all notifications as read.",
        inputSchema: {}
    }, readAllNotificationsHandler);
}
