/** One-time forensic extraction. Input is the owner's locally extracted 2.0.9 bundle; never executes it. */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
const file = process.argv[2];
if (!file)
  throw new Error(
    "Usage: node scripts/recover-private.mjs <background-bundle.js>",
  );
const program = ts.createProgram([file], {
  allowJs: true,
  checkJs: true,
  noResolve: true,
  target: ts.ScriptTarget.ESNext,
});
const sf = program.getSourceFile(file),
  checker = program.getTypeChecker(),
  f = ts.factory;
const owners = new Map();
for (const n of sf.statements) {
  if (ts.isVariableStatement(n))
    for (const d of n.declarationList.declarations)
      if (ts.isIdentifier(d.name))
        owners.set(checker.getSymbolAtLocation(d.name), d);
  if ((ts.isClassDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name)
    owners.set(checker.getSymbolAtLocation(n.name), n);
}
const names = new Map([...owners].map(([, n]) => [n.name.text, n]));
const classes = {
  as: ["dayu", "DaYuAdapter"],
  is: ["douyin", "DouyinAdapter"],
  us: ["jianshu", "JianshuAdapter"],
  ds: ["netease", "NeteaseAdapter"],
  gs: ["smzdm", "SmzdmAdapter"],
  ws: ["sohufocus", "SohuFocusAdapter"],
  bs: ["toutiao", "ToutiaoAdapter"],
  As: ["x", "XAdapter"],
  Js: ["xiaohongshu", "XiaohongshuAdapter"],
  Ys: ["yidian", "YidianAdapter"],
};
const imports = {
  D: ["../code-adapter", "CodeAdapter"],
  N: ["../../lib/logger", "createLogger"],
  xe: ["../../lib/markdown-images", "parseMarkdownImages"],
  Ve: ["../../lib/aws4", "signAWS4"],
  qt: ["../../lib/aws4", "crc32"],
  Mt: ["remarkable", "Remarkable"],
  Lt: ["markdown-draft-js", "markdownToDraft"],
  tr: ["../../lib/markdown-to-draft", "markdownToDraft"],
  rr: ["js-md5", "md5"],
  sr: ["jszip", "default"],
  ar: ["../../lib/turndown", "htmlToMarkdown"],
  nr: ["../../lib/turndown", "markdownToHtml"],
};
const known = new Set(["g", ...Object.keys(imports)]),
  picked = new Set();
function collect(n) {
  if (picked.has(n)) return;
  picked.add(n);
  function walk(x) {
    if (ts.isIdentifier(x)) {
      const owner = owners.get(checker.getSymbolAtLocation(x));
      if (owner && !known.has(owner.name.text)) collect(owner);
    }
    ts.forEachChild(x, walk);
  }
  walk(n);
}
for (const n of Object.keys(classes)) collect(names.get(n));
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const output = path.resolve(".recovery/extracted");
fs.mkdirSync(output, { recursive: true });
const props = {
  meta: "PlatformMeta",
  preprocessConfig: "PreprocessConfig",
  HEADER_RULES: "HeaderRule[]",
  cacheMeta: "Record<string, string> | null",
  uploadedImages: "Array<{ org_url: string; url: string }>",
  cachedSTS: "ImageXCredentials | null",
  defaultNotebookId: "number | null",
  accountInfo: "NeteaseAccount | null",
  _currentArticleId: "string | null",
  userInfo: "XUser | null",
  csrfToken: "string | null",
  xpForwardedFor: "string | null",
  queryIdRefreshInProgress: "Promise<void> | null",
  userId: "string | null",
  mpCode: "string | null",
};
function typeNode(text) {
  return ts.createSourceFile(
    "t.ts",
    "type T = " + text,
    ts.ScriptTarget.Latest,
    true,
  ).statements[0].type;
}
function transform(n) {
  return ts.transform(n, [
    (ctx) => {
      const visit = (x) => {
        if (ts.isClassDeclaration(x)) {
          const fields = [],
            methods = [];
          for (const member of x.members) {
            if (ts.isConstructorDeclaration(member)) {
              for (const stmt of member.body.statements) {
                const c = ts.isExpressionStatement(stmt)
                  ? stmt.expression
                  : null;
                if (
                  c &&
                  ts.isCallExpression(c) &&
                  c.expression.getText(sf) === "g"
                ) {
                  const key = c.arguments[1].text,
                    init = c.arguments[2];
                  fields.push(
                    f.createPropertyDeclaration(
                      undefined,
                      key,
                      undefined,
                      props[key] ? typeNode(props[key]) : undefined,
                      init,
                    ),
                  );
                }
              }
            } else methods.push(member);
          }
          return f.updateClassDeclaration(
            x,
            [f.createModifier(ts.SyntaxKind.ExportKeyword)],
            f.createIdentifier(classes[x.name.text][1]),
            undefined,
            x.heritageClauses,
            [...fields, ...methods].map((m) => ts.visitNode(m, visit)),
          );
        }
        if (ts.isCatchClause(x) && x.variableDeclaration) {
          const name = x.variableDeclaration.name.getText(sf);
          const declaration = f.createVariableDeclaration(
            name,
            undefined,
            undefined,
            f.createConditionalExpression(
              f.createBinaryExpression(
                f.createIdentifier("caughtError"),
                ts.SyntaxKind.InstanceOfKeyword,
                f.createIdentifier("Error"),
              ),
              f.createToken(ts.SyntaxKind.QuestionToken),
              f.createIdentifier("caughtError"),
              f.createToken(ts.SyntaxKind.ColonToken),
              f.createNewExpression(f.createIdentifier("Error"), undefined, [
                f.createCallExpression(
                  f.createIdentifier("String"),
                  undefined,
                  [f.createIdentifier("caughtError")],
                ),
              ]),
            ),
          );
          return f.updateCatchClause(
            x,
            f.createVariableDeclaration("caughtError"),
            f.updateBlock(x.block, [
              f.createVariableStatement(
                undefined,
                f.createVariableDeclarationList(
                  [declaration],
                  ts.NodeFlags.Const,
                ),
              ),
              ...x.block.statements.map((s) => ts.visitNode(s, visit)),
            ]),
          );
        }
        if (ts.isMethodDeclaration(x)) {
          const name = x.name.getText(sf),
            types =
              name === "publish"
                ? ["Article", "PublishOptions"]
                : name === "uploadImageByUrl"
                  ? ["string"]
                  : [];
          const params = x.parameters.map((p, i) =>
            f.updateParameterDeclaration(
              p,
              p.modifiers,
              p.dotDotDotToken,
              p.name,
              name === "publish" && i === 1
                ? f.createToken(ts.SyntaxKind.QuestionToken)
                : p.questionToken,
              types[i] ? typeNode(types[i]) : p.type,
              p.initializer,
            ),
          );
          return f.updateMethodDeclaration(
            x,
            x.modifiers,
            x.asteriskToken,
            x.name,
            x.questionToken,
            x.typeParameters,
            params,
            name === "publish"
              ? typeNode("Promise<SyncResult>")
              : name === "checkAuth"
                ? typeNode("Promise<AuthResult>")
                : x.type,
            ts.visitNode(x.body, visit),
          );
        }
        return ts.visitEachChild(x, visit, ctx);
      };
      return (node) => ts.visitNode(node, visit);
    },
  ]).transformed[0];
}
function deps(n) {
  const set = new Set();
  function walk(x) {
    if (ts.isIdentifier(x)) {
      const owner = owners.get(checker.getSymbolAtLocation(x));
      if (owner && owner !== n) set.add(owner.name.text);
      if (imports[x.text]) set.add(x.text);
    }
    ts.forEachChild(x, walk);
  }
  walk(n);
  return set;
}
const typeImports = `import type { Article, AuthResult, SyncResult, PlatformMeta, HeaderRule } from '../../types'\nimport type { PreprocessConfig, PublishOptions } from '../types'\nimport type { ImageXCredentials, NeteaseAccount, XUser } from './types'\n`;
for (const [symbol, [slug]] of Object.entries(classes)) {
  const node = names.get(symbol),
    required = deps(node);
  let headers = typeImports;
  for (const [alias, [source, name]] of Object.entries(imports))
    if (required.has(alias))
      headers +=
        name === "default"
          ? `import ${alias} from '${source}'\n`
          : `import { ${name} as ${alias} } from '${source}'\n`;
  const shared = [...required].filter(
    (n) => !known.has(n) && picked.has(names.get(n)),
  );
  if (shared.length)
    headers += `import { ${shared.join(", ")} } from './support'\n`;
  const result = printer.printNode(
    ts.EmitHint.Unspecified,
    transform(node),
    sf,
  );
  fs.writeFileSync(
    path.join(output, slug + ".ts"),
    `/** Reconstructed from supplied Wechatsync 2.0.9 bundle. Local identifiers are not original source names. */\n${headers}\n${result}\n`,
  );
}
let support =
  "/** Shared constants and content converters recovered from the supplied bundle. */\n";
for (const [alias, [source, name]] of Object.entries(imports))
  if (alias !== "D")
    support +=
      name === "default"
        ? `import ${alias} from '${source}'\n`
        : `import { ${name} as ${alias} } from '${source}'\n`;
for (const n of [...picked].sort((a, b) => a.pos - b.pos)) {
  if (ts.isClassDeclaration(n)) continue;
  if (n.name.text === "ks") {
    support += "export const ks = import.meta.env.VITE_X_WEB_BEARER || ''\n";
    continue;
  }
  let printed;
  if (ts.isVariableDeclaration(n)) {
    const flags = sf.text.slice(n.parent.parent.pos, n.pos).includes("let ")
      ? ts.NodeFlags.Let
      : ts.NodeFlags.Const;
    printed = printer.printNode(
      ts.EmitHint.Unspecified,
      f.createVariableStatement(
        [f.createModifier(ts.SyntaxKind.ExportKeyword)],
        f.createVariableDeclarationList([n], flags),
      ),
      sf,
    );
  } else
    printed = "export " + printer.printNode(ts.EmitHint.Unspecified, n, sf);
  support += printed + "\n";
}
fs.writeFileSync(path.join(output, "support.ts"), support);
console.log(
  "Extracted",
  Object.keys(classes).length,
  "adapters and shared helpers; add reviewed types before building.",
);
