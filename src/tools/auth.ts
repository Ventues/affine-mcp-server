import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";

export function registerAuthTools(_server: McpServer, _gql: GraphQLClient, _baseUrl: string) {
  // Auth tools removed — agents should authenticate via token/cookie, not interactive login
}
