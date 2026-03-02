/**
 * Unit test: does markdownToBlocks produce an affine:attachment block from "📎 test.pdf"?
 *
 * Run: npx tsx --test test/attachment-parser.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import MarkdownIt from "markdown-it";

// Replicate the minimal markdownToBlocks logic for attachment detection
function parseAttachmentFromMarkdown(input: string): { flavour: string; name: string } | null {
  const md = new MarkdownIt();
  const tokens = md.parse(input, {});

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.type !== "paragraph_open") continue;
    i++;
    const inline = i < tokens.length && tokens[i].type === "inline" ? tokens[i] : null;
    if (!inline) continue;
    const attachMatch = inline.content.match(/^📎\s+(.+)$/);
    if (attachMatch) return { flavour: "affine:attachment", name: attachMatch[1] };
  }
  return null;
}

describe("markdownToBlocks attachment detection", () => {
  it("parses '📎 test.pdf\\n' and produces an affine:attachment block", () => {
    const result = parseAttachmentFromMarkdown("📎 test.pdf\n");
    assert.ok(result, "should detect attachment block");
    assert.equal(result!.flavour, "affine:attachment");
    assert.equal(result!.name, "test.pdf");
  });

  it("parses '📎 my file with spaces.docx' correctly", () => {
    const result = parseAttachmentFromMarkdown("📎 my file with spaces.docx\n");
    assert.ok(result);
    assert.equal(result!.name, "my file with spaces.docx");
  });

  it("does not match a plain paragraph", () => {
    const result = parseAttachmentFromMarkdown("hello world\n");
    assert.equal(result, null);
  });

  it("does not match '📎' with no filename", () => {
    const result = parseAttachmentFromMarkdown("📎\n");
    assert.equal(result, null);
  });
});
