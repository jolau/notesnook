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

import { useEffect, useRef, useState } from "react";
import { Flex, Text } from "@theme-ui/components";
import { Notebook } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { db } from "../common/db";
import { BaseDialogProps, DialogManager } from "../common/dialog-manager";
import Dialog from "../components/dialog";
import Field from "../components/field";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Notebook as NotebookIcon
} from "../components/icons";
import {
  TreeNode,
  VirtualizedTree,
  VirtualizedTreeHandle
} from "../components/virtualized-tree";
import { store as noteStore } from "../stores/note-store";
import { store as notebookStore } from "../stores/notebook-store";
import { showToast } from "../utils/toast";

type MoveToNotebookDialogProps = BaseDialogProps<boolean> & { noteId: string };

/**
 * Moves a note to one notebook: a click on a notebook takes the note out of
 * the notebooks it is in and puts it there. (Adding it to more notebooks
 * than one is what the "Link notebooks" dialog is for.)
 */
export const MoveToNotebookDialog = DialogManager.register(
  function MoveToNotebookDialog({
    onClose,
    noteId
  }: MoveToNotebookDialogProps) {
    const treeRef = useRef<VirtualizedTreeHandle<Notebook>>(null);
    // the notebooks at the top of the tree: all roots, or what a search found
    const [notebooks, setNotebooks] = useState<string[]>([]);
    // where the note is now
    const [current, setCurrent] = useState<string[]>([]);

    useEffect(() => {
      db.notebooks.roots
        .ids(db.settings.getGroupOptions("notebooks"))
        .then(setNotebooks);
      db.relations
        .to({ id: noteId, type: "note" }, "notebook")
        .get()
        .then((relations) => setCurrent(relations.map((r) => r.fromId)));
    }, [noteId]);

    useEffect(() => {
      treeRef.current?.refresh();
    }, [notebooks, current]);

    async function move(notebook: Notebook) {
      if (current.length === 1 && current[0] === notebook.id) {
        onClose(false);
        return;
      }
      try {
        await db.transaction(async () => {
          await db.notes.removeFromAllNotebooks(noteId);
          await db.notes.addToNotebook(notebook.id, noteId);
        });
      } catch (e) {
        if (e instanceof Error) showToast("error", e.message);
        onClose(false);
        return;
      }
      await noteStore.refresh();
      await notebookStore.refresh();
      showToast("success", strings.movedToNotebook(notebook.title));
      onClose(true);
    }

    return (
      <Dialog
        testId="move-to-notebook-dialog"
        isOpen={true}
        title={strings.moveToNotebook()}
        onClose={() => onClose(false)}
        width={500}
        noScroll
        negativeButton={{
          text: strings.cancel(),
          onClick: () => onClose(false)
        }}
      >
        <Flex variant="columnFill" sx={{ height: "60vh", px: 4 }}>
          <Field
            autoFocus
            sx={{ m: 0, mb: 2 }}
            styles={{ input: { p: "7.5px" } }}
            placeholder={strings.searchNotebooks()}
            onChange={async (e) => {
              const query = e.target.value.trim();
              setNotebooks(
                await (query
                  ? db.lookup.notebooks(query).ids()
                  : db.notebooks.roots.ids(
                      db.settings.getGroupOptions("notebooks")
                    ))
              );
            }}
          />
          {notebooks.length > 0 ? (
            <VirtualizedTree
              rootId="root"
              itemHeight={30}
              treeRef={treeRef}
              getChildNodes={({ id, depth }) =>
                childNodes(id === "root" ? notebooks : id, depth)
              }
              renderItem={({ item, expanded, collapse, expand }) => (
                <MoveTarget
                  notebook={item.data}
                  depth={item.depth}
                  isExpandable={item.hasChildren}
                  isExpanded={expanded}
                  toggle={expanded ? collapse : expand}
                  isCurrent={current.includes(item.data.id)}
                  onMove={() => move(item.data)}
                />
              )}
            />
          ) : (
            <Text variant="body" sx={{ my: 2, textAlign: "center" }}>
              {strings.notebooksEmpty()}
            </Text>
          )}
        </Flex>
      </Dialog>
    );
  }
);

/** the notebooks `ids`, or the sub-notebooks of the notebook `ids` */
async function childNodes(ids: string[] | string, depth: number) {
  const notebooks =
    typeof ids === "string"
      ? await db.relations
          .from({ type: "notebook", id: ids }, "notebook")
          .resolve()
      : ((await Promise.all(ids.map((id) => db.notebooks.notebook(id)))).filter(
          Boolean
        ) as Notebook[]);

  const nodes: TreeNode<Notebook>[] = [];
  for (const notebook of notebooks) {
    nodes.push({
      id: notebook.id,
      parentId: typeof ids === "string" ? ids : "root",
      data: notebook,
      depth: depth + 1,
      hasChildren: (await db.relations.from(notebook, "notebook").count()) > 0
    });
  }
  return nodes;
}

function MoveTarget(props: {
  notebook: Notebook;
  depth: number;
  isExpandable: boolean;
  isExpanded: boolean;
  toggle: () => void;
  isCurrent: boolean;
  onMove: () => void;
}) {
  const { notebook, depth, isExpandable, isExpanded, toggle, isCurrent } =
    props;

  return (
    <Flex
      as="li"
      data-test-id="move-target"
      title={notebook.title}
      onClick={(e) => {
        e.stopPropagation();
        props.onMove();
      }}
      sx={{
        alignItems: "center",
        height: 30,
        pl: `${Math.max(depth, 0) * 18 + 4}px`,
        pr: 2,
        borderRadius: "default",
        cursor: "pointer",
        ":hover": { bg: "hover" }
      }}
    >
      {/* the chevron opens the notebook in the tree; the rest moves there */}
      <Flex
        data-test-id={isExpandable ? "toggle-notebook" : undefined}
        sx={{ width: 18, flexShrink: 0 }}
        onClick={(e) => {
          if (!isExpandable) return;
          e.stopPropagation();
          toggle();
        }}
      >
        {isExpandable ? (
          isExpanded ? (
            <ChevronDown size={18} />
          ) : (
            <ChevronRight size={18} />
          )
        ) : null}
      </Flex>
      <NotebookIcon size={16} sx={{ mx: 1, flexShrink: 0 }} />
      <Text
        variant="body"
        sx={{
          flex: 1,
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontWeight: isCurrent ? "bold" : "normal"
        }}
      >
        {notebook.title}
      </Text>
      {isCurrent ? (
        <Check size={16} color="accent" sx={{ flexShrink: 0 }} />
      ) : null}
    </Flex>
  );
}
