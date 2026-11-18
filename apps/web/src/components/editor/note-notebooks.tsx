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

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Flex, Text } from "@theme-ui/components";
import { DatabaseUpdatedEvent, EVENTS } from "@notesnook/core";
import { strings } from "@notesnook/intl";
import { db } from "../../common/db";
import { navigate } from "../../navigation";
import { useStore as useAppStore } from "../../stores/app-store";
import { MoveToNotebookDialog } from "../../dialogs/move-to-notebook-dialog";
import { Move, Notebook as NotebookIcon } from "../icons";

type Crumb = { id: string; title: string };

/**
 * Where the note is stored: the path of its notebook ("Work › Projects"),
 * each part of which opens that notebook, and a button to move the note
 * to another notebook.
 */
export function NoteNotebooks(props: { noteId: string; readonly: boolean }) {
  const { noteId, readonly } = props;
  const [paths, setPaths] = useState<Crumb[][]>();
  const request = useRef(0);

  const load = useCallback(async () => {
    // only the latest request counts: they can overtake each other
    const id = ++request.current;
    const notebooks = await db.relations
      .to({ id: noteId, type: "note" }, "notebook")
      .resolve();
    const paths = await Promise.all(
      notebooks.map((notebook) => db.notebooks.breadcrumbs(notebook.id))
    );
    if (id === request.current)
      setPaths(paths.filter((path) => path.length > 0));
  }, [noteId]);

  useEffect(() => {
    load();
    // the note moved (here, or from the list), or a notebook was renamed
    const subscription = db.eventManager.subscribe(
      EVENTS.databaseUpdated,
      (event: DatabaseUpdatedEvent) => {
        if (
          event.collection === "relations" ||
          event.collection === "notebooks"
        )
          load();
      }
    );
    return () => {
      subscription.unsubscribe();
    };
  }, [load]);

  if (!paths) return null;

  return (
    <Flex
      data-test-id="note-notebooks"
      sx={{
        alignItems: "center",
        minWidth: 0,
        mr: 2,
        pr: 2,
        borderRight: "1px solid var(--border)"
      }}
    >
      <NotebookIcon size={14} color="icon" sx={{ flexShrink: 0, mr: 1 }} />
      {paths.length === 0 ? (
        <Text variant="body" sx={{ color: "paragraph-secondary" }}>
          {strings.notInNotebook()}
        </Text>
      ) : (
        paths.map((path, index) => (
          <Flex
            key={path[path.length - 1].id}
            sx={{ alignItems: "center", minWidth: 0 }}
          >
            {index > 0 ? <Separator text="," /> : null}
            {path.map((crumb, depth) => (
              <Flex key={crumb.id} sx={{ alignItems: "center", minWidth: 0 }}>
                {depth > 0 ? <Separator text="›" /> : null}
                <Text
                  as="button"
                  variant="body"
                  data-test-id="note-notebook"
                  title={crumb.title}
                  onClick={() => openNotebook(crumb.id)}
                  sx={{
                    bg: "transparent",
                    border: "none",
                    borderRadius: "default",
                    px: "2px",
                    color: "paragraph",
                    cursor: "pointer",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    maxWidth: 200,
                    ":hover": { bg: "hover" }
                  }}
                >
                  {crumb.title}
                </Text>
              </Flex>
            ))}
          </Flex>
        ))
      )}
      {readonly ? null : (
        <Button
          variant="secondary"
          data-test-id="move-note"
          title={strings.moveToNotebook()}
          onClick={() => MoveToNotebookDialog.show({ noteId })}
          sx={{
            display: "flex",
            alignItems: "center",
            flexShrink: 0,
            ml: 1,
            py: 0,
            px: 1
          }}
        >
          <Move size={14} sx={{ mr: "4px" }} />
          <Text variant="body">{strings.move()}</Text>
        </Button>
      )}
    </Flex>
  );
}

function Separator({ text }: { text: string }) {
  return (
    <Text
      variant="body"
      sx={{ color: "paragraph-secondary", mx: "2px", flexShrink: 0 }}
    >
      {text}
    </Text>
  );
}

function openNotebook(id: string) {
  useAppStore.getState().setNavigationTab("notebooks");
  navigate(`/notebooks/${id}`);
}
