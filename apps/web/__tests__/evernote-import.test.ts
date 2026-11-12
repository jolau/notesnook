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
import { processContent, Note as ENNote } from "@notesnook-importer/enex";
import { ElementHandler } from "@notesnook-importer/core/dist/src/providers/evernote/element-handlers";
import { xxhash64 } from "hash-wasm";
import { normalizeEnml } from "../src/components/importer/providers/enml";
import { relativePaths } from "../src/components/importer/providers";

const enml = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${body}</en-note>`;

const body = (enml: string) => /<en-note>([\s\S]*)<\/en-note>/.exec(enml)?.[1];

/** what the importer makes of a note: normalizeEnml, then the stock converter */
async function convert(body: string) {
  const handler = new ElementHandler(
    { title: "", attachments: [] },
    { resources: [] } as unknown as ENNote,
    { type: "xxh64", hash: xxhash64 },
    {}
  );
  return processContent(normalizeEnml(enml(body)), handler);
}

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

test("Evernote 10 check lists: an item without a state is unticked", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<ul style="--en-todo:true;"><li style="--en-checked:false;"><div>ask</div></li><li><div>note</div></li><li style="--en-checked:true;"><div>done</div></li></ul>`
        )
      )
    )
  ).toBe(
    `<ul class="simple-checklist"><li style="--en-checked:false;" class="simple-checklist--item"><div>ask</div></li><li class="simple-checklist--item"><div>note</div></li><li style="--en-checked:true;" class="simple-checklist--item checked"><div>done</div></li></ul>`
  );
});

test("a list mixing checkboxes and bullets is split", () => {
  expect(
    body(
      normalizeEnml(
        enml(
          `<ul><li><div><en-todo checked="true"/>a</div></li><li><div>b</div></li></ul>`
        )
      )
    )
  ).toBe(
    `<ul class="simple-checklist"><li class="simple-checklist--item checked"><div>a</div></li></ul><ul><li><div>b</div></li></ul>`
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

test("text that looks like markup stays text, also in code blocks", async () => {
  expect(
    await convert(
      `<div>#include &lt;stdio.h&gt; Caf&#xE9; &amp; &nbsp;x</div><div style="--en-codeblock:true;"><div>if (a &lt; b &amp;&amp; c)</div></div>`
    )
  ).toBe(
    `<p>#include &lt;stdio.h&gt; Caf&#xE9; &amp; &nbsp;x</p><pre>if (a &lt; b &amp;&amp; c)</pre>`
  );
});

test("a selection clip becomes part of the note", async () => {
  expect(
    await convert(
      `<div style="--en-clipped-content:selection; --en-clipped-source-url:https://a.ch/?x=1&amp;y=2; --en-clipped-source-title:Fish &amp; Chips;"><div>a &lt;b&gt;</div></div>`
    )
  ).toBe(
    `<p>a &lt;b&gt;</p><hr><p>Clipped from: <a href="https://a.ch/?x=1&y=2">Fish &amp; Chips</a></p>`
  );
});

test("a bookmark clip keeps its card", async () => {
  expect(
    await convert(
      `<div style="--en-clipped-content:bookmark; --en-clipped-source-url:https://a.ch/; --en-clipped-source-title:A;"><div>A</div><div><a href="https://a.ch/">https://a.ch/</a></div><div>An excerpt</div></div>`
    )
  ).toBe(
    `<p>A</p><p><a href="https://a.ch/">https://a.ch/</a></p><p>An excerpt</p>`
  );
});

test("a clip of a site's top is kept like a full page clip", () => {
  expect(
    normalizeEnml(
      enml(
        `<div style="--en-clipped-content:topsite; --en-clipped-source-url:https://youtube.com/;"><div>video</div></div>`
      )
    )
  ).toContain(`--en-clipped-content:fullPage`);
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
