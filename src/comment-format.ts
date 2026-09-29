import { COMMENT_THREAD_REGEX } from "./constants";

export interface ParsedMeta {
  // 記法に識別子が書かれていないときは null。旧形式のノートで起きる
  id: string | null;
  author: string;
  date: string;
  type: string;
  body: string;
}

/** 返信を表す種別。吹き出しバーの選択肢には出さず、返信のときだけ使う */
export const REPLY_TAG = "REPLY";

/** 識別子の形。`|` を含まないため既存の区切りと衝突しない */
export const COMMENT_ID_PATTERN = /^rc-[0-9a-z]{6}$/;

/**
 * コメント1件に振る識別子。返信を同じコメントへ束ねる鍵で、記法の1つ目の
 * 区切りに置く。読み上げずに目で追える長さに収める
 */
export function newCommentId(): string {
  let suffix = "";
  for (let i = 0; i < 6; i++) {
    suffix += Math.floor(Math.random() * 36).toString(36);
  }
  return `rc-${suffix}`;
}

/**
 * CodeMirror の ViewPlugin 由来の Decoration.replace は改行をまたぐ範囲に使えない。
 * 記法自体に生の改行を残さないよう、ハイライト対象と本文は保存時にここを通す。
 */
export function escapeMultiline(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

export function unescapeMultiline(text: string): string {
  let result = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === "n") {
        result += "\n";
        i++;
        continue;
      }
      if (next === "\\") {
        result += "\\";
        i++;
        continue;
      }
    }
    result += text[i];
  }
  return result;
}

export function parseMeta(meta: string): ParsedMeta {
  // 識別子は先頭に置く。書かれていない記法は識別子を振る前に作られたもの
  const idHead = meta.match(/^(rc-[0-9a-z]{6})\|([\s\S]*)$/);
  const id = idHead ? idHead[1] : null;
  const rest = idHead ? idHead[2] : meta;

  const newFmt = rest.match(/^([^|]+)\|([^|]+)\|([A-Z]+):\s*([\s\S]*)$/);
  if (newFmt) {
    return {
      id,
      author: newFmt[1].trim(),
      date: newFmt[2].trim(),
      type: newFmt[3].trim(),
      body: unescapeMultiline(newFmt[4].trim()),
    };
  }

  const oldFmt = rest.match(/^([^|]+)\|([^|:]+):\s*([\s\S]*)$/);
  if (oldFmt) {
    return {
      id,
      author: oldFmt[1].trim(),
      date: oldFmt[2].trim(),
      type: "NOTE",
      body: unescapeMultiline(oldFmt[3].trim()),
    };
  }

  return {
    id,
    author: "",
    date: "",
    type: "NOTE",
    body: unescapeMultiline(rest),
  };
}

export function sanitizeAuthor(name: string): string {
  const trimmed = (name || "").trim();
  const stripped = trimmed.replace(/[|<>{}=]/g, "_");
  return stripped || "you";
}

export function formatDate(d: Date, format: "iso" | "japanese"): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  if (format === "japanese") return `${y}年${m}月${day}日`;
  return `${y}-${m}-${day}`;
}

export interface PreparedBody {
  // ノートへ書き込む形。改行はエスケープ済み
  body: string;
  // 記法の退避が起きたかどうか。呼び出し側が利用者へ知らせる
  adjusted: boolean;
}

// コメント記法を壊す並びを本文から取り除き、改行をエスケープして1行に収める
export function prepareCommentBody(raw: string): PreparedBody {
  const trimmed = raw.trim();
  const escaped = trimmed
    .replace(/\{==/g, "{ ==")
    .replace(/==\}/g, "== }")
    .replace(/\{>>/g, "{ >>")
    .replace(/<<\}/g, "<< }");
  return { body: escapeMultiline(escaped), adjusted: escaped !== trimmed };
}

/**
 * コメント記法を組み立てる。投稿者と日付は元の値を残し、読めなかった場合だけ
 * 呼び出し側が渡す控えで埋める。
 */
export function buildCommentMarkup(
  rawHighlighted: string,
  meta: ParsedMeta,
  preparedBody: string,
  fallback: { author: string; date: string }
): string {
  return `{==${rawHighlighted}==}${buildMetaBlock(
    meta,
    preparedBody,
    fallback
  )}`;
}

/** `{>>...<<}` の1つ分。識別子を持つ記法だけ先頭に識別子を出す */
export function buildMetaBlock(
  meta: ParsedMeta,
  preparedBody: string,
  fallback: { author: string; date: string }
): string {
  const author = meta.author || fallback.author;
  const date = meta.date || fallback.date;
  const head = meta.id ? `${meta.id}|` : "";
  return `{>>${head}${author}|${date}|${meta.type}: ${preparedBody}<<}`;
}

/**
 * ハイライトと、それに続く `{>>...<<}` を並べて1つの記法にする。1件目が
 * コメント、2件目以降が返信になる
 */
export function buildThreadMarkup(
  rawHighlighted: string,
  metaBlocks: string[]
): string {
  return `{==${rawHighlighted}==}${metaBlocks.join("")}`;
}

/**
 * 連なった `{>>...<<}` を1つずつに割る。中身は `<<}` を含まないため、
 * 区切りの取り違えは起きない
 */
export function splitMetaBlocks(raw: string): string[] {
  const blocks: string[] = [];
  const regex = /\{>>([\s\S]*?)<<\}/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(raw))) {
    blocks.push(m[1]);
  }
  return blocks;
}

/**
 * ハイライトと、それに続く記法をひとまとまりとして扱う形。1件目がコメント、
 * 2件目以降が返信になる。返信の無い記法は entries が1件だけになり、
 * 識別子を振る前に書かれた記法でもそのまま読める
 */
export interface CommentThread {
  // 画面に出す形。改行はエスケープを解いてある
  highlighted: string;
  // ノートに書かれているままの形。記法を組み直すときはこちらを使う
  rawHighlighted: string;
  entries: ParsedMeta[];
  // 各 `{>>...<<}` の中身。位置で組み直すときに使う
  rawMetaBlocks: string[];
  // 記法全体
  full: string;
  // 走査した文字列の先頭からの位置
  offset: number;
}

/** 記法を読む唯一の入口。編集中、読み取りモード、パネルの3か所が共有する */
export function parseThreads(text: string): CommentThread[] {
  const regex = new RegExp(COMMENT_THREAD_REGEX);
  const threads: CommentThread[] = [];
  let m: RegExpExecArray | null;

  while ((m = regex.exec(text))) {
    const rawMetaBlocks = splitMetaBlocks(m[2]);
    if (rawMetaBlocks.length === 0) continue;
    threads.push({
      highlighted: unescapeMultiline(m[1]),
      rawHighlighted: m[1],
      entries: rawMetaBlocks.map(parseMeta),
      rawMetaBlocks,
      full: m[0],
      offset: m.index,
    });
  }

  return threads;
}

/** スレッドの識別子。1件目に書かれているものを使う */
export function threadId(thread: CommentThread): string | null {
  return thread.entries[0]?.id ?? null;
}

/** スレッドを記法へ戻す。本文はすべてエスケープ済みで渡す */
export function buildThreadFromEntries(
  rawHighlighted: string,
  entries: ParsedMeta[],
  preparedBodies: string[],
  fallback: { author: string; date: string }
): string {
  const blocks = entries.map((entry, i) =>
    buildMetaBlock(entry, preparedBodies[i], fallback)
  );
  return buildThreadMarkup(rawHighlighted, blocks);
}

/**
 * スレッドの末尾へ返信を足した記法を作る。識別子を持たない記法には、この時点で
 * 識別子を振る。返信を付けるまで古い記法をそのまま置いておける
 */
export function buildReplyThread(
  rawHighlighted: string,
  entries: ParsedMeta[],
  preparedReplyBody: string,
  fallback: { author: string; date: string }
): string {
  const id = entries[0]?.id ?? newCommentId();
  const blocks = entries.map((entry) =>
    buildMetaBlock({ ...entry, id }, escapeMultiline(entry.body), fallback)
  );
  blocks.push(
    buildMetaBlock(
      {
        id,
        author: fallback.author,
        date: fallback.date,
        type: REPLY_TAG,
        body: "",
      },
      preparedReplyBody,
      fallback
    )
  );
  return buildThreadMarkup(rawHighlighted, blocks);
}

/**
 * 1件目の本文だけ差し替えた記法を作る。返信はそのまま残す
 */
export function buildThreadWithNewBody(
  rawHighlighted: string,
  entries: ParsedMeta[],
  preparedBody: string,
  fallback: { author: string; date: string }
): string {
  const blocks = entries.map((entry, i) =>
    buildMetaBlock(entry, i === 0 ? preparedBody : escapeMultiline(entry.body), fallback)
  );
  return buildThreadMarkup(rawHighlighted, blocks);
}
