/* PG Manager — accounts and access.

   Two modes behind one API:
     "supabase"  real server-side accounts, active once config.js holds keys
     "local"     browser-only accounts, used until then

   Local mode stores nothing in the clear. Passwords are stretched with
   PBKDF2-SHA256 and only the derived key is kept, invite codes are stored as
   SHA-256 digests, and sign-in attempts are rate limited with a growing wait.
   That makes the stored data useless to read and slow to attack.

   It cannot stop the owner of a browser from editing their own storage. No
   code that runs only in the browser can. Supabase mode is the one that holds
   the line, because the check happens on a machine the visitor does not own.
*/
(function (global) {
  "use strict";

  var cfg = global.PG_CONFIG || {};
  var PROJECT_URL = String(cfg.SUPABASE_URL || "").trim();
  var ANON_KEY = String(cfg.SUPABASE_ANON_KEY || "").trim();

  var lib = global.supabase;
  var client = null;
  if (PROJECT_URL && ANON_KEY && lib && typeof lib.createClient === "function") {
    try { client = lib.createClient(PROJECT_URL, ANON_KEY); } catch (err) { client = null; }
  }

  /* ---------- tuning ---------- */

  var DB_KEY = "pgAuthDb";
  var SESSION_KEY = "pgSession";
  var LEGACY_KEY = "pgUsers";

  var ITERATIONS = 210000;                    // OWASP floor for PBKDF2-SHA256
  var SALT_BYTES = 16;
  var HASH_BITS = 256;

  var IDLE_MS = 30 * 60 * 1000;               // signed out after 30 idle minutes
  var MAX_SESSION_MS = 12 * 60 * 60 * 1000;   // and after 12 hours regardless

  var FREE_TRIES = 4;
  /* The wait after the 5th, 6th, 7th ... consecutive failure. */
  var WAITS = [30e3, 60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3];
  var SPRAY_TRIES = 12;                       // failures across all logins
  var SPRAY_WINDOW = 15 * 60 * 1000;

  var INVITE_DAYS = 7;
  var MIN_PASSWORD = 10;
  var USER_RE = /^[a-z0-9._-]{3,20}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";  // no I, O, 0, 1

  var RESERVED = [
    "admin", "administrator", "root", "owner", "staff", "support", "help",
    "system", "pg", "pgmanager", "manager", "login", "signup", "account",
    "settings", "null", "undefined", "me", "test", "demo", "guest", "user"
  ];

  var COMMON = [
    "password", "password1", "password123", "123456789", "1234567890",
    "qwerty123", "qwertyuiop", "iloveyou1", "letmein123", "welcome123",
    "admin12345", "abcd123456", "passw0rd1", "sunshine1", "princess1"
  ];

  /* ---------- crypto ---------- */

  function subtle() {
    return global.crypto && global.crypto.subtle ? global.crypto.subtle : null;
  }

  /* Web Crypto is only handed out on a secure origin. Saying so beats failing
     with something cryptic. */
  function needCrypto() {
    if (subtle()) { return null; }
    return "This browser will not allow secure password storage here. Open the site over https.";
  }

  function randomBytes(n) {
    var out = new Uint8Array(n);
    global.crypto.getRandomValues(out);
    return out;
  }

  function toB64(bytes) {
    var s = "";
    var b = new Uint8Array(bytes);
    for (var i = 0; i < b.length; i++) { s += String.fromCharCode(b[i]); }
    return global.btoa(s);
  }

  function fromB64(text) {
    var s = global.atob(String(text || ""));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) { out[i] = s.charCodeAt(i); }
    return out;
  }

  function utf8(text) {
    return new global.TextEncoder().encode(String(text));
  }

  /* Stretch a password into a key. Slow on purpose: it is the whole defence
     against someone running a word list against the stored hash. */
  function derive(password, saltBytes, iterations) {
    var api = subtle();
    return api.importKey("raw", utf8(password), { name: "PBKDF2" }, false, ["deriveBits"])
      .then(function (key) {
        return api.deriveBits({
          name: "PBKDF2",
          salt: saltBytes,
          iterations: iterations || ITERATIONS,
          hash: "SHA-256"
        }, key, HASH_BITS);
      })
      .then(toB64);
  }

  function sha256(text) {
    return subtle().digest("SHA-256", utf8(text)).then(toB64);
  }

  /* Compare digests without leaking where they first differ. */
  function sameDigest(a, b) {
    var x = String(a || "");
    var y = String(b || "");
    if (x.length !== y.length) { return false; }
    var diff = 0;
    for (var i = 0; i < x.length; i++) { diff |= x.charCodeAt(i) ^ y.charCodeAt(i); }
    return diff === 0;
  }

  /* ---------- store ---------- */

  function blankDb() {
    return { v: 2, users: [], invites: [], locks: {}, spray: { n: 0, since: 0 } };
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === "[object Array]";
  }

  function loadDb() {
    var db;
    try {
      db = JSON.parse(localStorage.getItem(DB_KEY) || "null");
    } catch (err) {
      db = null;
    }
    if (!db || typeof db !== "object") { db = blankDb(); }
    if (!isArray(db.users)) { db.users = []; }
    if (!isArray(db.invites)) { db.invites = []; }
    if (!db.locks || typeof db.locks !== "object") { db.locks = {}; }
    if (!db.spray || typeof db.spray !== "object") { db.spray = { n: 0, since: 0 }; }
    return db;
  }

  function saveDb(db) {
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(db));
      return true;
    } catch (err) {
      return false;
    }
  }

  function now() { return Date.now(); }
  function iso() { return new Date().toISOString(); }

  function findByEmail(db, email) {
    var mail = String(email || "").trim().toLowerCase();
    for (var i = 0; i < db.users.length; i++) {
      if (db.users[i].id === mail) { return db.users[i]; }
    }
    return null;
  }

  function findByUsername(db, username) {
    var u = String(username || "").trim().toLowerCase();
    if (!u) { return null; }
    for (var i = 0; i < db.users.length; i++) {
      if (db.users[i].username === u) { return db.users[i]; }
    }
    return null;
  }

  function findByLogin(db, identifier) {
    var v = String(identifier || "").trim().toLowerCase();
    return findByEmail(db, v) || findByUsername(db, v);
  }

  function findById(db, id) {
    for (var i = 0; i < db.users.length; i++) {
      if (db.users[i].id === id) { return db.users[i]; }
    }
    return null;
  }

  /* Accounts made by the old plaintext build are re-hashed on first load and
     the clear copy is thrown away. The id stays the email so the rooms and
     tenants already saved under that key are still found. */
  function migrate() {
    var legacy;
    try {
      legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || "null");
    } catch (err) {
      legacy = null;
    }
    if (!isArray(legacy) || !legacy.length) { return Promise.resolve(); }
    if (needCrypto()) { return Promise.resolve(); }

    var db = loadDb();
    var jobs = legacy.map(function (old) {
      if (!old || !old.id || findByEmail(db, old.id)) { return Promise.resolve(null); }
      var salt = randomBytes(SALT_BYTES);
      return derive(String(old.pw == null ? "" : old.pw), salt, ITERATIONS)
        .then(function (hash) {
          return {
            id: String(old.id).toLowerCase(),
            username: "",
            name: old.name || String(old.id).split("@")[0],
            salt: toB64(salt),
            hash: hash,
            iter: ITERATIONS,
            created: old.created || iso(),
            stamp: iso()
          };
        });
    });

    return Promise.all(jobs).then(function (made) {
      /* The role is settled here rather than inside the map. Every hashing job
         runs in parallel, so inside the map they would all still see an empty
         list and every migrated account would come out as the owner. */
      made.forEach(function (u) {
        if (!u) { return; }
        u.role = db.users.length ? "staff" : "owner";
        db.users.push(u);
      });
      saveDb(db);
      try { localStorage.removeItem(LEGACY_KEY); } catch (err) {}
    });
  }

  var ready = migrate().catch(function () {});

  /* ---------- rate limiting ---------- */

  function waitFor(fails) {
    if (fails <= FREE_TRIES) { return 0; }
    var step = Math.min(fails - FREE_TRIES, WAITS.length) - 1;
    return WAITS[step];
  }

  /* Milliseconds still to wait before this login may be tried again. */
  function lockedFor(db, key) {
    var lock = db.locks[key];
    if (!lock) { return 0; }
    var left = (lock.until || 0) - now();
    return left > 0 ? left : 0;
  }

  function sprayLockedFor(db) {
    var s = db.spray;
    if (!s.since || now() - s.since > SPRAY_WINDOW) { return 0; }
    if (s.n < SPRAY_TRIES) { return 0; }
    var left = (s.since + SPRAY_WINDOW) - now();
    return left > 0 ? left : 0;
  }

  function noteFail(db, key) {
    var lock = db.locks[key] || { fails: 0, until: 0 };
    lock.fails += 1;
    lock.until = now() + waitFor(lock.fails);
    lock.last = iso();
    db.locks[key] = lock;

    var s = db.spray;
    if (!s.since || now() - s.since > SPRAY_WINDOW) { s.since = now(); s.n = 0; }
    s.n += 1;

    saveDb(db);
    return lock;
  }

  function clearFail(db, key) {
    delete db.locks[key];
    db.spray = { n: 0, since: 0 };
    saveDb(db);
  }

  function waitLabel(ms) {
    var secs = Math.ceil(ms / 1000);
    if (secs < 60) { return secs + (secs === 1 ? " second" : " seconds"); }
    var mins = Math.ceil(secs / 60);
    if (mins < 60) { return mins + (mins === 1 ? " minute" : " minutes"); }
    var hrs = Math.ceil(mins / 60);
    return hrs + (hrs === 1 ? " hour" : " hours");
  }

  /* ---------- password rules ---------- */

  function passwordProblem(pw, context) {
    var p = String(pw == null ? "" : pw);
    if (p.length < MIN_PASSWORD) {
      return "Use at least " + MIN_PASSWORD + " characters.";
    }
    if (p.length > 200) { return "That password is too long."; }
    if (COMMON.indexOf(p.toLowerCase()) !== -1) {
      return "That password is on every guessing list. Pick another.";
    }
    if (/^(.)\1+$/.test(p)) { return "One repeated character is not a password."; }

    var classes = 0;
    if (/[a-z]/.test(p)) { classes += 1; }
    if (/[A-Z]/.test(p)) { classes += 1; }
    if (/[0-9]/.test(p)) { classes += 1; }
    if (/[^A-Za-z0-9]/.test(p)) { classes += 1; }
    /* A long passphrase is strong without punctuation, so length buys a pass. */
    if (classes < 3 && p.length < 16) {
      return "Mix upper case, lower case and numbers \u2014 or make it 16 characters long.";
    }

    var ctx = String((context && context.email) || "").split("@")[0];
    if (ctx && ctx.length > 3 && p.toLowerCase().indexOf(ctx.toLowerCase()) !== -1) {
      return "Do not put your own login inside your password.";
    }
    return null;
  }

  /* 0 to 4, for the meter under the password box. */
  function passwordScore(pw) {
    var p = String(pw == null ? "" : pw);
    if (!p) { return { score: 0, label: "" }; }
    var score = 0;
    if (p.length >= MIN_PASSWORD) { score += 1; }
    if (p.length >= 14) { score += 1; }
    if (p.length >= 20) { score += 1; }
    var classes = 0;
    if (/[a-z]/.test(p)) { classes += 1; }
    if (/[A-Z]/.test(p)) { classes += 1; }
    if (/[0-9]/.test(p)) { classes += 1; }
    if (/[^A-Za-z0-9]/.test(p)) { classes += 1; }
    if (classes >= 3) { score += 1; }
    if (COMMON.indexOf(p.toLowerCase()) !== -1) { score = 0; }
    score = Math.max(0, Math.min(4, score));
    return { score: score, label: ["Too weak", "Weak", "Fair", "Strong", "Very strong"][score] };
  }

  /* ---------- invites ---------- */

  function makeCode() {
    var bytes = randomBytes(16);
    var out = "";
    for (var i = 0; i < 16; i++) {
      if (i && i % 4 === 0) { out += "-"; }
      out += CODE_ALPHABET.charAt(bytes[i] % CODE_ALPHABET.length);
    }
    return out;
  }

  function tidyCode(text) {
    return String(text || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  }

  function inviteState(inv) {
    if (inv.usedAt) { return "used"; }
    if (inv.revoked) { return "revoked"; }
    if (new Date(inv.expires).getTime() < now()) { return "expired"; }
    return "open";
  }

  /* ---------- session ---------- */

  function readSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    } catch (err) {
      return null;
    }
  }

  function writeSession(s) {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (err) {}
  }

  function dropSession() {
    try {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem("pgAuth");
      sessionStorage.removeItem("pgUser");
      sessionStorage.removeItem("pgUserId");
    } catch (err) {}
  }

  function startSession(user) {
    writeSession({
      uid: user.id,
      name: user.name,
      username: user.username || "",
      role: user.role,
      stamp: user.stamp,
      issued: now(),
      seen: now()
    });
  }

  var OUT = { signedIn: false, name: null, id: null, username: "", role: null, reason: null };

  function localSession() {
    var s = readSession();
    if (!s || !s.uid) { return OUT; }

    if (now() - (s.issued || 0) > MAX_SESSION_MS) {
      dropSession();
      return { signedIn: false, name: null, id: null, username: "", role: null, reason: "expired" };
    }
    if (now() - (s.seen || 0) > IDLE_MS) {
      dropSession();
      return { signedIn: false, name: null, id: null, username: "", role: null, reason: "idle" };
    }

    /* A changed password moves the stamp, which retires every older session. */
    var user = findById(loadDb(), s.uid);
    if (!user || user.stamp !== s.stamp) {
      dropSession();
      return { signedIn: false, name: null, id: null, username: "", role: null, reason: "stale" };
    }

    s.seen = now();
    writeSession(s);
    return {
      signedIn: true,
      name: user.name,
      id: user.id,
      username: user.username || "",
      role: user.role,
      reason: null
    };
  }

  function nameFromUser(user) {
    if (!user) { return "Owner"; }
    var meta = user.user_metadata || {};
    if (meta.full_name) { return meta.full_name; }
    if (user.email) { return user.email.split("@")[0]; }
    return "Owner";
  }

  /* The shape rules a username must pass in either mode. Whether it is also
     free is answered differently: locally by the stored list, on Supabase by
     the unique index in supabase/schema.sql. */
  function shapeProblem(username) {
    var u = String(username || "").trim().toLowerCase();
    if (!u) { return "Pick a username."; }
    if (!USER_RE.test(u)) {
      return "3 to 20 characters, using letters, numbers, dot, dash or underscore.";
    }
    if (RESERVED.indexOf(u) !== -1) { return "That username is reserved."; }
    if (EMAIL_RE.test(u)) { return "A username cannot be an email address."; }
    return null;
  }

  /* Turn a Postgres complaint into something an owner can act on. */
  function profileError(err) {
    var code = err && err.code ? String(err.code) : "";
    var text = err && err.message ? String(err.message) : "";
    if (code === "23505" || text.indexOf("duplicate key") !== -1) {
      return "That username is taken.";
    }
    if (code === "23514" || text.indexOf("profiles_username_shape") !== -1) {
      return "3 to 20 characters, using letters, numbers, dot, dash or underscore.";
    }
    if (code === "42P01" || text.indexOf("does not exist") !== -1) {
      return "Usernames need one more step: run supabase/schema.sql in the SQL editor.";
    }
    return text || "Could not save the username.";
  }

  function fail(message) { return { ok: false, error: message }; }

  /* ---------- api ---------- */

  var PGAuth = {
    mode: client ? "supabase" : "local",
    minPassword: MIN_PASSWORD,
    idleMinutes: Math.round(IDLE_MS / 60000),

    ready: function () { return ready; },

    isEmail: function (value) { return EMAIL_RE.test(String(value || "").trim()); },

    passwordScore: passwordScore,

    /* True while no account exists at all. The very first sign-up claims the
       property and becomes the owner; everyone after that needs an invite. */
    needsBootstrap: function () {
      if (client) {
        /* Check if any profiles exist — if not, first user becomes owner */
        return client.from("profiles").select("id").limit(1).then(function (res) {
          return !(res && res.data && res.data.length);
        }).catch(function () { return false; });
      }
      return ready.then(function () { return loadDb().users.length === 0; });
    },

    usernameProblem: function (username, selfId) {
      var u = String(username || "").trim().toLowerCase();
      var problem = shapeProblem(u);
      if (problem) { return problem; }

      /* On Supabase the local list is empty and the unique index decides, so
         there is nothing useful to answer here without a round trip. */
      if (client) { return null; }

      var taken = findByUsername(loadDb(), u);
      if (taken && taken.id !== selfId) { return "That username is taken."; }
      return null;
    },

    /* Create an account. An invite code is required unless this is the first. */
    signUp: function (opts) {
      var o = opts || {};
      var name = String(o.name || "").trim().slice(0, 60);
      var mail = String(o.email || "").trim().toLowerCase();
      var pw = String(o.password == null ? "" : o.password);
      var code = tidyCode(o.invite);

      if (client) {
        return client.from("profiles").select("id").limit(1).then(function (check) {
          var isFirst = !(check && check.data && check.data.length);
          var role = isFirst ? "owner" : "staff";
          return client.auth.signUp({
            email: mail,
            password: pw,
            options: { data: { full_name: name, role: role } }
          }).then(function (res) {
            if (res.error) { return fail(res.error.message); }
            /* Auto-create profile row */
            if (res.data && res.data.user) {
              client.from("profiles").upsert({
                id: res.data.user.id,
                name: name,
                role: role
              }, { onConflict: "id" }).then(function () {}, function () {});
              /* Auto-create property row for owner */
              if (isFirst) {
                client.from("properties").upsert({
                  id: res.data.user.id,
                  owner_id: res.data.user.id,
                  name: "",
                  owner_name: name
                }, { onConflict: "id" }).then(function () {}, function () {});
              }
            }
            return { ok: true, needsConfirm: !(res.data && res.data.session) };
          }, function (err) {
            return fail(err && err.message ? err.message : "Could not reach Supabase.");
          });
        }).catch(function () {
          return client.auth.signUp({
            email: mail,
            password: pw,
            options: { data: { full_name: name, role: "staff" } }
          }).then(function (res) {
            if (res.error) { return fail(res.error.message); }
            return { ok: true, needsConfirm: !(res.data && res.data.session) };
          }, function (err) {
            return fail(err && err.message ? err.message : "Could not reach Supabase.");
          });
        });
      }

      var blocked = needCrypto();
      if (blocked) { return Promise.resolve(fail(blocked)); }

      return ready.then(function () {
        var db = loadDb();
        var first = db.users.length === 0;

        if (!name) { return fail("Enter your name."); }
        if (!EMAIL_RE.test(mail)) { return fail("Enter a valid email address."); }
        if (findByEmail(db, mail)) { return fail("That email already has a login."); }

        var bad = passwordProblem(pw, { email: mail });
        if (bad) { return fail(bad); }

        if (first) { return makeUser(db, mail, name, pw, "owner", null); }

        if (!code) { return fail("You need an invite code from the owner to create a login."); }

        return sha256(code).then(function (digest) {
          var match = null;
          for (var i = 0; i < db.invites.length; i++) {
            if (sameDigest(db.invites[i].digest, digest)) { match = db.invites[i]; break; }
          }
          if (!match) { return fail("That invite code is not recognised."); }

          var state = inviteState(match);
          if (state === "used") { return fail("That invite code has already been used."); }
          if (state === "revoked") { return fail("That invite code was cancelled."); }
          if (state === "expired") { return fail("That invite code has expired. Ask for a new one."); }

          return makeUser(db, mail, name, pw, match.role || "staff", match);
        });
      });

      function makeUser(db, mail2, name2, pw2, role, invite) {
        var salt = randomBytes(SALT_BYTES);
        return derive(pw2, salt, ITERATIONS).then(function (hash) {
          db.users.push({
            id: mail2,
            username: "",
            name: name2,
            salt: toB64(salt),
            hash: hash,
            iter: ITERATIONS,
            role: role,
            created: iso(),
            stamp: iso()
          });
          if (invite) {
            invite.usedAt = iso();
            invite.usedBy = mail2;
          }
          if (!saveDb(db)) { return fail("Could not save the account in this browser."); }
          return { ok: true, needsConfirm: false, role: role };
        });
      }
    },

    /* Sign in with either the email or the username. */
    signIn: function (identifier, password) {
      var id = String(identifier || "").trim().toLowerCase();
      var pw = String(password == null ? "" : password);

      if (client) {
        return client.auth.signInWithPassword({ email: id, password: pw })
          .then(function (res) {
            if (res.error) { return fail(res.error.message); }
            return { ok: true, name: nameFromUser(res.data ? res.data.user : null) };
          }, function (err) {
            return fail(err && err.message ? err.message : "Could not reach Supabase.");
          });
      }

      var blocked = needCrypto();
      if (blocked) { return Promise.resolve(fail(blocked)); }

      return ready.then(function () {
        var db = loadDb();

        var spray = sprayLockedFor(db);
        if (spray > 0) {
          return { ok: false, locked: true, waitMs: spray,
            error: "Too many failed attempts from this browser. Try again in " + waitLabel(spray) + "." };
        }

        var left = lockedFor(db, id);
        if (left > 0) {
          return { ok: false, locked: true, waitMs: left,
            error: "Too many attempts. Try again in " + waitLabel(left) + "." };
        }

        var user = findByLogin(db, id);

        /* No account? Still burn the same time, so the wrong answer never
           arrives faster than the right one and reveals who exists. */
        if (!user) {
          return derive(pw, randomBytes(SALT_BYTES), ITERATIONS).then(function () {
            var lock = noteFail(loadDb(), id);
            return wrong(lock);
          });
        }

        return derive(pw, fromB64(user.salt), user.iter || ITERATIONS).then(function (hash) {
          if (!sameDigest(hash, user.hash)) {
            var lock = noteFail(loadDb(), id);
            return wrong(lock);
          }
          clearFail(loadDb(), id);
          startSession(user);
          return { ok: true, name: user.name, role: user.role };
        });
      });

      function wrong(lock) {
        var waitMs = lock.until - now();
        var left = FREE_TRIES + 1 - lock.fails;
        var extra = waitMs > 0
          ? " Locked for " + waitLabel(waitMs) + "."
          : (left > 0 && left <= 2 ? " " + left + (left === 1 ? " try" : " tries") + " left." : "");
        return { ok: false, waitMs: waitMs > 0 ? waitMs : 0,
          error: "Wrong login or password." + extra };
      }
    },

    session: function () {
      if (client) {
        return client.auth.getSession().then(function (res) {
          var s = res && res.data ? res.data.session : null;
          if (s) {
            var meta = (s.user && s.user.user_metadata) || {};
            return {
              signedIn: true,
              name: nameFromUser(s.user),
              id: (s.user && s.user.id) || "supabase",
              username: meta.username || "",
              role: meta.role || "owner",
              reason: null
            };
          }
          return OUT;
        }, function () { return OUT; });
      }
      return ready.then(localSession);
    },

    /* Push the idle clock forward while somebody is actually working. */
    touch: function () {
      var s = readSession();
      if (s && s.uid) { s.seen = now(); writeSession(s); }
    },

    signOut: function () {
      dropSession();
      if (client) { return client.auth.signOut().catch(function () {}); }
      return Promise.resolve();
    },

    setUsername: function (username) {
      var u = String(username || "").trim().toLowerCase();

      if (client) {
        var problem = shapeProblem(u);
        if (problem) { return Promise.resolve(fail(problem)); }

        return client.auth.getUser().then(function (who) {
          var me = who && who.data ? who.data.user : null;
          if (!me) { return fail("Sign in first."); }

          /* The table is the source of truth. If someone else already holds
             this name the unique index rejects the write, which is the only
             answer that cannot be raced or faked from the browser. */
          return client.from("profiles")
            .upsert({ id: me.id, username: u }, { onConflict: "id" })
            .then(function (res) {
              if (res && res.error) { return fail(profileError(res.error)); }

              /* Mirror it onto the account so the session can show it without
                 a second query. The table still decides who owns it. */
              function done() { return { ok: true, username: u }; }
              return client.auth.updateUser({ data: { username: u } })
                .then(done, done);
            });
        }).catch(function () { return fail("Could not save the username."); });
      }

      return ready.then(function () {
        var s = readSession();
        if (!s || !s.uid) { return fail("Sign in first."); }

        var problem = PGAuth.usernameProblem(u, s.uid);
        if (problem) { return fail(problem); }

        var db = loadDb();
        var user = findById(db, s.uid);
        if (!user) { return fail("Sign in first."); }

        user.username = u;
        if (!saveDb(db)) { return fail("Could not save the username."); }

        s.username = u;
        writeSession(s);
        return { ok: true, username: u };
      });
    },

    changePassword: function (current, next) {
      var cur = String(current == null ? "" : current);
      var nxt = String(next == null ? "" : next);

      if (client) {
        var weak = passwordProblem(nxt, {});
        if (weak) { return Promise.resolve(fail(weak)); }
        if (cur === nxt) { return Promise.resolve(fail("That is the password you already have.")); }

        /* Supabase happily lets any live session set a new password without
           proving the old one. Somebody who finds an unlocked screen should
           not be able to walk off with the account, so the current password
           is checked before the new one is accepted. */
        return client.auth.getUser().then(function (who) {
          var mail = who && who.data && who.data.user ? who.data.user.email : "";
          if (!mail) { return fail("Sign in first."); }

          return client.auth.signInWithPassword({ email: mail, password: cur })
            .then(function (check) {
              if (check.error) { return fail("That is not your current password."); }
              return client.auth.updateUser({ password: nxt }).then(function (res) {
                if (res.error) { return fail(res.error.message); }
                return { ok: true };
              });
            });
        }).catch(function () { return fail("Could not change the password."); });
      }

      var blocked = needCrypto();
      if (blocked) { return Promise.resolve(fail(blocked)); }

      return ready.then(function () {
        var s = readSession();
        if (!s || !s.uid) { return fail("Sign in first."); }

        var db = loadDb();
        var user = findById(db, s.uid);
        if (!user) { return fail("Sign in first."); }

        var bad = passwordProblem(nxt, { email: user.id });
        if (bad) { return fail(bad); }
        if (cur === nxt) { return fail("That is the password you already have."); }

        return derive(cur, fromB64(user.salt), user.iter || ITERATIONS).then(function (hash) {
          if (!sameDigest(hash, user.hash)) {
            return fail("Your current password is not right.");
          }
          var salt = randomBytes(SALT_BYTES);
          return derive(nxt, salt, ITERATIONS).then(function (fresh) {
            user.salt = toB64(salt);
            user.hash = fresh;
            user.iter = ITERATIONS;
            user.stamp = iso();
            if (!saveDb(db)) { return fail("Could not save the new password."); }
            /* The stamp moved, so this tab needs a session that matches. */
            startSession(user);
            return { ok: true };
          });
        });
      });
    },

    /* ---------- invites, owner only ---------- */

    createInvite: function (opts) {
      var o = opts || {};
      var label = String(o.label || "").trim().slice(0, 40);
      var role = o.role === "owner" ? "owner" : "staff";
      var days = Number(o.days) > 0 ? Number(o.days) : INVITE_DAYS;

      var blocked = needCrypto();
      if (blocked) { return Promise.resolve(fail(blocked)); }

      return ready.then(function () {
        var s = readSession();
        if (!s || s.role !== "owner") { return fail("Only the owner can invite people."); }

        var code = makeCode();
        return sha256(tidyCode(code)).then(function (digest) {
          var db = loadDb();
          if (db.invites.filter(function (i) { return inviteState(i) === "open"; }).length >= 20) {
            return fail("That is as many open invites as one property needs.");
          }
          db.invites.unshift({
            digest: digest,
            hint: code.slice(0, 4),
            label: label,
            role: role,
            created: iso(),
            expires: new Date(now() + days * 86400000).toISOString(),
            usedAt: null,
            usedBy: null,
            revoked: false
          });
          if (!saveDb(db)) { return fail("Could not save the invite."); }
          /* The plain code is handed back exactly once, right here. Only its
             digest is stored, so it cannot be looked up again later. */
          return { ok: true, code: code };
        });
      });
    },

    listInvites: function () {
      var db = loadDb();
      return db.invites.map(function (i) {
        return {
          digest: i.digest,
          hint: i.hint,
          label: i.label,
          role: i.role,
          created: i.created,
          expires: i.expires,
          usedBy: i.usedBy,
          state: inviteState(i)
        };
      });
    },

    revokeInvite: function (digest) {
      var s = readSession();
      if (!s || s.role !== "owner") { return fail("Only the owner can cancel invites."); }
      var db = loadDb();
      for (var i = 0; i < db.invites.length; i++) {
        if (db.invites[i].digest === digest) {
          if (db.invites[i].usedAt) { return fail("That invite was already used."); }
          db.invites[i].revoked = true;
          saveDb(db);
          return { ok: true };
        }
      }
      return fail("That invite is gone already.");
    },

    listPeople: function () {
      return loadDb().users.map(function (u) {
        return { id: u.id, name: u.name, username: u.username || "", role: u.role, created: u.created };
      });
    },

    /* Expose the Supabase client so other modules reuse it (no duplicates) */
    getClient: function () { return client; }
  };

  global.PGAuth = PGAuth;
})(window);
