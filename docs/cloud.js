/*
 * cloud.js — optional account layer (Supabase email/password login).
 *
 * Local-first by design: signed OUT, MonsterBox behaves exactly as before
 * (everything in this browser's IndexedDB, no account needed). Signing IN is
 * optional and surfaces the user's MonsterBox access level; cloud SYNC of the
 * compendium is wired on top of this in the next step.
 *
 * Identity is handled entirely by Supabase. The user's plan/role (Pro, comp,
 * admin / "god account") lives in OUR backend and is read from /api/auth/me.
 */
(function () {
  "use strict";

  // --- public config (safe to ship; the anon key is meant to be public) ---
  const SUPABASE_URL = "https://rioxklylnljvozdbabgm.supabase.co";
  const SUPABASE_ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJpb3hrbHlsbmxqdm96ZGJhYmdtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExODQ0MTcsImV4cCI6MjA5Njc2MDQxN30.WZmTwluvvGmvW1oZl3sy0CWMxy1Pj6xAcMbX-CLvFy0";

  // Where the MonsterBox backend lives. Local dev -> the FastAPI server on :8090.
  // (The production URL is filled in once the backend is deployed.)
  const API_BASE =
    location.hostname === "127.0.0.1" || location.hostname === "localhost"
      ? "http://127.0.0.1:8090"
      : "https://monsterbox-api.onrender.com";

  // bypass the IndexedDB fetch-shim so backend calls actually leave the browser
  const directFetch = window.sfDirectFetch || window.fetch.bind(window);
  const $ = (id) => document.getElementById(id);

  // BETA-ONLY: auto-send a signed-in tester's imported PDFs to the dev for parser
  // testing (testers consented). Flip to false / delete this block to retire it.
  const BETA_COLLECT_PDFS = true;

  let supa = null;
  let session = null;   // Supabase session (null = signed out)
  let account = null;   // our backend's view: { email, plan, role, has_full_access }
  let curMsg = "authmsg";   // which view's message line msg() writes to

  function client() {
    if (supa) return supa;
    if (!window.supabase || !window.supabase.createClient) return null;
    supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supa;
  }

  // ---- backend account / entitlement ----
  let acctErr = null;   // why the last access check failed (for the diagnostic line)
  async function fetchAccount() {
    account = null; acctErr = null;
    if (!session) return;
    if (!API_BASE) { acctErr = "no server configured for this site"; return; }
    try {
      const r = await directFetch(API_BASE + "/api/auth/me", {
        headers: { Authorization: "Bearer " + session.access_token },
      });
      if (r.ok) { account = await r.json(); }
      else {
        acctErr = "server replied HTTP " + r.status;
        try { const t = (await r.text()) || ""; if (t) acctErr += " (" + t.slice(0, 80) + ")"; } catch (e) {}
      }
    } catch (e) {
      acctErr = "couldn't reach the server at " + API_BASE + " (is it running?)";
    }
    if (acctErr) console.warn("[MonsterBox] access check:", acctErr);
  }

  function accessTag() {
    if (!account || !account.has_full_access) return "Free";
    if (account.role === "admin") return "Admin";
    if (account.plan === "comp") return "Full access";
    return "Pro";
  }

  // ---- UI ----
  function displayName() {
    const m = (session && session.user && session.user.user_metadata) || {};
    const f = (m.first_name || "").trim(), l = (m.last_name || "").trim();
    if (f || l) return [f, l].filter(Boolean).join(" ");
    const email = (session && session.user && session.user.email) || "";
    return email.split("@")[0] || "Account";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function render() {
    const btn = $("signinbtn");
    const macct = $("mAccountBtn");   // tablet/mobile top-bar account button
    if (!btn && !macct) return;
    if (session) {
      const full = !!(account && account.has_full_access);
      // Only show a plan tag for full-access accounts (Pro/Full access/Admin). The
      // "Free" tag is unnecessary exposition for now, so free accounts show none.
      const tag = full ? ' <span class="signin-tag">' + esc(accessTag()) + "</span>" : "";
      const ttl = ((session.user && session.user.email) || "") + " - " + accessTag();
      if (btn) {
        btn.innerHTML = "Signed in: " + esc(displayName()) + tag;
        btn.classList.remove("primary"); btn.classList.add("signed");
        btn.title = ttl;
      }
      if (macct) {
        macct.innerHTML = "Account" + tag;
        macct.classList.remove("acct-out"); macct.title = ttl;
      }
    } else {
      if (btn) {
        btn.textContent = "Sign In";
        btn.classList.add("primary"); btn.classList.remove("signed");
        btn.title = "Sign in to sync your compendium across devices";
      }
      if (macct) {
        macct.textContent = "Sign In";
        macct.classList.add("acct-out");
        macct.title = "Sign in to sync your compendium across devices";
      }
    }
  }

  function msg(text, kind) {
    const m = $(curMsg);
    if (m) { m.textContent = text || ""; m.className = "auth-msg" + (kind ? " " + kind : ""); }
  }

  // three views in one modal: sign-in / create-account / signed-in account.
  // The account view is a landscape card with its own header, so the shared
  // header is hidden and the box widens.
  function setView(view) {
    const account = view === "account";
    $("authForm").style.display = view === "signin" ? "block" : "none";
    $("authCreate").style.display = view === "create" ? "block" : "none";
    $("authAccount").style.display = account ? "flex" : "none";
    $("authHeader").style.display = account ? "none" : "block";
    $("authAcctActions").style.display = account ? "flex" : "none";
    $("authCloseShared").style.display = account ? "none" : "inline-block";
    $("authBox").classList.toggle("account-mode", account);
    if (!account) $("authTitle").textContent = view === "create" ? "Create account" : "Sign in";
    $("authModal").style.display = "flex";
  }
  function showSignIn() {
    curMsg = "authmsg"; msg("");
    setView("signin");
    const e = $("authEmail"); if (e) setTimeout(() => e.focus(), 30);
  }
  function showCreate() {
    curMsg = "authmsg2"; msg("");
    setView("create");
    const e = $("authNewEmail"); if (e) setTimeout(() => e.focus(), 30);
  }
  async function showModal() {
    if (!session) { showSignIn(); return; }
    setView("account");
    curMsg = "authmsg3"; msg("");
    $("authNameEdit").style.display = "none";
    $("authAcctName").textContent = displayName();
    $("authAcctEmail").textContent = (session.user && session.user.email) || "";
    paintTag();
    // re-check access in case the backend wasn't running when we first logged in
    await fetchAccount();
    paintTag();
    render();
  }
  function editName() {
    const meta = (session && session.user && session.user.user_metadata) || {};
    $("authEditFirst").value = meta.first_name || "";
    $("authEditLast").value = meta.last_name || "";
    curMsg = "authmsg3"; msg("");
    $("authNameEdit").style.display = "block";
  }
  function cancelEdit() { $("authNameEdit").style.display = "none"; curMsg = "authmsg3"; msg(""); }
  function paintTag() {
    const el = $("authAcctTag");
    if (!el) return;
    const full = !!(account && account.has_full_access);
    el.textContent = full ? accessTag() : "";   // hide the "Free" tag (unnecessary for now)
    el.style.display = full ? "" : "none";
    el.classList.toggle("full", full);
    const d = $("authAcctDiag");
    if (d) d.textContent = (!account && acctErr) ? ("Access not confirmed: " + acctErr) : "";
    // shareable account id (so a friend can be comped by code, not email)
    const idRow = $("authAcctId");
    if (idRow) {
      const aid = account && account.account_id;
      idRow.style.display = aid ? "flex" : "none";
      const v = $("authAcctIdVal");
      if (v) v.textContent = aid || "";
    }
    // admin-only: the in-app issue Reports + collected Books buttons
    const isAdmin = !!(account && account.role === "admin");
    const ab = $("authAccountsBtn"); if (ab) ab.style.display = isAdmin ? "inline-block" : "none";
    const rb = $("authReportsBtn"); if (rb) rb.style.display = isAdmin ? "inline-block" : "none";
    const bb = $("booksBtn"); if (bb) bb.style.display = (isAdmin && BETA_COLLECT_PDFS) ? "inline-block" : "none";
    checkAdminAlerts();
  }

  // Admin only: show a red dot on the sign-in button when there are reports or
  // collected books waiting. Cleared automatically once both lists are empty.
  async function checkAdminAlerts() {
    const setDot = (on) => { for (const id of ["signinbtn", "mAccountBtn"]) { const b = $(id); if (b) b.classList.toggle("has-alert", !!on); } };
    if (!session || !account || account.role !== "admin") { setDot(false); return; }
    try {
      const auth = { Authorization: "Bearer " + session.access_token };
      const grab = (url) => directFetch(API_BASE + url, { headers: auth }).then(r => r.ok ? r.json() : []).catch(() => []);
      const [reports, books] = await Promise.all([grab("/api/admin/reports"), BETA_COLLECT_PDFS ? grab("/api/beta/pdfs") : Promise.resolve([])]);
      setDot((reports.length || 0) + (books.length || 0) > 0);
    } catch (e) { /* leave dot as-is on a transient error */ }
  }

  // ---- admin: in-app issue Reports view ----
  async function openReports() {
    if (!session || !account || account.role !== "admin") return;
    const modal = $("reportsModal"), list = $("reportsList");
    if (!modal || !list) return;
    list.innerHTML = '<div class="rep-empty">Loading…</div>';
    modal.style.display = "flex";
    let reports;
    try {
      const r = await directFetch(API_BASE + "/api/admin/reports", { headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      reports = await r.json();
    } catch (e) { list.innerHTML = '<div class="rep-empty">Couldn\'t load reports.</div>'; return; }
    if (!reports.length) { list.innerHTML = '<div class="rep-empty">No reports yet.</div>'; return; }
    list.innerHTML = reports.map(rp => {
      const when = rp.created_at ? new Date(rp.created_at).toLocaleString() : "";
      return '<div class="rep"><div class="rep-head"><span class="rep-from">' + esc(rp.email || "(no email given)") +
        '</span><span class="rep-when">' + esc(when) + '</span></div><div class="rep-msg">' + esc(rp.message) + "</div>" +
        (rp.had_screenshot ? '<button class="btn rep-shotbtn" onclick="cloudLoadShot(' + rp.id + ', this)">View screenshot</button>' : "") +
        '<button class="btn rep-shotbtn" onclick="cloudResolveReport(' + rp.id + ', this)">Resolve &amp; remove</button>' + "</div>";
    }).join("");
  }
  async function loadShot(id, btn) {
    btn.disabled = true; btn.textContent = "Loading…";
    try {
      const r = await directFetch(API_BASE + "/api/admin/reports/" + id + "/screenshot", { headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error();
      const url = URL.createObjectURL(await r.blob());
      const img = document.createElement("img"); img.src = url; img.className = "rep-img";
      btn.parentNode.replaceChild(img, btn);
    } catch (e) { btn.disabled = false; btn.textContent = "Couldn't load image"; }
  }
  async function resolveReport(id, btn) {
    if (!confirm("Resolve and permanently remove this report?")) return;
    btn.disabled = true; btn.textContent = "Removing…";
    try {
      const r = await directFetch(API_BASE + "/api/admin/reports/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error();
      const rep = btn.closest(".rep"); if (rep) rep.remove();
      checkAdminAlerts();
    } catch (e) { btn.disabled = false; btn.textContent = "Failed"; }
  }
  function closeReports() { const m = $("reportsModal"); if (m) m.style.display = "none"; }

  // ---- admin: all accounts + grant/revoke comp ----
  async function openAccounts() {
    if (!session || !account || account.role !== "admin") return;
    const modal = $("accountsModal"), list = $("accountsList");
    if (!modal || !list) return;
    list.innerHTML = '<div class="rep-empty">Loading…</div>';
    modal.style.display = "flex";
    let users;
    try {
      const r = await directFetch(API_BASE + "/api/admin/users", { headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      users = await r.json();
    } catch (e) { list.innerHTML = '<div class="rep-empty">Couldn\'t load accounts.</div>'; return; }
    if (!users.length) { list.innerHTML = '<div class="rep-empty">No accounts yet.</div>'; return; }
    const summary = '<div class="rep-empty">' + users.length + ' account' + (users.length === 1 ? '' : 's') +
      ' &middot; ' + users.filter(u => u.has_full_access).length + ' with full access</div>';
    list.innerHTML = summary + users.map(renderAcctRow).join("");
  }
  function renderAcctRow(u) {
    const aid = u.account_id || "";
    const when = u.created_at ? new Date(u.created_at).toLocaleDateString() : "";
    const plan = u.role === "admin" ? "admin" : u.plan;
    const access = u.has_full_access ? "full access" : "free";
    const pending = u.signed_in === false ? " &middot; not signed in yet" : "";
    // toggle: comp <-> free. Admins are left alone (don't let the dev demote themselves here).
    const toggle = u.role === "admin" ? "" : (u.has_full_access
      ? '<button class="btn rep-shotbtn" onclick="cloudSetPlan(\'' + aid + '\',\'free\',this)">Set to free</button>'
      : '<button class="btn rep-shotbtn" onclick="cloudSetPlan(\'' + aid + '\',\'comp\',this)">Grant comp</button>');
    return '<div class="rep" data-aid="' + esc(aid) + '"><div class="rep-head"><span class="rep-from">' +
      esc(u.email || "(no email)") + '</span><span class="rep-when">' + esc(when) + '</span></div>' +
      '<div class="rep-msg">' + esc(aid || "(no id)") + ' &middot; <b>' + esc(plan) + '</b> (' + access + ')' + pending + '</div>' +
      (aid ? toggle : '<span class="rep-when">no id — can\'t change until first sign-in</span>') + '</div>';
  }
  async function setPlan(accountId, plan, btn) {
    if (!accountId) return;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const r = await directFetch(API_BASE + "/api/admin/grant", {
        method: "POST", headers: { Authorization: "Bearer " + session.access_token, "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, plan: plan }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const u = await r.json();
      const row = btn.closest(".rep");
      if (row) row.outerHTML = renderAcctRow(u);   // re-render this row with its new state + flipped button
    } catch (e) { btn.disabled = false; btn.textContent = "Failed"; }
  }
  function closeAccounts() { const m = $("accountsModal"); if (m) m.style.display = "none"; }

  // ---- BETA-ONLY: auto-collect imported PDFs (consented testers) ----
  async function betaUploadPdf(file) {
    if (!BETA_COLLECT_PDFS || !file || !API_BASE) return;
    if (session && account && account.role === "admin") return;   // skip the dev's own imports
    try {
      const fd = new FormData(); fd.append("file", file, file.name || "book.pdf");
      // Signed-in testers send their token (records their email); anonymous
      // testers (no account) are collected too, with no email attached.
      const headers = session ? { Authorization: "Bearer " + session.access_token } : {};
      await directFetch(API_BASE + "/api/beta/pdf", { method: "POST", headers, body: fd });
    } catch (e) { /* best-effort; never block or surface to the importer */ }
  }
  async function openBooks() {
    if (!session || !account || account.role !== "admin") return;
    const modal = $("booksModal"), list = $("booksList");
    if (!modal || !list) return;
    list.innerHTML = '<div class="rep-empty">Loading…</div>';
    modal.style.display = "flex";
    let books;
    try {
      const r = await directFetch(API_BASE + "/api/beta/pdfs", { headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error("HTTP " + r.status);
      books = await r.json();
    } catch (e) { list.innerHTML = '<div class="rep-empty">Couldn\'t load.</div>'; return; }
    const diagBar = '<button class="btn rep-shotbtn" style="margin-bottom:8px" onclick="cloudStorageDiag(this)">Run storage diagnostics</button>';
    if (!books.length) { list.innerHTML = diagBar + '<div class="rep-empty">No imported books collected yet.</div>'; return; }
    const anyUnstored = books.some(b => !b.has_file);
    const clearBar = anyUnstored ? '<button class="btn rep-shotbtn" style="margin-bottom:8px" onclick="cloudClearUnstored()">Clear the "too large to store" entries</button>' : "";
    list.innerHTML = diagBar + clearBar + books.map(b => {
      const when = b.created_at ? new Date(b.created_at).toLocaleString() : "";
      return '<div class="rep"><div class="rep-head"><span class="rep-from">' + esc(b.filename || "(unnamed)") +
        '</span><span class="rep-when">' + esc(when) + '</span></div><div class="rep-msg">' +
        esc(b.email || "(unknown)") + " · " + b.size_mb + " MB</div>" +
        (b.has_file ? '<button class="btn rep-shotbtn" onclick="cloudDownloadBook(' + b.id + ', this)">Download</button> '
                    : '<span class="rep-when">too large to store; ask the tester</span> ') +
        '<button class="btn rep-shotbtn" onclick="cloudDeleteBook(' + b.id + ', this)">Delete</button>' + "</div>";
    }).join("");
  }
  async function downloadBook(id, btn) {
    btn.disabled = true; btn.textContent = "Fetching…";
    try {
      const r = await directFetch(API_BASE + "/api/beta/pdfs/" + id + "/download", { headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error();
      const ct = r.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        // Supabase-storage path: a short-lived signed URL — download straight from Supabase.
        const { url } = await r.json();
        if (url) window.open(url, "_blank");
      } else {
        // Legacy DB-stored bytes.
        const blobUrl = URL.createObjectURL(await r.blob());
        const a = document.createElement("a"); a.href = blobUrl; a.download = "book.pdf"; a.click();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 4000);
      }
      btn.disabled = false; btn.textContent = "Download";
    } catch (e) { btn.disabled = false; btn.textContent = "Failed"; }
  }
  async function deleteBook(id, btn) {
    btn.disabled = true; btn.textContent = "Deleting…";
    try {
      const r = await directFetch(API_BASE + "/api/beta/pdfs/" + id, { method: "DELETE", headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error();
      const rep = btn.closest(".rep"); if (rep) rep.remove();   // drop the row
      checkAdminAlerts();
    } catch (e) { btn.disabled = false; btn.textContent = "Delete failed"; }
  }
  // Tidy up: remove the metadata-only ("too large to store") rows from the list.
  async function clearUnstored() {
    if (!confirm("Remove all “too large to store” entries? They were never stored; this just tidies the list. Note the filenames first if you still need them from the tester.")) return;
    try {
      const r = await directFetch(API_BASE + "/api/beta/pdfs/unstored", { method: "DELETE", headers: { Authorization: "Bearer " + session.access_token } });
      if (!r.ok) throw new Error();
    } catch (e) {}
    openBooks(); checkAdminAlerts();
  }
  // Admin: run the server-side storage self-test and show the result, so a
  // "too large to store" problem can be diagnosed without reading server logs.
  // Reports whether Supabase Storage is configured, the bucket's own file-size
  // limit (the usual culprit), and a live upload/sign/delete round-trip.
  async function storageDiag(btn) {
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    let out;
    try {
      const r = await directFetch(API_BASE + "/api/beta/storage-diag", { headers: { Authorization: "Bearer " + session.access_token } });
      out = await r.json();
    } catch (e) { out = { error: "couldn't reach the server" }; }
    if (btn) { btn.disabled = false; btn.textContent = "Run storage diagnostics"; }
    const lines = [];
    if (!out.storage_ready) {
      lines.push("Supabase Storage is NOT configured on the server.");
      lines.push("Books fall back to the database path, capped at 40 MB each; anything bigger shows \"too large to store\".");
      lines.push("Fix: set SUPABASE_SERVICE_KEY and SUPABASE_URL in the Render environment, then redeploy.");
    } else {
      lines.push("Storage configured: yes  (bucket: " + (out.bucket || "?") + ")");
      if (out.bucket_limit_warning) lines.push("PROBLEM: " + out.bucket_limit_warning);
      else if (out.bucket_file_size_limit) lines.push("Bucket file-size limit: " + (out.bucket_limit_mb ? out.bucket_limit_mb + " MB" : out.bucket_file_size_limit));
      if (out.storage_used_mb != null) lines.push("Storage used: " + out.storage_used_mb + " of " + out.storage_budget_mb + " MB budget (per-file cap " + out.per_file_cap_mb + " MB)");
      if (out.budget_warning) lines.push("PROBLEM: " + out.budget_warning);
      var lru = out.last_real_upload;
      if (lru && lru.when) {
        lines.push("Last real book upload: " + (lru.file || "?") + " (" + lru.size_mb + " MB) at " + lru.when +
          "\n  -> stored to: " + (lru.where || "?") + (lru.error ? "\n  -> ERROR: " + lru.error : "  (no error)"));
      } else if (lru) {
        lines.push("Last real book upload: none recorded since the server last restarted; import a book, then re-run this.");
      }
      lines.push("Test upload (tiny file): " + (out.upload || "?"));
      if (out.signed_url) lines.push("Signed URL: " + out.signed_url);
      if (out.result) lines.push("Result: " + out.result);
    }
    alert("Storage diagnostics\n\n" + lines.join("\n\n") + "\n\nRaw:\n" + JSON.stringify(out, null, 1));
  }
  function closeBooks() { const m = $("booksModal"); if (m) m.style.display = "none"; }

  async function copyId() {
    const aid = account && account.account_id;
    if (!aid) return;
    const btn = $("authAcctIdCopy");
    try { await navigator.clipboard.writeText(aid); }
    catch (_) { /* clipboard may be blocked; the id is visible to copy by hand */ }
    if (btn) { const o = btn.textContent; btn.textContent = "Copied"; setTimeout(() => { btn.textContent = o; }, 1200); }
  }
  function closeModal() { const m = $("authModal"); if (m) m.style.display = "none"; }

  async function signIn() {
    const email = ($("authEmail").value || "").trim();
    const pw = $("authPass").value || "";
    if (!email || !pw) return msg("Enter your email and password.", "err");
    const c = client(); if (!c) return msg("Login is unavailable right now.", "err");
    msg("Signing in…");
    const { error } = await c.auth.signInWithPassword({ email, password: pw });
    if (error) return msg(error.message, "err");
    closeModal();
  }

  async function createAccount() {
    const first = ($("authFirst").value || "").trim();
    const last = ($("authLast").value || "").trim();
    const email = ($("authNewEmail").value || "").trim();
    const pw = $("authNewPass").value || "";
    const pw2 = $("authNewPass2").value || "";
    if (!first || !last) return msg("Enter your first and last name.", "err");
    if (!email || !pw || !pw2) return msg("Fill in email, password and confirm password.", "err");
    if (pw.length < 8) return msg("Password must be at least 8 characters.", "err");
    if (pw !== pw2) return msg("Passwords don't match.", "err");
    const c = client(); if (!c) return msg("Sign-up is unavailable right now.", "err");
    msg("Creating your account…");
    const { data, error } = await c.auth.signUp({
      email, password: pw,
      options: { data: { first_name: first, last_name: last } },
    });
    if (error) return msg(error.message, "err");
    // confirmation is on, so signUp returns no session — prompt to confirm by email
    if (data && data.session) closeModal();
    else msg("Account created. Check your email to confirm, then log in.", "ok");
  }

  async function saveName() {
    curMsg = "authmsg3";
    const first = ($("authEditFirst").value || "").trim();
    const last = ($("authEditLast").value || "").trim();
    if (!first || !last) return msg("Enter your first and last name.", "err");
    const c = client(); if (!c) return;
    msg("Saving…");
    const { data, error } = await c.auth.updateUser({ data: { first_name: first, last_name: last } });
    if (error) return msg(error.message, "err");
    if (data && data.user) session.user = data.user;   // refresh local copy
    $("authAcctName").textContent = displayName();
    $("authNameEdit").style.display = "none";          // collapse the editor
    render();
  }

  async function signOut() {
    const c = client();
    if (c) await c.auth.signOut();
    closeModal();
  }

  async function onAuth(newSession) {
    session = newSession || null;
    await fetchAccount();
    render();
    // let the rest of the app react (sync hooks attach here later)
    if (typeof window.onCloudAuthChange === "function") {
      try { window.onCloudAuthChange(session, account); } catch (e) {}
    }
  }

  function init() {
    // #signinbtn uses inline onclick="cloudOpen()"; Enter-to-submit is handled
    // by the <form> onsubmit.
    const c = client();
    if (!c) { render(); return; }   // supabase-js failed to load -> stay signed-out
    c.auth.getSession().then(({ data }) => onAuth(data ? data.session : null));
    c.auth.onAuthStateChange((_evt, s) => onAuth(s));
    startKeepAlive();
  }

  // The backend runs on Render's free tier, which sleeps after ~15 min idle. The
  // first request while it is cold takes 30-60s and times out — surfacing as
  // "Sync paused (couldn't reach the server)" even though nothing is wrong. Ping
  // /health on load (to start waking it) and every 10 min while the app is open,
  // so it stays warm during a session. When a ping succeeds after sync had failed,
  // re-kick the sync so it recovers on its own instead of staying paused. Local
  // dev (:8090) is skipped.
  function startKeepAlive() {
    if (!API_BASE || /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
    const ping = () => directFetch(API_BASE + "/health", { cache: "no-store" })
      .then((r) => { if (r && r.ok && window.sfSyncStatus && window.sfSyncStatus() === "error" && window.sfSyncNow) window.sfSyncNow(); })
      .catch(() => {});
    ping();
    setInterval(ping, 10 * 60 * 1000);
  }

  // sync.js reports its status here; show it on the account card
  window.onSyncStatus = function (s) {
    const el = $("authSyncStatus");
    if (!el) return;
    const text = { syncing: "Syncing your compendium…", synced: "Compendium synced",
                   error: "Sync paused (couldn't reach the server)", off: "" };
    el.textContent = session ? (text[s] || "") : "";
    el.className = "acct-sync" + (s === "syncing" ? " syncing" : s === "error" ? " error" : "");
  };

  // expose for inline onclick handlers
  window.cloudOpen = showModal;
  window.cloudSignIn = signIn;
  window.cloudCreateAccount = createAccount;
  window.cloudSaveName = saveName;
  window.cloudEditName = editName;
  window.cloudCancelEdit = cancelEdit;
  window.cloudShowCreate = showCreate;
  window.cloudShowSignIn = showSignIn;
  window.cloudSignOut = signOut;
  window.cloudCloseModal = closeModal;
  window.cloudCopyId = copyId;
  window.cloudOpenReports = openReports;
  window.cloudLoadShot = loadShot;
  window.cloudResolveReport = resolveReport;
  window.cloudCloseReports = closeReports;
  window.cloudOpenAccounts = openAccounts;
  window.cloudCloseAccounts = closeAccounts;
  window.cloudSetPlan = setPlan;
  window.sfBetaUploadPdf = betaUploadPdf;
  window.cloudOpenBooks = openBooks;
  window.cloudDownloadBook = downloadBook;
  window.cloudDeleteBook = deleteBook;
  window.cloudClearUnstored = clearUnstored;
  window.cloudStorageDiag = storageDiag;
  window.cloudCloseBooks = closeBooks;
  window.cloudGetSession = () => session;
  window.cloudGetAccount = () => account;

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", init);
})();
