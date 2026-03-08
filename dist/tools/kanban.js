import { z } from "zod";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate } from "../ws.js";
import * as Y from "yjs";
const WorkspaceId = z.string().min(1);
const DocId = z.string().min(1);
const TAG_COLORS = [
    "var(--affine-tag-gray)", "var(--affine-tag-blue)", "var(--affine-tag-green)",
    "var(--affine-tag-red)", "var(--affine-tag-orange)", "var(--affine-tag-yellow)",
    "var(--affine-tag-purple)", "var(--affine-tag-teal)",
];
export function registerKanbanTools(server, gql, defaults) {
    function getEndpointAndAuthHeaders() {
        return { endpoint: gql.endpoint, authHeaders: gql.getAuthHeaders() };
    }
    function hexId() {
        let id = "";
        for (let i = 0; i < 10; i++)
            id += Math.floor(Math.random() * 16).toString(16);
        return id;
    }
    function findBlockByFlavour(blocks, flavour) {
        for (const [id, block] of blocks) {
            if (block instanceof Y.Map && block.get("sys:flavour") === flavour)
                return id;
        }
        return null;
    }
    function findNoteBlock(blocks) {
        return findBlockByFlavour(blocks, "affine:note");
    }
    function buildSelectColumn(name, options) {
        const colId = hexId();
        const optionMap = {};
        const opts = options.map((value, i) => {
            const optId = hexId();
            optionMap[value] = optId;
            return { id: optId, value, color: TAG_COLORS[i % TAG_COLORS.length] };
        });
        return { col: { id: colId, type: "select", name, data: { options: opts } }, optionMap };
    }
    async function withDoc(args, fn) {
        const workspaceId = args.workspaceId || defaults.workspaceId;
        if (!workspaceId)
            throw new Error("workspaceId is required");
        const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
        const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
        const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
        try {
            await joinWorkspace(socket, workspaceId);
            const doc = new Y.Doc();
            const snapshot = await loadDoc(socket, workspaceId, args.docId);
            if (snapshot.missing)
                Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
            const prevSV = Y.encodeStateVector(doc);
            const blocks = doc.getMap("blocks");
            const result = fn(doc, blocks);
            const delta = Y.encodeStateAsUpdate(doc, prevSV);
            await pushDocUpdate(socket, workspaceId, args.docId, Buffer.from(delta).toString("base64"));
            return result;
        }
        finally {
            socket.disconnect();
        }
    }
    // ── create_kanban_board ───────────────────────────────────────────────
    async function createKanbanBoard(args) {
        const { title, statuses = ["Todo", "In Progress", "Done"], assignees, priorities } = args;
        return withDoc(args, (_doc, blocks) => {
            const noteId = findNoteBlock(blocks);
            if (!noteId)
                throw new Error("No note block found in document");
            const dbId = hexId();
            const dbBlock = new Y.Map();
            dbBlock.set("sys:id", dbId);
            dbBlock.set("sys:flavour", "affine:database");
            dbBlock.set("sys:version", 1);
            dbBlock.set("sys:parent", noteId);
            dbBlock.set("sys:children", new Y.Array());
            const titleText = new Y.Text();
            titleText.insert(0, title);
            dbBlock.set("prop:title", titleText);
            // Columns
            const { col: statusCol, optionMap: statusOptions } = buildSelectColumn("Status", statuses);
            const allColumns = [statusCol];
            if (assignees?.length)
                allColumns.push(buildSelectColumn("Assignee", assignees).col);
            if (priorities?.length)
                allColumns.push(buildSelectColumn("Priority", priorities).col);
            const yColumns = new Y.Array();
            for (const c of allColumns)
                yColumns.push([c]);
            dbBlock.set("prop:columns", yColumns);
            // Cells (empty initially)
            dbBlock.set("prop:cells", new Y.Map());
            // View
            const viewId = hexId();
            const view = {
                id: viewId,
                name: "Kanban View",
                mode: "kanban",
                columns: allColumns.map(c => ({ id: c.id, hide: false })),
                filter: { type: "group", op: "and", conditions: [] },
                groupBy: { type: "groupBy", columnId: statusCol.id, name: "Status" },
                header: { titleColumn: undefined, iconColumn: "type" },
                groupProperties: statusCol.data.options.map((o) => ({
                    key: o.id, hide: false, manuallyCardSort: [],
                })),
            };
            const yViews = new Y.Array();
            yViews.push([view]);
            dbBlock.set("prop:views", yViews);
            blocks.set(dbId, dbBlock);
            // Add database to note's children
            const note = blocks.get(noteId);
            note.get("sys:children").push([dbId]);
            return text(JSON.stringify({ databaseBlockId: dbId, statusColumnId: statusCol.id, statusOptions }));
        });
    }
    // ── add_kanban_card ───────────────────────────────────────────────────
    async function addKanbanCard(args) {
        const { databaseBlockId, title: cardTitle, status, assignee, priority } = args;
        return withDoc(args, (_doc, blocks) => {
            const dbBlock = blocks.get(databaseBlockId);
            if (!dbBlock)
                throw new Error(`Database block ${databaseBlockId} not found`);
            const cardId = hexId();
            const cardBlock = new Y.Map();
            cardBlock.set("sys:id", cardId);
            cardBlock.set("sys:flavour", "affine:paragraph");
            cardBlock.set("sys:version", 1);
            cardBlock.set("sys:parent", databaseBlockId);
            cardBlock.set("sys:children", new Y.Array());
            const cardText = new Y.Text();
            cardText.insert(0, cardTitle);
            cardBlock.set("prop:text", cardText);
            cardBlock.set("prop:type", "text");
            blocks.set(cardId, cardBlock);
            // Add to database children
            dbBlock.get("sys:children").push([cardId]);
            // Resolve columns and set cells
            const columns = dbBlock.get("prop:columns");
            const cells = dbBlock.get("prop:cells");
            const fieldMap = { Status: status, Assignee: assignee, Priority: priority };
            for (let i = 0; i < columns.length; i++) {
                const col = columns.get(i);
                const label = fieldMap[col.name];
                if (!label)
                    continue;
                const option = col.data?.options?.find((o) => o.value === label);
                if (!option)
                    continue; // gracefully skip unknown labels
                if (!cells.has(cardId))
                    cells.set(cardId, new Y.Map());
                cells.get(cardId).set(col.id, new Y.Map([['columnId', col.id], ['value', option.id]]));
            }
            return text(JSON.stringify({ cardBlockId: cardId }));
        });
    }
    // ── move_kanban_card ──────────────────────────────────────────────────
    async function moveKanbanCard(args) {
        const { databaseBlockId, cardBlockId, newStatus } = args;
        return withDoc(args, (_doc, blocks) => {
            const dbBlock = blocks.get(databaseBlockId);
            if (!dbBlock)
                throw new Error(`Database block ${databaseBlockId} not found`);
            const columns = dbBlock.get("prop:columns");
            let statusCol = null;
            for (let i = 0; i < columns.length; i++) {
                if (columns.get(i).name === "Status") {
                    statusCol = columns.get(i);
                    break;
                }
            }
            if (!statusCol)
                throw new Error("Status column not found");
            const option = statusCol.data?.options?.find((o) => o.value === newStatus);
            if (!option)
                throw new Error(`Status "${newStatus}" not found in options: ${statusCol.data.options.map((o) => o.value).join(", ")}`);
            const cells = dbBlock.get("prop:cells");
            if (!cells.has(cardBlockId))
                cells.set(cardBlockId, new Y.Map());
            cells.get(cardBlockId).set(statusCol.id, new Y.Map([['columnId', statusCol.id], ['value', option.id]]));
            return text(JSON.stringify({ ok: true }));
        });
    }
    // ── read_kanban_board ─────────────────────────────────────────────────
    async function readKanbanBoard(args) {
        const { databaseBlockId } = args;
        return withDoc(args, (_doc, blocks) => {
            const dbBlock = blocks.get(databaseBlockId);
            if (!dbBlock)
                throw new Error(`Database block ${databaseBlockId} not found`);
            // Build option ID → label maps per column
            const columns = dbBlock.get("prop:columns");
            const colDefs = [];
            const optionLabelMap = {}; // colId -> optId -> label
            const colNameMap = {}; // colId -> name
            for (let i = 0; i < columns.length; i++) {
                const col = columns.get(i);
                colDefs.push({ id: col.id, name: col.name, type: col.type, options: col.data?.options || [] });
                colNameMap[col.id] = col.name;
                optionLabelMap[col.id] = {};
                for (const opt of (col.data?.options || [])) {
                    optionLabelMap[col.id][opt.id] = opt.value;
                }
            }
            // Read cards
            const children = dbBlock.get("sys:children");
            const cards = [];
            for (let i = 0; i < children.length; i++) {
                const cardId = children.get(i);
                const cardBlock = blocks.get(cardId);
                if (!cardBlock)
                    continue;
                const cardTitle = cardBlock.get("prop:text")?.toString() || "";
                const cellValues = {};
                const cells = dbBlock.get("prop:cells");
                for (let j = 0; j < columns.length; j++) {
                    const col = columns.get(j);
                    // Try nested structure first: cells[cardId][colId]
                    const rowMap = cells.get(cardId);
                    let cellValue;
                    if (rowMap instanceof Y.Map) {
                        const cellMap = rowMap.get(col.id);
                        cellValue = cellMap instanceof Y.Map ? cellMap.get("value") : cellMap?.value;
                    }
                    else {
                        // Fallback: flat composite key for backwards compat
                        const flat = cells.get(`${cardId}:${col.id}`);
                        cellValue = flat?.value;
                    }
                    if (cellValue && optionLabelMap[col.id]?.[cellValue]) {
                        cellValues[col.name] = optionLabelMap[col.id][cellValue];
                    }
                }
                cards.push({ id: cardId, title: cardTitle, cells: cellValues });
            }
            const titleText = dbBlock.get("prop:title");
            const boardTitle = titleText?.toString() || "";
            return text(JSON.stringify({ title: boardTitle, columns: colDefs, cards }));
        });
    }
    // ── Register tools ────────────────────────────────────────────────────
    server.registerTool("create_kanban_board", {
        title: "Create Kanban Board",
        description: "Creates an affine:database block pre-configured as a kanban board with status lanes.",
        inputSchema: {
            workspaceId: WorkspaceId.optional(),
            docId: DocId,
            title: z.string().min(1).describe("Board name"),
            statuses: z.array(z.string()).optional().describe('Kanban lane names (default: ["Todo","In Progress","Done"])'),
            assignees: z.array(z.string()).optional().describe("Assignee options"),
            priorities: z.array(z.string()).optional().describe("Priority options"),
        },
    }, createKanbanBoard);
    server.registerTool("add_kanban_card", {
        title: "Add Kanban Card",
        description: "Adds a card (row) to an existing kanban board.",
        inputSchema: {
            workspaceId: WorkspaceId.optional(),
            docId: DocId,
            databaseBlockId: z.string().min(1).describe("Database block ID from create_kanban_board"),
            title: z.string().min(1).describe("Card title"),
            status: z.string().optional().describe("Status label"),
            assignee: z.string().optional().describe("Assignee label"),
            priority: z.string().optional().describe("Priority label"),
        },
    }, addKanbanCard);
    server.registerTool("move_kanban_card", {
        title: "Move Kanban Card",
        description: "Changes a card's status (moves it to a different kanban lane).",
        inputSchema: {
            workspaceId: WorkspaceId.optional(),
            docId: DocId,
            databaseBlockId: z.string().min(1).describe("Database block ID"),
            cardBlockId: z.string().min(1).describe("Card block ID to move"),
            newStatus: z.string().min(1).describe("Target status label"),
        },
    }, moveKanbanCard);
    server.registerTool("read_kanban_board", {
        title: "Read Kanban Board",
        description: "Returns the full board state as structured JSON with columns, cards, and cell values.",
        inputSchema: {
            workspaceId: WorkspaceId.optional(),
            docId: DocId,
            databaseBlockId: z.string().min(1).describe("Database block ID"),
        },
    }, readKanbanBoard);
}
