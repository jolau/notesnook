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
  IProvider,
  ProviderFactory,
  Providers
} from "@notesnook-importer/core";
import { commonFolders, Evernote } from "./evernote";

/** The importer's providers, with this app's fixes swapped in. */
export function getProvider(name: Providers): IProvider {
  if (name === "evernote") return new Evernote();
  return ProviderFactory.getProvider(name);
}

/**
 * Where each dropped file sits relative to what was dropped: a dropped
 * folder is the export itself, so the folder all files share is cut off.
 */
export function relativePaths(files: File[]): Map<File, string> {
  const paths = files.map((file) => {
    // set by react-dropzone: `/folder/file.enex` for a dropped folder
    const { path } = file as File & { path?: string };
    return (path || file.name)
      .split("/")
      .filter((part) => part && part !== ".");
  });

  const common = commonFolders(paths.map((path) => path.slice(0, -1)));

  return new Map(
    files.map((file, i) => [file, paths[i].slice(common.length).join("/")])
  );
}
