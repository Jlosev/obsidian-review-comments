import { App, TFile, normalizePath } from "obsidian";
import {
  CommentThread,
  ParsedMeta,
  newCommentId,
  parseThreads,
} from "./comment-format";
import type ReviewCommentsPlugin from "./main";

/** 構造化データ1件。コメントノートのフロントマターと書き出しの両方で使う */
export interface CommentRecord {
  id: string;
  file: string;
  type: string;
  author: string;
  date: string;
  body: string;
  highlighted: string;
  replies: { author: string; date: string; body: string }[];
  // ノート先頭からの文字位置。同じ記法が2つあるときの見分けに使う
  offset: number;
}

/** 走査の結果。どのノートから何件取れたかを呼び出し側が数えられる */
export interface ScanResult {
  records: CommentRecord[];
  fileCount: number;
}

function toRecord(
  path: string,
  thread: CommentThread,
  fallbackId: string
): CommentRecord {
  const head: ParsedMeta = thread.entries[0];
  return {
    id: head.id ?? fallbackId,
    file: path,
    type: head.type,
    author: head.author,
    date: head.date,
    body: head.body,
    highlighted: thread.highlighted,
    replies: thread.entries.slice(1).map((e) => ({
      author: e.author,
      date: e.date,
      body: e.body,
    })),
    offset: thread.offset,
  };
}

/**
 * vault の Markdown を走査してコメントを集める。除外するのは、このプラグインが
 * 作った置き場そのもの。自分の出力を読み直して二重に数えるのを避ける
 */
export async function scanVault(
  plugin: ReviewCommentsPlugin
): Promise<ScanResult> {
  const { app, settings } = plugin;
  const records: CommentRecord[] = [];
  let fileCount = 0;

  for (const file of app.vault.getMarkdownFiles()) {
    if (isOwnOutput(plugin, file.path)) continue;

    const text = await app.vault.cachedRead(file);
    if (text.indexOf("{==") === -1) continue;

    const threads = parseThreads(text);
    if (threads.length === 0) continue;

    fileCount++;
    for (const thread of threads) {
      records.push(toRecord(file.path, thread, newCommentId()));
    }
  }

  return { records, fileCount };
}

/**
 * このプラグインが作ったファイルかどうか。自分の出力を読み直して、記法の例を
 * 本物のコメントとして数えるのを避ける
 */
export function isOwnOutput(
  plugin: ReviewCommentsPlugin,
  path: string
): boolean {
  const notes = normalizePath(plugin.settings.commentNotesFolder);
  const resolved = normalizePath(plugin.settings.resolvedFolder);
  return (
    path === notes ||
    path === resolved ||
    path.startsWith(`${notes}/`) ||
    path.startsWith(`${resolved}/`)
  );
}

function yamlString(value: string): string {
  // 二重引用符で囲み、中の引用符と逆斜線だけ退避する。改行は \n のまま1行に収める
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  return `"${escaped}"`;
}

/** コメントノート1件の中身。Bases と Dataview が読むのはフロントマター */
function renderCommentNote(record: CommentRecord): string {
  const lines = [
    "---",
    `id: ${yamlString(record.id)}`,
    `source: ${yamlString(record.file)}`,
    `type: ${yamlString(record.type)}`,
    `author: ${yamlString(record.author)}`,
    `date: ${yamlString(record.date)}`,
    `replies: ${record.replies.length}`,
    `offset: ${record.offset}`,
    "---",
    "",
    `[[${record.file}]]`,
    "",
    "> " + record.highlighted.split("\n").join("\n> "),
    "",
    record.body,
  ];

  for (const reply of record.replies) {
    lines.push("", `**${reply.author} · ${reply.date}**`, "", reply.body);
  }

  return lines.join("\n") + "\n";
}

async function ensureFolder(app: App, path: string) {
  const normalized = normalizePath(path);
  if (app.vault.getFolderByPath(normalized)) return;
  // 同じ名前のファイルが先にあるときは作らない。上書きすると中身を失う
  if (app.vault.getFileByPath(normalized)) return;
  await app.vault.createFolder(normalized);
}

async function writeFile(app: App, path: string, contents: string) {
  const normalized = normalizePath(path);
  const existing = app.vault.getFileByPath(normalized);
  if (existing) {
    await app.vault.modify(existing, contents);
    return;
  }
  await app.vault.create(normalized, contents);
}

/**
 * コメントノートを作り直す。参照元はノートの記法なので、置き場の中身は毎回
 * 作り直してよい。消えても記法から復元できる
 */
export async function syncCommentNotes(
  plugin: ReviewCommentsPlugin
): Promise<number> {
  const { app, settings } = plugin;
  const folder = normalizePath(settings.commentNotesFolder);
  await ensureFolder(app, folder);

  const { records } = await scanVault(plugin);
  const written = new Set<string>();

  for (const record of records) {
    const path = `${folder}/${record.id}.md`;
    written.add(path);
    await writeFile(app, path, renderCommentNote(record));
  }

  // 参照元から消えたコメントのノートは残さない。記法が唯一の参照元のため
  const dir = app.vault.getFolderByPath(folder);
  if (dir) {
    for (const child of dir.children) {
      if (!(child instanceof TFile)) continue;
      if (child.extension !== "md") continue;
      if (written.has(child.path)) continue;
      await app.vault.trash(child, true);
    }
  }

  return records.length;
}

/** すべてのコメントを1つの JSON へ書き出す。エージェントへ渡す入力になる */
export async function exportComments(
  plugin: ReviewCommentsPlugin
): Promise<{ count: number; path: string }> {
  const folder = normalizePath(plugin.settings.commentNotesFolder);
  await ensureFolder(plugin.app, folder);
  const path = `${folder}/comments.json`;

  const { records } = await scanVault(plugin);
  await writeFile(
    plugin.app,
    path,
    JSON.stringify({ generatedAt: new Date().toISOString(), comments: records }, null, 2) + "\n"
  );

  return { count: records.length, path };
}

/**
 * 解決したコメントの控えを追記する。ノート側からは記法を外すため、ここが
 * 対応済みの唯一の置き場になる
 */
export async function appendResolved(
  plugin: ReviewCommentsPlugin,
  sourcePath: string,
  thread: CommentThread
): Promise<string> {
  const { app, settings } = plugin;
  const folder = normalizePath(settings.resolvedFolder);
  await ensureFolder(app, folder);

  const head = thread.entries[0];
  const resolvedOn = new Date().toISOString().slice(0, 10);
  // 月ごとに分ける。1つのファイルへ足し続けると開くのが重くなる
  const path = `${folder}/${resolvedOn.slice(0, 7)}.md`;
  const lines = [
    "",
    `## ${head.type} · ${head.author} · ${head.date}`,
    "",
    `- 元のノート: [[${sourcePath}]]`,
    `- 識別子: ${head.id ?? "なし"}`,
    `- 解決した日: ${resolvedOn}`,
    "",
    "> " + thread.highlighted.split("\n").join("\n> "),
    "",
    head.body,
  ];
  for (const reply of thread.entries.slice(1)) {
    lines.push("", `**${reply.author} · ${reply.date}**`, "", reply.body);
  }

  const block = lines.join("\n") + "\n";
  const existing = app.vault.getFileByPath(path);
  if (existing) {
    await app.vault.append(existing, block);
  } else {
    await app.vault.create(path, `# ${resolvedOn.slice(0, 7)}\n` + block);
  }

  return path;
}

/**
 * 1つのノートぶんだけコメントノートを書き直す。保存のたびに vault 全体を
 * 走査しないための経路で、読むのは渡されたファイルとコメントノートの
 * フロントマターだけ
 */
export async function syncOneFile(
  plugin: ReviewCommentsPlugin,
  file: TFile
): Promise<void> {
  const { app, settings } = plugin;
  if (isOwnOutput(plugin, file.path)) return;

  const folder = normalizePath(settings.commentNotesFolder);
  const text = await app.vault.cachedRead(file);
  const threads = text.indexOf("{==") === -1 ? [] : parseThreads(text);

  const kept = new Set<string>();
  if (threads.length > 0) {
    await ensureFolder(app, folder);
    for (const thread of threads) {
      const record = toRecord(file.path, thread, newCommentId());
      kept.add(record.id);
      await writeFile(app, `${folder}/${record.id}.md`, renderCommentNote(record));
    }
  }

  // このノートから消えたコメントのノートを落とす。source を見て自分の分だけ触る
  const dir = app.vault.getFolderByPath(folder);
  if (!dir) return;
  for (const child of dir.children) {
    if (!(child instanceof TFile)) continue;
    if (child.extension !== "md") continue;
    const source = app.metadataCache.getFileCache(child)?.frontmatter?.source;
    if (source !== file.path) continue;
    if (kept.has(child.basename)) continue;
    await app.vault.trash(child, true);
  }
}

/**
 * 指定したパスを source に持つコメントノートを落とす。ノートを消したり名前を
 * 変えたときに、行き先の無いコメントノートが残るのを防ぐ
 */
export async function dropNotesFor(
  plugin: ReviewCommentsPlugin,
  sourcePath: string
): Promise<void> {
  const { app, settings } = plugin;
  const dir = app.vault.getFolderByPath(
    normalizePath(settings.commentNotesFolder)
  );
  if (!dir) return;

  for (const child of dir.children) {
    if (!(child instanceof TFile)) continue;
    if (child.extension !== "md") continue;
    const source = app.metadataCache.getFileCache(child)?.frontmatter?.source;
    if (source !== sourcePath) continue;
    await app.vault.trash(child, true);
  }
}
