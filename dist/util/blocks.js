import * as Y from "yjs";
import MarkdownIt from "markdown-it";
export function blockVersion(flavour) {
    switch (flavour) {
        case "affine:page": return 2;
        case "affine:surface": return 5;
        default: return 1;
    }
}
export function generateId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    let id = '';
    for (let i = 0; i < 10; i++)
        id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
}
export function makeText(content) {
    const yt = new Y.Text();
    if (content.length > 0)
        yt.insert(0, content);
    return yt;
}
export function setSysFields(block, blockId, flavour) {
    block.set("sys:id", blockId);
    block.set("sys:flavour", flavour);
    block.set("sys:version", blockVersion(flavour));
}
const PIPE_PLACEHOLDER = "\uE000PIPE\uE000";
function escapePipes(md) { return md.replace(/\\\|/g, PIPE_PLACEHOLDER); }
function unescapePipes(s) { return s.replace(new RegExp(PIPE_PLACEHOLDER, "g"), "|"); }
export function makeRichText(children) {
    const yt = new Y.Text();
    if (!children || children.length === 0)
        return yt;
    const allKeys = new Set();
    const segments = [];
    const active = {};
    for (const tok of children) {
        switch (tok.type) {
            case "text":
            case "softbreak": {
                const t = tok.type === "softbreak" ? "\n" : unescapePipes(tok.content);
                if (t)
                    segments.push({ text: t, attrs: { ...active } });
                break;
            }
            case "code_inline":
                segments.push({ text: unescapePipes(tok.content), attrs: { code: true } });
                allKeys.add("code");
                break;
            case "strong_open":
                active.bold = true;
                allKeys.add("bold");
                break;
            case "strong_close":
                delete active.bold;
                break;
            case "em_open":
                active.italic = true;
                allKeys.add("italic");
                break;
            case "em_close":
                delete active.italic;
                break;
            case "s_open":
                active.strikethrough = true;
                allKeys.add("strikethrough");
                break;
            case "s_close":
                delete active.strikethrough;
                break;
            case "link_open": {
                const href = tok.attrs?.find(a => a[0] === "href")?.[1];
                if (href) {
                    active.link = href;
                    allKeys.add("link");
                }
                break;
            }
            case "link_close":
                delete active.link;
                break;
            case "image": {
                const alt = tok.content || tok.children?.map(c => c.content).join("") || "";
                if (alt)
                    segments.push({ text: alt, attrs: {} });
                break;
            }
            default:
                if (tok.content)
                    segments.push({ text: tok.content, attrs: {} });
                break;
        }
    }
    let pos = 0;
    const needsExplicitAttrs = allKeys.size > 0;
    for (const seg of segments) {
        if (!needsExplicitAttrs) {
            yt.insert(pos, seg.text);
        }
        else {
            const a = {};
            for (const key of allKeys)
                a[key] = seg.attrs[key] ?? null;
            yt.insert(pos, seg.text, a);
        }
        pos += seg.text.length;
    }
    return yt;
}
export function markdownToBlocks(tokens, noteId, blocks, noteChildren) {
    let i = 0;
    function addBlock(parentId, parentChildren, flavour, props) {
        const blockId = generateId();
        const block = new Y.Map();
        setSysFields(block, blockId, flavour);
        block.set("sys:parent", parentId);
        const ch = new Y.Array();
        block.set("sys:children", ch);
        for (const [k, v] of Object.entries(props))
            block.set(k, v);
        blocks.set(blockId, block);
        parentChildren.push([blockId]);
        return { blockId, children: ch };
    }
    function getInlineToken(idx) {
        return idx < tokens.length && tokens[idx].type === "inline" ? tokens[idx] : null;
    }
    function processListItems(parentId, parentChildren, listType) {
        while (i < tokens.length) {
            const tok = tokens[i];
            if (tok.type === "bullet_list_close" || tok.type === "ordered_list_close") {
                i++;
                return;
            }
            if (tok.type !== "list_item_open") {
                i++;
                continue;
            }
            i++;
            let itemInline = null;
            if (i < tokens.length && tokens[i].type === "paragraph_open") {
                i++;
                itemInline = getInlineToken(i);
                if (itemInline)
                    i++;
                if (i < tokens.length && tokens[i].type === "paragraph_close")
                    i++;
            }
            let actualType = listType;
            let checked = false;
            let inlineChildren = itemInline?.children || null;
            if (listType === "bulleted" && itemInline?.content) {
                const todoMatch = itemInline.content.match(/^\[([ xX])\]\s*/);
                if (todoMatch) {
                    actualType = "todo";
                    checked = todoMatch[1] !== " ";
                    if (inlineChildren && inlineChildren.length > 0 && inlineChildren[0].type === "text") {
                        inlineChildren = [...inlineChildren];
                        const first = { ...inlineChildren[0], content: inlineChildren[0].content.replace(/^\[([ xX])\]\s*/, "") };
                        inlineChildren[0] = first;
                    }
                }
            }
            const props = {
                "prop:type": actualType,
                "prop:text": makeRichText(inlineChildren),
                "prop:checked": actualType === "todo" ? checked : false,
            };
            const item = addBlock(parentId, parentChildren, "affine:list", props);
            while (i < tokens.length && tokens[i].type !== "list_item_close") {
                if (tokens[i].type === "bullet_list_open") {
                    i++;
                    processListItems(item.blockId, item.children, "bulleted");
                }
                else if (tokens[i].type === "ordered_list_open") {
                    i++;
                    processListItems(item.blockId, item.children, "numbered");
                }
                else {
                    i++;
                }
            }
            if (i < tokens.length && tokens[i].type === "list_item_close")
                i++;
        }
    }
    while (i < tokens.length) {
        const tok = tokens[i];
        if (tok.type === "heading_open") {
            const level = parseInt(tok.tag.replace("h", ""), 10) || 1;
            i++;
            const inline = getInlineToken(i);
            if (inline)
                i++;
            i++;
            addBlock(noteId, noteChildren, "affine:paragraph", {
                "prop:type": `h${level}`,
                "prop:text": makeRichText(inline?.children || null),
            });
            continue;
        }
        if (tok.type === "paragraph_open") {
            i++;
            const inline = getInlineToken(i);
            if (inline)
                i++;
            i++;
            if (inline) {
                const content = inline.content;
                const children = inline.children || [];
                const latexMatch = content.match(/^\$\$([\s\S]+)\$\$$/);
                if (latexMatch) {
                    addBlock(noteId, noteChildren, "affine:latex", {
                        "prop:xywh": "[0,0,16,16]", "prop:index": "a0",
                        "prop:lockedBySelf": false, "prop:scale": 1, "prop:rotate": 0,
                        "prop:latex": latexMatch[1],
                    });
                    continue;
                }
                const attachMatch = content.match(/^📎\s+(.+)$/);
                if (attachMatch) {
                    addBlock(noteId, noteChildren, "affine:attachment", {
                        "prop:name": attachMatch[1], "prop:type": "application/octet-stream",
                        "prop:size": 0, "prop:sourceId": "", "prop:embed": false,
                    });
                    continue;
                }
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
                addBlock(noteId, noteChildren, "affine:paragraph", {
                    "prop:type": "text",
                    "prop:text": makeRichText(children),
                });
            }
            continue;
        }
        if (tok.type === "blockquote_open") {
            i++;
            if (i < tokens.length && tokens[i].type === "paragraph_open") {
                i++;
                const inline = getInlineToken(i);
                if (inline)
                    i++;
                i++;
                addBlock(noteId, noteChildren, "affine:paragraph", {
                    "prop:type": "quote",
                    "prop:text": makeRichText(inline?.children || null),
                });
            }
            while (i < tokens.length && tokens[i].type !== "blockquote_close")
                i++;
            i++;
            continue;
        }
        if (tok.type === "bullet_list_open") {
            i++;
            processListItems(noteId, noteChildren, "bulleted");
            continue;
        }
        if (tok.type === "ordered_list_open") {
            i++;
            processListItems(noteId, noteChildren, "numbered");
            continue;
        }
        if (tok.type === "fence") {
            addBlock(noteId, noteChildren, "affine:code", {
                "prop:language": tok.info.trim() || "txt",
                "prop:text": makeText(tok.content.replace(/\n$/, "")),
            });
            i++;
            continue;
        }
        if (tok.type === "hr") {
            addBlock(noteId, noteChildren, "affine:divider", {});
            i++;
            continue;
        }
        if (tok.type === "table_open") {
            i++;
            const tableRows = [];
            while (i < tokens.length && tokens[i].type !== "table_close") {
                if (tokens[i].type === "tr_open") {
                    i++;
                    const row = [];
                    while (i < tokens.length && tokens[i].type !== "tr_close") {
                        if (tokens[i].type === "th_open" || tokens[i].type === "td_open") {
                            i++;
                            const inline = getInlineToken(i);
                            if (inline) {
                                row.push(inline.children || []);
                                i++;
                            }
                            else
                                row.push([]);
                            i++;
                        }
                        else
                            i++;
                    }
                    i++;
                    tableRows.push(row);
                }
                else
                    i++;
            }
            i++;
            const nRows = tableRows.length;
            const nCols = nRows > 0 ? Math.max(...tableRows.map(r => r.length)) : 1;
            const rowIds = [];
            const colIds = [];
            const flatProps = {};
            for (let r = 0; r < nRows; r++) {
                const rid = generateId();
                rowIds.push(rid);
                flatProps[`prop:rows.${rid}.rowId`] = rid;
                flatProps[`prop:rows.${rid}.order`] = `a${String(r).padStart(2, "0")}`;
            }
            for (let c = 0; c < nCols; c++) {
                const cid = generateId();
                colIds.push(cid);
                flatProps[`prop:columns.${cid}.columnId`] = cid;
                flatProps[`prop:columns.${cid}.order`] = `a${String(c).padStart(2, "0")}`;
            }
            for (let r = 0; r < nRows; r++) {
                for (let c = 0; c < nCols; c++) {
                    flatProps[`prop:cells.${rowIds[r]}:${colIds[c]}.text`] = makeRichText(tableRows[r]?.[c] || []);
                }
            }
            addBlock(noteId, noteChildren, "affine:table", {
                ...flatProps,
                "prop:comments": undefined, "prop:textAlign": undefined,
            });
            continue;
        }
        i++;
    }
}
const mdParser = new MarkdownIt({ linkify: true });
/** Parse a markdown string and write blocks into the given note. */
export function applyMarkdownToNote(markdown, noteId, blocks, noteChildren) {
    const tokens = mdParser.parse(escapePipes(markdown), {});
    markdownToBlocks(tokens, noteId, blocks, noteChildren);
}
