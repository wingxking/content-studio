import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { parseHTML } from "linkedom";
import { workspaceSummarySchema } from "../src/contracts/workspace.ts";
import { randomUUID } from "node:crypto";

test("switching creation types preserves each draft and the original DOM form", async () => {
  const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
  Object.defineProperty(window.document, "oninput", {configurable:true,value:null});
  const globals = { window, document: window.document, HTMLElement: window.HTMLElement, HTMLButtonElement: window.HTMLButtonElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key,value] of Object.entries(globals)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis,key));
    Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
  }
  const {createMemoryRouter, RouterProvider} = await import("react-router");
  const {TaskCreatePage} = await import("../src/ui/task-wizard.tsx");
  const client = new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(["models"], [{id:"test-model",name:"Test model",description:"Test"}]);
  client.setQueryData(["assets"], []);
  client.setQueryData(["workspace","summary"], workspaceSummarySchema.parse({paused:true,schedulerEnabled:false,accounts:[],readiness:{modelReady:true}}));
  const router = createMemoryRouter([{path:"/tasks/new",element:createElement(TaskCreatePage)}], {initialEntries:["/tasks/new?type=discovery"]});
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(window.document.getElementById("root")!);
  try {
    await act(async () => root.render(createElement(QueryClientProvider,{client},createElement(RouterProvider,{router}))));
    const button = (text:string) => [...window.document.querySelectorAll(".segmented button")].find(item=>item.textContent===text)!;
    assert.equal(button("发现选题").getAttribute("aria-pressed"),"true");
    const discovery = window.document.querySelector("form")!;
    const discoveryTitle = discovery.querySelector("input")!;
    const enterText = async (input: HTMLInputElement, value: string) => {
      await act(async () => {
        // Browsers default an omitted input type to text; linkedom leaves it empty.
        input.type = "text";
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
        assert.ok(setter);
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", {bubbles:true}));
      });
    };
    await enterText(discoveryTitle, "发现选题草稿");
    await act(async () => button("文章生产").dispatchEvent(new window.Event("click",{bubbles:true})));
    const article = [...window.document.querySelectorAll("form")].find(form=>!form.parentElement!.hidden)!;
    assert.notEqual(article,discovery);
    const articleTitle=article.querySelector("input")!;
    await enterText(articleTitle,"文章草稿");
    await act(async () => button("发现选题").dispatchEvent(new window.Event("click",{bubbles:true})));
    assert.equal(discovery.parentElement!.hidden,false);
    assert.equal(discovery.querySelector("input"),discoveryTitle);
    assert.equal(discoveryTitle.value,"发现选题草稿");
    assert.equal(article.parentElement!.hidden,true);
    await act(async () => button("文章生产").dispatchEvent(new window.Event("click",{bubbles:true})));
    assert.equal(article.parentElement!.hidden,false);
    assert.equal(article.querySelector("input"),articleTitle);
    assert.equal(articleTitle.value,"文章草稿");
  } finally {
    await act(async()=>root.unmount());
    router.dispose();client.clear();
    for(const [key,descriptor] of previous) {
      if(descriptor) Object.defineProperty(globalThis,key,descriptor);
      else Reflect.deleteProperty(globalThis,key);
    }
  }
});

test("task-level attachments show readable names before a first episode exists", async () => {
  const [{renderToStaticMarkup}, {MemoryRouter}, {TaskResources}] = await Promise.all([
    import("react-dom/server"), import("react-router"), import("../src/ui/task-workbench.tsx"),
  ]);
  const ref = {kind:"plan" as const,id:randomUUID()};
  const resourceId = randomUUID();
  const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
  client.setQueryData(["workspace","task-resources","plan",ref.id,undefined], {
    links:[{id:randomUUID(),task_kind:"plan",task_id:ref.id,episode_id:null,resource_kind:"asset",resource_id:resourceId,created_at:new Date().toISOString()}],
    captures:[],resources:[{id:resourceId,kind:"asset",name:"品牌封面.png",mime:"image/png",url:"/api/assets/cover"}],
  });
  try {
    const element=createElement(TaskResources,{context:{ref,title:"待生产任务",status:"paused",plan:null,episodes:[],nextCursor:null,selectedEpisodeId:null,tags:[],archivedAt:null,related:[]},articleSources:[],episodeId:undefined});
    const markup=renderToStaticMarkup(createElement(QueryClientProvider,{client},createElement(MemoryRouter,null,element)));
    const {document}=parseHTML(markup);
    assert.match(markup,/品牌封面.png/);
    assert.match(markup,/采集网页资料到任务/);
    assert.doesNotMatch(markup,new RegExp(resourceId));
    assert.equal(document.querySelector('img[alt="品牌封面.png"]')?.getAttribute("src"),"/api/assets/cover");
    assert.ok(document.querySelector('a[href="/api/assets/cover"]'));
    assert.doesNotMatch(markup,/本期实际引用/);
  } finally {client.clear();}
});
