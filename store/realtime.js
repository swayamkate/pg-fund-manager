/* store/realtime.js — Supabase Realtime bridge (multi-device sync, feature 1)
 *
 * One postgres_changes channel over WebSockets; events for tenants, beds and
 * rent_ledger flow into db.mergeRemote (newest updated_at wins, remote
 * tombstones propagate), and the existing pub/sub re-renders only the views
 * that care. No page refresh, no polling.
 *
 * Self-echo safety: our own upserts come back as UPDATE events too; mergeRemote
 * applies them only when strictly newer, so an echo of our own write is a
 * harmless no-op — the merge layer IS the dedupe. No special casing needed.
 *
 * Node-testable: the supabase client is injected (no window / no supabase-js).
 */

const REALTIME_TABLES = ["tenants", "beds", "rent_ledger", "properties", "rooms", "floors"];

export function createRealtime(db, getClient, notify) {
  /* db:       store/db instance (uses db.mergeRemote + _raw for stats probe)
     getClient:() => supabase client or null
     notify:   (kind, detail) => void — e.g. toast("Ravi's rent updated on another device") */

  let channel = null;
  let status = "off";               // off | connecting | live | error

  function setStatus(s, detail) {
    status = s;
    if (typeof window !== "undefined" && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent("pgv2:realtime", { detail: { status: s, error: detail || null } }));
    }
  }

  function apply(table, row) {
    if (!row) { return; }
    // mergeRemote dedupes: newest updated_at wins, remote tombstones propagate.
    // applied === 0 for our own echoed writes, so only genuine remote changes
    // reach the notify layer ("rent marked paid on another device").
    const applied = db.mergeRemote(table, [row]);
    if (applied && notify) { notify("remote-change", { table, id: row.id, name: row.name || row.period || "" }); }
  }

  function start() {
    const client = getClient();
    if (!client || channel) { return; }
    if (!client.channel || !client.removeChannel) {
      // Injected mock without realtime support (or unsupported environment).
      setStatus("off");
      return;
    }
    setStatus("connecting");
    channel = client.channel("pg_live_updates", { config: { broadcast: { self: false } } });
    const uid = (typeof window !== "undefined" && window.__PGV2_UID__) || null;
    for (const table of REALTIME_TABLES) {
      channel.on("postgres_changes",
        { event: "*", schema: "public", table,
          /* server-side filter: only this owner's rows cross the socket */
          filter: uid ? "owner_id=eq." + uid : undefined },
        (payload) => {
          try {
            if (payload.eventType === "DELETE") {
              // The app never hard-deletes; a DELETE on the wire means another
              // client did — synthesize a tombstone so local state converges.
              const old = payload.old || {};
              if (old.id) { apply(table, { id: old.id, owner_id: old.owner_id, deleted_at: new Date().toISOString() }); }
              return;
            }
            apply(table, payload.new || null);
          } catch (e) { /* one bad event must not kill the socket */ }
        });
    }
    channel.subscribe((s) => {
      if (s === "SUBSCRIBED") { setStatus("live"); }
      else if (s === "CHANNEL_ERROR" || s === "TIMED_OUT") { setStatus("error", s); }
      // CLOSED: supabase-js auto-reconnects; status flips on next SUBSCRIBED.
    });
  }

  function stop() {
    const client = getClient();
    if (channel && client && client.removeChannel) {
      try { client.removeChannel(channel); } catch (e) { /* already gone */ }
    }
    channel = null;
    setStatus("off");
  }

  function isLive() { return status === "live"; }
  function currentStatus() { return status; }

  return { start, stop, isLive, currentStatus };
}
