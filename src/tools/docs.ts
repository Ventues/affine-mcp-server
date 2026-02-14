import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GraphQLClient } from "../graphqlClient.js";
import { text } from "../util/mcp.js";
import { wsUrlFromGraphQLEndpoint, connectWorkspaceSocket, joinWorkspace, loadDoc, pushDocUpdate, deleteDoc as wsDeleteDoc } from "../ws.js";
import * as Y from "yjs";
import MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

const WorkspaceId = z.string().min(1, "workspaceId required");
const DocId = z.string().min(1, "docId required");
const APPEND_BLOCK_CANONICAL_TYPE_VALUES = [
  "paragraph",
  "heading",
  "quote",
  "list",
  "code",
  "divider",
  "callout",
  "latex",
  "table",
  "bookmark",
  "image",
  "attachment",
  "embed_youtube",
  "embed_github",
  "embed_figma",
  "embed_loom",
  "embed_html",
  "embed_linked_doc",
  "embed_synced_doc",
  "embed_iframe",
  "database",
  "data_view",
  "surface_ref",
  "frame",
  "edgeless_text",
  "note",
] as const;
type AppendBlockCanonicalType = typeof APPEND_BLOCK_CANONICAL_TYPE_VALUES[number];

const APPEND_BLOCK_LEGACY_ALIAS_MAP = {
  heading1: "heading",
  heading2: "heading",
  heading3: "heading",
  bulleted_list: "list",
  numbered_list: "list",
  todo: "list",
} as const;
type AppendBlockLegacyType = keyof typeof APPEND_BLOCK_LEGACY_ALIAS_MAP;
type AppendBlockTypeInput = AppendBlockCanonicalType | AppendBlockLegacyType;

const APPEND_BLOCK_LIST_STYLE_VALUES = ["bulleted", "numbered", "todo"] as const;
type AppendBlockListStyle = typeof APPEND_BLOCK_LIST_STYLE_VALUES[number];
const AppendBlockListStyle = z.enum(APPEND_BLOCK_LIST_STYLE_VALUES);
const APPEND_BLOCK_BOOKMARK_STYLE_VALUES = [
  "vertical",
  "horizontal",
  "list",
  "cube",
  "citation",
] as const;
type AppendBlockBookmarkStyle = typeof APPEND_BLOCK_BOOKMARK_STYLE_VALUES[number];
const AppendBlockBookmarkStyle = z.enum(APPEND_BLOCK_BOOKMARK_STYLE_VALUES);

type AppendPlacement = {
  parentId?: string;
  afterBlockId?: string;
  beforeBlockId?: string;
  index?: number;
};

type AppendBlockInput = {
  workspaceId?: string;
  docId: string;
  type: string;
  text?: string;
  url?: string;
  pageId?: string;
  iframeUrl?: string;
  html?: string;
  design?: string;
  reference?: string;
  refFlavour?: string;
  width?: number;
  height?: number;
  background?: string;
  sourceId?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  embed?: boolean;
  rows?: number;
  columns?: number;
  latex?: string;
  checked?: boolean;
  language?: string;
  caption?: string;
  level?: number;
  style?: AppendBlockListStyle;
  bookmarkStyle?: AppendBlockBookmarkStyle;
  strict?: boolean;
  placement?: AppendPlacement;
};

type NormalizedAppendBlockInput = {
  workspaceId?: string;
  docId: string;
  type: AppendBlockCanonicalType;
  strict: boolean;
  placement?: AppendPlacement;
  text: string;
  url: string;
  pageId: string;
  iframeUrl: string;
  html: string;
  design: string;
  reference: string;
  refFlavour: string;
  width: number;
  height: number;
  background: string;
  sourceId: string;
  name: string;
  mimeType: string;
  size: number;
  embed: boolean;
  rows: number;
  columns: number;
  latex: string;
  headingLevel: 1 | 2 | 3 | 4 | 5 | 6;
  listStyle: AppendBlockListStyle;
  bookmarkStyle: AppendBlockBookmarkStyle;
  checked: boolean;
  language: string;
  caption?: string;
  legacyType?: AppendBlockLegacyType;
};

function blockVersion(flavour: string): number {
  switch (flavour) {
    case "affine:page":
      return 2;
    case "affine:surface":
      return 5;
    default:
      return 1;
  }
}

export function registerDocTools(server: McpServer, gql: GraphQLClient, defaults: { workspaceId?: string }) {
  // helpers
  function generateId(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let id = '';
    for (let i = 0; i < 10; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  function getEndpointAndAuthHeaders() {
    const endpoint = gql.endpoint;
    const authHeaders = gql.getAuthHeaders();
    return { endpoint, authHeaders };
  }

  function makeText(content: string): Y.Text {
    const yText = new Y.Text();
    if (content.length > 0) {
      yText.insert(0, content);
    }
    return yText;
  }

  function asText(value: unknown): string {
    if (value instanceof Y.Text) return value.toString();
    if (typeof value === "string") return value;
    return "";
  }

  function richTextToMarkdown(value: unknown): string {
    if (typeof value === "string") return value;
    if (!(value instanceof Y.Text)) return "";
    const delta = value.toDelta() as Array<{ insert: any; attributes?: Record<string, any> }>;
    if (!delta || delta.length === 0) return "";
    // Fast path: no attributes anywhere → plain text
    if (delta.every(d => !d.attributes)) return value.toString();
    return delta.map(d => {
      if (typeof d.insert !== "string") return "";
      let t = d.insert;
      const a = d.attributes;
      if (!a) return t;
      if (a.code) return `\`${t}\``;
      if (a.bold && a.italic) t = `***${t}***`;
      else if (a.bold) t = `**${t}**`;
      else if (a.italic) t = `*${t}*`;
      if (a.strikethrough) t = `~~${t}~~`;
      if (a.underline) t = `<u>${t}</u>`;
      if (a.link) t = `[${t}](${a.link})`;
      return t;
    }).join("");
  }

  function childIdsFrom(value: unknown): string[] {
    if (!(value instanceof Y.Array)) return [];
    const childIds: string[] = [];
    value.forEach((entry: unknown) => {
      if (typeof entry === "string") {
        childIds.push(entry);
        return;
      }
      if (Array.isArray(entry)) {
        for (const child of entry) {
          if (typeof child === "string") {
            childIds.push(child);
          }
        }
      }
    });
    return childIds;
  }

  function setSysFields(block: Y.Map<any>, blockId: string, flavour: string): void {
    block.set("sys:id", blockId);
    block.set("sys:flavour", flavour);
    block.set("sys:version", blockVersion(flavour));
  }

  function findBlockIdByFlavour(blocks: Y.Map<any>, flavour: string): string | null {
    for (const [, value] of blocks) {
      const block = value as Y.Map<any>;
      if (block?.get && block.get("sys:flavour") === flavour) {
        return String(block.get("sys:id"));
      }
    }
    return null;
  }

  function ensureNoteBlock(blocks: Y.Map<any>): string {
    const existingNoteId = findBlockIdByFlavour(blocks, "affine:note");
    if (existingNoteId) {
      return existingNoteId;
    }

    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    if (!pageId) {
      throw new Error("Document has no page block; unable to insert content.");
    }

    const noteId = generateId();
    const note = new Y.Map<any>();
    setSysFields(note, noteId, "affine:note");
    note.set("sys:parent", pageId);
    note.set("sys:children", new Y.Array<string>());
    note.set("prop:xywh", "[0,0,800,95]");
    note.set("prop:index", "a0");
    note.set("prop:hidden", false);
    note.set("prop:displayMode", "both");
    const background = new Y.Map<any>();
    background.set("light", "#ffffff");
    background.set("dark", "#252525");
    note.set("prop:background", background);
    blocks.set(noteId, note);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([noteId]);
    return noteId;
  }

  function ensureSurfaceBlock(blocks: Y.Map<any>): string {
    const existingSurfaceId = findBlockIdByFlavour(blocks, "affine:surface");
    if (existingSurfaceId) {
      return existingSurfaceId;
    }

    const pageId = findBlockIdByFlavour(blocks, "affine:page");
    if (!pageId) {
      throw new Error("Document has no page block; unable to create/find surface.");
    }

    const surfaceId = generateId();
    const surface = new Y.Map<any>();
    setSysFields(surface, surfaceId, "affine:surface");
    surface.set("sys:parent", pageId);
    surface.set("sys:children", new Y.Array<string>());
    const elements = new Y.Map<any>();
    elements.set("type", "$blocksuite:internal:native$");
    elements.set("value", new Y.Map<any>());
    surface.set("prop:elements", elements);
    blocks.set(surfaceId, surface);

    const page = blocks.get(pageId) as Y.Map<any>;
    let pageChildren = page.get("sys:children") as Y.Array<string> | undefined;
    if (!(pageChildren instanceof Y.Array)) {
      pageChildren = new Y.Array<string>();
      page.set("sys:children", pageChildren);
    }
    pageChildren.push([surfaceId]);
    return surfaceId;
  }

  function normalizeBlockTypeInput(typeInput: string): {
    type: AppendBlockCanonicalType;
    legacyType?: AppendBlockLegacyType;
    headingLevelFromAlias?: 1 | 2 | 3;
    listStyleFromAlias?: AppendBlockListStyle;
  } {
    const key = typeInput.trim().toLowerCase();
    if ((APPEND_BLOCK_CANONICAL_TYPE_VALUES as readonly string[]).includes(key)) {
      return { type: key as AppendBlockCanonicalType };
    }

    if (Object.prototype.hasOwnProperty.call(APPEND_BLOCK_LEGACY_ALIAS_MAP, key)) {
      const legacyType = key as AppendBlockLegacyType;
      const type = APPEND_BLOCK_LEGACY_ALIAS_MAP[legacyType];
      const listStyleFromAlias =
        legacyType === "bulleted_list"
          ? "bulleted"
          : legacyType === "numbered_list"
            ? "numbered"
            : legacyType === "todo"
              ? "todo"
              : undefined;
      const headingLevelFromAlias =
        legacyType === "heading1"
          ? 1
          : legacyType === "heading2"
            ? 2
            : legacyType === "heading3"
              ? 3
              : undefined;
      return { type, legacyType, headingLevelFromAlias, listStyleFromAlias };
    }

    const supported = [
      ...APPEND_BLOCK_CANONICAL_TYPE_VALUES,
      ...Object.keys(APPEND_BLOCK_LEGACY_ALIAS_MAP),
    ].join(", ");
    throw new Error(`Unsupported append_block type '${typeInput}'. Supported types: ${supported}`);
  }

  function normalizePlacement(placement: AppendPlacement | undefined): AppendPlacement | undefined {
    if (!placement) return undefined;

    const normalized: AppendPlacement = {};
    if (placement.parentId?.trim()) normalized.parentId = placement.parentId.trim();
    if (placement.afterBlockId?.trim()) normalized.afterBlockId = placement.afterBlockId.trim();
    if (placement.beforeBlockId?.trim()) normalized.beforeBlockId = placement.beforeBlockId.trim();
    if (placement.index !== undefined) normalized.index = placement.index;

    const hasAfter = Boolean(normalized.afterBlockId);
    const hasBefore = Boolean(normalized.beforeBlockId);
    if (hasAfter && hasBefore) {
      throw new Error("placement.afterBlockId and placement.beforeBlockId are mutually exclusive.");
    }
    if (normalized.index !== undefined) {
      if (!Number.isInteger(normalized.index) || normalized.index < 0) {
        throw new Error("placement.index must be an integer greater than or equal to 0.");
      }
      if (hasAfter || hasBefore) {
        throw new Error("placement.index cannot be used with placement.afterBlockId/beforeBlockId.");
      }
    }

    if (!normalized.parentId && !normalized.afterBlockId && !normalized.beforeBlockId && normalized.index === undefined) {
      return undefined;
    }
    return normalized;
  }

  function validateNormalizedAppendBlockInput(normalized: NormalizedAppendBlockInput, raw: AppendBlockInput): void {
    if (normalized.type === "heading") {
      if (!Number.isInteger(normalized.headingLevel) || normalized.headingLevel < 1 || normalized.headingLevel > 6) {
        throw new Error("Heading level must be an integer from 1 to 6.");
      }
    } else if (raw.level !== undefined && normalized.strict) {
      throw new Error("The 'level' field can only be used with type='heading'.");
    }

    if (normalized.type === "list") {
      if (!(APPEND_BLOCK_LIST_STYLE_VALUES as readonly string[]).includes(normalized.listStyle)) {
        throw new Error(`Invalid list style '${normalized.listStyle}'.`);
      }
      if (normalized.listStyle !== "todo" && raw.checked !== undefined && normalized.strict) {
        throw new Error("The 'checked' field can only be used when list style is 'todo'.");
      }
    } else {
      if (raw.style !== undefined && normalized.strict) {
        throw new Error("The 'style' field can only be used with type='list'.");
      }
      if (raw.checked !== undefined && normalized.strict) {
        throw new Error("The 'checked' field can only be used with type='list' (style='todo').");
      }
    }

    if (normalized.type !== "code") {
      if (raw.language !== undefined && normalized.strict) {
        throw new Error("The 'language' field can only be used with type='code'.");
      }
      const allowsCaption =
        normalized.type === "bookmark" ||
        normalized.type === "image" ||
        normalized.type === "attachment" ||
        normalized.type === "surface_ref" ||
        normalized.type.startsWith("embed_");
      if (raw.caption !== undefined && !allowsCaption && normalized.strict) {
        throw new Error("The 'caption' field is not valid for this block type.");
      }
    } else if (normalized.language.length > 64) {
      throw new Error("Code language is too long (max 64 chars).");
    }

    if (normalized.type === "divider" && raw.text && raw.text.length > 0 && normalized.strict) {
      throw new Error("Divider blocks do not accept text.");
    }

    const requiresUrl = [
      "bookmark",
      "embed_youtube",
      "embed_github",
      "embed_figma",
      "embed_loom",
      "embed_iframe",
    ] as const;
    const urlAllowedTypes = [...requiresUrl] as readonly string[];
    if (urlAllowedTypes.includes(normalized.type)) {
      if (!normalized.url) {
        throw new Error(`${normalized.type} blocks require a non-empty url.`);
      }
      try {
        new URL(normalized.url);
      } catch {
        throw new Error(`Invalid url for ${normalized.type} block: '${normalized.url}'.`);
      }
    }

    if (normalized.type === "bookmark") {
      if (!(APPEND_BLOCK_BOOKMARK_STYLE_VALUES as readonly string[]).includes(normalized.bookmarkStyle)) {
        throw new Error(`Invalid bookmark style '${normalized.bookmarkStyle}'.`);
      }
    } else {
      if (raw.bookmarkStyle !== undefined && normalized.strict) {
        throw new Error("The 'bookmarkStyle' field can only be used with type='bookmark'.");
      }
      if (raw.url !== undefined && !urlAllowedTypes.includes(normalized.type) && normalized.strict) {
        throw new Error("The 'url' field is not valid for this block type.");
      }
    }

    if (normalized.type === "image" || normalized.type === "attachment") {
      if (!normalized.sourceId) {
        throw new Error(`${normalized.type} blocks require sourceId (use upload_blob first).`);
      }
      if (normalized.type === "attachment" && (!normalized.name || !normalized.mimeType)) {
        throw new Error("attachment blocks require valid name and mimeType.");
      }
    } else if (raw.sourceId !== undefined && normalized.strict) {
      throw new Error("The 'sourceId' field can only be used with type='image' or type='attachment'.");
    } else if (
      (raw.name !== undefined || raw.mimeType !== undefined || raw.embed !== undefined || raw.size !== undefined) &&
      normalized.strict
    ) {
      throw new Error("The 'name'/'mimeType'/'embed'/'size' fields are only valid for image/attachment blocks.");
    }

    if (normalized.type === "latex") {
      if (!normalized.latex && normalized.strict) {
        throw new Error("latex blocks require a non-empty 'latex' value in strict mode.");
      }
    } else if (raw.latex !== undefined && normalized.strict) {
      throw new Error("The 'latex' field can only be used with type='latex'.");
    }

    if (normalized.type === "embed_linked_doc" || normalized.type === "embed_synced_doc") {
      if (!normalized.pageId) {
        throw new Error(`${normalized.type} blocks require pageId.`);
      }
    } else if (raw.pageId !== undefined && normalized.strict) {
      throw new Error("The 'pageId' field can only be used with linked/synced doc embed types.");
    }

    if (normalized.type === "embed_html") {
      if (!normalized.html && !normalized.design && normalized.strict) {
        throw new Error("embed_html blocks require html or design.");
      }
    } else if ((raw.html !== undefined || raw.design !== undefined) && normalized.strict) {
      throw new Error("The 'html'/'design' fields can only be used with type='embed_html'.");
    }

    if (normalized.type === "embed_iframe") {
      if (raw.iframeUrl !== undefined && !normalized.iframeUrl && normalized.strict) {
        throw new Error("embed_iframe iframeUrl cannot be empty when provided.");
      }
    } else if (raw.iframeUrl !== undefined && normalized.strict) {
      throw new Error("The 'iframeUrl' field can only be used with type='embed_iframe'.");
    }

    if (normalized.type === "surface_ref") {
      if (!normalized.reference) {
        throw new Error("surface_ref blocks require 'reference' (target element/block id).");
      }
      if (!normalized.refFlavour) {
        throw new Error("surface_ref blocks require 'refFlavour' (for example affine:frame).");
      }
    } else if ((raw.reference !== undefined || raw.refFlavour !== undefined) && normalized.strict) {
      throw new Error("The 'reference'/'refFlavour' fields can only be used with type='surface_ref'.");
    }

    if (normalized.type === "frame" || normalized.type === "edgeless_text" || normalized.type === "note") {
      if (!Number.isInteger(normalized.width) || normalized.width < 1 || normalized.width > 10000) {
        throw new Error(`${normalized.type} width must be an integer between 1 and 10000.`);
      }
      if (!Number.isInteger(normalized.height) || normalized.height < 1 || normalized.height > 10000) {
        throw new Error(`${normalized.type} height must be an integer between 1 and 10000.`);
      }
    } else if ((raw.width !== undefined || raw.height !== undefined) && normalized.strict) {
      throw new Error("The 'width'/'height' fields are only valid for frame/edgeless_text/note.");
    }

    if (normalized.type !== "frame" && normalized.type !== "note" && raw.background !== undefined && normalized.strict) {
      throw new Error("The 'background' field is only valid for frame/note.");
    }

    if (normalized.type === "table") {
      if (!Number.isInteger(normalized.rows) || normalized.rows < 1 || normalized.rows > 20) {
        throw new Error("table rows must be an integer between 1 and 20.");
      }
      if (!Number.isInteger(normalized.columns) || normalized.columns < 1 || normalized.columns > 20) {
        throw new Error("table columns must be an integer between 1 and 20.");
      }
    } else if ((raw.rows !== undefined || raw.columns !== undefined) && normalized.strict) {
      throw new Error("The 'rows'/'columns' fields can only be used with type='table'.");
    }
  }

  function normalizeAppendBlockInput(parsed: AppendBlockInput): NormalizedAppendBlockInput {
    const strict = parsed.strict !== false;
    const typeInfo = normalizeBlockTypeInput(parsed.type);
    const headingLevelCandidate = parsed.level ?? typeInfo.headingLevelFromAlias ?? 1;
    const headingLevelNumber = Number(headingLevelCandidate);
    const headingLevel = Math.max(1, Math.min(6, headingLevelNumber)) as 1 | 2 | 3 | 4 | 5 | 6;
    const listStyle = typeInfo.listStyleFromAlias ?? parsed.style ?? "bulleted";
    const bookmarkStyle = parsed.bookmarkStyle ?? "horizontal";
    const language = (parsed.language ?? "txt").trim().toLowerCase() || "txt";
    const placement = normalizePlacement(parsed.placement);
    const url = (parsed.url ?? "").trim();
    const pageId = (parsed.pageId ?? "").trim();
    const iframeUrl = (parsed.iframeUrl ?? "").trim();
    const html = parsed.html ?? "";
    const design = parsed.design ?? "";
    const reference = (parsed.reference ?? "").trim();
    const refFlavour = (parsed.refFlavour ?? "").trim();
    const width = Number.isFinite(parsed.width) ? Math.max(1, Math.floor(parsed.width as number)) : 100;
    const height = Number.isFinite(parsed.height) ? Math.max(1, Math.floor(parsed.height as number)) : 100;
    const background = (parsed.background ?? "transparent").trim() || "transparent";
    const sourceId = (parsed.sourceId ?? "").trim();
    const name = (parsed.name ?? "attachment").trim() || "attachment";
    const mimeType = (parsed.mimeType ?? "application/octet-stream").trim() || "application/octet-stream";
    const size = Number.isFinite(parsed.size) ? Math.max(0, Math.floor(parsed.size as number)) : 0;
    const rows = Number.isInteger(parsed.rows) ? (parsed.rows as number) : 3;
    const columns = Number.isInteger(parsed.columns) ? (parsed.columns as number) : 3;
    const latex = (parsed.latex ?? "").trim();

    const normalized: NormalizedAppendBlockInput = {
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: typeInfo.type,
      strict,
      placement,
      text: parsed.text ?? "",
      url,
      pageId,
      iframeUrl,
      html,
      design,
      reference,
      refFlavour,
      width,
      height,
      background,
      sourceId,
      name,
      mimeType,
      size,
      embed: Boolean(parsed.embed),
      rows,
      columns,
      latex,
      headingLevel,
      listStyle,
      bookmarkStyle,
      checked: Boolean(parsed.checked),
      language,
      caption: parsed.caption,
      legacyType: typeInfo.legacyType,
    };

    validateNormalizedAppendBlockInput(normalized, parsed);
    return normalized;
  }

  function findBlockById(blocks: Y.Map<any>, blockId: string): Y.Map<any> | null {
    const value = blocks.get(blockId);
    if (value instanceof Y.Map) return value;
    return null;
  }

  function ensureChildrenArray(block: Y.Map<any>): Y.Array<any> {
    const current = block.get("sys:children");
    if (current instanceof Y.Array) return current;
    const created = new Y.Array<any>();
    block.set("sys:children", created);
    return created;
  }

  function indexOfChild(children: Y.Array<any>, blockId: string): number {
    let index = -1;
    children.forEach((entry: unknown, i: number) => {
      if (index >= 0) return;
      if (typeof entry === "string") {
        if (entry === blockId) index = i;
        return;
      }
      if (Array.isArray(entry)) {
        for (const child of entry) {
          if (child === blockId) {
            index = i;
            return;
          }
        }
      }
    });
    return index;
  }

  function resolveInsertContext(blocks: Y.Map<any>, normalized: NormalizedAppendBlockInput): {
    parentId: string;
    parentBlock: Y.Map<any>;
    children: Y.Array<any>;
    insertIndex: number;
  } {
    const placement = normalized.placement;
    let parentId: string | undefined;
    let referenceBlockId: string | undefined;
    let mode: "append" | "index" | "after" | "before" = "append";

    if (placement?.afterBlockId) {
      mode = "after";
      referenceBlockId = placement.afterBlockId;
      const referenceBlock = findBlockById(blocks, referenceBlockId);
      if (!referenceBlock) throw new Error(`placement.afterBlockId '${referenceBlockId}' was not found.`);
      const refParentId = referenceBlock.get("sys:parent");
      if (typeof refParentId !== "string" || !refParentId) {
        throw new Error(`Block '${referenceBlockId}' has no parent.`);
      }
      parentId = refParentId;
    } else if (placement?.beforeBlockId) {
      mode = "before";
      referenceBlockId = placement.beforeBlockId;
      const referenceBlock = findBlockById(blocks, referenceBlockId);
      if (!referenceBlock) throw new Error(`placement.beforeBlockId '${referenceBlockId}' was not found.`);
      const refParentId = referenceBlock.get("sys:parent");
      if (typeof refParentId !== "string" || !refParentId) {
        throw new Error(`Block '${referenceBlockId}' has no parent.`);
      }
      parentId = refParentId;
    } else if (placement?.parentId) {
      mode = placement.index !== undefined ? "index" : "append";
      parentId = placement.parentId;
    }

    if (!parentId) {
      if (normalized.type === "frame" || normalized.type === "edgeless_text") {
        parentId = ensureSurfaceBlock(blocks);
      } else if (normalized.type === "note") {
        parentId = findBlockIdByFlavour(blocks, "affine:page") || undefined;
        if (!parentId) {
          throw new Error("Document has no page block; unable to insert note.");
        }
      } else {
        parentId = ensureNoteBlock(blocks);
      }
    }
    const parentBlock = findBlockById(blocks, parentId);
    if (!parentBlock) {
      throw new Error(`Target parent block '${parentId}' was not found.`);
    }
    const parentFlavour = parentBlock.get("sys:flavour");
    if (normalized.strict) {
      if (parentFlavour === "affine:page" && normalized.type !== "note") {
        throw new Error(`Cannot append '${normalized.type}' directly under 'affine:page'.`);
      }
      if (
        parentFlavour === "affine:surface" &&
        normalized.type !== "frame" &&
        normalized.type !== "edgeless_text"
      ) {
        throw new Error(`Cannot append '${normalized.type}' directly under 'affine:surface'.`);
      }
      if (normalized.type === "note" && parentFlavour !== "affine:page") {
        throw new Error("note blocks must be appended under affine:page.");
      }
      if (
        (normalized.type === "frame" || normalized.type === "edgeless_text") &&
        parentFlavour !== "affine:surface"
      ) {
        throw new Error(`${normalized.type} blocks must be appended under affine:surface.`);
      }
    }

    const children = ensureChildrenArray(parentBlock);
    let insertIndex = children.length;
    if (mode === "after" || mode === "before") {
      const idx = indexOfChild(children, referenceBlockId as string);
      if (idx < 0) {
        throw new Error(`Reference block '${referenceBlockId}' is not a child of parent '${parentId}'.`);
      }
      insertIndex = mode === "after" ? idx + 1 : idx;
    } else if (mode === "index") {
      const requestedIndex = placement?.index ?? children.length;
      if (requestedIndex > children.length && normalized.strict) {
        throw new Error(`placement.index ${requestedIndex} is out of range (max ${children.length}).`);
      }
      insertIndex = Math.min(requestedIndex, children.length);
    }

    return { parentId, parentBlock, children, insertIndex };
  }

  function createBlock(
    parentId: string,
    normalized: NormalizedAppendBlockInput
  ): { blockId: string; block: Y.Map<any>; flavour: string; blockType?: string } {
    const blockId = generateId();
    const block = new Y.Map<any>();
    const content = normalized.text;

    switch (normalized.type) {
      case "paragraph":
      case "heading":
      case "quote": {
        setSysFields(block, blockId, "affine:paragraph");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        const blockType =
          normalized.type === "heading"
            ? (`h${normalized.headingLevel}` as const)
            : normalized.type === "quote"
              ? "quote"
              : "text";
        block.set("prop:type", blockType);
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:paragraph", blockType };
      }
      case "list": {
        setSysFields(block, blockId, "affine:list");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:type", normalized.listStyle);
        block.set("prop:checked", normalized.listStyle === "todo" ? normalized.checked : false);
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:list", blockType: normalized.listStyle };
      }
      case "code": {
        setSysFields(block, blockId, "affine:code");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:language", normalized.language);
        if (normalized.caption) {
          block.set("prop:caption", normalized.caption);
        }
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:code" };
      }
      case "divider": {
        setSysFields(block, blockId, "affine:divider");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        return { blockId, block, flavour: "affine:divider" };
      }
      case "callout": {
        setSysFields(block, blockId, "affine:callout");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:icon", { type: "emoji", unicode: "💡" });
        block.set("prop:backgroundColorName", "grey");
        block.set("prop:text", makeText(content));
        return { blockId, block, flavour: "affine:callout" };
      }
      case "latex": {
        setSysFields(block, blockId, "affine:latex");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", "[0,0,16,16]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:rotate", 0);
        block.set("prop:latex", normalized.latex);
        return { blockId, block, flavour: "affine:latex" };
      }
      case "table": {
        setSysFields(block, blockId, "affine:table");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        const rows: Record<string, { rowId: string; order: string; backgroundColor?: string }> = {};
        const columns: Record<string, { columnId: string; order: string; backgroundColor?: string; width?: number }> = {};
        const cells: Record<string, { text: Y.Text }> = {};

        for (let i = 0; i < normalized.rows; i++) {
          const rowId = generateId();
          rows[rowId] = { rowId, order: `r${String(i).padStart(4, "0")}` };
        }
        for (let i = 0; i < normalized.columns; i++) {
          const columnId = generateId();
          columns[columnId] = { columnId, order: `c${String(i).padStart(4, "0")}` };
        }
        for (const rowId of Object.keys(rows)) {
          for (const columnId of Object.keys(columns)) {
            cells[`${rowId}:${columnId}`] = { text: makeText("") };
          }
        }

        block.set("prop:rows", rows);
        block.set("prop:columns", columns);
        block.set("prop:cells", cells);
        block.set("prop:comments", undefined);
        block.set("prop:textAlign", undefined);
        return { blockId, block, flavour: "affine:table" };
      }
      case "bookmark": {
        setSysFields(block, blockId, "affine:bookmark");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:style", normalized.bookmarkStyle);
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:description", null);
        block.set("prop:icon", null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:bookmark" };
      }
      case "image": {
        setSysFields(block, blockId, "affine:image");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:caption", normalized.caption ?? "");
        block.set("prop:sourceId", normalized.sourceId);
        block.set("prop:width", 0);
        block.set("prop:height", 0);
        block.set("prop:size", normalized.size || -1);
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        return { blockId, block, flavour: "affine:image" };
      }
      case "attachment": {
        setSysFields(block, blockId, "affine:attachment");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:name", normalized.name);
        block.set("prop:size", normalized.size);
        block.set("prop:type", normalized.mimeType);
        block.set("prop:sourceId", normalized.sourceId);
        block.set("prop:caption", normalized.caption ?? undefined);
        block.set("prop:embed", normalized.embed);
        block.set("prop:style", "horizontalThin");
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:attachment" };
      }
      case "embed_youtube": {
        setSysFields(block, blockId, "affine:embed-youtube");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "video");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:creator", null);
        block.set("prop:creatorUrl", null);
        block.set("prop:creatorImage", null);
        block.set("prop:videoId", null);
        return { blockId, block, flavour: "affine:embed-youtube" };
      }
      case "embed_github": {
        setSysFields(block, blockId, "affine:embed-github");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "horizontal");
        block.set("prop:owner", "");
        block.set("prop:repo", "");
        block.set("prop:githubType", "issue");
        block.set("prop:githubId", "");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:status", null);
        block.set("prop:statusReason", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:createdAt", null);
        block.set("prop:assignees", null);
        return { blockId, block, flavour: "affine:embed-github" };
      }
      case "embed_figma": {
        setSysFields(block, blockId, "affine:embed-figma");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "figma");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        return { blockId, block, flavour: "affine:embed-figma" };
      }
      case "embed_loom": {
        setSysFields(block, blockId, "affine:embed-loom");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "video");
        block.set("prop:url", normalized.url);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:image", null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        block.set("prop:videoId", null);
        return { blockId, block, flavour: "affine:embed-loom" };
      }
      case "embed_html": {
        setSysFields(block, blockId, "affine:embed-html");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "html");
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:html", normalized.html || undefined);
        block.set("prop:design", normalized.design || undefined);
        return { blockId, block, flavour: "affine:embed-html" };
      }
      case "embed_linked_doc": {
        setSysFields(block, blockId, "affine:embed-linked-doc");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "horizontal");
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:pageId", normalized.pageId);
        block.set("prop:title", undefined);
        block.set("prop:description", undefined);
        block.set("prop:footnoteIdentifier", null);
        return { blockId, block, flavour: "affine:embed-linked-doc" };
      }
      case "embed_synced_doc": {
        setSysFields(block, blockId, "affine:embed-synced-doc");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,800,100]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:rotate", 0);
        block.set("prop:style", "syncedDoc");
        block.set("prop:caption", normalized.caption ?? undefined);
        block.set("prop:pageId", normalized.pageId);
        block.set("prop:scale", undefined);
        block.set("prop:preFoldHeight", undefined);
        block.set("prop:title", undefined);
        block.set("prop:description", undefined);
        return { blockId, block, flavour: "affine:embed-synced-doc" };
      }
      case "embed_iframe": {
        setSysFields(block, blockId, "affine:embed-iframe");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:index", "a0");
        block.set("prop:xywh", "[0,0,0,0]");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:url", normalized.url);
        block.set("prop:iframeUrl", normalized.iframeUrl || normalized.url);
        block.set("prop:width", undefined);
        block.set("prop:height", undefined);
        block.set("prop:caption", normalized.caption ?? null);
        block.set("prop:title", null);
        block.set("prop:description", null);
        return { blockId, block, flavour: "affine:embed-iframe" };
      }
      case "database": {
        setSysFields(block, blockId, "affine:database");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:views", new Y.Array<any>());
        block.set("prop:title", makeText(content));
        block.set("prop:cells", new Y.Map<any>());
        block.set("prop:columns", new Y.Array<any>());
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:database" };
      }
      case "data_view": {
        // AFFiNE 0.26.x currently crashes on raw affine:data-view render path.
        // Keep API compatibility for type="data_view" by mapping it to the stable database block.
        setSysFields(block, blockId, "affine:database");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:views", new Y.Array<any>());
        block.set("prop:title", makeText(content));
        block.set("prop:cells", new Y.Map<any>());
        block.set("prop:columns", new Y.Array<any>());
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:database", blockType: "data_view_fallback" };
      }
      case "surface_ref": {
        setSysFields(block, blockId, "affine:surface-ref");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:reference", normalized.reference);
        block.set("prop:caption", normalized.caption ?? "");
        block.set("prop:refFlavour", normalized.refFlavour);
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:surface-ref" };
      }
      case "frame": {
        setSysFields(block, blockId, "affine:frame");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:title", makeText(content || "Frame"));
        block.set("prop:background", normalized.background);
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        block.set("prop:childElementIds", new Y.Map<any>());
        block.set("prop:presentationIndex", "a0");
        block.set("prop:lockedBySelf", false);
        return { blockId, block, flavour: "affine:frame" };
      }
      case "edgeless_text": {
        setSysFields(block, blockId, "affine:edgeless-text");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:scale", 1);
        block.set("prop:rotate", 0);
        block.set("prop:hasMaxWidth", false);
        block.set("prop:comments", undefined);
        block.set("prop:color", "black");
        block.set("prop:fontFamily", "Inter");
        block.set("prop:fontStyle", "normal");
        block.set("prop:fontWeight", "regular");
        block.set("prop:textAlign", "left");
        return { blockId, block, flavour: "affine:edgeless-text" };
      }
      case "note": {
        setSysFields(block, blockId, "affine:note");
        block.set("sys:parent", parentId);
        block.set("sys:children", new Y.Array<string>());
        block.set("prop:xywh", `[0,0,${normalized.width},${normalized.height}]`);
        block.set("prop:background", normalized.background);
        block.set("prop:index", "a0");
        block.set("prop:lockedBySelf", false);
        block.set("prop:hidden", false);
        block.set("prop:displayMode", "both");
        const edgeless = new Y.Map<any>();
        const style = new Y.Map<any>();
        style.set("borderRadius", 8);
        style.set("borderSize", 1);
        style.set("borderStyle", "solid");
        style.set("shadowType", "none");
        edgeless.set("style", style);
        block.set("prop:edgeless", edgeless);
        block.set("prop:comments", undefined);
        return { blockId, block, flavour: "affine:note" };
      }
    }
  }

  /** Update the updatedDate for a doc in the workspace root meta pages list */
  async function touchDocMeta(socket: any, workspaceId: string, docId: string): Promise<void> {
    const wsDoc = new Y.Doc();
    const snapshot = await loadDoc(socket, workspaceId, workspaceId);
    if (snapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, "base64"));
    const prevSV = Y.encodeStateVector(wsDoc);
    const wsMeta = wsDoc.getMap("meta");
    const pages = wsMeta.get("pages") as Y.Array<Y.Map<any>> | undefined;
    if (pages) {
      pages.forEach((entry: any) => {
        if (entry?.get && entry.get("id") === docId) {
          entry.set("updatedDate", Date.now());
        }
      });
    }
    const delta = Y.encodeStateAsUpdate(wsDoc, prevSV);
    if (delta.byteLength > 0) {
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(delta).toString("base64"));
    }
  }

  /** Remove a block and all its descendants from the Y.Map */
  function removeBlockTree(blocks: Y.Map<any>, blockId: string): void {
    const block = blocks.get(blockId);
    if (block instanceof Y.Map) {
      const kids = childIdsFrom(block.get("sys:children"));
      for (const kid of kids) removeBlockTree(blocks, kid);
    }
    blocks.delete(blockId);
  }

  async function appendBlockInternal(parsed: AppendBlockInput) {
    const normalized = normalizeAppendBlockInput(parsed);
    const workspaceId = normalized.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);

      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, normalized.docId);
      if (snapshot.missing) {
        Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      }

      const prevSV = Y.encodeStateVector(doc);
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const context = resolveInsertContext(blocks, normalized);
      const { blockId, block, flavour, blockType } = createBlock(context.parentId, normalized);

      blocks.set(blockId, block);
      if (context.insertIndex >= context.children.length) {
        context.children.push([blockId]);
      } else {
        context.children.insert(context.insertIndex, [blockId]);
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, normalized.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${normalized.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, normalized.docId);

      return { appended: true, blockId, flavour, blockType, normalizedType: normalized.type, legacyType: normalized.legacyType || null };
    } finally {
      socket.disconnect();
    }
  }

  const listDocsHandler = async (parsed: { workspaceId?: string; first?: number; offset?: number; after?: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query ListDocs($workspaceId: String!, $first: Int, $offset: Int, $after: String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      const docs = data.workspace.docs;
      // Enrich null titles by fetching individual doc metadata via GraphQL
      const nullTitleEdges = docs.edges ? docs.edges.filter((e: any) => !e.node.title) : [];
      if (nullTitleEdges.length > 0) {
        const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
        const results = await Promise.allSettled(
          nullTitleEdges.map((edge: any) =>
            gql.request<{ workspace: any }>(getDocQuery, { workspaceId, docId: edge.node.id })
          )
        );
        results.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
            const doc = result.value.workspace.doc;
            if (doc.title) nullTitleEdges[i].node.title = doc.title;
            if (doc.summary) nullTitleEdges[i].node.summary = doc.summary;
          }
        });
      }
      return text(docs);
    };
  server.registerTool(
    "list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listDocsHandler as any
  );
  server.registerTool(
    "affine_list_docs",
    {
      title: "List Documents",
      description: "List documents in a workspace (GraphQL).",
      inputSchema: {
        workspaceId: z.string().describe("Workspace ID (optional if default set).").optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    listDocsHandler as any
  );

  const getDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id workspaceId title summary public defaultRole createdAt updatedAt } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, docId: parsed.docId });
      return text(data.workspace.doc);
    };
  server.registerTool(
    "get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    getDocHandler as any
  );
  server.registerTool(
    "affine_get_doc",
    {
      title: "Get Document",
      description: "Get a document by ID (GraphQL metadata).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: DocId
      }
    },
    getDocHandler as any
  );

  // SEARCH DOCS (with server-side + client-side fallback)
  const searchDocsHandler = async (parsed: { workspaceId?: string; keyword: string; limit?: number }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      try {
        const query = `query SearchDocs($workspaceId:String!, $keyword:String!, $limit:Int){ workspace(id:$workspaceId){ searchDocs(input:{ keyword:$keyword, limit:$limit }){ docId title highlight createdAt updatedAt } } }`;
        const data = await gql.request<{ workspace: any }>(query, { workspaceId, keyword: parsed.keyword, limit: parsed.limit });
        const results = data.workspace?.searchDocs;
        if (results && results.length > 0) {
          return text(results);
        }
      } catch (error: any) {
        console.error("Server-side search unavailable, falling back to client-side search:", error.message);
      }
      try {
        const listQuery = `query ListAllDocs($workspaceId: String!){ workspace(id:$workspaceId){ docs(pagination:{first:100}){ edges{ node{ id workspaceId title summary createdAt updatedAt } } } } }`;
        const listData = await gql.request<{ workspace: any }>(listQuery, { workspaceId });
        const allEdges = listData.workspace.docs.edges || [];
        const nullTitleEdges = allEdges.filter((e: any) => !e.node.title);
        if (nullTitleEdges.length > 0) {
          const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
          const results = await Promise.allSettled(
            nullTitleEdges.map((edge: any) =>
              gql.request<{ workspace: any }>(getDocQuery, { workspaceId, docId: edge.node.id })
            )
          );
          results.forEach((result, i) => {
            if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
              const doc = result.value.workspace.doc;
              if (doc.title) nullTitleEdges[i].node.title = doc.title;
              if (doc.summary) nullTitleEdges[i].node.summary = doc.summary;
            }
          });
        }
        const kw = parsed.keyword.toLowerCase();
        const keywords = kw.split(/\s+/);
        const matched = allEdges
          .map((e: any) => e.node)
          .filter((doc: any) => {
            const title = (doc.title || '').toLowerCase();
            const summary = (doc.summary || '').toLowerCase();
            const combined = title + ' ' + summary;
            return keywords.every((k: string) => combined.includes(k));
          })
          .slice(0, parsed.limit || 20)
          .map((doc: any) => ({
            docId: doc.id, title: doc.title, summary: doc.summary,
            createdAt: doc.createdAt, updatedAt: doc.updatedAt
          }));
        return text(matched);
      } catch (fallbackError: any) {
        console.error("Client-side search also failed:", fallbackError.message);
        return text([]);
      }
    };
  server.registerTool(
    "search_docs",
    {
      title: "Search Documents",
      description: "Search documents in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        keyword: z.string().min(1),
        limit: z.number().optional()
      }
    },
    searchDocsHandler as any
  );
  server.registerTool(
    "affine_search_docs",
    {
      title: "Search Documents",
      description: "Search documents in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        keyword: z.string().min(1),
        limit: z.number().optional()
      }
    },
    searchDocsHandler as any
  );

  // RECENT DOCS
  const recentDocsHandler = async (parsed: { workspaceId?: string; first?: number; offset?: number; after?: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const query = `query RecentDocs($workspaceId:String!, $first:Int, $offset:Int, $after:String){ workspace(id:$workspaceId){ docs(pagination:{first:$first, offset:$offset, after:$after}){ totalCount pageInfo{ hasNextPage endCursor } edges{ cursor node{ id workspaceId title summary public defaultRole createdAt updatedAt } } } } }`;
      const data = await gql.request<{ workspace: any }>(query, { workspaceId, first: parsed.first, offset: parsed.offset, after: parsed.after });
      const docs = data.workspace.docs;
      const nullTitleEdges = docs.edges ? docs.edges.filter((e: any) => !e.node.title) : [];
      if (nullTitleEdges.length > 0) {
        const getDocQuery = `query GetDoc($workspaceId:String!, $docId:String!){ workspace(id:$workspaceId){ doc(docId:$docId){ id title summary } } }`;
        const results = await Promise.allSettled(
          nullTitleEdges.map((edge: any) =>
            gql.request<{ workspace: any }>(getDocQuery, { workspaceId, docId: edge.node.id })
          )
        );
        results.forEach((result, i) => {
          if (result.status === 'fulfilled' && result.value?.workspace?.doc) {
            const doc = result.value.workspace.doc;
            if (doc.title) nullTitleEdges[i].node.title = doc.title;
            if (doc.summary) nullTitleEdges[i].node.summary = doc.summary;
          }
        });
      }
      return text(docs);
    };
  server.registerTool(
    "recent_docs",
    {
      title: "Recent Documents",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    recentDocsHandler as any
  );
  server.registerTool(
    "affine_recent_docs",
    {
      title: "Recent Documents",
      description: "List recently updated docs in a workspace.",
      inputSchema: {
        workspaceId: z.string().optional(),
        first: z.number().optional(),
        offset: z.number().optional(),
        after: z.string().optional()
      }
    },
    recentDocsHandler as any
  );

  const readDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);

      if (!snapshot.missing) {
        return text({
          docId: parsed.docId,
          title: null,
          exists: false,
          blockCount: 0,
          blocks: [],
          plainText: "",
        });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      const noteId = findBlockIdByFlavour(blocks, "affine:note");
      const visited = new Set<string>();
      const blockRows: Array<{
        id: string;
        parentId: string | null;
        flavour: string | null;
        type: string | null;
        text: string | null;
        checked: boolean | null;
        language: string | null;
        childIds: string[];
      }> = [];
      const plainTextLines: string[] = [];
      let title = "";

      const visit = (blockId: string) => {
        if (visited.has(blockId)) return;
        visited.add(blockId);

        const raw = blocks.get(blockId);
        if (!(raw instanceof Y.Map)) return;

        const flavour = raw.get("sys:flavour");
        const parentId = raw.get("sys:parent");
        const type = raw.get("prop:type");
        const textValue = asText(raw.get("prop:text"));
        const language = raw.get("prop:language");
        const checked = raw.get("prop:checked");
        const childIds = childIdsFrom(raw.get("sys:children"));

        if (flavour === "affine:page") {
          title = asText(raw.get("prop:title")) || title;
        }
        if (textValue.length > 0) {
          plainTextLines.push(textValue);
        }

        blockRows.push({
          id: blockId,
          parentId: typeof parentId === "string" ? parentId : null,
          flavour: typeof flavour === "string" ? flavour : null,
          type: typeof type === "string" ? type : null,
          text: textValue.length > 0 ? textValue : null,
          checked: typeof checked === "boolean" ? checked : null,
          language: typeof language === "string" ? language : null,
          childIds,
        });

        for (const childId of childIds) {
          visit(childId);
        }
      };

      if (pageId) {
        visit(pageId);
      } else if (noteId) {
        visit(noteId);
      }
      for (const [id] of blocks) {
        const blockId = String(id);
        if (!visited.has(blockId)) {
          visit(blockId);
        }
      }

      return text({
        docId: parsed.docId,
        title: title || null,
        exists: true,
        blockCount: blockRows.length,
        blocks: blockRows,
        plainText: plainTextLines.join("\n"),
      });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    "read_doc",
    {
      title: "Read Document Content",
      description: "Read document block content via WebSocket snapshot (blocks + plain text).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    readDocHandler as any
  );
  server.registerTool(
    "affine_read_doc_content",
    {
      title: "Read Document Content",
      description: "Read document block content via WebSocket snapshot (blocks + plain text).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
      },
    },
    readDocHandler as any
  );

  // ── read_doc_as_markdown ──────────────────────────────────────────────
  const readDocAsMarkdownHandler = async (parsed: { workspaceId?: string; docId: string; includeBlockIds?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) {
      throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
    }

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);

      if (!snapshot.missing) {
        return text({ docId: parsed.docId, exists: false, markdown: "" });
      }

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      const noteId = findBlockIdByFlavour(blocks, "affine:note");

      let title = "";
      if (pageId) {
        const pageBlock = blocks.get(pageId) as Y.Map<any>;
        if (pageBlock) title = asText(pageBlock.get("prop:title"));
      }

      const noteBlock = noteId ? blocks.get(noteId) as Y.Map<any> : null;
      if (!noteBlock) {
        return text({ docId: parsed.docId, exists: true, title, markdown: title ? `# ${title}\n` : "" });
      }

      const { markdown, blockLineRanges } = blocksToMarkdownWithMap(blocks, noteBlock, title);

      const result: any = { docId: parsed.docId, exists: true, title, markdown };
      if (parsed.includeBlockIds) {
        result.blockMap = blockLineRanges.map(r => {
          const block = blocks.get(r.blockId) as Y.Map<any>;
          return {
            blockId: r.blockId,
            startLine: r.startLine,
            endLine: r.endLine,
            flavour: block?.get("sys:flavour") || null,
            type: block?.get("prop:type") || null,
          };
        });
      }
      return text(result);
    } finally {
      socket.disconnect();
    }
  };

  const readDocAsMarkdownMeta = {
    title: "Read Document as Markdown",
    description: "Read a document and return its content as a markdown string. Much more readable than raw blocks. Set includeBlockIds=true to get a blockMap array mapping each top-level block to its line range — useful for targeted update_block calls.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      includeBlockIds: z.boolean().optional().describe("If true, includes blockMap array with block IDs and line ranges for each top-level block."),
    },
  };
  server.registerTool("read_doc_as_markdown", readDocAsMarkdownMeta, readDocAsMarkdownHandler as any);

  // ── write_doc_from_markdown ───────────────────────────────────────────
  const mdParser = new MarkdownIt();

  /** Convert markdown-it inline tokens to a Y.Text with rich formatting deltas */
  function makeRichText(children: Token[] | null): Y.Text {
    const yt = new Y.Text();
    if (!children || children.length === 0) return yt;
    // Build segments with explicit attributes
    const allKeys = new Set<string>();
    const segments: { text: string; attrs: Record<string, any> }[] = [];
    const active: Record<string, any> = {};
    for (const tok of children) {
      switch (tok.type) {
        case "text":
        case "softbreak": {
          const t = tok.type === "softbreak" ? "\n" : tok.content;
          if (t) segments.push({ text: t, attrs: { ...active } });
          break;
        }
        case "code_inline":
          segments.push({ text: tok.content, attrs: { code: true } });
          allKeys.add("code");
          break;
        case "strong_open": active.bold = true; allKeys.add("bold"); break;
        case "strong_close": delete active.bold; break;
        case "em_open": active.italic = true; allKeys.add("italic"); break;
        case "em_close": delete active.italic; break;
        case "s_open": active.strikethrough = true; allKeys.add("strikethrough"); break;
        case "s_close": delete active.strikethrough; break;
        case "link_open": {
          const href = tok.attrs?.find(a => a[0] === "href")?.[1];
          if (href) { active.link = href; allKeys.add("link"); }
          break;
        }
        case "link_close": delete active.link; break;
        case "image": {
          const alt = tok.content || tok.children?.map(c => c.content).join("") || "";
          if (alt) segments.push({ text: alt, attrs: {} });
          break;
        }
        default:
          if (tok.content) segments.push({ text: tok.content, attrs: {} });
          break;
      }
    }
    // Insert segments with explicit null for inactive attributes (prevents Y.Text inheritance)
    let pos = 0;
    const needsExplicitAttrs = allKeys.size > 0;
    for (const seg of segments) {
      if (!needsExplicitAttrs) {
        yt.insert(pos, seg.text);
      } else {
        const a: Record<string, any> = {};
        for (const key of allKeys) a[key] = seg.attrs[key] ?? null;
        yt.insert(pos, seg.text, a);
      }
      pos += seg.text.length;
    }
    return yt;
  }

  /** Walk markdown-it tokens and create AFFiNE blocks under the given parent */
  function markdownToBlocks(
    tokens: Token[],
    noteId: string,
    blocks: Y.Map<any>,
    noteChildren: Y.Array<any>
  ): void {
    let i = 0;

    function addBlock(parentId: string, parentChildren: Y.Array<any>, flavour: string, props: Record<string, any>): { blockId: string; children: Y.Array<any> } {
      const blockId = generateId();
      const block = new Y.Map<any>();
      setSysFields(block, blockId, flavour);
      block.set("sys:parent", parentId);
      const ch = new Y.Array<string>();
      block.set("sys:children", ch);
      for (const [k, v] of Object.entries(props)) block.set(k, v);
      blocks.set(blockId, block);
      parentChildren.push([blockId]);
      return { blockId, children: ch };
    }

    function getInlineToken(idx: number): Token | null {
      return idx < tokens.length && tokens[idx].type === "inline" ? tokens[idx] : null;
    }

    function processListItems(parentId: string, parentChildren: Y.Array<any>, listType: "bulleted" | "numbered"): void {
      // We're positioned after the list_open token. Process list_item tokens until list_close.
      while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === "bullet_list_close" || tok.type === "ordered_list_close") { i++; return; }
        if (tok.type !== "list_item_open") { i++; continue; }
        i++; // skip list_item_open

        // Next should be paragraph_open + inline + paragraph_close (the item text)
        let itemInline: Token | null = null;
        if (i < tokens.length && tokens[i].type === "paragraph_open") {
          i++; // skip paragraph_open
          itemInline = getInlineToken(i);
          if (itemInline) i++;
          if (i < tokens.length && tokens[i].type === "paragraph_close") i++;
        }

        // Detect todo items: text starting with [ ] or [x]
        let actualType: string = listType;
        let checked = false;
        let inlineChildren = itemInline?.children || null;
        if (listType === "bulleted" && itemInline?.content) {
          const todoMatch = itemInline.content.match(/^\[([ xX])\]\s*/);
          if (todoMatch) {
            actualType = "todo" as any;
            checked = todoMatch[1] !== " ";
            // Strip the [ ]/[x] prefix from the inline children
            if (inlineChildren && inlineChildren.length > 0 && inlineChildren[0].type === "text") {
              inlineChildren = [...inlineChildren];
              const first = { ...inlineChildren[0], content: inlineChildren[0].content.replace(/^\[([ xX])\]\s*/, "") };
              inlineChildren[0] = first as Token;
            }
          }
        }

        const props: Record<string, any> = {
          "prop:type": actualType,
          "prop:text": makeRichText(inlineChildren),
          "prop:checked": actualType === "todo" ? checked : false,
        };
        const item = addBlock(parentId, parentChildren, "affine:list", props);

        // Process nested lists (children of this list item)
        while (i < tokens.length && tokens[i].type !== "list_item_close") {
          if (tokens[i].type === "bullet_list_open") {
            i++;
            processListItems(item.blockId, item.children, "bulleted");
          } else if (tokens[i].type === "ordered_list_open") {
            i++;
            processListItems(item.blockId, item.children, "numbered");
          } else {
            i++; // skip unexpected tokens inside list item
          }
        }
        if (i < tokens.length && tokens[i].type === "list_item_close") i++;
      }
    }

    while (i < tokens.length) {
      const tok = tokens[i];

      // Heading
      if (tok.type === "heading_open") {
        const level = parseInt(tok.tag.replace("h", ""), 10) || 1;
        i++;
        const inline = getInlineToken(i);
        if (inline) i++;
        i++; // heading_close
        addBlock(noteId, noteChildren, "affine:paragraph", {
          "prop:type": `h${level}`,
          "prop:text": makeRichText(inline?.children || null),
        });
        continue;
      }

      // Paragraph — may contain special AFFiNE blocks
      if (tok.type === "paragraph_open") {
        i++;
        const inline = getInlineToken(i);
        if (inline) i++;
        i++; // paragraph_close

        if (inline) {
          const content = inline.content;
          const children = inline.children || [];

          // Detect $$latex$$ block
          const latexMatch = content.match(/^\$\$([\s\S]+)\$\$$/);
          if (latexMatch) {
            addBlock(noteId, noteChildren, "affine:latex", {
              "prop:xywh": "[0,0,16,16]", "prop:index": "a0",
              "prop:lockedBySelf": false, "prop:scale": 1, "prop:rotate": 0,
              "prop:latex": latexMatch[1],
            });
            continue;
          }

          // Detect 📎 attachment
          const attachMatch = content.match(/^📎\s+(.+)$/);
          if (attachMatch) {
            addBlock(noteId, noteChildren, "affine:attachment", {
              "prop:name": attachMatch[1], "prop:type": "application/octet-stream",
              "prop:size": 0, "prop:sourceId": "", "prop:embed": false,
            });
            continue;
          }

          // Detect image: single image token
          if (children.length === 1 && children[0].type === "image") {
            const imgTok = children[0];
            const src = imgTok.attrs?.find(a => a[0] === "src")?.[1] || "";
            const caption = imgTok.content || imgTok.children?.map(c => c.content).join("") || "";
            addBlock(noteId, noteChildren, "affine:image", {
              "prop:sourceId": src === "image" ? "" : src,
              "prop:caption": caption, "prop:width": 0, "prop:height": 0,
              "prop:xywh": "[0,0,0,0]", "prop:index": "a0",
              "prop:lockedBySelf": false, "prop:rotate": 0,
            });
            continue;
          }

          // Detect affine:// linked doc: single link with affine:// href
          if (children.length === 3 && children[0].type === "link_open") {
            const href = children[0].attrs?.find(a => a[0] === "href")?.[1] || "";
            if (href.startsWith("affine://")) {
              const pageId = href.replace("affine://", "");
              const linkText = children[1]?.content || "Linked Doc";
              addBlock(noteId, noteChildren, "affine:embed-linked-doc", {
                "prop:pageId": pageId, "prop:title": linkText,
                "prop:xywh": "[0,0,0,0]", "prop:index": "a0",
                "prop:lockedBySelf": false, "prop:rotate": 0,
                "prop:style": "horizontal",
              });
              continue;
            }
          }

          // Regular paragraph
          addBlock(noteId, noteChildren, "affine:paragraph", {
            "prop:type": "text",
            "prop:text": makeRichText(children),
          });
        }
        continue;
      }

      // Blockquote
      if (tok.type === "blockquote_open") {
        i++;
        // Collect inline content from the paragraph inside blockquote
        if (i < tokens.length && tokens[i].type === "paragraph_open") {
          i++;
          const inline = getInlineToken(i);
          if (inline) i++;
          i++; // paragraph_close
          addBlock(noteId, noteChildren, "affine:paragraph", {
            "prop:type": "quote",
            "prop:text": makeRichText(inline?.children || null),
          });
        }
        // Skip to blockquote_close
        while (i < tokens.length && tokens[i].type !== "blockquote_close") i++;
        i++; // blockquote_close
        continue;
      }

      // Bullet list
      if (tok.type === "bullet_list_open") {
        i++;
        processListItems(noteId, noteChildren, "bulleted");
        continue;
      }

      // Ordered list
      if (tok.type === "ordered_list_open") {
        i++;
        processListItems(noteId, noteChildren, "numbered");
        continue;
      }

      // Fenced code block
      if (tok.type === "fence") {
        addBlock(noteId, noteChildren, "affine:code", {
          "prop:language": tok.info.trim() || "txt",
          "prop:text": makeText(tok.content.replace(/\n$/, "")),
        });
        i++;
        continue;
      }

      // Horizontal rule
      if (tok.type === "hr") {
        addBlock(noteId, noteChildren, "affine:divider", {});
        i++;
        continue;
      }

      // Table
      if (tok.type === "table_open") {
        i++;
        // Collect all rows (thead + tbody)
        const tableRows: Token[][][] = []; // rows of cells, each cell is array of inline children
        while (i < tokens.length && tokens[i].type !== "table_close") {
          if (tokens[i].type === "tr_open") {
            i++;
            const row: Token[][] = [];
            while (i < tokens.length && tokens[i].type !== "tr_close") {
              if (tokens[i].type === "th_open" || tokens[i].type === "td_open") {
                i++;
                const inline = getInlineToken(i);
                if (inline) { row.push(inline.children || []); i++; }
                else row.push([]);
                i++; // th_close/td_close
              } else i++;
            }
            i++; // tr_close
            tableRows.push(row);
          } else i++;
        }
        i++; // table_close

        const nRows = tableRows.length;
        const nCols = nRows > 0 ? Math.max(...tableRows.map(r => r.length)) : 1;

        // Build AFFiNE table block
        const rowIds: string[] = [];
        const colIds: string[] = [];
        const rows: Record<string, any> = {};
        const columns: Record<string, any> = {};
        const cells: Record<string, any> = {};

        for (let r = 0; r < nRows; r++) {
          const rid = generateId();
          rowIds.push(rid);
          rows[rid] = { rowId: rid, order: `r${String(r).padStart(4, "0")}` };
        }
        for (let c = 0; c < nCols; c++) {
          const cid = generateId();
          colIds.push(cid);
          columns[cid] = { columnId: cid, order: `c${String(c).padStart(4, "0")}` };
        }
        for (let r = 0; r < nRows; r++) {
          for (let c = 0; c < nCols; c++) {
            const cellChildren = tableRows[r]?.[c] || [];
            cells[`${rowIds[r]}:${colIds[c]}`] = { text: makeRichText(cellChildren) };
          }
        }

        addBlock(noteId, noteChildren, "affine:table", {
          "prop:rows": rows, "prop:columns": columns, "prop:cells": cells,
          "prop:comments": undefined, "prop:textAlign": undefined,
        });
        continue;
      }

      // Skip unrecognized tokens
      i++;
    }
  }

  const writeDocFromMarkdownHandler = async (parsed: { workspaceId?: string; docId: string; markdown: string; dryRun?: boolean }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);

      const doc = new Y.Doc();
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const noteId = findBlockIdByFlavour(blocks, "affine:note");
      if (!noteId) throw new Error("Document has no note block.");

      // Read current markdown for dry run / diff
      if (parsed.dryRun) {
        const noteBlock = blocks.get(noteId) as Y.Map<any>;
        const pageId = findBlockIdByFlavour(blocks, "affine:page");
        let title = "";
        if (pageId) {
          const pageBlock = blocks.get(pageId) as Y.Map<any>;
          if (pageBlock) title = asText(pageBlock.get("prop:title"));
        }
        const { markdown: currentMd } = blocksToMarkdownWithMap(blocks, noteBlock, title);
        return text({ dryRun: true, currentMarkdown: currentMd, newMarkdown: parsed.markdown });
      }

      const prevSV = Y.encodeStateVector(doc);
      const noteBlock = blocks.get(noteId) as Y.Map<any>;
      const noteChildren = ensureChildrenArray(noteBlock);

      // Delete all existing note children (clear doc body)
      const existingChildIds = childIdsFrom(noteChildren);
      // Remove children from note
      if (noteChildren.length > 0) noteChildren.delete(0, noteChildren.length);
      // Remove child blocks recursively
      for (const cid of existingChildIds) removeBlockTree(blocks, cid);

      // Parse markdown and create new blocks
      // Strip leading title heading if it matches the doc title (avoid duplication)
      let md = parsed.markdown;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      if (pageId) {
        const pageBlock = blocks.get(pageId) as Y.Map<any>;
        const docTitle = asText(pageBlock?.get("prop:title"));
        if (docTitle) {
          const titlePattern = new RegExp(`^#\\s+${docTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\n+`);
          md = md.replace(titlePattern, "");
        }
      }

      const mdTokens = mdParser.parse(md, {});
      markdownToBlocks(mdTokens, noteId, blocks, noteChildren);

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ written: true, docId: parsed.docId, blocksCreated: noteChildren.length });
    } finally {
      socket.disconnect();
    }
  };

  server.registerTool(
    "write_doc_from_markdown",
    {
      title: "Write Document from Markdown",
      description: "Replace the entire body of a document with content parsed from a markdown string. Supports headings, paragraphs, lists (bulleted/numbered/todo), code blocks, blockquotes, tables, dividers, latex ($$...$$), images, attachments (📎), and linked docs (affine://). Use dryRun=true to preview changes without writing. Inline formatting (bold, italic, code, links, strikethrough) is preserved.",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        markdown: z.string().describe("Markdown content to write into the document body"),
        dryRun: z.boolean().optional().describe("If true, returns current and new markdown without writing. Use to preview changes."),
      },
    },
    writeDocFromMarkdownHandler as any
  );

  // ── update_doc_markdown (str_replace style partial update) ────────────
  // Optimized: single WS connection, single doc load, surgical block update.

  /** Render blocks to markdown, returning both the markdown string and a map of top-level block IDs to their line ranges */
  function blocksToMarkdownWithMap(
    blocks: Y.Map<any>, noteBlock: Y.Map<any>, title: string
  ): { markdown: string; blockLineRanges: { blockId: string; startLine: number; endLine: number }[] } {
    const lines: string[] = [];
    const blockLineRanges: { blockId: string; startLine: number; endLine: number }[] = [];
    if (title) lines.push(`# ${title}`, "");

    const renderBlock = (blockId: string, depth: number, listIndex: number[]): void => {
      const raw = blocks.get(blockId);
      if (!(raw instanceof Y.Map)) return;
      const flavour = raw.get("sys:flavour") as string;
      const type = raw.get("prop:type") as string | undefined;
      const blockText = richTextToMarkdown(raw.get("prop:text"));
      const childIds = childIdsFrom(raw.get("sys:children"));
      const indent = "  ".repeat(depth);

      switch (flavour) {
        case "affine:paragraph": {
          if (type && type.startsWith("h") && type.length === 2) {
            const level = parseInt(type[1], 10);
            if (level >= 1 && level <= 6) { lines.push(`${indent}${"#".repeat(level)} ${blockText}`, ""); break; }
          }
          if (type === "quote") { lines.push(`${indent}> ${blockText}`, ""); }
          else { if (blockText) lines.push(`${indent}${blockText}`, ""); }
          for (const cid of childIds) renderBlock(cid, depth, []);
          break;
        }
        case "affine:list": {
          const checked = raw.get("prop:checked");
          let prefix: string;
          let listText = blockText;
          if (type === "todo") { prefix = checked ? "- [x]" : "- [ ]"; }
          else if (type === "numbered") {
            const num = (listIndex[depth] ?? 0) + 1;
            listIndex[depth] = num;
            prefix = `${num}.`;
            listText = listText.replace(/^\d+\.\s*/, "");
          } else { prefix = "-"; }
          lines.push(`${indent}${prefix} ${listText}`);
          for (const cid of childIds) renderBlock(cid, depth + 1, listIndex);
          break;
        }
        case "affine:code": {
          const lang = raw.get("prop:language") || "";
          lines.push(`${indent}\`\`\`${lang}`, blockText, `${indent}\`\`\``, "");
          break;
        }
        case "affine:divider": { lines.push("---", ""); break; }
        case "affine:table": {
          const rowsRaw = raw.get("prop:rows");
          const colsRaw = raw.get("prop:columns");
          const cellsRaw = raw.get("prop:cells");
          const toObj = (v: unknown) => v instanceof Y.Map ? v.toJSON() : (typeof v === "object" && v ? v : {});
          const rowsObj = rowsRaw ? toObj(rowsRaw) as Record<string, { order?: string }> : {};
          const colsObj = colsRaw ? toObj(colsRaw) as Record<string, { order?: string }> : {};
          const sortedRowIds = Object.keys(rowsObj).sort((a, b) => (rowsObj[a]?.order ?? "").localeCompare(rowsObj[b]?.order ?? ""));
          const sortedColIds = Object.keys(colsObj).sort((a, b) => (colsObj[a]?.order ?? "").localeCompare(colsObj[b]?.order ?? ""));
          if (sortedRowIds.length > 0 && sortedColIds.length > 0 && cellsRaw) {
            const readCell = (rowId: string, colId: string): string => {
              const key = `${rowId}:${colId}`;
              if (cellsRaw instanceof Y.Map) {
                const cell = cellsRaw.get(key);
                if (cell instanceof Y.Map) return richTextToMarkdown(cell.get("text"));
                if (cell instanceof Y.Text) return richTextToMarkdown(cell);
              }
              const obj = toObj(cellsRaw) as Record<string, any>;
              const c = obj[key];
              if (c && typeof c === "object" && "text" in c) return String(c.text ?? "");
              return "";
            };
            for (let r = 0; r < sortedRowIds.length; r++) {
              const cells = sortedColIds.map(cid => readCell(sortedRowIds[r], cid));
              lines.push(`| ${cells.join(" | ")} |`);
              if (r === 0) lines.push(`|${sortedColIds.map(() => " --- ").join("|")}|`);
            }
            lines.push("");
          } else {
            const nRows = Math.max(sortedRowIds.length, 1);
            const nCols = Math.max(sortedColIds.length, 1);
            const emptyRow = `|${" |".repeat(nCols)}`;
            lines.push(emptyRow);
            lines.push(`|${" --- |".repeat(nCols)}`);
            for (let r = 1; r < nRows; r++) lines.push(emptyRow);
            lines.push("");
          }
          break;
        }
        case "affine:latex": {
          const latex = raw.get("prop:latex") || "";
          if (latex) lines.push(`${indent}$$${latex}$$`, "");
          break;
        }
        case "affine:image": {
          const caption = raw.get("prop:caption") || "";
          lines.push(`${indent}![${caption}](image)`, "");
          break;
        }
        case "affine:attachment": {
          const name = raw.get("prop:name") || "attachment";
          lines.push(`${indent}📎 ${name}`, "");
          break;
        }
        case "affine:database": {
          const dbTitle = asText(raw.get("prop:title")) || blockText;
          if (dbTitle) lines.push(`${indent}**${dbTitle}**`, "");
          for (const cid of childIds) renderBlock(cid, depth, []);
          if (!dbTitle && childIds.length === 0) lines.push("*(database)*", "");
          break;
        }
        case "affine:bookmark": {
          const url = raw.get("prop:url") || "";
          const bmTitle = raw.get("prop:title") || url;
          lines.push(`[${bmTitle}](${url})`, "");
          break;
        }
        case "affine:embed-linked-doc": {
          const pid = raw.get("prop:pageId") || "";
          const docTitle = raw.get("prop:title") || "Linked Doc";
          lines.push(`[${docTitle}](affine://${pid})`, "");
          break;
        }
        default: {
          if (blockText) lines.push(blockText, "");
          break;
        }
      }
    };

    const noteChildIds = childIdsFrom(noteBlock.get("sys:children"));
    const listIndex: number[] = [];
    let prevWasList = false;
    for (const childId of noteChildIds) {
      const raw = blocks.get(childId);
      const isList = raw instanceof Y.Map && raw.get("sys:flavour") === "affine:list";
      if (!isList) {
        if (prevWasList) lines.push("");
        listIndex.length = 0;
      }
      const startLine = lines.length;
      renderBlock(childId, 0, listIndex);
      blockLineRanges.push({ blockId: childId, startLine, endLine: lines.length });
      prevWasList = isList;
    }

    // Collapse consecutive blank lines
    const collapsed: string[] = [];
    // Map from collapsed line index → original line index
    const collapseMap: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === "" && collapsed.length > 0 && collapsed[collapsed.length - 1] === "") continue;
      collapsed.push(lines[i]);
      collapseMap.push(i);
    }
    while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") { collapsed.pop(); collapseMap.pop(); }

    // Remap blockLineRanges to collapsed line numbers
    // Build reverse map: original line → collapsed line
    const reverseMap = new Array(lines.length).fill(-1);
    for (let ci = 0; ci < collapseMap.length; ci++) reverseMap[collapseMap[ci]] = ci;
    // For lines that were collapsed away, map to the next valid collapsed line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (reverseMap[i] === -1) reverseMap[i] = i + 1 < lines.length ? reverseMap[i + 1] : collapseMap.length;
    }
    for (const range of blockLineRanges) {
      range.startLine = reverseMap[range.startLine] ?? range.startLine;
      range.endLine = reverseMap[range.endLine] !== undefined ? reverseMap[range.endLine] : range.endLine;
    }

    return { markdown: collapsed.join("\n") + "\n", blockLineRanges };
  }

  // ── update_block (edit block text/properties in-place) ────────────────
  const STRUCTURAL_FLAVOURS = new Set(["affine:page", "affine:surface", "affine:note"]);

  const updateBlockHandler = async (parsed: {
    workspaceId?: string; docId: string; blockId: string;
    text?: string; properties?: Record<string, any>;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const block = findBlockById(blocks, parsed.blockId);
      if (!block) throw new Error(`Block '${parsed.blockId}' not found.`);

      const flavour = block.get("sys:flavour") as string;
      if (STRUCTURAL_FLAVOURS.has(flavour)) throw new Error(`Cannot update structural block (${flavour}).`);

      const prevSV = Y.encodeStateVector(doc);

      // Update text in-place (preserves Y.Text identity for CRDT correctness)
      if (parsed.text !== undefined) {
        const yText = block.get("prop:text");
        if (yText instanceof Y.Text) {
          yText.delete(0, yText.length);
          yText.insert(0, parsed.text);
        } else {
          block.set("prop:text", makeText(parsed.text));
        }
      }

      // Update properties
      if (parsed.properties) {
        for (const [key, value] of Object.entries(parsed.properties)) {
          const propKey = key.startsWith("prop:") ? key : `prop:${key}`;
          block.set(propKey, value);
        }
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ updated: true, blockId: parsed.blockId, flavour });
    } finally {
      socket.disconnect();
    }
  };

  const updateBlockMeta = {
    title: "Update Block",
    description: "Edit an existing block's text or properties in-place. Cannot update structural blocks (page, surface, note). For text updates, the Y.Text is modified in-place preserving CRDT identity.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      blockId: z.string().min(1).describe("ID of the block to update"),
      text: z.string().optional().describe("New plain text content for the block"),
      properties: z.record(z.any()).optional().describe("Properties to update, e.g. { type: 'h2', language: 'python', checked: true }"),
    },
  };
  server.registerTool("update_block", updateBlockMeta, updateBlockHandler as any);
  server.registerTool("affine_update_block", updateBlockMeta, updateBlockHandler as any);

  // ── delete_block (remove block + descendants) ─────────────────────────
  const deleteBlockHandler = async (parsed: {
    workspaceId?: string; docId: string; blockId: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const block = findBlockById(blocks, parsed.blockId);
      if (!block) throw new Error(`Block '${parsed.blockId}' not found.`);

      const flavour = block.get("sys:flavour") as string;
      if (STRUCTURAL_FLAVOURS.has(flavour)) throw new Error(`Cannot delete structural block (${flavour}).`);

      // Remove from parent's sys:children
      const parentId = block.get("sys:parent") as string;
      if (parentId) {
        const parent = findBlockById(blocks, parentId);
        if (parent) {
          const children = ensureChildrenArray(parent);
          const idx = indexOfChild(children, parsed.blockId);
          if (idx >= 0) children.delete(idx, 1);
        }
      }

      const prevSV = Y.encodeStateVector(doc);
      removeBlockTree(blocks, parsed.blockId);

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ deleted: true, blockId: parsed.blockId, flavour });
    } finally {
      socket.disconnect();
    }
  };

  const deleteBlockMeta = {
    title: "Delete Block",
    description: "Delete a block and all its descendants from a document. Cannot delete structural blocks (page, surface, note).",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      blockId: z.string().min(1).describe("ID of the block to delete"),
    },
  };
  server.registerTool("delete_block", deleteBlockMeta, deleteBlockHandler as any);
  server.registerTool("affine_delete_block", deleteBlockMeta, deleteBlockHandler as any);

  // ── delete_blocks (bulk delete) ───────────────────────────────────────
  const deleteBlocksHandler = async (parsed: {
    workspaceId?: string; docId: string; blockIds: string[];
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const deleted: string[] = [];
      const prevSV = Y.encodeStateVector(doc);

      for (const blockId of parsed.blockIds) {
        const block = findBlockById(blocks, blockId);
        if (!block) continue; // skip missing blocks

        const flavour = block.get("sys:flavour") as string;
        if (STRUCTURAL_FLAVOURS.has(flavour)) continue; // skip structural blocks

        // Remove from parent's sys:children
        const parentId = block.get("sys:parent") as string;
        if (parentId) {
          const parent = findBlockById(blocks, parentId);
          if (parent) {
            const children = ensureChildrenArray(parent);
            const idx = indexOfChild(children, blockId);
            if (idx >= 0) children.delete(idx, 1);
          }
        }

        removeBlockTree(blocks, blockId);
        deleted.push(blockId);
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ deleted: deleted.length, blockIds: deleted });
    } finally {
      socket.disconnect();
    }
  };

  const deleteBlocksMeta = {
    title: "Delete Multiple Blocks",
    description: "Delete multiple blocks in a single transaction. Skips structural blocks (page, surface, note) and missing blocks.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      blockIds: z.array(z.string().min(1)).describe("Array of block IDs to delete"),
    },
  };
  server.registerTool("delete_blocks", deleteBlocksMeta, deleteBlocksHandler as any);
  server.registerTool("affine_delete_blocks", deleteBlocksMeta, deleteBlocksHandler as any);

  // ── move_block (reorder / reparent a block) ───────────────────────────
  const moveBlockHandler = async (parsed: {
    workspaceId?: string; docId: string; blockId: string;
    placement: { parentId?: string; afterBlockId?: string; beforeBlockId?: string; index?: number };
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));

      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const block = findBlockById(blocks, parsed.blockId);
      if (!block) throw new Error(`Block '${parsed.blockId}' not found.`);

      const flavour = block.get("sys:flavour") as string;
      if (STRUCTURAL_FLAVOURS.has(flavour)) throw new Error(`Cannot move structural block (${flavour}).`);

      // Remove from old parent
      const oldParentId = block.get("sys:parent") as string;
      if (oldParentId) {
        const oldParent = findBlockById(blocks, oldParentId);
        if (oldParent) {
          const oldChildren = ensureChildrenArray(oldParent);
          const idx = indexOfChild(oldChildren, parsed.blockId);
          if (idx >= 0) oldChildren.delete(idx, 1);
        }
      }

      // Resolve new parent + position
      const pl = parsed.placement;
      let newParentId: string;
      let insertIdx: number;

      if (pl.afterBlockId) {
        const ref = findBlockById(blocks, pl.afterBlockId);
        if (!ref) throw new Error(`placement.afterBlockId '${pl.afterBlockId}' not found.`);
        newParentId = ref.get("sys:parent") as string;
        const children = ensureChildrenArray(findBlockById(blocks, newParentId)!);
        insertIdx = indexOfChild(children, pl.afterBlockId) + 1;
      } else if (pl.beforeBlockId) {
        const ref = findBlockById(blocks, pl.beforeBlockId);
        if (!ref) throw new Error(`placement.beforeBlockId '${pl.beforeBlockId}' not found.`);
        newParentId = ref.get("sys:parent") as string;
        const children = ensureChildrenArray(findBlockById(blocks, newParentId)!);
        insertIdx = indexOfChild(children, pl.beforeBlockId);
      } else if (pl.parentId) {
        newParentId = pl.parentId;
        if (!findBlockById(blocks, newParentId)) throw new Error(`placement.parentId '${newParentId}' not found.`);
        const children = ensureChildrenArray(findBlockById(blocks, newParentId)!);
        insertIdx = pl.index !== undefined ? Math.min(pl.index, children.length) : children.length;
      } else {
        throw new Error("placement must specify afterBlockId, beforeBlockId, or parentId.");
      }

      // Insert into new parent
      const prevSV = Y.encodeStateVector(doc);
      const newParent = findBlockById(blocks, newParentId)!;
      ensureChildrenArray(newParent).insert(insertIdx, [parsed.blockId]);
      block.set("sys:parent", newParentId);

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ moved: true, blockId: parsed.blockId, newParentId, insertIdx });
    } finally {
      socket.disconnect();
    }
  };

  const moveBlockMeta = {
    title: "Move Block",
    description: "Move/reorder a block within a document. Specify new position via placement (afterBlockId, beforeBlockId, or parentId + optional index).",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      blockId: z.string().min(1).describe("ID of the block to move"),
      placement: z.object({
        parentId: z.string().optional().describe("Target parent block ID"),
        afterBlockId: z.string().optional().describe("Insert after this block"),
        beforeBlockId: z.string().optional().describe("Insert before this block"),
        index: z.number().optional().describe("Index within parent (used with parentId)"),
      }).describe("New position for the block"),
    },
  };
  server.registerTool("move_block", moveBlockMeta, moveBlockHandler as any);
  server.registerTool("affine_move_block", moveBlockMeta, moveBlockHandler as any);

  // ── update_doc_title ──────────────────────────────────────────────────
  const updateDocTitleHandler = async (parsed: {
    workspaceId?: string; docId: string; title: string;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);

      // Update prop:title on the page block
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      if (!pageId) throw new Error("Document has no page block.");
      const pageBlock = blocks.get(pageId) as Y.Map<any>;

      const prevSV = Y.encodeStateVector(doc);
      const titleYText = pageBlock.get("prop:title");
      if (titleYText instanceof Y.Text) {
        titleYText.delete(0, titleYText.length);
        titleYText.insert(0, parsed.title);
      } else {
        const yt = new Y.Text();
        yt.insert(0, parsed.title);
        pageBlock.set("prop:title", yt);
      }

      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });

      // Update workspace meta pages entry
      const wsDoc = new Y.Doc();
      const wsSnap = await loadDoc(socket, workspaceId, workspaceId);
      if (wsSnap.missing) Y.applyUpdate(wsDoc, Buffer.from(wsSnap.missing, "base64"));
      const wsPrevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap("meta");
      const pages = wsMeta.get("pages") as Y.Array<Y.Map<any>> | undefined;
      if (pages) {
        pages.forEach((entry: any) => {
          if (entry?.get && entry.get("id") === parsed.docId) {
            entry.set("title", parsed.title);
            entry.set("updatedDate", Date.now());
          }
        });
      }
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, wsPrevSV);
      if (wsDelta.byteLength > 0) {
        await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString("base64"));
      }

      return text({ updated: true, docId: parsed.docId, title: parsed.title });
    } finally {
      socket.disconnect();
    }
  };

  const updateDocTitleMeta = {
    title: "Update Document Title",
    description: "Rename a document. Updates the page block's prop:title and the workspace meta entry.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      title: z.string().min(1).describe("New document title"),
    },
  };
  server.registerTool("update_doc_title", updateDocTitleMeta, updateDocTitleHandler as any);
  server.registerTool("affine_update_doc_title", updateDocTitleMeta, updateDocTitleHandler as any);

  const updateDocMarkdownHandler = async (parsed: {
    workspaceId?: string; docId: string;
    old_markdown: string; new_markdown: string; dryRun?: boolean;
  }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");

    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);

      // 1. Load doc ONCE
      const doc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, parsed.docId);
      if (!snapshot.missing) throw new Error(`Document '${parsed.docId}' not found.`);
      Y.applyUpdate(doc, Buffer.from(snapshot.missing, "base64"));
      const blocks = doc.getMap("blocks") as Y.Map<any>;
      const noteId = findBlockIdByFlavour(blocks, "affine:note");
      if (!noteId) throw new Error("Document has no note block.");
      const noteBlock = blocks.get(noteId) as Y.Map<any>;
      const pageId = findBlockIdByFlavour(blocks, "affine:page");
      let title = "";
      if (pageId) {
        const pageBlock = blocks.get(pageId) as Y.Map<any>;
        if (pageBlock) title = asText(pageBlock.get("prop:title"));
      }

      // 2. Render to markdown WITH block-line mapping
      const { markdown: currentMd, blockLineRanges } = blocksToMarkdownWithMap(blocks, noteBlock, title);

      // 3. str_replace validation
      const idx = currentMd.indexOf(parsed.old_markdown);
      if (idx === -1) throw new Error("old_markdown not found in document. Make sure it matches the exact text from read_doc_as_markdown.");
      if (currentMd.indexOf(parsed.old_markdown, idx + 1) !== -1)
        throw new Error("old_markdown matches multiple locations in the document. Include more surrounding text to make it unique.");

      if (parsed.dryRun) {
        const newMd = currentMd.slice(0, idx) + parsed.new_markdown + currentMd.slice(idx + parsed.old_markdown.length);
        return text({ dryRun: true, currentMarkdown: currentMd, patchedMarkdown: newMd });
      }

      // 4. Convert line ranges to char offsets
      const mdLines = currentMd.split("\n");
      const lineToCharOffset: number[] = [0];
      for (let i = 0; i < mdLines.length; i++) {
        lineToCharOffset.push(lineToCharOffset[i] + mdLines[i].length + 1); // +1 for \n
      }

      // Find affected blocks (those whose char ranges overlap the change)
      const changeStart = idx;
      const changeEnd = idx + parsed.old_markdown.length;
      const affectedBlockIds: string[] = [];
      let firstAffectedIdx = -1;
      let lastAffectedIdx = -1;

      for (let i = 0; i < blockLineRanges.length; i++) {
        const r = blockLineRanges[i];
        const blockStart = lineToCharOffset[r.startLine];
        const blockEnd = lineToCharOffset[r.endLine];
        if (blockEnd > changeStart && blockStart < changeEnd) {
          affectedBlockIds.push(r.blockId);
          if (firstAffectedIdx === -1) firstAffectedIdx = i;
          lastAffectedIdx = i;
        }
      }

      if (affectedBlockIds.length === 0) {
        throw new Error("Change is in title or whitespace only. Use write_doc_from_markdown for title changes.");
      }

      // 5. Extract the new markdown for just the affected region
      const regionStart = lineToCharOffset[blockLineRanges[firstAffectedIdx].startLine];
      const regionEnd = lineToCharOffset[blockLineRanges[lastAffectedIdx].endLine];
      
      // Compute new region directly without allocating full newMd
      const newRegionMd = 
        currentMd.slice(regionStart, idx) + 
        parsed.new_markdown + 
        currentMd.slice(idx + parsed.old_markdown.length, regionEnd);

      // 6. Surgical update: remove affected blocks, parse new region, insert at position
      const prevSV = Y.encodeStateVector(doc);
      const noteChildren = ensureChildrenArray(noteBlock);

      // Find insertion index in noteChildren
      let insertIdx = 0;
      if (firstAffectedIdx > 0) {
        const prevBlockId = blockLineRanges[firstAffectedIdx - 1].blockId;
        const prevIdx = indexOfChild(noteChildren, prevBlockId);
        insertIdx = prevIdx >= 0 ? prevIdx + 1 : 0;
      }

      // Remove affected blocks from noteChildren and blocks map
      for (const bid of affectedBlockIds) {
        const childIdx = indexOfChild(noteChildren, bid);
        if (childIdx >= 0) noteChildren.delete(childIdx, 1);
        removeBlockTree(blocks, bid);
      }

      // Parse new region and collect new block IDs
      const tempNoteId = generateId();
      const tempChildren = new Y.Array<string>();
      const mdTokens = mdParser.parse(newRegionMd, {});
      markdownToBlocks(mdTokens, tempNoteId, blocks, tempChildren);

      // Insert new blocks into real note at insertIdx
      const newBlockIds: string[] = childIdsFrom(tempChildren);
      for (let i = 0; i < newBlockIds.length; i++) {
        const bid = newBlockIds[i];
        const block = blocks.get(bid);
        if (block instanceof Y.Map) block.set("sys:parent", noteId);
        noteChildren.insert(insertIdx + i, [bid]);
      }

      // 7. Push single CRDT delta
      const delta = Y.encodeStateAsUpdate(doc, prevSV);
      await pushDocUpdate(socket, workspaceId, parsed.docId, Buffer.from(delta).toString("base64"))
        .catch(err => { console.error(`pushDocUpdate failed for doc ${parsed.docId}:`, err.message); throw err; });

      // 8. Touch doc meta on same socket
      await touchDocMeta(socket, workspaceId, parsed.docId);

      return text({ patched: true, docId: parsed.docId, blocksRemoved: affectedBlockIds.length, blocksCreated: newBlockIds.length });
    } finally {
      socket.disconnect();
    }
  };

  const updateDocMarkdownMeta = {
    title: "Update Document Markdown",
    description: "Partial doc update using str_replace style. Reads the doc as markdown, finds the old_markdown substring (must match exactly once), replaces it with new_markdown, and writes back. Use dryRun=true to preview changes. Only send the changed section — avoids rewriting the entire doc.",
    inputSchema: {
      workspaceId: WorkspaceId.optional(),
      docId: DocId,
      old_markdown: z.string().describe("Exact markdown substring to find and replace. Must match exactly once in the document."),
      new_markdown: z.string().describe("Replacement markdown string."),
      dryRun: z.boolean().optional().describe("If true, returns current and patched markdown without writing."),
    },
  };
  server.registerTool("update_doc_markdown", updateDocMarkdownMeta, updateDocMarkdownHandler as any);
  server.registerTool("affine_update_doc_markdown", updateDocMarkdownMeta, updateDocMarkdownHandler as any);

  const publishDocHandler = async (parsed: { workspaceId?: string; docId: string; mode?: "Page" | "Edgeless" }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation PublishDoc($workspaceId:String!,$docId:String!,$mode:PublicDocMode){ publishDoc(workspaceId:$workspaceId, docId:$docId, mode:$mode){ id workspaceId public mode } }`;
      const data = await gql.request<{ publishDoc: any }>(mutation, { workspaceId, docId: parsed.docId, mode: parsed.mode });
      return text(data.publishDoc);
    };
  server.registerTool(
    "publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    publishDocHandler as any
  );
  server.registerTool(
    "affine_publish_doc",
    {
      title: "Publish Document",
      description: "Publish a doc (make public).",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        mode: z.enum(["Page","Edgeless"]).optional()
      }
    },
    publishDocHandler as any
  );

  const revokeDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
      const workspaceId = parsed.workspaceId || defaults.workspaceId;
      if (!workspaceId) {
        throw new Error("workspaceId is required. Provide it as a parameter or set AFFINE_WORKSPACE_ID in environment.");
      }
      const mutation = `mutation RevokeDoc($workspaceId:String!,$docId:String!){ revokePublicDoc(workspaceId:$workspaceId, docId:$docId){ id workspaceId public } }`;
      const data = await gql.request<{ revokePublicDoc: any }>(mutation, { workspaceId, docId: parsed.docId });
      return text(data.revokePublicDoc);
    };
  server.registerTool(
    "revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    revokeDocHandler as any
  );
  server.registerTool(
    "affine_revoke_doc",
    {
      title: "Revoke Document",
      description: "Revoke a doc's public access.",
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string()
      }
    },
    revokeDocHandler as any
  );

  // CREATE DOC (high-level)
  const createDocHandler = async (parsed: { workspaceId?: string; title?: string; content?: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error("workspaceId is required. Provide it or set AFFINE_WORKSPACE_ID.");
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);

      // 1) Create doc content
      const docId = generateId();
      const ydoc = new Y.Doc();
      const blocks = ydoc.getMap('blocks');
      const pageId = generateId();
      const page = new Y.Map();
      setSysFields(page, pageId, "affine:page");
      const titleText = new Y.Text();
      titleText.insert(0, parsed.title || 'Untitled');
      page.set('prop:title', titleText);
      const children = new Y.Array();
      page.set('sys:children', children);
      blocks.set(pageId, page);

      const surfaceId = generateId();
      const surface = new Y.Map();
      setSysFields(surface, surfaceId, "affine:surface");
      surface.set('sys:parent', pageId);
      surface.set('sys:children', new Y.Array());
      const elements = new Y.Map<any>();
      elements.set("type", "$blocksuite:internal:native$");
      elements.set("value", new Y.Map<any>());
      surface.set("prop:elements", elements);
      blocks.set(surfaceId, surface);
      children.push([surfaceId]);

      const noteId = generateId();
      const note = new Y.Map();
      setSysFields(note, noteId, "affine:note");
      note.set('sys:parent', pageId);
      note.set('prop:displayMode', 'both');
      note.set('prop:xywh', '[0,0,800,95]');
      note.set('prop:index', 'a0');
      note.set('prop:hidden', false);
      const background = new Y.Map<any>();
      background.set("light", "#ffffff");
      background.set("dark", "#252525");
      note.set("prop:background", background);
      const noteChildren = new Y.Array();
      note.set('sys:children', noteChildren);
      blocks.set(noteId, note);
      children.push([noteId]);

      if (parsed.content) {
        // Parse content as markdown into rich blocks
        const mdTokens = mdParser.parse(parsed.content, {});
        markdownToBlocks(mdTokens, noteId, blocks, noteChildren);
      }

      const meta = ydoc.getMap('meta');
      meta.set('id', docId);
      meta.set('title', parsed.title || 'Untitled');
      meta.set('createDate', Date.now());
      meta.set('tags', new Y.Array());

      const updateFull = Y.encodeStateAsUpdate(ydoc);
      const updateBase64 = Buffer.from(updateFull).toString('base64');
      await pushDocUpdate(socket, workspaceId, docId, updateBase64);

      // 2) Update workspace root pages list
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) {
        Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
      }
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap('meta');
      let pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
      if (!pages) {
        pages = new Y.Array();
        wsMeta.set('pages', pages);
      }
      const entry = new Y.Map();
      entry.set('id', docId);
      entry.set('title', parsed.title || 'Untitled');
      entry.set('createDate', Date.now());
      entry.set('updatedDate', Date.now());
      entry.set('tags', new Y.Array());
      pages.push([entry as any]);
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      const wsDeltaB64 = Buffer.from(wsDelta).toString('base64');
      await pushDocUpdate(socket, workspaceId, workspaceId, wsDeltaB64);

      return text({ docId, title: parsed.title || 'Untitled' });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    createDocHandler as any
  );
  server.registerTool(
    'affine_create_doc',
    {
      title: 'Create Document',
      description: 'Create a new AFFiNE document with optional content',
      inputSchema: {
        workspaceId: z.string().optional(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    createDocHandler as any
  );

  // APPEND PARAGRAPH
  const appendParagraphHandler = async (parsed: { workspaceId?: string; docId: string; text: string }) => {
    const result = await appendBlockInternal({
      workspaceId: parsed.workspaceId,
      docId: parsed.docId,
      type: "paragraph",
      text: parsed.text,
    });
    return text({ appended: result.appended, paragraphId: result.blockId });
  };
  server.registerTool(
    'append_paragraph',
    {
      title: 'Append Paragraph',
      description: 'Append a text paragraph block to a document',
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        text: z.string(),
      },
    },
    appendParagraphHandler as any
  );
  server.registerTool(
    'affine_append_paragraph',
    {
      title: 'Append Paragraph',
      description: 'Append a text paragraph block to a document',
      inputSchema: {
        workspaceId: z.string().optional(),
        docId: z.string(),
        text: z.string(),
      },
    },
    appendParagraphHandler as any
  );

  const appendBlockHandler = async (parsed: {
    workspaceId?: string;
    docId: string;
    type: string;
    text?: string;
    url?: string;
    pageId?: string;
    iframeUrl?: string;
    html?: string;
    design?: string;
    reference?: string;
    refFlavour?: string;
    width?: number;
    height?: number;
    background?: string;
    sourceId?: string;
    name?: string;
    mimeType?: string;
    size?: number;
    embed?: boolean;
    rows?: number;
    columns?: number;
    latex?: string;
    checked?: boolean;
    language?: string;
    caption?: string;
    level?: number;
    style?: AppendBlockListStyle;
    bookmarkStyle?: AppendBlockBookmarkStyle;
    strict?: boolean;
    placement?: AppendPlacement;
  }) => {
    const result = await appendBlockInternal(parsed);
    return text({
      appended: result.appended,
      blockId: result.blockId,
      flavour: result.flavour,
      type: result.blockType || null,
      normalizedType: result.normalizedType,
      legacyType: result.legacyType,
    });
  };
  server.registerTool(
    "append_block",
    {
      title: "Append Block",
      description: "Append document blocks with canonical types and legacy aliases (supports placement + strict validation).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        type: z.string().min(1).describe("Block type. Canonical: paragraph|heading|quote|list|code|divider|callout|latex|table|bookmark|image|attachment|embed_youtube|embed_github|embed_figma|embed_loom|embed_html|embed_linked_doc|embed_synced_doc|embed_iframe|database|data_view|surface_ref|frame|edgeless_text|note. Legacy aliases remain supported."),
        text: z.string().optional().describe("Block content text"),
        url: z.string().optional().describe("URL for bookmark/embeds"),
        pageId: z.string().optional().describe("Target page/doc id for linked/synced doc embeds"),
        iframeUrl: z.string().optional().describe("Override iframe src for embed_iframe"),
        html: z.string().optional().describe("Raw html for embed_html"),
        design: z.string().optional().describe("Design payload for embed_html"),
        reference: z.string().optional().describe("Target id for surface_ref"),
        refFlavour: z.string().optional().describe("Target flavour for surface_ref (e.g. affine:frame)"),
        width: z.number().int().min(1).max(10000).optional().describe("Width for frame/edgeless_text/note"),
        height: z.number().int().min(1).max(10000).optional().describe("Height for frame/edgeless_text/note"),
        background: z.string().optional().describe("Background for frame/note"),
        sourceId: z.string().optional().describe("Blob source id for image/attachment"),
        name: z.string().optional().describe("Attachment file name"),
        mimeType: z.string().optional().describe("Attachment mime type"),
        size: z.number().optional().describe("Attachment/image file size in bytes"),
        embed: z.boolean().optional().describe("Attachment embed mode"),
        rows: z.number().int().min(1).max(20).optional().describe("Table row count"),
        columns: z.number().int().min(1).max(20).optional().describe("Table column count"),
        latex: z.string().optional().describe("Latex expression"),
        level: z.number().int().min(1).max(6).optional().describe("Heading level for type=heading"),
        style: AppendBlockListStyle.optional().describe("List style for type=list"),
        bookmarkStyle: AppendBlockBookmarkStyle.optional().describe("Bookmark card style"),
        checked: z.boolean().optional().describe("Todo state when type is todo"),
        language: z.string().optional().describe("Code language when type is code"),
        caption: z.string().optional().describe("Code caption when type is code"),
        strict: z.boolean().optional().describe("Strict validation mode (default true)"),
        placement: z
          .object({
            parentId: z.string().optional(),
            afterBlockId: z.string().optional(),
            beforeBlockId: z.string().optional(),
            index: z.number().int().min(0).optional(),
          })
          .optional()
          .describe("Optional insertion target/position"),
      },
    },
    appendBlockHandler as any
  );
  server.registerTool(
    "affine_append_block",
    {
      title: "Append Block",
      description: "Append document blocks with canonical types and legacy aliases (supports placement + strict validation).",
      inputSchema: {
        workspaceId: WorkspaceId.optional(),
        docId: DocId,
        type: z.string().min(1).describe("Block type."),
        text: z.string().optional(), url: z.string().optional(), pageId: z.string().optional(),
        iframeUrl: z.string().optional(), html: z.string().optional(), design: z.string().optional(),
        reference: z.string().optional(), refFlavour: z.string().optional(),
        width: z.number().int().min(1).max(10000).optional(), height: z.number().int().min(1).max(10000).optional(),
        background: z.string().optional(), sourceId: z.string().optional(), name: z.string().optional(),
        mimeType: z.string().optional(), size: z.number().optional(), embed: z.boolean().optional(),
        rows: z.number().int().min(1).max(20).optional(), columns: z.number().int().min(1).max(20).optional(),
        latex: z.string().optional(), level: z.number().int().min(1).max(6).optional(),
        style: AppendBlockListStyle.optional(), bookmarkStyle: AppendBlockBookmarkStyle.optional(),
        checked: z.boolean().optional(), language: z.string().optional(), caption: z.string().optional(),
        strict: z.boolean().optional(),
        placement: z.object({
          parentId: z.string().optional(), afterBlockId: z.string().optional(),
          beforeBlockId: z.string().optional(), index: z.number().int().min(0).optional(),
        }).optional(),
      },
    },
    appendBlockHandler as any
  );

  // DELETE DOC
  const deleteDocHandler = async (parsed: { workspaceId?: string; docId: string }) => {
    const workspaceId = parsed.workspaceId || defaults.workspaceId;
    if (!workspaceId) throw new Error('workspaceId is required');
    const { endpoint, authHeaders } = getEndpointAndAuthHeaders();
    const wsUrl = wsUrlFromGraphQLEndpoint(endpoint);
    const socket = await connectWorkspaceSocket(wsUrl, authHeaders);
    try {
      await joinWorkspace(socket, workspaceId);
      // remove from workspace pages
      const wsDoc = new Y.Doc();
      const snapshot = await loadDoc(socket, workspaceId, workspaceId);
      if (snapshot.missing) Y.applyUpdate(wsDoc, Buffer.from(snapshot.missing, 'base64'));
      const prevSV = Y.encodeStateVector(wsDoc);
      const wsMeta = wsDoc.getMap('meta');
      const pages = wsMeta.get('pages') as Y.Array<Y.Map<any>> | undefined;
      if (pages) {
        // find by id
        let idx = -1;
        pages.forEach((m: any, i: number) => {
          if (idx >= 0) return;
          if (m.get && m.get('id') === parsed.docId) idx = i;
        });
        if (idx >= 0) pages.delete(idx, 1);
      }
      const wsDelta = Y.encodeStateAsUpdate(wsDoc, prevSV);
      await pushDocUpdate(socket, workspaceId, workspaceId, Buffer.from(wsDelta).toString('base64'));
      // delete doc content
      wsDeleteDoc(socket, workspaceId, parsed.docId);
      return text({ deleted: true });
    } finally {
      socket.disconnect();
    }
  };
  server.registerTool(
    'delete_doc',
    {
      title: 'Delete Document',
      description: 'Delete a document and remove from workspace list',
      inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    },
    deleteDocHandler as any
  );
  server.registerTool(
    'affine_delete_doc',
    {
      title: 'Delete Document',
      description: 'Delete a document and remove from workspace list',
      inputSchema: { workspaceId: z.string().optional(), docId: z.string() },
    },
    deleteDocHandler as any
  );
}
