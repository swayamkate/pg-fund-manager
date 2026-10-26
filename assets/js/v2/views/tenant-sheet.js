/* views/tenant-sheet.js — tenant detail drawer (shared by beds + search views).
 * Profile, payment-history strip, notice / move-out / edit actions.
 */

import { store, mutations } from "../store/index.js";
import { uploadTenantDoc } from "../lib/supabase.js";
import { esc, money, periodLabel, toast, openDrawer, closeDrawer, el } from "./ui.js";

export function tenantSheet(tenantId) {
  const t = store.tenant(tenantId);
  if (!t) { toast("Tenant not found", "error"); return; }

  const wrap = el("div", "tenant-sheet");
  wrap.innerHTML =
    '<div class="sheet-headrow"><h4>' + esc(t.name) + "</h4>" +
    '<span class="badge badge-' + esc(t.status) + '">' + esc(t.status.replace("_", " ")) + "</span></div>" +
    '<dl class="kv">' +
    "<dt>Phone</dt><dd>" + esc(t.phone || "—") + "</dd>" +
    "<dt>Joined</dt><dd>" + esc(t.joined_on || "—") + "</dd>" +
    "<dt>Rent</dt><dd>" + money(store.effectiveRent(t)) + (t.rent_amount != null ? " (custom)" : "") + "</dd>" +
    "<dt>Collect day</dt><dd>" + (t.collect_day || "—") + "</dd>" +
    "<dt>Deposit</dt><dd>" + money(t.deposit) + "</dd>" +
    (t.id_type ? "<dt>ID</dt><dd>" + esc(t.id_type) + " · " + esc(t.id_number) + "</dd>" : "") +
    (t.emergency_contact ? "<dt>Emergency</dt><dd>" + esc(t.emergency_contact) + "</dd>" : "") +
    (t.notes ? "<dt>Notes</dt><dd>" + esc(t.notes) + "</dd>" : "") +
    "</dl>";

  /* payment history strip */
  const months = store.billedMonths(t).slice(-8).reverse();
  if (months.length) {
    const strip = el("div", "pay-strip");
    for (const p of months) {
      const rows = store.rentLedger(p).filter((r) => r.tenant.id === t.id);
      const st = rows.length ? rows[0].status : "pending";
      strip.appendChild(el("span", "pay-chip pay-" + st,
        esc(p.slice(2)) + " · " + esc(st)));
    }
    wrap.appendChild(el("h5", "sheet-h5", "Recent rent"));
    wrap.appendChild(strip);
  }

  /* actions */
  const actions = el("div", "sheet-actions");
  if (t.status === "active") {
    const notice = el("button", "btn btn-ghost", "Give notice");
    notice.type = "button";
    notice.addEventListener("click", () => {
      mutations.updateTenant(t.id, { status: "on_notice" });
      toast(t.name + " put on notice");
      closeDrawer(); tenantSheet(t.id);
    });
    actions.appendChild(notice);
  }
  if (t.status === "on_notice") {
    const cancel = el("button", "btn btn-ghost", "Cancel notice");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      mutations.updateTenant(t.id, { status: "active" });
      toast("Notice cancelled");
      closeDrawer(); tenantSheet(t.id);
    });
    actions.appendChild(cancel);
  }
  if (t.status !== "moved_out") {
    const out = el("button", "btn btn-danger", "Move out");
    out.type = "button";
    out.addEventListener("click", () => {
      if (confirm("Move out " + t.name + "? Bed becomes vacant; history is kept.")) {
        mutations.moveOut(t.id);
        toast(t.name + " moved out");
        closeDrawer();
      }
    });
    actions.appendChild(out);
  }
  /* Module 6: 1-tap WhatsApp rent reminder (wa.me deep link). */
  if (t.phone && t.status === "active") {
    const wa = el("button", "btn btn-ghost", "Send WhatsApp reminder");
    wa.type = "button";
    wa.addEventListener("click", async () => {
      const res = await store.whatsappReminder(t.id);
      if (!res.ok) { toast(res.error, "error"); return; }
      window.open(res.wa_url, "_blank", "noopener");
      toast("WhatsApp reminder ready for " + t.name);
    });
    actions.appendChild(wa);
  }

  /* ID verification document (feature 4): upload → signed URL on the row. */
  const docBlock = el("div", "doc-block");
  if (t.id_proof_path) {
    const link = el("a", "btn btn-ghost doc-link", "View ID document");
    link.href = t.id_proof_url || "#";
    link.target = "_blank";
    link.rel = "noopener";
    docBlock.appendChild(link);
  } else {
    const file = el("input", "doc-input");
    file.type = "file";
    file.accept = "image/jpeg,image/png,image/webp,application/pdf";
    file.addEventListener("change", async () => {
      const f = file.files && file.files[0];
      if (!f) { return; }
      toast("Uploading document…");
      const res = await uploadTenantDoc(t.id, f);
      if (!res.ok) { toast(res.error, "error"); return; }
      mutations.updateTenant(t.id, { id_proof_path: res.path, id_proof_url: res.url });
      toast("ID document attached");
      closeDrawer(); tenantSheet(t.id);
    });
    docBlock.appendChild(file);
  }
  wrap.appendChild(docBlock);

  const edit = el("button", "btn btn-ghost", "Edit");
  edit.type = "button";
  edit.addEventListener("click", () => editSheet(t.id));
  actions.appendChild(edit);
  wrap.appendChild(actions);

  openDrawer(t.name, wrap);
}

function editSheet(tenantId) {
  const t = store.tenant(tenantId);
  if (!t) { return; }
  const f = el("form", "sheet-form");
  f.innerHTML =
    '<label>Name<input name="name" required maxlength="60" value="' + esc(t.name) + '"></label>' +
    '<label>Phone<input name="phone" maxlength="24" inputmode="tel" value="' + esc(t.phone) + '"></label>' +
    '<label>Custom rent (₹, blank = room rent)<input name="rent_amount" type="number" min="0" inputmode="numeric" value="' + (t.rent_amount != null ? esc(t.rent_amount) : "") + '"></label>' +
    '<label>Collect day (1–31, 0 = not set)<input name="collect_day" type="number" min="0" max="31" value="' + esc(t.collect_day || 0) + '"></label>' +
    '<label>Deposit (₹)<input name="deposit" type="number" min="0" inputmode="numeric" value="' + esc(t.deposit) + '"></label>' +
    '<label>Notes<input name="notes" maxlength="200" value="' + esc(t.notes) + '"></label>' +
    '<button class="btn btn-primary" type="submit">Save</button>';
  f.addEventListener("submit", (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(f).entries());
    const res = mutations.updateTenant(t.id, fd);
    if (!res.ok) { toast(res.error, "error"); return; }
    toast("Saved");
    closeDrawer(); tenantSheet(t.id);
  });
  openDrawer("Edit " + t.name, f);
}
