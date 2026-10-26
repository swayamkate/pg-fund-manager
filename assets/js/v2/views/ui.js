/* views/ui.js — shared DOM helpers for the v2 views.
 * Small on purpose: esc, money, dates, toasts (with undo action), and the
 * bottom-sheet drawer the tenant details open in. All rendering is
 * textContent-based (XSS-safe); HTML strings only ever interpolate esc().
 */

export const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const money = (n) => "\u20B9" + Number(n || 0).toLocaleString("en-IN");

export function periodLabel(p) {
  if (!/^\d{4}-\d{2}$/.test(p || "")) { return ""; }
  const d = new Date(Number(p.slice(0, 4)), Number(p.slice(5, 7)) - 1, 1);
  return d.toLocaleDateString("en-IN", { month: "long", year: "numeric" });
}

/* Toast stack. type: ok | error | info. action: { label, fn } renders a
   button (the undo affordance for rent toggles). */
export function toast(msg, type = "ok", duration = 3200, action = null) {
  const host = document.getElementById("toasts");
  if (!host) { return; }
  const t = document.createElement("div");
  t.className = "toast toast-" + type;
  const span = document.createElement("span");
  span.textContent = msg;
  t.appendChild(span);
  if (action) {
    const b = document.createElement("button");
    b.className = "toast-act";
    b.type = "button";
    b.textContent = action.label;
    b.addEventListener("click", () => { action.fn(); t.remove(); });
    t.appendChild(b);
  }
  host.appendChild(t);
  setTimeout(() => t.remove(), duration);
}

/* Bottom-sheet drawer (mobile-first tenant detail). */
export function openDrawer(title, node) {
  const root = document.getElementById("drawer");
  const body = document.getElementById("drawer-body");
  const titleEl = document.getElementById("drawer-title");
  if (!root || !body) { return; }
  titleEl.textContent = title;
  body.replaceChildren(node);
  root.classList.add("is-open");
}
export function closeDrawer() {
  const root = document.getElementById("drawer");
  if (root) { root.classList.remove("is-open"); }
}

export function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) { e.className = cls; }
  if (html != null) { e.innerHTML = html; }
  return e;
}
