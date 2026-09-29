import { App, Component, MarkdownRenderer, setIcon } from "obsidian";
import { TYPE_LUCIDE } from "../constants";
import type { ParsedMeta } from "../comment-format";
import type { I18n } from "../i18n";

/**
 * MarkdownRenderer.render は常にブロック要素で包んで返すため、ハイライト対象が
 * 単一の p になっている場合は中身だけを取り出して地の文へ溶け込ませる。見出しや
 * リストのブロック構文はそのまま挿入し、同じ行へ流し込むのは CSS 側で行う。
 */
export async function renderIntoInlineContext(
  app: App,
  markdown: string,
  target: HTMLElement,
  sourcePath: string,
  component: Component
) {
  const tmp = createDiv();
  await MarkdownRenderer.render(app, markdown, tmp, sourcePath, component);
  if (tmp.children.length === 1 && tmp.firstElementChild?.tagName === "P") {
    const p = tmp.firstElementChild;
    while (p.firstChild) target.appendChild(p.firstChild);
  } else {
    while (tmp.firstChild) target.appendChild(tmp.firstChild);
  }
  markHeadingAnchor(target);
}

const HEADING_TAGS = ["H1", "H2", "H3", "H4", "H5", "H6"];

/**
 * 中身が見出しのときだけ、外側のアンカーへクラスを付ける。CSS の :has で
 * 同じことをすると、無関係な変更でも広い範囲の再判定が走る
 */
function markHeadingAnchor(target: HTMLElement) {
  const anchor = target.parentElement;
  if (!anchor) return;
  const isHeading = Array.from(target.children).some((child) =>
    HEADING_TAGS.includes(child.tagName)
  );
  anchor.toggleClass("review-comment-has-heading", isHeading);
}

export interface CommentBubbleHandlers {
  // 記法を外してハイライトされていたテキストだけを残す
  onDelete?: () => void;
  // 1件目の本文を書き換える
  onEdit?: () => void;
  // スレッドの末尾へ返信を足す
  onReply?: () => void;
}

/**
 * 吹き出しボタンと、クリックで開閉するポップオーバーを container へ足す。
 * entries の1件目がコメント、2件目以降が返信。返信が無いときの見た目は
 * 1件だけを渡していたときと同じになる。
 */
export function appendCommentBubble(
  container: HTMLElement,
  entries: ParsedMeta[],
  i18n: I18n,
  handlers: CommentBubbleHandlers = {}
) {
  const meta = entries[0];
  const { onDelete, onEdit, onReply } = handlers;
  container.addClass("review-comment-anchor");
  container.dataset.type = meta.type;

  const btn = container.createEl("button", {
    cls: "review-comment-bubble-btn",
    attr: { type: "button", "aria-label": i18n.t("bubble.show") },
  });
  setIcon(btn, TYPE_LUCIDE[meta.type] || "message-circle");
  // 返信が付いているスレッドは件数を出す。1件だけのときは今までどおり出さない
  if (entries.length > 1) {
    btn.createSpan({
      cls: "review-comment-bubble-count",
      text: String(entries.length),
    });
  }

  const popover = container.createDiv({ cls: "review-comment-bubble-popover" });

  {
    const actions = popover.createDiv({
      cls: "review-comment-bubble-popover-actions",
    });

    if (onEdit) {
      const editBtn = actions.createEl("button", {
        cls: "review-comment-bubble-popover-btn",
        attr: { type: "button", "aria-label": i18n.t("bubble.edit") },
      });
      setIcon(editBtn, "pencil");
      editBtn.addEventListener("mousedown", (e) => e.preventDefault());
      editBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllCommentPopovers(container.ownerDocument);
        onEdit();
      });
    }

    if (onReply) {
      const replyBtn = actions.createEl("button", {
        cls: "review-comment-bubble-popover-btn",
        attr: { type: "button", "aria-label": i18n.t("bubble.reply") },
      });
      setIcon(replyBtn, "reply");
      // Obsidian が同梱するアイコンに reply が無い版では空の四角になる。
      // 何も入らなかったときだけ文字で出す
      if (!replyBtn.firstElementChild) {
        replyBtn.setText(i18n.t("panel.reply"));
      }
      replyBtn.addEventListener("mousedown", (e) => e.preventDefault());
      replyBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllCommentPopovers(container.ownerDocument);
        onReply();
      });
    }

    if (onDelete) {
      const deleteBtn = actions.createEl("button", {
        cls: "review-comment-bubble-popover-btn review-comment-bubble-popover-delete",
        attr: { type: "button", "aria-label": i18n.t("bubble.delete") },
      });
      setIcon(deleteBtn, "trash-2");
      deleteBtn.addEventListener("mousedown", (e) => e.preventDefault());
      deleteBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeAllCommentPopovers(container.ownerDocument);
        onDelete();
      });
    }

    // × は閉じるだけ。閉じる形のアイコンに削除を割り当てると取り違える
    const closeBtn = actions.createEl("button", {
      cls: "review-comment-bubble-popover-btn",
      attr: { type: "button", "aria-label": i18n.t("bubble.close") },
    });
    setIcon(closeBtn, "x");
    closeBtn.addEventListener("mousedown", (e) => e.preventDefault());
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAllCommentPopovers(container.ownerDocument);
    });
  }

  const header = popover.createDiv({
    cls: "review-comment-bubble-popover-header",
  });
  header.setText(`${meta.author} · ${meta.date}`);
  const body = popover.createDiv({ cls: "review-comment-bubble-popover-body" });
  body.setText(meta.body);

  for (const reply of entries.slice(1)) {
    const item = popover.createDiv({
      cls: "review-comment-bubble-popover-reply",
    });
    item
      .createDiv({ cls: "review-comment-bubble-popover-header" })
      .setText(`${reply.author} · ${reply.date}`);
    item
      .createDiv({ cls: "review-comment-bubble-popover-body" })
      .setText(reply.body);
  }

  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = popover.hasClass("is-open");
    closeAllCommentPopovers(container.ownerDocument);
    if (!isOpen) popover.addClass("is-open");
  });
}

export function closeAllCommentPopovers(doc: Document) {
  doc
    .querySelectorAll(".review-comment-bubble-popover.is-open")
    .forEach((el) => el.removeClass("is-open"));
}
