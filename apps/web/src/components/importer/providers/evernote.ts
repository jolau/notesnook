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

import {
  ContentType,
  error,
  File,
  IFileProvider,
  log,
  Note,
  Notebook,
  ProviderMessage,
  ProviderSettings
} from "@notesnook-importer/core";
import { ElementHandler } from "@notesnook-importer/core/dist/src/providers/evernote/element-handlers";
import { parse, processContent } from "@notesnook-importer/enex";
import { hasClip, normalizeEnml } from "./enml";

/**
 * The stock Evernote provider, with two changes:
 * - checkboxes, web clips and text the stock importer gets wrong are
 *   fixed in the ENML first (see `normalizeEnml`)
 * - the folders around an .enex file become its parent notebooks, so
 *   that an export with stacks as folders keeps its structure. The folder
 *   (or .zip) that was dropped is the export itself, not a notebook.
 */
export class Evernote implements IFileProvider<string[]> {
  id = "evernote" as const;
  type = "file" as const;
  supportedExtensions = [".enex"];
  examples = ["First Notebook.enex", "checklist.enex"];
  version = "1.0.0";
  name = "Evernote";
  helpLink =
    "https://help.notesnook.com/importing-notes/import-notes-from-evernote";
  private ids: Record<string, string> = {};

  filter(file: File) {
    return this.supportedExtensions.includes(file.extension);
  }

  /** the folders all .enex files in a .zip share */
  async preprocess(files: File[]) {
    return commonFolders(
      files
        .filter((file) => file.parent && this.filter(file))
        .map((file) => folders(file))
    );
  }

  async *process(
    file: File,
    settings: ProviderSettings,
    _files: File[],
    zipRoot: string[] = []
  ): AsyncGenerator<ProviderMessage, void, unknown> {
    const notebook = toNotebook([
      ...folders(file).slice(file.parent ? zipRoot.length : 0),
      file.nameWithoutExtension
    ]);

    for await (const chunk of parse(
      file.stream.pipeThrough(new TextDecoderStream())
    )) {
      for (const enNote of chunk) {
        yield log(`Found ${enNote.title}...`);
        const note: Note = {
          id: this.ids[enNote.title || ""],
          title: enNote.title || "",
          tags: enNote.tags,
          dateCreated: enNote.created?.getTime(),
          dateEdited: enNote.updated?.getTime(),
          attachments: [],
          notebooks: [notebook]
        };

        if (enNote.content) {
          const elementHandler = new ElementHandler(
            note,
            enNote,
            settings.hasher,
            this.ids
          );
          try {
            const html = await processContent(
              normalizeEnml(enNote.content),
              elementHandler,
              // a note from the web clipper is kept as one full page clip,
              // unless it is in Evernote 10's format: then normalizeEnml
              // has handled its clip
              hasClip(enNote.content)
                ? { ...enNote, source: undefined, sourceApplication: undefined }
                : enNote
            );
            note.content = { data: html.trim(), type: ContentType.HTML };
          } catch (e) {
            yield error(e, { note });
          }
        }

        yield { type: "note", note };
      }
    }
  }
}

/** The folders a file sits in. Files in a .zip start with the .zip's name. */
function folders(file: File): string[] {
  const parts = (file.path || "").split("/").filter(Boolean);
  parts.pop();
  if (file.parent) parts.shift();
  return parts;
}

export function commonFolders(paths: string[][]): string[] {
  if (paths.length === 0) return [];
  const common = paths[0].slice();
  for (const path of paths) {
    let i = 0;
    while (i < common.length && common[i] === path[i]) i++;
    common.length = i;
  }
  return common;
}

function toNotebook(titles: string[]): Notebook {
  const [title, ...children] = titles;
  return {
    title,
    children: children.length ? [toNotebook(children)] : []
  };
}
