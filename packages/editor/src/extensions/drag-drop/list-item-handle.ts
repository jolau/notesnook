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
import {
  EditorState,
  NodeSelection,
  Plugin,
  PluginKey
} from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { Icons } from "../../toolbar/icons.js";
import { getScroller, markerWidth, startItemDrag, zoomOf } from "./drag.js";

/**
 * A drag handle in the gutter of bullet, numbered and check lists, next to
 * whichever item the mouse is over — the way Notion and Evernote do it.
 *
 * These list items have no node view to put a handle in, and giving them
 * one would cost every item of every note, so this is a single element
 * that follows the mouse instead. Task list items have handles of their
 * own. Mouse only: there is no hovering on a touch screen.
 */
export function listItemHandlePlugin(editor: Editor) {
  return new Plugin({
    key: new PluginKey("list-item-handle"),
    view: (view) => new ListItemHandleView(editor, view)
  });
}

/** the items that get this handle */
const ITEM_TYPES = ["listItem", "checkListItem"];
/** list items that do not: the handle stays away from them, and from
 *  whatever is inside them */
const OTHER_ITEM_TYPES = ["taskItem", "outlineListItem"];

/** the handle's size, in CSS pixels */
const HANDLE_WIDTH = 18;
const HANDLE_HEIGHT = 24;
/** the space between the handle and the item's bullet, number or checkbox */
const HANDLE_GAP = 4;
/** how far outside the text the mouse can be and still be on a row: the
 *  handle has to stay reachable */
const GUTTER = 64;
/** how much the mouse can move off an item, into the space between it and
 *  the next, before the handle is gone */
const ROW_SLOP = 6;

type Hovered = { pos: number; element: HTMLElement };

class ListItemHandleView {
  private readonly handle: HTMLElement;
  private hovered?: Hovered;
  private pointer?: { x: number; y: number };
  private frame = 0;
  /** an item is being dragged, by this handle or another one */
  private dragging = false;
  /** the handle stays hidden while typing, until the mouse moves */
  private typing = false;

  constructor(
    private readonly editor: Editor,
    private readonly view: EditorView
  ) {
    this.handle = createHandle();
    this.handle.addEventListener("pointerdown", this.onPointerDown);
    // the handle is not part of the editor's content, so a click on it is
    // not a click on the editor
    this.handle.addEventListener("click", stopPropagation);

    window.addEventListener("pointermove", this.onPointerMove, {
      passive: true
    });
    // scrolling moves the content under the mouse
    window.addEventListener("scroll", this.schedule, {
      passive: true,
      capture: true
    });
    window.addEventListener("blur", this.hide);
    document.documentElement.addEventListener("mouseleave", this.hide);
    view.dom.addEventListener("keydown", this.onKeyDown);
  }

  update(view: EditorView, prevState: EditorState) {
    // the content (and so the item) may have moved
    if (view.state.doc !== prevState.doc) this.hide();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("scroll", this.schedule, { capture: true });
    window.removeEventListener("blur", this.hide);
    document.documentElement.removeEventListener("mouseleave", this.hide);
    this.view.dom.removeEventListener("keydown", this.onKeyDown);
    this.handle.remove();
  }

  private onPointerMove = (event: PointerEvent) => {
    // selecting text, or dragging something else
    if (event.pointerType !== "mouse" || event.buttons !== 0) {
      this.pointer = undefined;
      return this.hide();
    }
    this.typing = false;
    this.pointer = { x: event.clientX, y: event.clientY };
    this.schedule();
  };

  private onKeyDown = () => {
    this.typing = true;
    this.hide();
  };

  private schedule = () => {
    if (!this.frame) this.frame = requestAnimationFrame(this.refresh);
  };

  private refresh = () => {
    this.frame = 0;
    const { pointer } = this;
    if (
      !pointer ||
      this.dragging ||
      this.typing ||
      !this.editor.isEditable ||
      !this.isOverEditor(pointer.x, pointer.y)
    )
      return this.hide();

    const hovered = this.itemAt(pointer.x, pointer.y) ?? this.stay(pointer);
    if (!hovered) return this.hide();
    this.show(hovered);
  };

  private onPointerDown = (event: PointerEvent) => {
    const { hovered, view } = this;
    if (!hovered) return;
    const { pos, element } = hovered;

    startItemDrag(
      this.editor,
      // the item is wherever it was when it was picked up, unless the
      // document has changed since
      () => (view.nodeDOM(pos) === element ? pos : -1),
      event,
      {
        item: element,
        onStart: () => {
          this.dragging = true;
          this.hide();
        },
        onEnd: (dragged) => {
          this.dragging = false;
          if (!dragged) this.select(pos, element);
          this.schedule();
        }
      }
    );
  };

  /** a click on the handle selects the item, with everything nested in it */
  private select(pos: number, element: HTMLElement) {
    const { view } = this;
    if (view.nodeDOM(pos) !== element) return;
    view.dispatch(
      view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos))
    );
    view.focus();
  }

  /**
   * The item on the row at `y`, wherever the mouse is along it — the
   * handle sits in the gutter, so it has to be reachable from there, and
   * left of a nested item is still that item's row, not its parent's.
   * So the row is looked up at its end instead of under the mouse.
   */
  private itemAt(x: number, y: number): Hovered | null {
    const { view } = this;
    const box = view.dom.getBoundingClientRect();

    // a row in a table ends at the end of its cell
    const under = document.elementFromPoint(
      Math.min(Math.max(x, box.left + 1), box.right - 1),
      y
    );
    const cell = under?.closest("td, th");
    const end =
      cell && view.dom.contains(cell)
        ? cell.getBoundingClientRect().right
        : box.right -
          parseFloat(getComputedStyle(view.dom).paddingRight || "0") *
            zoomOf(view.dom);

    const hit = view.posAtCoords({ left: end - 2, top: y });
    if (!hit) return null;

    const $pos = view.state.doc.resolve(hit.pos);
    for (let depth = $pos.depth; depth > 0; depth--) {
      const type = $pos.node(depth).type.name;
      if (OTHER_ITEM_TYPES.includes(type)) return null;
      if (ITEM_TYPES.includes(type)) return this.item($pos.before(depth));
    }

    // between two items: in the list, but not in any of them
    const inside = hit.inside >= 0 && view.state.doc.nodeAt(hit.inside);
    return inside && ITEM_TYPES.includes(inside.type.name)
      ? this.item(hit.inside)
      : null;
  }

  /** over the editor, or close enough to it to be in its gutter */
  private isOverEditor(x: number, y: number) {
    const box = this.view.dom.getBoundingClientRect();
    const gutter = GUTTER * zoomOf(this.view.dom);
    return (
      y >= box.top &&
      y <= box.bottom &&
      x >= box.left - gutter &&
      x <= box.right + gutter
    );
  }

  private item(pos: number): Hovered | null {
    const element = this.view.nodeDOM(pos);
    return element instanceof HTMLElement ? { pos, element } : null;
  }

  /**
   * Nothing is on the row, but the mouse has only just left the item —
   * into the space between two items, say — so keep the handle there.
   */
  private stay(pointer: { x: number; y: number }) {
    const { hovered } = this;
    if (!hovered?.element.isConnected) return undefined;
    const box = hovered.element.getBoundingClientRect();
    const slop = ROW_SLOP * zoomOf(hovered.element);
    return pointer.y >= box.top - slop && pointer.y <= box.bottom + slop
      ? hovered
      : undefined;
  }

  private show(hovered: Hovered) {
    const { handle, view } = this;
    const parent = view.dom.parentElement;
    if (!parent) return;
    // next to the editor, to be styled like it (themes, zoom), but not in
    // it: the editor would take it for content
    if (handle.parentElement !== parent) parent.appendChild(handle);

    const position = this.position(hovered.element);
    if (!position) return this.hide();

    const zoom = zoomOf(handle);
    handle.style.transform = `translate3d(${position.left / zoom}px, ${
      position.top / zoom
    }px, 0)`;
    this.hovered = hovered;
    handle.classList.add("visible");
  }

  private hide = () => {
    this.hovered = undefined;
    this.handle.classList.remove("visible");
  };

  /**
   * Where the handle goes: in front of the item's bullet (or number, or
   * checkbox), in the middle of its first line. Not when that line is
   * scrolled out of sight, though, or the handle would float over whatever
   * is above the note.
   */
  private position(element: HTMLElement) {
    const zoom = zoomOf(element);
    const style = getComputedStyle(element);
    const rtl = style.direction === "rtl";
    const box = element.getBoundingClientRect();

    const width = HANDLE_WIDTH * zoom;
    const height = HANDLE_HEIGHT * zoom;
    const offset = (markerWidth(element) + HANDLE_GAP) * zoom;
    const top =
      firstLineMiddle(element.firstElementChild ?? element) - height / 2;
    const left = rtl ? box.right + offset : box.left - offset - width;

    const visible = getScroller(this.view.dom)?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight
    };
    if (top < visible.top || top + height > visible.bottom) return null;
    return { left, top };
  }
}

function createHandle() {
  const handle = document.createElement("div");
  handle.className = "list-item-handle";
  handle.contentEditable = "false";
  handle.setAttribute("aria-hidden", "true");
  handle.style.width = `${HANDLE_WIDTH}px`;
  handle.style.height = `${HANDLE_HEIGHT}px`;

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", Icons.dragHandle);
  svg.appendChild(path);
  handle.appendChild(svg);
  return handle;
}

/**
 * The middle of the element's first line, on screen. Measured from the
 * text itself, which sits in the middle of its line whatever the line
 * height — and is measured as it is shown, zoomed or not.
 */
function firstLineMiddle(element: Element) {
  const range = document.createRange();
  range.selectNodeContents(element);
  for (const rect of range.getClientRects())
    if (rect.height) return rect.top + rect.height / 2;

  // no text to measure: an empty paragraph, which is a single line
  const box = element.getBoundingClientRect();
  return box.top + box.height / 2;
}

function stopPropagation(event: Event) {
  event.stopPropagation();
}
