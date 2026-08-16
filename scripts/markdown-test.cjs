// quick markdown renderer smoke test
const fs = require("fs");
const vm = require("vm");
const code = fs.readFileSync("renderer/markdown.js", "utf8");
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(code, ctx);
const r = ctx.window.PetMarkdown.render;

const md = [
  "# 标题",
  "这是**加粗**和*斜体*以及`code`。",
  "",
  "- 列表项1",
  "- 列表项2",
  "",
  "1. 第一",
  "2. 第二",
  "",
  "> 引用",
  "",
  "代码块：",
  "```js",
  "const x = 1 < 2 && 3 > 2;",
  "```",
  "",
  "链接 [example](https://example.com) 和自动 https://auto.com",
  "",
  "<script>alert(1)</script>",
  "~~删除~~",
].join("\n");

console.log(r(md));

// assertions
const out = r(md);
const checks = [
  ["escapes <script>", !out.includes("<script>") && out.includes("&lt;script&gt;")],
  ["heading", out.includes("<h1>标题</h1>")],
  ["bold", out.includes("<strong>加粗</strong>")],
  ["italic", out.includes("<em>斜体</em>")],
  ["inline code", out.includes("<code>code</code>")],
  ["ul", out.includes("<ul>") && out.includes("<li>列表项1</li>")],
  ["ol", out.includes("<ol>") && out.includes("<li>第一</li>")],
  ["blockquote", out.includes("<blockquote>")],
  ["fenced code", out.includes("<pre><code class=\"language-js\">")],
  ["escaped code", out.includes("1 &lt; 2")],
  ["link", out.includes('<a href="https://example.com"')],
  ["autolink", out.includes('<a href="https://auto.com"')],
  ["strike", out.includes("<del>删除</del>")],
];
let fail = 0;
for (const [name, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) fail++;
}
// javascript: link must be blocked
const xss = r("[x](javascript:alert(1))");
console.log(`${!xss.includes("href") ? "PASS" : "FAIL"}  javascript: link blocked`);
if (xss.includes("href")) fail++;
process.exit(fail ? 1 : 0);
