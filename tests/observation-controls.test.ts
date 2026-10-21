import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHTML } from "linkedom";
import { ObservationControls } from "../src/ui/diagnostics-panel.tsx";

test("observation controls only expose the valid next action and block pending requests", () => {
  const render=(status:string|undefined,busy=false)=>parseHTML(renderToStaticMarkup(createElement(ObservationControls,{status,busy,onStart:()=>{},onStop:()=>{}}))).document;
  assert.equal(render("running").querySelector("button")?.textContent,"停止当前观察");
  assert.equal(render("stale").querySelector("button")?.textContent,"开始新的观察窗口");
  assert.equal(render(undefined).querySelector("button")?.hasAttribute("disabled"),true);
  assert.equal(render("running",true).querySelector("button")?.hasAttribute("disabled"),true);
  assert.equal(render("stale",true).querySelector("button")?.hasAttribute("disabled"),true);
  assert.match(render("stale").querySelector("small")?.textContent ?? "",/旧窗口的时长不会累计/);
});
