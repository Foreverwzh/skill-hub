import { TextView } from "gpui-base";

export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders selectable plain text via gpui-base TextView so users can drag-select
 * and Cmd+C copy paths, remotes, IDs, and diagnostic lines natively.
 */
export function selectableLine(id, text, color) {
  const safe = escapeHtml(text);
  return TextView.html(id, `<p>${safe}</p>`)
    .selectable(true)
    .text_xs()
    .text_color(color);
}
