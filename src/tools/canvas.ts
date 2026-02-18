import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
import * as Y from "yjs";
import dagre from "@dagrejs/dagre";

const WorkspaceId = z.string().min(1);
const DocId = z.string().min(1);

export function registerCanvasTools(server: McpServer, gql: GraphQLClient, defaults: any) {
  function getEndpointAndAuthHeaders() {
    return { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
  }

  function generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let id = '';
    for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  function findSurfaceBlock(blocks: Y.Map<any>): Y.Map<any> | null {
    for (const [, block] of blocks) {
      if (block instanceof Y.Map && block.get('sys:flavour') === 'affine:surface') return block;
    }
    return null;
  }

  function findBlockByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
    for (const [id, block] of blocks) {
      if (block instanceof Y.Map && block.get('sys:flavour') === flavour) return id;
    }
    return null;
  }

  function getSurfaceElementsMap(blocks: Y.Map<any>): Y.Map<any> {
    let surface = findSurfaceBlock(blocks);
    if (!surface) {
      const pageId = findBlockByFlavour(blocks, 'affine:page');
      if (!pageId) throw new Error('No page block');
      const surfaceId = generateId();
      surface = new Y.Map<any>();
      surface.set('sys:id', surfaceId);
      surface.set('sys:flavour', 'affine:surface');
      surface.set('sys:version', 5);
      surface.set('sys:parent', pageId);
      surface.set('sys:children', new Y.Array<string>());
      const elements = new Y.Map<any>();
      elements.set('type', '$blocksuite:internal:native$');
      elements.set('value', new Y.Map<any>());
      surface.set('prop:elements', elements);
      blocks.set(surfaceId, surface);
      const page = blocks.get(pageId) as Y.Map<any>;
      const children = page.get('sys:children') as Y.Array<string>;
      children.push([surfaceId]);
    }
    const elementsOuter = surface.get('prop:elements') as Y.Map<any>;
    return elementsOuter.get('value') as Y.Map<any>;
  }

  async function addShape(args: any) {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const { docId, shapeType, x, y, width, height, text: textContent } = args;
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const elementsMap = getSurfaceElementsMap(blocks);
      
      const elementId = generateId();
      const element = new Y.Map<any>();
      element.set('type', 'shape');
      element.set('id', elementId);
      element.set('index', 'a0');
      element.set('seed', Math.floor(Math.random() * 1000000));
      element.set('shapeType', shapeType);
      element.set('xywh', `[${x},${y},${width},${height}]`);
      element.set('radius', 0);
      element.set('filled', true);
      element.set('fillColor', '--affine-palette-shape-yellow');
      element.set('strokeColor', '--affine-palette-shape-yellow');
      element.set('strokeWidth', 4);
      element.set('strokeStyle', 'solid');
      element.set('shapeStyle', 'General');
      element.set('roughness', 1.4);
      element.set('rotate', 0);
      element.set('textHorizontalAlign', 'center');
      element.set('textVerticalAlign', 'center');
      
      if (textContent) {
        const yText = new Y.Text();
        yText.insert(0, textContent);
        element.set('text', yText);
      }
      
      elementsMap.set(elementId, element);
      
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString("base64"));
      return text(`Shape added with ID: ${elementId}`);
    } finally {
      socket.disconnect();
    }
  }

  async function addConnector(args: any) {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const { docId, sourceId, targetId, mode, text: textContent } = args;
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const elementsMap = getSurfaceElementsMap(blocks);
      
      const elementId = generateId();
      const element = new Y.Map<any>();
      element.set('type', 'connector');
      element.set('id', elementId);
      element.set('index', 'a0');
      element.set('seed', Math.floor(Math.random() * 1000000));
      element.set('mode', mode || 0);
      element.set('xywh', '[0,0,0,0]');
      element.set('stroke', '--affine-palette-line-grey');
      element.set('strokeWidth', 2);
      element.set('strokeStyle', 'solid');
      element.set('roughness', 1.4);
      element.set('source', { id: sourceId });
      element.set('target', { id: targetId });
      element.set('frontEndpointStyle', 'None');
      element.set('rearEndpointStyle', 'Arrow');
      element.set('rotate', 0);
      
      if (textContent) {
        const yText = new Y.Text();
        yText.insert(0, textContent);
        element.set('text', yText);
      }
      
      elementsMap.set(elementId, element);
      
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString("base64"));
      return text(`Connector added with ID: ${elementId}`);
    } finally {
      socket.disconnect();
    }
  }

  async function addCanvasText(args: any) {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const { docId, x, y, width, height, text: textContent } = args;
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const elementsMap = getSurfaceElementsMap(blocks);
      
      const elementId = generateId();
      const element = new Y.Map<any>();
      element.set('type', 'text');
      element.set('id', elementId);
      element.set('index', 'a0');
      element.set('seed', Math.floor(Math.random() * 1000000));
      element.set('xywh', `[${x},${y},${width},${height}]`);
      element.set('color', '--affine-palette-line-black');
      element.set('fontSize', 24);
      element.set('fontFamily', 'blocksuite:surface:Inter');
      element.set('fontWeight', '400');
      element.set('fontStyle', 'normal');
      element.set('textAlign', 'left');
      element.set('rotate', 0);
      element.set('hasMaxWidth', false);
      
      const yText = new Y.Text();
      yText.insert(0, textContent);
      element.set('text', yText);
      
      elementsMap.set(elementId, element);
      
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString("base64"));
      return text(`Text element added with ID: ${elementId}`);
    } finally {
      socket.disconnect();
    }
  }

  async function listCanvasElements(args: any) {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const { docId } = args;
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const surface = findSurfaceBlock(blocks);
      if (!surface) return text("No canvas elements found");
      
      const elementsOuter = surface.get('prop:elements') as Y.Map<any>;
      const elementsMap = elementsOuter.get('value') as Y.Map<any>;
      const elements = [];
      
      for (const [id, element] of elementsMap) {
        if (element instanceof Y.Map) {
          elements.push({
            id,
            type: element.get('type'),
            xywh: element.get('xywh'),
            text: element.get('text')?.toString() || null
          });
        }
      }
      
      return text(JSON.stringify(elements, null, 2));
    } finally {
      socket.disconnect();
    }
  }

  async function buildGraph(args: any) {
    const workspaceId = args.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");
    const { docId, nodes, edges } = args;
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }
      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const elementsMap = getSurfaceElementsMap(blocks);

      // Compute layout with dagre unless all nodes have explicit positions
      const allHavePositions = nodes.every((n: any) => n.x !== undefined && n.y !== undefined);
      const positions: Array<{ x: number; y: number }> = [];

      if (allHavePositions) {
        for (const node of nodes) positions.push({ x: node.x, y: node.y });
      } else {
        const g = new dagre.graphlib.Graph();
        g.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 80, marginx: 20, marginy: 20 });
        g.setDefaultEdgeLabel(() => ({}));
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          g.setNode(String(i), { width: n.width || 120, height: n.height || 80 });
        }
        for (const edge of edges) {
          g.setEdge(String(edge.from), String(edge.to));
        }
        dagre.layout(g);
        for (let i = 0; i < nodes.length; i++) {
          const laid = g.node(String(i));
          const w = nodes[i].width || 120;
          const h = nodes[i].height || 80;
          // dagre returns center coords; convert to top-left
          positions.push({ x: laid.x - w / 2, y: laid.y - h / 2 });
        }
      }

      // Add nodes
      const nodeIds: string[] = [];
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const elementId = generateId();
        const element = new Y.Map<any>();
        const w = node.width || 120;
        const h = node.height || 80;

        element.set('type', 'shape');
        element.set('id', elementId);
        element.set('index', 'a0');
        element.set('seed', Math.floor(Math.random() * 1000000));
        element.set('shapeType', node.shapeType || 'rect');
        element.set('xywh', `[${positions[i].x},${positions[i].y},${w},${h}]`);
        element.set('radius', 0);
        element.set('filled', true);
        element.set('fillColor', '--affine-palette-shape-yellow');
        element.set('strokeColor', '--affine-palette-shape-yellow');
        element.set('strokeWidth', 4);
        element.set('strokeStyle', 'solid');
        element.set('shapeStyle', 'General');
        element.set('roughness', 1.4);
        element.set('rotate', 0);
        element.set('textHorizontalAlign', 'center');
        element.set('textVerticalAlign', 'center');

        if (node.text) {
          const yText = new Y.Text();
          yText.insert(0, node.text);
          element.set('text', yText);
        }

        elementsMap.set(elementId, element);
        nodeIds.push(elementId);
      }

      // Add edges
      for (const edge of edges) {
        const sourceId = nodeIds[edge.from];
        const targetId = nodeIds[edge.to];
        if (!sourceId || !targetId) continue;

        const elementId = generateId();
        const element = new Y.Map<any>();
        element.set('type', 'connector');
        element.set('id', elementId);
        element.set('index', 'a0');
        element.set('seed', Math.floor(Math.random() * 1000000));
        element.set('mode', edge.mode ?? 1);
        element.set('xywh', '[0,0,0,0]');
        element.set('stroke', '--affine-palette-line-grey');
        element.set('strokeWidth', 2);
        element.set('strokeStyle', 'solid');
        element.set('roughness', 1.4);
        element.set('source', { id: sourceId });
        element.set('target', { id: targetId });
        element.set('frontEndpointStyle', 'None');
        element.set('rearEndpointStyle', 'Arrow');
        element.set('rotate', 0);

        if (edge.text) {
          const yText = new Y.Text();
          yText.insert(0, edge.text);
          element.set('text', yText);
        }

        elementsMap.set(elementId, element);
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, docId, Buffer.from(delta).toString("base64"));
      return text(`Graph created with ${nodes.length} nodes and ${edges.length} edges`);
    } finally {
      socket.disconnect();
    }
  }

  const addShapeMeta = {
    title: "Add Shape to Canvas",
    description: "Add a shape element to the Edgeless canvas.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      shapeType: z.enum(["rect", "ellipse", "diamond", "triangle"]).describe("Shape type"),
      x: z.number().describe("X position"),
      y: z.number().describe("Y position"),
      width: z.number().describe("Width"),
      height: z.number().describe("Height"),
      text: z.string().optional().describe("Text inside the shape"),
    },
  };
  server.registerTool("add_shape", addShapeMeta, addShape as any);

  const addConnectorMeta = {
    title: "Add Connector to Canvas",
    description: "Connect two elements on the canvas.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      sourceId: z.string().min(1).describe("Source element ID"),
      targetId: z.string().min(1).describe("Target element ID"),
      mode: z.number().int().min(0).max(2).optional().describe("0=Straight, 1=Orthogonal, 2=Curve"),
      text: z.string().optional().describe("Label on the connector"),
    },
  };
  server.registerTool("add_connector", addConnectorMeta, addConnector as any);

  const addCanvasTextMeta = {
    title: "Add Text to Canvas",
    description: "Add standalone text element on canvas.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      x: z.number().describe("X position"),
      y: z.number().describe("Y position"),
      width: z.number().describe("Width"),
      height: z.number().describe("Height"),
      text: z.string().min(1).describe("Text content"),
    },
  };
  server.registerTool("add_canvas_text", addCanvasTextMeta, addCanvasText as any);

  const listCanvasElementsMeta = {
    title: "List Canvas Elements",
    description: "List all elements on the Edgeless canvas with their types, positions, and IDs.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
    },
  };
  server.registerTool("list_canvas_elements", listCanvasElementsMeta, listCanvasElements as any);

  const buildGraphMeta = {
    title: "Build Graph",
    description: "Create a complete graph/diagram in one call with auto-layout. Nodes are shapes, edges are connectors.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      nodes: z.array(z.object({
        text: z.string().optional(),
        shapeType: z.enum(["rect", "ellipse", "diamond", "triangle"]).optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
      })).describe("Array of node definitions"),
      edges: z.array(z.object({
        from: z.number().int().describe("Source node index"),
        to: z.number().int().describe("Target node index"),
        text: z.string().optional(),
        mode: z.number().int().min(0).max(2).optional(),
      })).describe("Array of edge definitions (from/to are node indices)"),
    },
  };
  server.registerTool("build_graph", buildGraphMeta, buildGraph as any);
}