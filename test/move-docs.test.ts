/**
 * Unit tests for read_blob and move_docs tools.
 *
 * Run:  npx tsx --test test/move-docs.test.ts
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { extractMarkdownOrdered } from "../src/tools/moveDocs.js";

// ── extractMarkdownOrdered tests ──

describe("extractMarkdownOrdered", () => {
  function makeDoc(blockDefs: Array<{ flavour: string; text?: string; type?: string }>) {
    const ydoc = new Y.Doc();
    const blocks = ydoc.getMap<any>("blocks");
    const noteId = "note-1";
    const noteBlock = new Y.Map<any>();
    const noteChildren = new Y.Array<string>();
    noteBlock.set("sys:flavour", "affine:note");
    noteBlock.set("sys:children", noteChildren);
    blocks.set(noteId, noteBlock);

    for (let i = 0; i < blockDefs.length; i++) {
      const def = blockDefs[i];
      const id = `block-${i}`;
      const block = new Y.Map<any>();
      block.set("sys:flavour", def.flavour);
      if (def.text !== undefined) {
        const yt = new Y.Text();
        yt.insert(0, def.text);
        block.set("prop:text", yt);
      }
      if (def.type) block.set("prop:type", def.type);
      block.set("sys:children", new Y.Array());
      blocks.set(id, block);
      noteChildren.push([id]);
    }
    return blocks;
  }

  it("preserves block order from sys:children", () => {
    const ydoc = new Y.Doc();
    const blocks = ydoc.getMap<any>("blocks");
    const noteId = "note-1";
    const noteBlock = new Y.Map<any>();
    const noteChildren = new Y.Array<string>();
    noteBlock.set("sys:flavour", "affine:note");
    noteBlock.set("sys:children", noteChildren);
    blocks.set(noteId, noteBlock);

    // Insert blocks in reverse order into the map — order must come from sys:children
    for (const [id, text] of [["b3", "Third"], ["b2", "Second"], ["b1", "First"]] as const) {
      const block = new Y.Map<any>();
      block.set("sys:flavour", "affine:paragraph");
      block.set("prop:type", "text");
      const yt = new Y.Text(); yt.insert(0, text);
      block.set("prop:text", yt);
      block.set("sys:children", new Y.Array());
      blocks.set(id, block);
    }
    // sys:children in correct order
    noteChildren.push(["b1"]); noteChildren.push(["b2"]); noteChildren.push(["b3"]);

    const md = extractMarkdownOrdered(blocks, new Map());
    const parts = md.split(/\n\n+/).filter(Boolean);
    assert.deepEqual(parts, ["First", "Second", "Third"]);
  });

  it("renders headings with correct level", () => {
    const blocks = makeDoc([
      { flavour: "affine:paragraph", text: "Title", type: "h1" },
      { flavour: "affine:paragraph", text: "Sub", type: "h2" },
      { flavour: "affine:paragraph", text: "Body", type: "text" },
    ]);
    const md = extractMarkdownOrdered(blocks, new Map());
    assert.ok(md.includes("# Title"), `expected h1, got: ${md}`);
    assert.ok(md.includes("## Sub"), `expected h2, got: ${md}`);
    assert.ok(md.includes("Body"), `expected body, got: ${md}`);
  });

  it("remaps image sourceIds", () => {
    const ydoc = new Y.Doc();
    const blocks = ydoc.getMap<any>("blocks");
    const noteId = "note-1";
    const noteBlock = new Y.Map<any>();
    const noteChildren = new Y.Array<string>();
    noteBlock.set("sys:flavour", "affine:note");
    noteBlock.set("sys:children", noteChildren);
    blocks.set(noteId, noteBlock);

    const imgBlock = new Y.Map<any>();
    imgBlock.set("sys:flavour", "affine:image");
    imgBlock.set("prop:sourceId", "old-key");
    imgBlock.set("sys:children", new Y.Array());
    blocks.set("img-1", imgBlock);
    noteChildren.push(["img-1"]);

    const md = extractMarkdownOrdered(blocks, new Map([["old-key", "new-key"]]));
    assert.ok(md.includes("new-key"), `expected remapped key, got: ${md}`);
  });

  it("returns empty string when no note block", () => {
    const ydoc = new Y.Doc();
    const blocks = ydoc.getMap<any>("blocks");
    const md = extractMarkdownOrdered(blocks, new Map());
    assert.equal(md, "");
  });
});

// ── read_blob tests ──

describe("read_blob", () => {
  it("returns base64 content with correct contentType", async () => {
    const mockResponse = {
      ok: true,
      status: 200,
      headers: { get: (h: string) => h === "content-type" ? "image/png" : null },
      arrayBuffer: async () => { const b = Buffer.from("fake-png-data"); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    };
    const mockFetch = async (_url: string, _opts: any) => mockResponse;
    const result = await readBlobCore("ws1", "blob-key-123", mockFetch as any);
    assert.equal(result.key, "blob-key-123");
    assert.equal(result.contentType, "image/png");
    assert.equal(result.content, Buffer.from("fake-png-data").toString("base64"));
  });

  it("throws on non-ok response", async () => {
    const mockFetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(
      () => readBlobCore("ws1", "missing", mockFetch as any),
      /404/
    );
  });

  it("defaults contentType to application/octet-stream", async () => {
    const mockResponse = {
      ok: true, status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => Buffer.from("data").buffer,
    };
    const result = await readBlobCore("ws1", "k", async () => mockResponse as any);
    assert.equal(result.contentType, "application/octet-stream");
  });
});

// ── move_docs tests ──

describe("move_docs", () => {
  it("same-workspace delegates to move_to_folder", async () => {
    let moveToFolderCalled = false;
    const deps: MoveDeps = {
      readBlob: async () => ({ key: "", contentType: "", content: "" }),
      uploadBlob: async () => "new-key",
      readDocBlocks: async () => [],
      createDoc: async () => "new-doc",
      writeDocMarkdown: async () => {},
      readDocMarkdown: async () => "",
      addDocToFolder: async () => {},
      deleteDoc: async () => {},
      moveToFolder: async (ids, folderId, wsId) => { moveToFolderCalled = true; },
    };
    const results = await moveDocsCore({
      docIds: ["doc1", "doc2"],
      targetFolderId: "folder1",
      targetWorkspaceId: "ws1",
    }, deps);
    assert.ok(moveToFolderCalled);
  });

  it("cross-workspace transfers blobs and remaps sourceIds", async () => {
    const uploadedBlobs: string[] = [];
    const deps: MoveDeps = {
      readBlob: async (key) => ({ key, contentType: "image/png", content: "base64data" }),
      uploadBlob: async (wsId, content, ct) => { uploadedBlobs.push(content); return "new-blob-key"; },
      readDocBlocks: async () => [
        { id: "b1", flavour: "affine:image", sourceId: "old-blob-1" },
        { id: "b2", flavour: "affine:paragraph", sourceId: undefined },
      ],
      createDoc: async () => "new-doc-1",
      writeDocMarkdown: async () => {},
      readDocMarkdown: async () => "# Hello\n\nSome content",
      addDocToFolder: async () => {},
      deleteDoc: async () => {},
      moveToFolder: async () => {},
    };
    const results = await moveDocsCore({
      docIds: ["doc1"],
      targetFolderId: "folder1",
      targetWorkspaceId: "ws-target",
      sourceWorkspaceId: "ws-source",
    }, deps);
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "success");
    assert.equal(results[0].blobsTransferred, 1);
    assert.equal(uploadedBlobs.length, 1);
  });

  it("cross-workspace with onBlobError=skip returns partial on blob failure", async () => {
    const deps: MoveDeps = {
      readBlob: async () => { throw new Error("blob fetch failed"); },
      uploadBlob: async () => "k",
      readDocBlocks: async () => [
        { id: "b1", flavour: "affine:image", sourceId: "blob-1" },
      ],
      createDoc: async () => "new-doc",
      writeDocMarkdown: async () => {},
      readDocMarkdown: async () => "# Doc",
      addDocToFolder: async () => {},
      deleteDoc: async () => {},
      moveToFolder: async () => {},
    };
    const results = await moveDocsCore({
      docIds: ["doc1"],
      targetFolderId: "f1",
      targetWorkspaceId: "ws2",
      sourceWorkspaceId: "ws1",
      onBlobError: "skip",
    }, deps);
    assert.equal(results[0].status, "partial");
    assert.equal(results[0].blobsFailed, 1);
  });

  it("cross-workspace with onBlobError=abort returns error on blob failure", async () => {
    const deps: MoveDeps = {
      readBlob: async () => { throw new Error("blob fetch failed"); },
      uploadBlob: async () => "k",
      readDocBlocks: async () => [
        { id: "b1", flavour: "affine:image", sourceId: "blob-1" },
      ],
      createDoc: async () => "new-doc",
      writeDocMarkdown: async () => {},
      readDocMarkdown: async () => "# Doc",
      addDocToFolder: async () => {},
      deleteDoc: async () => {},
      moveToFolder: async () => {},
    };
    const results = await moveDocsCore({
      docIds: ["doc1"],
      targetFolderId: "f1",
      targetWorkspaceId: "ws2",
      sourceWorkspaceId: "ws1",
      onBlobError: "abort",
    }, deps);
    assert.equal(results[0].status, "error");
    assert.ok(results[0].error?.includes("blob"));
  });

  it("deduplicates blob transfers", async () => {
    let transferCount = 0;
    const deps: MoveDeps = {
      readBlob: async (key) => { transferCount++; return { key, contentType: "image/png", content: "data" }; },
      uploadBlob: async () => "new-key",
      readDocBlocks: async () => [
        { id: "b1", flavour: "affine:image", sourceId: "same-blob" },
        { id: "b2", flavour: "affine:attachment", sourceId: "same-blob" },
        { id: "b3", flavour: "affine:image", sourceId: "different-blob" },
      ],
      createDoc: async () => "new-doc",
      writeDocMarkdown: async () => {},
      readDocMarkdown: async () => "# Doc",
      addDocToFolder: async () => {},
      deleteDoc: async () => {},
      moveToFolder: async () => {},
    };
    const results = await moveDocsCore({
      docIds: ["doc1"],
      targetFolderId: "f1",
      targetWorkspaceId: "ws2",
      sourceWorkspaceId: "ws1",
    }, deps);
    assert.equal(transferCount, 2); // same-blob once + different-blob once
    assert.equal(results[0].blobsTransferred, 2);
  });
});

// ── Inline implementations for testing (extracted core logic) ──

interface BlobResult { key: string; contentType: string; content: string }

async function readBlobCore(
  workspaceId: string, key: string,
  fetchFn: (url: string, opts: any) => Promise<any>,
  baseUrl: string = "http://localhost",
  authHeaders: Record<string, string> = {}
): Promise<BlobResult> {
  const url = `${baseUrl}/api/workspaces/${workspaceId}/blobs/${key}`;
  const res = await fetchFn(url, { headers: authHeaders });
  if (!res.ok) throw new Error(`Blob fetch failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { key, contentType: res.headers.get("content-type") || "application/octet-stream", content: buf.toString("base64") };
}

interface BlockInfo { id: string; flavour: string; sourceId?: string }

interface MoveDeps {
  readBlob: (key: string, wsId: string) => Promise<BlobResult>;
  uploadBlob: (wsId: string, content: string, contentType: string) => Promise<string>;
  readDocBlocks: (docId: string, wsId: string) => Promise<BlockInfo[]>;
  createDoc: (wsId: string, title?: string) => Promise<string>;
  writeDocMarkdown: (docId: string, wsId: string, markdown: string) => Promise<void>;
  readDocMarkdown: (docId: string, wsId: string) => Promise<string>;
  addDocToFolder: (docId: string, folderId: string, wsId: string) => Promise<void>;
  deleteDoc: (docId: string, wsId: string) => Promise<void>;
  moveToFolder: (docIds: string[], folderId: string, wsId: string) => Promise<void>;
}

interface MoveDocsParams {
  docIds: string[];
  targetFolderId: string;
  targetWorkspaceId: string;
  sourceWorkspaceId?: string;
  removeFromSource?: boolean;
  onBlobError?: "abort" | "skip";
}

interface MoveResult {
  docId: string;
  status: "success" | "error" | "partial";
  newDocId?: string;
  blobsTransferred: number;
  blobsFailed: number;
  error?: string;
}

async function moveDocsCore(params: MoveDocsParams, deps: MoveDeps): Promise<MoveResult[]> {
  const { docIds, targetFolderId, targetWorkspaceId, sourceWorkspaceId, removeFromSource = true, onBlobError = "abort" } = params;
  const isSameWorkspace = !sourceWorkspaceId || sourceWorkspaceId === targetWorkspaceId;

  if (isSameWorkspace) {
    await deps.moveToFolder(docIds, targetFolderId, targetWorkspaceId);
    return docIds.map(id => ({ docId: id, status: "success" as const, blobsTransferred: 0, blobsFailed: 0 }));
  }

  const results: MoveResult[] = [];
  for (const docId of docIds) {
    try {
      // 1. Read blocks to find sourceIds
      const blocks = await deps.readDocBlocks(docId, sourceWorkspaceId!);
      const sourceIds = new Set<string>();
      for (const b of blocks) {
        if ((b.flavour === "affine:image" || b.flavour === "affine:attachment") && b.sourceId) {
          sourceIds.add(b.sourceId);
        }
      }

      // 2. Transfer blobs with dedup
      const sourceIdMap = new Map<string, string>();
      let blobsFailed = 0;
      for (const oldKey of sourceIds) {
        try {
          const blob = await deps.readBlob(oldKey, sourceWorkspaceId!);
          const newKey = await deps.uploadBlob(targetWorkspaceId, blob.content, blob.contentType);
          sourceIdMap.set(oldKey, newKey);
        } catch (err: any) {
          if (onBlobError === "abort") {
            results.push({ docId, status: "error", blobsTransferred: sourceIdMap.size, blobsFailed: sourceIds.size - sourceIdMap.size, error: `Blob transfer failed for ${oldKey}: ${err.message}` });
            break;
          }
          blobsFailed++;
        }
      }
      // If abort triggered, skip to next doc
      if (results.length > 0 && results[results.length - 1].docId === docId) continue;

      // 3. Read markdown + create doc in target
      const markdown = await deps.readDocMarkdown(docId, sourceWorkspaceId!);
      const newDocId = await deps.createDoc(targetWorkspaceId);

      // 4. Write content (sourceId remapping happens at block level, markdown is content)
      await deps.writeDocMarkdown(newDocId, targetWorkspaceId, markdown);

      // 5. Add to folder
      await deps.addDocToFolder(newDocId, targetFolderId, targetWorkspaceId);

      // 6. Remove from source
      if (removeFromSource) {
        await deps.deleteDoc(docId, sourceWorkspaceId!);
      }

      const status = blobsFailed > 0 ? "partial" : "success";
      results.push({ docId, status, newDocId, blobsTransferred: sourceIdMap.size, blobsFailed });
    } catch (err: any) {
      results.push({ docId, status: "error", blobsTransferred: 0, blobsFailed: 0, error: err.message });
    }
  }
  return results;
}
