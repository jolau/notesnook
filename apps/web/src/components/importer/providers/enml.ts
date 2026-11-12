/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import { parseDocument } from "htmlparser2";
import { render } from "dom-serializer";
import { ChildNode, Element, isTag, isText, Text } from "domhandler";
import {
  append,
  appendChild,
  findAll,
  getElementsByTagName,
  prepend,
  removeElement
} from "domutils";

/**
 * The HTML the editor parses into a check list (see the editor's
 * `CheckList` and `CheckListItem` nodes).
 */
const CHECK_LIST_CLASS = "simple-checklist";
const CHECK_LIST_ITEM_CLASS = "simple-checklist--item";

const LISTS = ["ul", "ol"];
const LINES = ["div", "p", "h1", "h2", "h3", "h4", "h5", "h6"];
const INLINE_WRAPPERS = ["a", "span", "font", "b", "i", "u", "strong", "em"];

type Line = {
  /** the element that takes the line's place among its siblings */
  outer: Element;
  /** the element holding the line's content */
  inner: Element;
  checked: boolean;
};

const CLIP_STYLE = /--en-clipped-content\s*:\s*([a-zA-Z]+)/;

/**
 * Rewrites a note's ENML before the stock importer sees it, for what the
 * stock importer gets wrong.
 *
 * Checkboxes become the editor's check lists. The stock importer only
 * keeps a checkbox that sits in a bullet list, and turns it into a task
 * list. Evernote writes checkboxes three ways:
 * - Evernote 10: `<ul style="--en-todo:true"><li style="--en-checked:true">`
 *   (an item without `--en-checked` is an unticked checkbox)
 * - in a list: `<ul><li><div><en-todo checked="true"/>text</div></li></ul>`
 * - on a line: `<div><en-todo checked="true"/>text</div>`
 *
 * Evernote nests lists as `<ul><li/><ul>…</ul></ul>`, which the editor
 * reads as an extra empty item, so nested lists are moved into the item
 * before them.
 *
 * Web clips of a selection and bookmarks become part of the note (the
 * stock importer drops selections and keeps only a bookmark's link), and
 * clips of a site's top (YouTube) are kept like full page clips.
 *
 * Text is escaped once more, because the stock importer writes text out
 * unescaped (code blocks too): `#include <stdio.h>` would otherwise
 * become a tag.
 */
export function normalizeEnml(enml: string): string {
  const document = parseDocument(enml, {
    xmlMode: true,
    decodeEntities: false
  });
  const [note] = getElementsByTagName("en-note", document, true, 1);
  if (!note) return enml;

  convertClips(note);
  nestListsInItems(note);
  convertListCheckboxes(note);
  convertLineCheckboxes(note);
  escapeText(note);

  return render(document, { xmlMode: true, decodeEntities: false });
}

/** Whether a note's ENML has a web clip in Evernote 10's format. */
export function hasClip(enml: string) {
  return CLIP_STYLE.test(enml);
}

function convertClips(root: Element) {
  const clips = findAll((e) => CLIP_STYLE.test(e.attribs.style || ""), [root]);
  for (const clip of clips) {
    const style = clip.attribs.style;
    const type = CLIP_STYLE.exec(style)?.[1];
    if (type === "topsite") {
      clip.attribs.style = style.replace(
        CLIP_STYLE,
        "--en-clipped-content:fullPage"
      );
      continue;
    }
    if (type !== "selection" && type !== "simplified" && type !== "bookmark")
      continue;

    for (const child of clip.children.slice()) prepend(clip, child);
    const url = styleValue(style, "--en-clipped-source-url");
    const title = styleValue(style, "--en-clipped-source-title");
    // a bookmark's card shows its title and link already
    if (type !== "bookmark" && (url || title)) {
      // the same footer as the stock importer's other clips
      const link = new Element("a", url ? { href: url } : {});
      appendChild(link, new Text(title || url || ""));
      const footer = new Element("p", {});
      appendChild(footer, new Text("Clipped from: "));
      appendChild(footer, link);
      prepend(clip, new Element("hr", {}));
      prepend(clip, footer);
    }
    removeElement(clip);
  }
}

/** A custom property's value: a title can hold `;` (as in `&amp;`). */
function styleValue(style: string, name: string) {
  for (const declaration of style.split(/;\s*(?=--[a-zA-Z-]+\s*:)/)) {
    const index = declaration.indexOf(":");
    if (declaration.slice(0, index).trim() === name)
      return declaration
        .slice(index + 1)
        .trim()
        .replace(/;$/, "");
  }
}

function escapeText(node: Element) {
  for (const child of node.children) {
    if (isText(child)) child.data = child.data.replace(/&/g, "&amp;");
    else if (isTag(child)) escapeText(child);
  }
}

function nestListsInItems(root: Element) {
  for (const list of findAll((e) => LISTS.includes(e.name), root.children)) {
    const parent = list.parent;
    if (!parent || !isTag(parent) || !LISTS.includes(parent.name)) continue;

    const previous = previousElement(list);
    if (previous?.name === "li") {
      appendChild(previous, list);
    } else {
      const item = new Element("li", {});
      prepend(list, item);
      appendChild(item, list);
    }
  }
}

function convertListCheckboxes(root: Element) {
  const checked = new Map<Element, boolean>();
  for (const item of findAll((e) => e.name === "li", root.children)) {
    const state = /--en-checked\s*:\s*(true|false)/.exec(
      item.attribs.style || ""
    );
    const todo = findAll(
      (e) => e.name === "en-todo" && closest(e, "li") === item,
      item.children
    )[0];

    const list = item.parent;
    const inCheckList =
      !!list && isTag(list) && /--en-todo\s*:\s*true/.test(list.attribs.style);

    if (state) checked.set(item, state[1] === "true");
    else if (todo) checked.set(item, todo.attribs.checked === "true");
    else if (inCheckList) checked.set(item, false);
    if (todo) removeTodo(todo);
  }
  if (checked.size === 0) return;

  for (const list of findAll((e) => LISTS.includes(e.name), root.children)) {
    const items = list.children.filter(isTag);
    if (!items.some((item) => checked.has(item))) continue;

    // a list can mix checkboxes with plain items: split it into runs
    const { name, attribs } = list;
    let current: Element | undefined;
    let isCheckList = false;
    for (const child of list.children.slice()) {
      if (!isTag(child)) {
        if (current && current !== list) appendChild(current, child);
        continue;
      }

      const isCheckItem = checked.has(child);
      if (!current || isCheckItem !== isCheckList) {
        isCheckList = isCheckItem;
        if (!current) current = list;
        else {
          const next = new Element(name, { ...attribs });
          append(current, next);
          current = next;
        }
        if (isCheckList) {
          current.name = "ul";
          current.attribs = { class: CHECK_LIST_CLASS };
        }
      }

      if (isCheckItem) {
        child.attribs.class = checked.get(child)
          ? `${CHECK_LIST_ITEM_CLASS} checked`
          : CHECK_LIST_ITEM_CLASS;
      }
      if (current !== list) appendChild(current, child);
    }
  }
}

function convertLineCheckboxes(root: Element) {
  const lines = new Map<Element, Line>();
  for (const todo of getElementsByTagName("en-todo", root, true)) {
    const line = lineOf(todo, root);
    if (!lines.has(line.outer)) {
      lines.set(line.outer, {
        ...line,
        checked: todo.attribs.checked === "true"
      });
    }
    removeTodo(todo);
  }

  const parents = new Set(Array.from(lines.keys(), (line) => line.parent));
  for (const parent of parents) {
    if (!parent) continue;

    let list: Element | undefined;
    for (const child of parent.children.slice()) {
      const line = isTag(child) ? lines.get(child) : undefined;
      if (!line) {
        // whitespace between two lines doesn't end the check list
        if (list && isText(child) && !child.data.trim()) {
          removeElement(child);
          continue;
        }
        list = undefined;
        continue;
      }

      if (!list) {
        list = new Element("ul", { class: CHECK_LIST_CLASS });
        prepend(child, list);
      }
      const item = new Element("li", {
        class: line.checked
          ? `${CHECK_LIST_ITEM_CLASS} checked`
          : CHECK_LIST_ITEM_CLASS
      });
      appendChild(list, item);
      removeTrailingBreak(line.inner);
      appendChild(item, line.inner);
      if (line.outer !== line.inner) removeElement(line.outer);
    }
  }
}

/**
 * The line a checkbox starts: the closest `div` (or `p`, heading) around
 * it, stretched over wrappers that hold nothing else, so that consecutive
 * lines end up next to each other in one check list.
 */
function lineOf(todo: Element, root: Element): Omit<Line, "checked"> {
  let node = todo.parent;
  while (node && node !== root && isTag(node) && !LINES.includes(node.name)) {
    if (!INLINE_WRAPPERS.includes(node.name)) break;
    node = node.parent;
  }

  if (!node || node === root || !isTag(node) || !LINES.includes(node.name)) {
    // no line around the checkbox: wrap the text up to the next break
    const inner = wrapInlineRun(todo, node && isTag(node) ? node : root);
    return { outer: inner, inner };
  }

  const inner = node;
  let outer = node;
  while (
    outer.parent &&
    outer.parent !== root &&
    isTag(outer.parent) &&
    outer.parent.name === "div" &&
    outer.parent.children.every(
      (c) => c === outer || (isText(c) && !c.data.trim())
    )
  ) {
    outer = outer.parent;
  }
  return { outer, inner };
}

function wrapInlineRun(todo: Element, container: Element): Element {
  let start: ChildNode = todo;
  while (start.parent && start.parent !== container) start = start.parent;

  const isBreak = (n: ChildNode | null) =>
    !n || (isTag(n) && (n.name === "br" || !isInline(n)));

  let first: ChildNode = start;
  while (!isBreak(first.prev)) first = first.prev as ChildNode;

  const line = new Element("div", {});
  prepend(first, line);
  let node: ChildNode | null = first;
  while (node && !isBreak(node)) {
    const next: ChildNode | null = node.next;
    appendChild(line, node);
    node = next;
  }
  if (node && isTag(node) && node.name === "br") removeElement(node);
  return line;
}

function isInline(element: Element) {
  return (
    INLINE_WRAPPERS.includes(element.name) ||
    element.name.startsWith("en-") ||
    ["img", "code", "sub", "sup", "s", "strike", "del"].includes(element.name)
  );
}

/** Removes a checkbox and the link or span left empty around it. */
function removeTodo(todo: Element) {
  let parent = todo.parent;
  removeElement(todo);
  while (
    parent &&
    isTag(parent) &&
    INLINE_WRAPPERS.includes(parent.name) &&
    parent.children.every((c) => isText(c) && !c.data.trim())
  ) {
    const next: typeof parent.parent = parent.parent;
    removeElement(parent);
    parent = next;
  }
}

function removeTrailingBreak(line: Element) {
  const children = line.children.filter((c) => !isText(c) || c.data.trim());
  const last = children[children.length - 1];
  if (children.length > 1 && last && isTag(last) && last.name === "br")
    removeElement(last);
}

function previousElement(node: ChildNode): Element | undefined {
  let previous = node.prev;
  while (previous && isText(previous) && !previous.data.trim())
    previous = previous.prev;
  return previous && isTag(previous) ? previous : undefined;
}

function closest(node: ChildNode, name: string): Element | undefined {
  let parent = node.parent;
  while (parent && !(isTag(parent) && parent.name === name))
    parent = parent.parent;
  return parent && isTag(parent) ? parent : undefined;
}
