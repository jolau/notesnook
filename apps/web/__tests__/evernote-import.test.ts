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

import "./bootstrap";
import { expect, test } from "vitest";
import { normalizeEnml } from "../src/components/importer/providers/enml";
import { relativePaths } from "../src/components/importer/providers";

const enml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>`;

const body = (enml: string) => /<en-note>([\s\S]*)<\/en-note>/.exec(enml)?.[1];

test("checkboxes on lines become one check list", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<div>Food:</div><div><en-todo checked="true" />Frittata</div><div><en-todo checked="false"/>Pizza<br /></div><div><br /></div><div><en-todo checked="false"/>Ramen</div>`
        )
      )
    )
  ).toBe(
    `<div>Food:</div><ul class="simple-checklist"><li class="simple-checklist--item checked"><div>Frittata</div></li><li class="simple-checklist--item"><div>Pizza</div></li></ul><div><br/></div><ul class="simple-checklist"><li class="simple-checklist--item"><div>Ramen</div></li></ul>`
  );
});

test("a link left empty by its checkbox is removed", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<div><a href="https://a.ch/"><en-todo checked="false" /></a>festo</div><div><span><en-todo checked="true"/> abb</span></div>`
        )
      )
    )
  ).toBe(
    `<ul class="simple-checklist"><li class="simple-checklist--item"><div>festo</div></li><li class="simple-checklist--item checked"><div><span> abb</span></div></li></ul>`
  );
});

test("Evernote 10 check lists, with a plain item in the middle", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<ul style="--en-todo:true;"><li style="--en-checked:false;"><div>ask</div></li><li><div>note</div></li><li style="--en-checked:true;"><div>done</div></li></ul>`
        )
      )
    )
  ).toBe(
    `<ul class="simple-checklist"><li style="--en-checked:false;" class="simple-checklist--item"><div>ask</div></li></ul><ul style="--en-todo:true;"><li><div>note</div></li></ul><ul class="simple-checklist"><li style="--en-checked:true;" class="simple-checklist--item checked"><div>done</div></li></ul>`
  );
});

test("checkboxes in a list, with a nested list", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<ul><li><div><en-todo checked="false"/>Visitenkarte</div></li><ul><li><div><en-todo checked="true"/>designen</div></li></ul><li><div><en-todo checked="false"/>Laptop</div></li></ul>`
        )
      )
    )
  ).toBe(
    `<ul class="simple-checklist"><li class="simple-checklist--item"><div>Visitenkarte</div><ul class="simple-checklist"><li class="simple-checklist--item checked"><div>designen</div></li></ul></li><li class="simple-checklist--item"><div>Laptop</div></li></ul>`
  );
});

test("a nested list without an item before it gets its own item", () => {
  expect(
    body(normalizeEnml(enml(`<ul><ul><li>a</li></ul><li>b</li></ul>`)))
  ).toBe(`<ul><li><ul><li>a</li></ul></li><li>b</li></ul>`);
});

test("a checkbox without a line around it", () => {
  expect(
    body(
      normalizeEnml(
        enml(`text<br/><en-todo checked="true"/>first<br/>after<div>x</div>`)
      )
    )
  ).toBe(
    `text<br/><ul class="simple-checklist"><li class="simple-checklist--item checked"><div>first</div></li></ul>after<div>x</div>`
  );
});

test("entities and other markup are left alone", () => {
  const input = enml(
    `<div>Caf&#xE9; &amp; &nbsp;<en-media hash="abc" type="image/png"/></div><table><tr><td><div>x</div></td></tr></table>`
  );
  expect(normalizeEnml(input)).toBe(input);
});

test("a dropped folder is the export, the folders in it are notebooks", () => {
  const file = (path: string) =>
    Object.assign(new File([], path.split("/").pop() || ""), { path });
  const files = [
    file("/Evernote/A default Book.enex"),
    file("/Evernote/Travel Stack/Asia.enex")
  ];
  expect([...relativePaths(files).values()]).toEqual([
    "A default Book.enex",
    "Travel Stack/Asia.enex"
  ]);
  expect([...relativePaths([file("./Notes.enex")]).values()]).toEqual([
    "Notes.enex"
  ]);
});
