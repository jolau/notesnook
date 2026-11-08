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

import { Editor } from "@tiptap/core";
import { Node as ProsemirrorNode, NodeType } from "prosemirror-model";
import { NodeSelection, Selection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { isAndroid, isiOS } from "../../utils/platform.js";

/**
 * Drags a list item by a handle the way Notion does it: nothing in the
 * note moves while the item is dragged. A faded copy of the item (with
 * everything nested in it) follows the pointer, and a line shows where it
 * will land: between two items, as deep as the copy is far to the right —
 * or between two paragraphs, as a list of its own.
 *
 * Pointer events, not the browser's HTML5 drag & drop, which on iOS and
 * Android loses the gesture to text selection and in Firefox never starts
 * inside `contenteditable` at all.
 */

// how far the pointer has to move before this is a drag and not a tap, or
// how long it has to stay down without moving (touch only)
const DRAG_THRESHOLD = 4;
const HOLD_DELAY = 150;
/** how much further in a child of an item starts than the item itself */
const NEST_INDENT = 24;
/** how far short of a depth the dragged item can be and still reach it */
const REACH = 6;
/** drop slots this close together are the same place, at different depths */
const SAME_PLACE = 8;
/** without lists of its own to drop into, a slot further away than this
 *  is too far: the item is not over anything it can be dropped into */
const MAX_DISTANCE = 48;
/** how far outside the note the pointer can be before a drop is cancelled */
const OUTSIDE = 120;
/** a copy taller than this is cut off (see the `.drag-preview` style) */
const PREVIEW_MAX_HEIGHT = 320;
// distance from the edge of the scroller at which auto scrolling starts
const SCROLL_ZONE = 60;
const SCROLL_SPEED = 12;

const DRAGGING_CLASS = "dragging-list-item";

/** a place the item can be dropped */
type Slot = {
  /** where the item goes */
  pos: number;
  /** there is no list here: the item goes in a new one */
  wrap?: boolean;
  /** the item becomes a child of the one before `pos` */
  nest?: boolean;
  /** where the drop line is */
  y: number;
  line: { left: number; right: number };
  /** how deep this is: where the item's text would start (mirrored for
   *  right to left, so that further in is always more) */
  depth: number;
};

type Drag = {
  item: HTMLElement;
  /** the item only drops into lists that can hold this type of node */
  type: NodeType;
  /** the list the item is taken out of: a new list is one like it */
  list: ProsemirrorNode;
  /** which list elements can hold the item, so each is checked only once */
  lists: Map<Element, boolean>;
  pos: number;
  end: number;
  startX: number;
  startY: number;
  /** how deep the item is (see `Slot.depth`) when it is picked up */
  depth: number;
  rtl: boolean;
  preview: HTMLElement;
  line: HTMLElement;
  /** the slots, as they are at one scroll position: nothing else moves */
  slots?: { at: string; slots: Slot[] };
  target?: Slot;
  pointer: { x: number; y: number };
  scroller: HTMLElement | null;
  frame?: number;
};

export type ItemDragOptions = {
  /** the item's element, if the handle is not inside it */
  item?: HTMLElement;
  /** the item has been picked up */
  onStart?: () => void;
  /** the pointer has been let go, after a drag or just a click */
  onEnd?: (dragged: boolean) => void;
};

/**
 * Picks up the list item at `getPos` and moves it wherever it is dropped.
 */
export function startItemDrag(
  editor: Editor,
  getPos: () => number,
  event: PointerEvent,
  options: ItemDragOptions = {}
) {
  const handle = event.currentTarget as HTMLElement;
  const item = options.item ?? handle.closest<HTMLElement>("li");
  if (!editor.isEditable || event.button !== 0 || !item) return;

  event.stopPropagation();
  // the handle has no tap action of its own, so cancelling the default is
  // safe — and on touch it is what stops the WebView from starting a text
  // selection instead of the drag
  if (event.cancelable) event.preventDefault();

  const { view } = editor;
  let drag: Drag | undefined;
  let hold: number | undefined;

  const start = () => {
    clearTimeout(hold);
    if (drag) return drag;

    const pos = getPos();
    const node = pos >= 0 ? view.state.doc.nodeAt(pos) : null;
    if (!node) return undefined;

    if (isAndroid || isiOS) setTimeout(() => editor.commands.blur());
    // whatever was moved (or clicked) before is not what is being moved now
    if (view.state.selection instanceof NodeSelection)
      view.dispatch(
        view.state.tr.setSelection(
          Selection.near(view.state.doc.resolve(pos + 1))
        )
      );

    const box = item.getBoundingClientRect();
    const rtl = getComputedStyle(item).direction === "rtl";
    drag = {
      item,
      type: node.type,
      list: view.state.doc.resolve(pos).parent,
      lists: new Map(),
      pos,
      end: pos + node.nodeSize,
      startX: event.clientX,
      startY: event.clientY,
      depth: rtl ? -box.right : box.left,
      rtl,
      preview: createPreview(view, item, box, rtl),
      line: createLine(view),
      pointer: { x: event.clientX, y: event.clientY },
      scroller: getScroller(view.dom)
    };

    document.documentElement.classList.add(DRAGGING_CLASS);
    options.onStart?.();
    return drag;
  };

  const update = (state: Drag) => {
    const { x, y } = state.pointer;
    movePreview(state, x - state.startX, y - state.startY);
    state.target = findSlot(view, state, x, y);
    showLine(state);
  };

  const move = (e: PointerEvent) => {
    const state =
      drag ??
      (Math.hypot(e.clientX - event.clientX, e.clientY - event.clientY) <
      DRAG_THRESHOLD
        ? undefined
        : start());
    if (!state) return;
    e.preventDefault();
    state.pointer = { x: e.clientX, y: e.clientY };
    update(state);
    autoScroll(state, e.clientY);
  };

  // the note scrolling under the pointer (by itself near the edges, or by
  // the wheel) moves the slots
  const scroll = () => drag && update(drag);

  const keydown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };

  const end = () => {
    const dropped = drag;
    cleanup();
    if (dropped?.target) {
      const at = moveItem(view, dropped, dropped.target);
      if (at !== null && dropped.target.nest) nestItem(editor, at);
    }
    options.onEnd?.(!!dropped);
  };

  const cancel = () => {
    const dragged = !!drag;
    cleanup();
    options.onEnd?.(dragged);
  };

  const cleanup = () => {
    clearTimeout(hold);
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("scroll", scroll, { capture: true });
    window.removeEventListener("keydown", keydown, { capture: true });
    if (!drag) return;
    cancelAnimationFrame(drag.frame ?? 0);
    drag.preview.remove();
    drag.line.remove();
    document.documentElement.classList.remove(DRAGGING_CLASS);
    drag = undefined;
  };

  // NOTE: on `window`, not the handle, which may be re-rendered (or, for
  // the one that follows the mouse, hidden) while the item is dragged
  window.addEventListener("pointermove", move, { passive: false });
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("scroll", scroll, { passive: true, capture: true });
  window.addEventListener("keydown", keydown, { capture: true });
  if (event.pointerType !== "mouse")
    hold = setTimeout(() => {
      const state = start();
      if (state) update(state);
    }, HOLD_DELAY) as unknown as number;
}

/**
 * A faded copy of the item, nested items and all, laid exactly over it —
 * as if lifted off the note — to be moved along with the pointer.
 */
function createPreview(
  view: EditorView,
  item: HTMLElement,
  box: DOMRect,
  rtl: boolean
) {
  const zoom = zoomOf(view.dom);
  const preview = document.createElement("div");
  preview.className = "drag-preview";
  preview.style.direction = rtl ? "rtl" : "ltr";

  const context = document.createElement("div");
  context.className = view.dom.className;
  // `.ProseMirror:first-child` adds a top margin to the editor content; the
  // wrapper is not that, so drop it
  context.style.margin = "0";
  preview.appendChild(context);

  // the list around the item, for its bullet or number or checkbox
  const source = item.parentElement;
  const list = (source ?? document.createElement("ul")).cloneNode(
    false
  ) as HTMLElement;
  list.style.margin = "0";
  context.appendChild(list);

  const clone = item.cloneNode(true) as HTMLElement;
  clone.style.margin = "0";
  clone.classList.remove("ProseMirror-selectednode");
  // the handle is what is being held: hidden, but still taking up its room
  // so that the copy lines up with the item
  clone
    .querySelectorAll<HTMLElement>("[data-drag-handle]")
    .forEach((handle) => (handle.style.visibility = "hidden"));
  // on its own, the item would be numbered as the first of its list
  if (source instanceof HTMLOListElement)
    clone.setAttribute("value", String(source.start + ordinal(source, item)));
  list.appendChild(clone);

  (view.dom.parentElement ?? document.body).appendChild(preview);

  const outer = preview.getBoundingClientRect();
  const inner = clone.getBoundingClientRect();
  preview.style.left = `${(box.left - (inner.left - outer.left)) / zoom}px`;
  preview.style.top = `${(box.top - (inner.top - outer.top)) / zoom}px`;
  preview.style.width = `${(box.width + outer.width - inner.width) / zoom}px`;
  if (box.height > PREVIEW_MAX_HEIGHT * zoom) preview.classList.add("tall");
  return preview;
}

function movePreview(drag: Drag, dx: number, dy: number) {
  const zoom = zoomOf(drag.preview);
  drag.preview.style.transform = `translate3d(${dx / zoom}px, ${
    dy / zoom
  }px, 0)`;
}

/** the line that shows where the item will land */
function createLine(view: EditorView) {
  const line = document.createElement("div");
  line.className = "drop-line";
  (view.dom.parentElement ?? document.body).appendChild(line);
  return line;
}

function showLine({ line, target }: Drag) {
  if (!target) return line.classList.remove("visible");
  const zoom = zoomOf(line);
  line.style.transform = `translate3d(${target.line.left / zoom}px, ${
    target.y / zoom
  }px, 0)`;
  line.style.width = `${(target.line.right - target.line.left) / zoom}px`;
  line.classList.add("visible");
}

/**
 * Where the item would land: of the slots nearest to the pointer, the
 * deepest one the dragged copy reaches — moving it to the right nests it,
 * moving it to the left takes it out of a nested list.
 */
function findSlot(
  view: EditorView,
  drag: Drag,
  x: number,
  y: number
): Slot | undefined {
  const zoom = zoomOf(view.dom);
  const box = view.dom.getBoundingClientRect();
  if (x < box.left - OUTSIDE * zoom || x > box.right + OUTSIDE * zoom)
    return undefined;

  const slots = getSlots(view, drag);
  let nearest = Infinity;
  for (const slot of slots) nearest = Math.min(nearest, Math.abs(slot.y - y));
  const wraps = slots.some((slot) => slot.wrap);
  if (!wraps && nearest > MAX_DISTANCE * zoom) return undefined;

  const here = slots.filter(
    (slot) => Math.abs(slot.y - y) <= nearest + SAME_PLACE * zoom
  );
  const depth = drag.depth + (drag.rtl ? drag.startX - x : x - drag.startX);
  const reached = here.filter((slot) => slot.depth <= depth + REACH * zoom);
  const pick = (a: Slot, b: Slot) =>
    (reached.length ? b.depth > a.depth : b.depth < a.depth) ? b : a;
  return (reached.length ? reached : here).reduce(pick);
}

function getSlots(view: EditorView, drag: Drag) {
  const at = `${drag.scroller?.scrollTop ?? 0}:${window.scrollY}`;
  if (drag.slots?.at !== at)
    drag.slots = { at, slots: collectSlots(view, drag) };
  return drag.slots.slots;
}

/**
 * Every place the item can be dropped: before, between and after the
 * items of the lists that can hold it, as a child of each of their items,
 * and — unless it is a task (a task list is more than a list) — between
 * the paragraphs and such of the note, as a list of its own.
 */
function collectSlots(view: EditorView, drag: Drag): Slot[] {
  const { doc } = view.state;
  const zoom = zoomOf(view.dom);
  const gap = 2 * zoom;
  const slots: Slot[] = [];

  const mirror = (box: DOMRect) => (drag.rtl ? -box.right : box.left);
  const lineFrom = (box: DOMRect, inset: number, list: DOMRect) =>
    drag.rtl
      ? { left: list.left, right: box.right - inset }
      : { left: box.left + inset, right: list.right };

  for (const list of view.dom.querySelectorAll<HTMLElement>("ul, ol")) {
    // nothing goes into the item itself
    if (drag.item.contains(list) || !accepts(view, drag, list)) continue;
    const listBox = list.getBoundingClientRect();
    if (!listBox.height) continue;

    let previous: DOMRect | undefined;
    for (const child of list.children) {
      if (!(child instanceof HTMLElement) || child.tagName !== "LI") continue;
      const box = child.getBoundingClientRect();
      const pos = posOf(view, child);
      if (!box.height || !pos) continue;

      const marker = markerWidth(child) * zoom;
      const line = lineFrom(box, -marker, listBox);
      slots.push({
        pos: pos.before,
        y: previous ? (previous.bottom + box.top) / 2 : box.top - gap,
        line,
        depth: mirror(box)
      });

      // as this item's child — unless it has children it can be one of,
      // which have slots of their own
      const node = doc.nodeAt(pos.before);
      const parent = doc.resolve(pos.before).parent;
      if (
        node &&
        child !== drag.item &&
        !node.lastChild?.type.contentMatch.matchType(drag.type) &&
        node.canReplaceWith(node.childCount, node.childCount, parent.type)
      )
        slots.push({
          pos: pos.after,
          nest: true,
          y: box.bottom + gap,
          line: lineFrom(box, NEST_INDENT * zoom - marker, listBox),
          depth: mirror(box) + NEST_INDENT * zoom
        });

      previous = box;
      if (!nextItem(child)) {
        slots.push({
          pos: pos.after,
          y: box.bottom + gap,
          line,
          depth: mirror(box)
        });
      }
    }
  }

  // NOTE: by name, because a new task list would be more than a list: it
  // has a title and a summary of its own
  if (drag.list.type.name === "taskList") return slots;

  const content = contentBox(view.dom);
  let previousBottom: number | undefined;
  let previousHolds = false;
  doc.forEach((node, offset) => {
    const holds = !!node.type.contentMatch.matchType(drag.type);
    const dom = view.nodeDOM(offset);
    const box = dom instanceof HTMLElement ? dom.getBoundingClientRect() : null;
    if (box?.height) {
      // a list that can hold the item has slots of its own around it
      if (!holds && !previousHolds)
        slots.push({
          pos: offset,
          wrap: true,
          y:
            previousBottom === undefined
              ? box.top - gap
              : (previousBottom + box.top) / 2,
          line: { left: content.left, right: content.right },
          depth: drag.rtl ? -content.right : content.left
        });
      previousBottom = box.bottom;
    }
    previousHolds = holds;
  });
  if (previousBottom !== undefined && !previousHolds)
    slots.push({
      pos: doc.content.size,
      wrap: true,
      y: previousBottom + gap,
      line: { left: content.left, right: content.right },
      depth: drag.rtl ? -content.right : content.left
    });

  return slots;
}

/** the next list item after `item`, if any (not counting anything else) */
function nextItem(item: Element) {
  for (let next = item.nextElementSibling; next; next = next.nextElementSibling)
    if (next.tagName === "LI") return next;
  return null;
}

/** the element's content box, on screen */
function contentBox(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const zoom = zoomOf(element);
  return {
    left: box.left + (parseFloat(style.paddingLeft) || 0) * zoom,
    right: box.right - (parseFloat(style.paddingRight) || 0) * zoom
  };
}

/**
 * Whether `list` is the element holding the items of a list node that the
 * dragged item can be one of. The document does not change during a drag,
 * so the answer is kept.
 */
function accepts(view: EditorView, drag: Drag, list: Element) {
  let result = drag.lists.get(list);
  if (result === undefined) {
    result = !!listNodeOf(view, list)?.type.contentMatch.matchType(drag.type);
    drag.lists.set(list, result);
  }
  return result;
}

/** the node whose children `element` holds, if it holds any */
function listNodeOf(view: EditorView, element: Element) {
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(element, 0));
    if ($pos.depth === 0 || $pos.parentOffset !== 0) return null;
    // `posAtDOM` resolves any element, so make sure this one really belongs
    // to the node: it is either the node's element (a bullet list's `ul`) or
    // inside it (a task list's `ul` is inside its header and tools)
    const dom = view.nodeDOM($pos.before());
    return dom === element ||
      (dom instanceof HTMLElement && dom.contains(element))
      ? $pos.parent
      : null;
  } catch (e) {
    // the element is not part of the document (yet)
    return null;
  }
}

/** the positions around the node `element` renders */
function posOf(view: EditorView, element: HTMLElement) {
  try {
    const $pos = view.state.doc.resolve(view.posAtDOM(element, 0));
    for (let depth = $pos.depth; depth > 0; depth--)
      if (view.nodeDOM($pos.before(depth)) === element)
        return { before: $pos.before(depth), after: $pos.after(depth) };
  } catch (e) {
    // the element is not part of the document (yet)
  }
  return null;
}

/**
 * Moves the item to the slot, returning where it ended up. It is selected
 * there, nested items and all, so that it is clear what moved.
 */
function moveItem(view: EditorView, drag: Drag, target: Slot) {
  const { state } = view;
  const from = drag.pos;
  const item = state.doc.nodeAt(from);
  if (!item || item.type !== drag.type) return null;

  const to = target.pos;
  if (!target.wrap && (to === from || to === from + item.nodeSize)) {
    view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, from)));
    return from;
  }

  // NOTE: `deleteRange`, not `delete`: taking the only child out of a
  // nested list leaves the list empty, and an empty list is not valid
  // content, so it would be filled with a blank item. This takes the list
  // itself away instead.
  const tr = state.tr.deleteRange(from, from + item.nodeSize);
  const at = Math.min(tr.mapping.map(to), tr.doc.content.size);
  const node = target.wrap ? newList(drag.list, item) : item;

  const $at = tr.doc.resolve(at);
  if (!$at.parent.canReplaceWith($at.index(), $at.index(), node.type))
    return null;
  tr.insert(at, node);

  const itemAt = target.wrap ? at + 1 : at;
  if (tr.doc.nodeAt(itemAt)?.type === item.type)
    tr.setSelection(NodeSelection.create(tr.doc, itemAt));

  view.dispatch(tr.setMeta("uiEvent", "drop"));
  return itemAt;
}

/** a list like `list`, but holding only `item` */
function newList(list: ProsemirrorNode, item: ProsemirrorNode) {
  // only the look of the list: its id (and a numbered list's first number)
  // belong to it alone
  const attrs: Record<string, unknown> = {};
  for (const key of ["listType", "textDirection"])
    if (key in list.attrs) attrs[key] = list.attrs[key];
  return list.type.create(attrs, item);
}

function nestItem(editor: Editor, pos: number) {
  const node = editor.state.doc.nodeAt(pos);
  if (!node) return;
  editor
    .chain()
    .setTextSelection(pos + 1)
    .sinkListItem(node.type.name)
    .run();

  // select it again, where it went
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--)
    if ($from.node(depth).type === node.type) {
      editor.commands.setNodeSelection($from.before(depth));
      return;
    }
}

/** dragging past the edge of the note scrolls it */
function autoScroll(drag: Drag, y: number) {
  const box = drag.scroller?.getBoundingClientRect();
  const top = (box?.top ?? 0) + SCROLL_ZONE;
  const bottom = (box?.bottom ?? window.innerHeight) - SCROLL_ZONE;
  const speed = y < top ? -SCROLL_SPEED : y > bottom ? SCROLL_SPEED : 0;

  cancelAnimationFrame(drag.frame ?? 0);
  if (!speed) return;
  const step = () => {
    (drag.scroller ?? window).scrollBy(0, speed);
    drag.frame = requestAnimationFrame(step);
  };
  drag.frame = requestAnimationFrame(step);
}

export function getScroller(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight <= node.clientHeight) continue;
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * How much the element is scaled by a CSS `zoom` around it (the editor
 * zoom setting). Its box is measured scaled, but the lengths it is given
 * are scaled again, so they have to be divided by this first.
 */
export function zoomOf(element: Element) {
  return (element as Element & { currentCSSZoom?: number }).currentCSSZoom || 1;
}

/** the item's place in its list, counting from 0 */
function ordinal(list: HTMLElement, item: HTMLElement) {
  return Math.max(
    Array.from(list.children)
      .filter((child) => child.tagName === "LI")
      .indexOf(item),
    0
  );
}

/** how far in front of the item a check list draws its checkbox (see the
 *  `.simple-checklist > li::after` style) */
const CHECKBOX_SPACE = 24;

/**
 * How much room the item's bullet, number or checkbox takes up in front of
 * it, in CSS pixels (a task item draws its checkbox inside itself). A list
 * marker is not an element that can be measured, so its text is measured
 * instead.
 */
export function markerWidth(item: HTMLElement) {
  const list = item.parentElement;
  if (list?.classList.contains("simple-checklist")) return CHECKBOX_SPACE;
  const style = getComputedStyle(item);
  if (style.listStyleType === "none") return 0;

  const marker =
    list instanceof HTMLOListElement
      ? `${list.start + ordinal(list, item)}. `
      : "• ";
  return measureText(
    marker,
    `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
  );
}

let canvas: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, font: string) {
  canvas ??= document.createElement("canvas").getContext("2d");
  if (!canvas) return 16;
  canvas.font = font;
  return canvas.measureText(text).width;
}
