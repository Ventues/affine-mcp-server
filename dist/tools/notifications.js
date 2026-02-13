import { z } from "zod";
import { text } from "../util/mcp.js";
export function registerNotificationTools(server, gql) {
    // LIST NOTIFICATIONS
    const listNotificationsHandler = async ({ first = 20, unreadOnly = false }) => {
        try {
            const query = `
        query GetNotifications($first: Int!) {
          currentUser {
            notifications(first: $first) {
              nodes {
                id
                type
                title
                body
                read
                createdAt
              }
              totalCount
              pageInfo {
                hasNextPage
              }
            }
          }
        }
      `;
            const data = await gql.request(query, { first });
            let notifications = data.currentUser?.notifications?.nodes || [];
            if (unreadOnly) {
                notifications = notifications.filter((n) => !n.read);
            }
            return text(notifications);
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("affine_list_notifications", {
        title: "List Notifications",
        description: "Get user notifications.",
        inputSchema: {
            first: z.number().optional().describe("Number of notifications to fetch"),
            unreadOnly: z.boolean().optional().describe("Show only unread notifications")
        }
    }, listNotificationsHandler);
    server.registerTool("list_notifications", {
        title: "List Notifications",
        description: "Get user notifications.",
        inputSchema: {
            first: z.number().optional().describe("Number of notifications to fetch"),
            unreadOnly: z.boolean().optional().describe("Show only unread notifications")
        }
    }, listNotificationsHandler);
    // MARK NOTIFICATION AS READ
    const readNotificationHandler = async ({ id }) => {
        try {
            const mutation = `
        mutation ReadNotification($id: String!) {
          readNotification(id: $id)
        }
      `;
            const data = await gql.request(mutation, { id });
            return text({ success: data.readNotification, notificationId: id });
        }
        catch (error) {
            return text({ error: error.message });
        }
    };
    server.registerTool("affine_read_notification", {
        title: "Mark Notification Read",
        description: "Mark a notification as read.",
        inputSchema: {
            id: z.string().describe("Notification ID")
        }
    }, readNotificationHandler);
    server.registerTool("read_notification", {
        title: "Mark Notification Read",
        description: "Mark a notification as read.",
        inputSchema: {
            id: z.string().describe("Notification ID")
        }
    }, readNotificationHandler);
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
    server.registerTool("affine_read_all_notifications", {
        title: "Mark All Notifications Read",
        description: "Mark all notifications as read.",
        inputSchema: {}
    }, readAllNotificationsHandler);
    server.registerTool("read_all_notifications", {
        title: "Mark All Notifications Read",
        description: "Mark all notifications as read.",
        inputSchema: {}
    }, readAllNotificationsHandler);
}
