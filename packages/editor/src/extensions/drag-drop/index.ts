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

import { Extension } from "@tiptap/core";
import { listItemHandlePlugin } from "./list-item-handle.js";

export { startItemDrag } from "./drag.js";
export type { ItemDragOptions } from "./drag.js";

export type DragDropOptions = {
  /**
   * Show a drag handle next to bullet, numbered and check list items when
   * the mouse is over them (task list items have handles of their own).
   * It needs a mouse, so it is off on touch screens.
   */
  listItemHandle: boolean;
};

/**
 * Moving list items around by dragging them, see `drag.ts`.
 */
export const DragDrop = Extension.create<DragDropOptions>({
  name: "dragDrop",

  addOptions() {
    return { listItemHandle: false };
  },

  addProseMirrorPlugins() {
    return this.options.listItemHandle
      ? [listItemHandlePlugin(this.editor)]
      : [];
  }
});
