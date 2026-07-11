/* MonsterBox PWA engine — a fully client-side backend.
 *
 * The UI (index.html) talks to "/api/..." via fetch(). Here we monkey-patch
 * fetch() to answer those same routes locally, backed by IndexedDB and a small
 * JS roll/tracker engine. No server, no network — works offline on GitHub Pages.
 *
 * Storage is per-browser (each DM has their own compendium). Use the Export /
 * Import JSON buttons to back up or share libraries.
 */
(function () {
  "use strict";

  const realFetch = window.fetch.bind(window);
  // cloud.js uses this to reach the REAL backend; the shim below would otherwise
  // intercept any path containing "/api/" and answer it locally.
  window.sfDirectFetch = realFetch;
  // Fired after any local statblock write so the cloud-sync layer (sync.js) can
  // mirror it to the server. Suppressed while sync is applying a REMOTE change
  // back into IndexedDB, so we don't echo it straight back to the server.
  function notifyWrite(op, payload) {
    if (window._sfApplyingRemote) return;
    try { if (typeof window.sfOnWrite === "function") window.sfOnWrite(op, payload); } catch (e) {}
  }
  const OWNER = "local-user";
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2));

  // ---------------------------------------------------------------- IndexedDB
  let _db = null;
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("monsterbox", 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("statblocks")) db.createObjectStore("statblocks", { keyPath: "id" });
        if (!db.objectStoreNames.contains("encounters")) db.createObjectStore("encounters", { keyPath: "id" });
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv", { keyPath: "k" });
        // LOCAL-ONLY: cropped PDF screenshots for flagged stat blocks, shown beside
        // the review editor. Keyed by stat-block id. Never synced to the backend.
        if (!db.objectStoreNames.contains("shots")) db.createObjectStore("shots", { keyPath: "id" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx(store, mode) { return _db.transaction(store, mode).objectStore(store); }
  function pr(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
  const dbGet = (s, k) => pr(tx(s, "readonly").get(k));
  const dbAll = (s) => pr(tx(s, "readonly").getAll());
  const dbPut = (s, v) => pr(tx(s, "readwrite").put(v));
  const dbDel = (s, k) => pr(tx(s, "readwrite").delete(k));
  const dbClear = (s) => pr(tx(s, "readwrite").clear());
  async function kvGet(k, dflt) { const r = await dbGet("kv", k); return r ? r.v : dflt; }
  const kvPut = (k, v) => dbPut("kv", { k, v });

  // LOCAL-ONLY review screenshots (cropped PDF image per flagged stat block).
  // Kept out of the statblocks store so they never sync to the backend.
  window.sfSaveShot = async (id, img) => { await dbReady; try { await dbPut("shots", { id, img }); } catch (e) {} };
  window.sfGetShot = async (id) => { await dbReady; try { const r = await dbGet("shots", id); return r ? r.img : null; } catch (e) { return null; } };
  window.sfDeleteShot = async (id) => { await dbReady; try { await dbDel("shots", id); } catch (e) {} };

  // ------------------------------------------------------------- live state
  let currentEnc = { round: 0, active_index: 0, combatants: [], started: false };
  let rolls = [];
  const saveEnc = () => kvPut("currentEncounter", currentEnc);
  const saveRolls = () => kvPut("rolls", rolls);

  // ------------------------------------------------------------------- dice
  const abMod = (score) => Math.floor(((score == null ? 10 : score) - 10) / 2);
  function rollDie(n) { return 1 + Math.floor(Math.random() * n); }
  function rollD20(modifier, advantage) {
    let dice, pick;
    if (advantage === "advantage" || advantage === "disadvantage") {
      const a = rollDie(20), b = rollDie(20); dice = [a, b];
      pick = advantage === "advantage" ? Math.max(a, b) : Math.min(a, b);
    } else { pick = rollDie(20); dice = [pick]; }
    return { dice, total: pick + (modifier || 0), nat: pick };   // nat = the kept d20 before modifiers
  }
  function rollDiceExpr(diceStr, bonus) {
    const out = { results: [], total: bonus || 0 };
    const m = /(\d+)\s*d\s*(\d+)/i.exec(diceStr || "");
    if (m) { const c = +m[1], f = +m[2]; for (let i = 0; i < c; i++) { const r = rollDie(f); out.results.push(r); out.total += r; } }
    return out;
  }
  function makeEvent(o) {
    return {
      id: uuid(), owner_id: OWNER, timestamp: new Date().toISOString(),
      source: o.source, roll_type: o.roll_type, label: o.label,
      expression: o.expression, dice_results: o.dice_results,
      modifier: o.modifier || 0, total: o.total, target: null,
      advantage: o.advantage || null, nat: o.nat != null ? o.nat : null, private: true,
    };
  }
  const signed = (n) => (n >= 0 ? "+" + n : "" + n);

  // -------------------------------------------------------------- statblocks
  function crValue(cr) {
    if (!cr) return Infinity;
    cr = String(cr).trim();
    try { if (cr.includes("/")) { const [a, b] = cr.split("/"); return (+a) / (+b); } return parseFloat(cr); }
    catch (e) { return Infinity; }
  }
  // count of legendary resistances. The importer strips the "(3/Day)" suffix off
  // trait names (it lands in trait.usage / raw_text), so match the name loosely
  // and pull the count from wherever it survived; default to 1 if it has the
  // trait but no number parsed.
  function lrCount(sb) {
    for (const t of (sb.traits || [])) {
      if (!/legendary resistance/i.test(t.name || "")) continue;
      const m = /(\d+)\s*\/\s*day/i.exec(`${t.name || ""} ${t.usage || ""} ${t.raw_text || ""}`);
      return m ? +m[1] : 1;
    }
    return 0;
  }
  // Multiattack / Spellcasting can land in any bucket depending on the book's
  // layout (some omit the Actions header, some list spellcasting as an action or
  // bonus action), so scan them all. "Innate Spellcasting" matches too.
  const anyNamed = (sb, re) => [sb.actions, sb.traits, sb.bonus_actions, sb.reactions, sb.legendary_actions]
    .some(b => (b || []).some(a => re.test(a.name || "")));
  const hasMultiattack = (sb) => anyNamed(sb, /multiattack/i);
  const hasSpellcasting = (sb) => !!sb.spellcasting || anyNamed(sb, /spellcasting/i);
  async function listStatblocks() {
    const all = await dbAll("statblocks");
    const items = all.map(sb => ({
      id: sb.id, name: sb.name, challenge_rating: sb.challenge_rating,
      armor_class: sb.armor_class, hit_points: sb.hit_points,
      creature_type: sb.creature_type, size: sb.size,
      source: sb.source || null,
      abilities: sb.abilities || null,
      damage_resistances: sb.damage_resistances || [], damage_immunities: sb.damage_immunities || [],
      condition_immunities: sb.condition_immunities || [],
      legendary_resistances: lrCount(sb), has_multiattack: hasMultiattack(sb), has_spellcasting: hasSpellcasting(sb),
      parse_confidence: sb.parse_confidence, parse_warnings: sb.parse_warnings || [],
    }));
    items.sort((a, b) => (crValue(a.challenge_rating) - crValue(b.challenge_rating)) ||
      (a.name || "").toLowerCase().localeCompare((b.name || "").toLowerCase()));
    return items;
  }
  function findAction(sb, name) {
    for (const bucket of [sb.actions, sb.legendary_actions, sb.bonus_actions, sb.reactions, sb.traits]) {
      for (const a of (bucket || [])) if (a.name === name) return a;
    }
    return null;
  }

  // ---------------------------------------------------------------- tracker
  function encDump() {
    return {
      round: currentEnc.round, active_index: currentEnc.active_index,
      combatants: currentEnc.combatants.map(c => ({
        id: c.id, display_name: c.display_name, initiative: c.initiative,
        current_hp: c.current_hp, max_hp: c.max_hp, temp_hp: c.temp_hp || 0,
        armor_class: c.armor_class, statblock_id: c.statblock_id,
        is_player: !!c.is_player, conditions: (c.conditions || []).slice(),
        death_saves: c.death_saves || { successes: 0, failures: 0, stable: false, dead: false },
        can_undo: (c.hp_history || []).length > 0,
        lr: c.lr || 0, lr_max: c.lr_max || 0,
      })),
    };
  }
  // initiative as a number (a stray string like "21" or a NaN would corrupt the sort)
  function initVal(c) { const n = Number(c && c.initiative); return Number.isFinite(n) ? n : -Infinity; }
  function sortEnc() {
    // remember whose turn it is so a re-sort (e.g. adding a creature mid-fight)
    // keeps the SAME creature active instead of pointing at a new array position
    const cur = currentEnc.combatants[currentEnc.active_index];
    const activeId = cur && cur.id;
    currentEnc.combatants.sort((a, b) => initVal(b) - initVal(a));
    if (currentEnc.started && activeId) {
      const i = currentEnc.combatants.findIndex(c => c.id === activeId);
      currentEnc.active_index = i >= 0 ? i : 0;
    } else {
      currentEnc.active_index = 0;   // not started yet → highest initiative goes first
    }
  }
  function renumber() {
    const groups = {};
    currentEnc.combatants.forEach(c => { if (c.is_player) return; (groups[c.statblock_id] = groups[c.statblock_id] || []).push(c); });
    Object.values(groups).forEach(list => {
      if (list.length > 1) list.forEach((c, i) => { c.display_name = `${c.base || c.display_name.replace(/\s*#\d+$/, "")} #${i + 1}`; });
      else if (list.length === 1) list[0].display_name = list[0].base || list[0].display_name;
    });
  }
  async function spawn(statblockId, count) {
    const sb = await dbGet("statblocks", statblockId);
    if (!sb) return;
    const dex = abMod(sb.abilities && sb.abilities.dexterity);
    for (let i = 0; i < (count || 1); i++) {
      currentEnc.combatants.push({
        id: uuid(), statblock_id: sb.id, base: sb.name, display_name: sb.name,
        initiative: rollD20(dex).total, current_hp: sb.hit_points || 1,
        max_hp: sb.hit_points || 1, temp_hp: 0, armor_class: sb.armor_class || 10,
        is_player: false, conditions: [],
        hp_history: [], death_saves: { successes: 0, failures: 0, stable: false, dead: false },
        lr_max: lrCount(sb), lr: lrCount(sb),
      });
    }
    renumber(); sortEnc(); await saveEnc();
  }

  // ----------------------------------------------------------------- rolling
  async function doRoll(d) {
    const sb = await dbGet("statblocks", d.statblock_id);
    if (!sb) return { _status: 404, error: "stat block not found" };
    const source = d.source || sb.name;
    const kind = d.kind || "attack";
    const adv = d.advantage || null;
    let ev;
    if (kind === "attack") {
      const a = findAction(sb, d.action_name); if (!a) return { _status: 404, error: "action not found" };
      const toHit = (a.attack && a.attack.to_hit) || 0;
      const r = rollD20(toHit, adv);
      ev = makeEvent({ source, roll_type: "attack", label: `${a.name} to Hit`, expression: `1d20${signed(toHit)}`, dice_results: r.dice, modifier: toHit, total: r.total, advantage: adv, nat: r.nat });
    } else if (kind === "damage") {
      const a = findAction(sb, d.action_name); if (!a) return { _status: 404, error: "action not found" };
      const comps = a.damage || []; let dice = [], total = 0, parts = [];
      comps.forEach(c => {
        const reps = d.crit ? 2 : 1; let local = [];
        for (let k = 0; k < reps; k++) { const rr = rollDiceExpr(c.dice, 0); local = local.concat(rr.results); total += rr.total; }
        total += (c.bonus || 0); dice = dice.concat(local);
        parts.push(`${c.dice || ""}${c.bonus ? signed(c.bonus) : ""}`.trim());
      });
      ev = makeEvent({ source, roll_type: "damage", label: `${a.name} Damage`, expression: parts.join(" + ") || "-", dice_results: dice, total });
    } else if (kind === "skill") {
      const bonus = (() => { for (const [k, v] of Object.entries(sb.skills || {})) if (k.toLowerCase() === String(d.skill).toLowerCase()) return v; return 0; })();
      const r = rollD20(bonus, adv);
      ev = makeEvent({ source, roll_type: "check", label: `${String(d.skill).replace(/\b[a-z]/g, c => c.toUpperCase())} Check`, expression: `1d20${signed(bonus)}`, dice_results: r.dice, modifier: bonus, total: r.total, advantage: adv, nat: r.nat });
    } else if (kind === "initiative") {
      const m = abMod(sb.abilities && sb.abilities.dexterity); const r = rollD20(m, adv);
      ev = makeEvent({ source, roll_type: "check", label: "Initiative", expression: `1d20${signed(m)}`, dice_results: r.dice, modifier: m, total: r.total, advantage: adv, nat: r.nat });
    } else if (kind === "save" || kind === "check") {
      const ab = d.ability; const mod = abMod(sb.abilities && sb.abilities[{ str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" }[ab]]);
      let modifier = mod, label;
      if (kind === "save") {
        const ov = (() => { for (const [k, v] of Object.entries(sb.saving_throws || {})) if (k.toLowerCase() === ab) return v; return null; })();
        modifier = ov != null ? (parseInt(ov, 10) || 0) : mod; label = `${ab.toUpperCase()} Save`;   // ov may be "+13" (string)
      } else label = `${ab.toUpperCase()} Check`;
      const r = rollD20(modifier, adv);
      ev = makeEvent({ source, roll_type: kind === "save" ? "save" : "check", label, expression: `1d20${signed(modifier)}`, dice_results: r.dice, modifier, total: r.total, advantage: adv, nat: r.nat });
    } else return { _status: 400, error: `unknown roll kind '${kind}'` };
    rolls.push(ev); if (rolls.length > 200) rolls = rolls.slice(-200); await saveRolls();
    return ev;
  }

  // -------------------------------------------------------------- API router
  function jsonResp(obj, status) {
    const st = (obj && obj._status) || status || 200;
    if (obj && obj._status) delete obj._status;
    return new Response(JSON.stringify(obj), { status: st, headers: { "Content-Type": "application/json" } });
  }
  async function route(path, method, body) {
    let m;
    if (path === "/api/statblocks" && method === "GET") return jsonResp(await listStatblocks());
    if (path === "/api/statblocks" && method === "DELETE") { const n = (await dbAll("statblocks")).length; await dbClear("statblocks"); notifyWrite("clear"); return jsonResp({ deleted: n }); }
    if ((m = path.match(/^\/api\/statblocks\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]);
      if (method === "GET") { const sb = await dbGet("statblocks", id); return sb ? jsonResp(sb) : jsonResp({ error: "not found" }, 404); }
      if (method === "POST") {
        body.id = id; body.owner_id = OWNER;
        // a fresh local change bumps the clock (for last-write-wins); a remote
        // change being applied keeps the server's timestamp
        if (!window._sfApplyingRemote) body.updated_at = Date.now();
        await dbPut("statblocks", body); notifyWrite("upsert", body); return jsonResp(body);
      }
      if (method === "DELETE") { await dbDel("statblocks", id); notifyWrite("delete", { id }); return jsonResp({ deleted: true }); }
    }
    if (path === "/api/encounter" && method === "GET") return jsonResp(encDump());
    if (path === "/api/encounter/spawn" && method === "POST") { await spawn(body.statblock_id, body.count || 1); return jsonResp(encDump()); }
    if (path === "/api/encounter/damage" && method === "POST") {
      const c = currentEnc.combatants.find(x => x.id === body.combatant_id);
      if (!c) return jsonResp({ error: "combatant not found" }, 404);
      const amt = +body.amount;   // positive = damage, negative = healing
      // snapshot for undo (keep last 25)
      c.hp_history = c.hp_history || [];
      c.hp_history.push({ current_hp: c.current_hp, temp_hp: c.temp_hp || 0, death_saves: JSON.parse(JSON.stringify(c.death_saves || {})) });
      if (c.hp_history.length > 25) c.hp_history.shift();
      if (amt >= 0) {
        let dmg = amt;                                  // temporary HP absorbs first
        const t = c.temp_hp || 0;
        if (t > 0) { const used = Math.min(t, dmg); c.temp_hp = t - used; dmg -= used; }
        c.current_hp = Math.max(0, c.current_hp - dmg);
      } else {
        c.current_hp = Math.min(c.max_hp, c.current_hp - amt);   // -amt = heal
        if (c.current_hp > 0 && c.death_saves) c.death_saves = { successes: 0, failures: 0, stable: false, dead: false };
      }
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/undo-hp" && method === "POST") {
      const c = currentEnc.combatants.find(x => x.id === body.combatant_id);
      if (!c) return jsonResp({ error: "combatant not found" }, 404);
      const h = c.hp_history || [];
      if (h.length) { const p = h.pop(); c.current_hp = p.current_hp; c.temp_hp = p.temp_hp || 0; if (p.death_saves) c.death_saves = p.death_saves; }
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/legendary-resist" && method === "POST") {
      const c = currentEnc.combatants.find(x => x.id === body.combatant_id);
      if (!c) return jsonResp({ error: "combatant not found" }, 404);
      const delta = body.delta != null ? +body.delta : -1;   // default: spend one
      c.lr = Math.max(0, Math.min(c.lr_max || 0, (c.lr || 0) + delta));
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/death-save" && method === "POST") {
      const c = currentEnc.combatants.find(x => x.id === body.combatant_id);
      if (!c) return jsonResp({ error: "combatant not found" }, 404);
      const ds = c.death_saves = c.death_saves || { successes: 0, failures: 0, stable: false, dead: false };
      const r = body.result;
      if (r === "success") { ds.successes = Math.min(3, ds.successes + 1); if (ds.successes >= 3) { ds.stable = true; } }
      else if (r === "failure") { ds.failures = Math.min(3, ds.failures + 1); ds.dead = ds.failures >= 3; }
      else if (r === "reset") { ds.successes = 0; ds.failures = 0; ds.stable = false; ds.dead = false; }
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/remove" && method === "POST") { currentEnc.combatants = currentEnc.combatants.filter(c => c.id !== body.combatant_id); renumber(); await saveEnc(); return jsonResp(encDump()); }
    if (path === "/api/encounter/add-player" && method === "POST") {
      const hp = parseInt(body.max_hp || 0, 10) || 1;
      currentEnc.combatants.push({ id: uuid(), statblock_id: "", base: body.name || "Player", display_name: body.name || "Player", initiative: parseInt(body.initiative || 0, 10), current_hp: hp, max_hp: hp, temp_hp: 0, armor_class: 10, is_player: true, conditions: [], hp_history: [], death_saves: { successes: 0, failures: 0, stable: false, dead: false } });
      sortEnc(); await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/condition" && method === "POST") {
      const c = currentEnc.combatants.find(x => x.id === body.combatant_id);
      if (!c) return jsonResp({ error: "combatant not found" }, 404);
      c.conditions = c.conditions || [];
      if (body.action === "remove") c.conditions = c.conditions.filter(n => n !== body.name);
      else if (!c.conditions.includes(body.name)) c.conditions.push(body.name);
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/next" && method === "POST") {
      const n = currentEnc.combatants.length;
      if (n) { currentEnc.started = true; currentEnc.active_index++; if (currentEnc.active_index >= n) { currentEnc.active_index = 0; currentEnc.round++; } }
      await saveEnc(); return jsonResp(encDump());
    }
    if (path === "/api/encounter/clear" && method === "POST") { currentEnc = { round: 0, active_index: 0, combatants: [], started: false }; await saveEnc(); return jsonResp(encDump()); }
    if (path === "/api/encounter/save" && method === "POST") {
      const rec = { id: uuid(), owner_id: OWNER, name: body.name || "Encounter", round: currentEnc.round, active_index: currentEnc.active_index, combatants: JSON.parse(JSON.stringify(currentEnc.combatants)) };
      await dbPut("encounters", rec); return jsonResp({ id: rec.id, name: rec.name });
    }
    if (path === "/api/encounters" && method === "GET") { const all = await dbAll("encounters"); return jsonResp(all.map(e => ({ id: e.id, name: e.name, combatants: e.combatants.length, round: e.round }))); }
    if (path === "/api/encounter/load" && method === "POST") {
      const e = await dbGet("encounters", body.encounter_id);
      // loading an encounter starts it fresh at the top of initiative
      if (e) { currentEnc = { round: 0, active_index: 0, combatants: JSON.parse(JSON.stringify(e.combatants)), started: false }; sortEnc(); await saveEnc(); }
      return jsonResp(encDump());
    }
    if ((m = path.match(/^\/api\/encounters\/([^/]+)$/)) && method === "DELETE") { await dbDel("encounters", decodeURIComponent(m[1])); return jsonResp({ deleted: true }); }
    if (path === "/api/roll" && method === "POST") return jsonResp(await doRoll(body));
    if (path === "/api/rolls" && method === "GET") return jsonResp(rolls.slice(-30));
    if (path === "/api/rolls" && method === "DELETE") { rolls = []; await saveRolls(); return jsonResp({ cleared: true }); }
    if (path === "/api/ping" && method === "POST") return jsonResp({ ok: true });
    // PDF import is desktop-only in this web version
    if (path === "/api/import/start") return jsonResp({ error: "PDF import isn't available in the web app. Use “Import JSON”, or add monsters with “New Compendium Entry”." });
    if (path.startsWith("/api/import/status")) return jsonResp({ finished: true, error: "PDF import unavailable in the web app." });
    return jsonResp({ error: "not found: " + path }, 404);
  }

  // ------------------------------------------------------------ fetch shim
  const dbReady = (async function init() {
    _db = await openDB();
    currentEnc = (await kvGet("currentEncounter", null)) || { round: 0, active_index: 0, combatants: [], started: false };
    // Reopening the app restarts the turn order at the top of initiative (HP,
    // conditions and combatants are kept). This guarantees a session never
    // begins on a stale "current turn" pointer left over from before.
    currentEnc.started = false;
    currentEnc.active_index = 0;
    if (typeof currentEnc.round !== "number") currentEnc.round = 0;
    rolls = (await kvGet("rolls", null)) || [];
    // No stat blocks ship with the app — each DM imports their own PDF locally.
    if (navigator.storage && navigator.storage.persist) { try { await navigator.storage.persist(); } catch (e) {} }
  })();

  window.fetch = async function (input, init) {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    if (path.indexOf("/api/") === -1) return realFetch(input, init);
    await dbReady;
    init = init || {};
    const method = (init.method || "GET").toUpperCase();
    let body = null;
    if (init.body && typeof init.body === "string") { try { body = JSON.parse(init.body); } catch (e) { body = {}; } }
    else if (init.body) body = {};   // FormData (PDF upload) — handled as unavailable
    try { return await route(path, method, body || {}); }
    catch (e) { return jsonResp({ error: String(e) }, 500); }
  };

  // ---------------------------------------------- JSON export / import (UI)
  window.sfExport = async function () {
    await dbReady;
    const all = await dbAll("statblocks");
    const blob = new Blob([JSON.stringify(all, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "monsterbox-compendium.json";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    try { localStorage.setItem("sf-last-export", String(Date.now())); } catch (e) {}
    if (window.refreshBackupNag) window.refreshBackupNag();
  };
  window.sfImport = async function (file) {
    if (!file) return;
    await dbReady;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) { alert("That file isn't valid JSON."); return; }
    const arr = Array.isArray(data) ? data : (data.statblocks || []);
    let n = 0;
    for (const sb of arr) { if (!sb || !sb.name) continue; sb.id = sb.id || uuid(); sb.owner_id = OWNER; if (!sb.updated_at) sb.updated_at = Date.now(); await dbPut("statblocks", sb); n++; }
    if (typeof loadLibrary === "function") loadLibrary();
    notifyWrite("bulk");
    alert(`Imported ${n} ${n === 1 ? "monster" : "monsters"}.`);
  };

  // ------------------------------------------------------ service worker
  // A new deploy installs a new worker that WAITS (sw.js no longer skipWaiting()s
  // on install). We show a one-click "new version" banner; only when the user
  // accepts do we tell the worker to take over and then reload — so a version
  // change can never wedge a live session between old and new assets.
  function showUpdateBanner(worker) {
    if (!worker || document.getElementById("sf-update-bar")) return;
    const bar = document.createElement("div");
    bar.id = "sf-update-bar";
    bar.setAttribute("role", "status");
    bar.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;" +
      "display:flex;gap:12px;align-items:center;background:#1b1815;color:#efe9df;border:1px solid #b23b3b;" +
      "border-radius:10px;padding:10px 14px;box-shadow:0 6px 24px rgba(0,0,0,.45);font-size:14px;max-width:92vw;";
    const span = document.createElement("span");
    span.textContent = "A new version of MonsterBox is ready.";
    const btn = document.createElement("button");
    btn.textContent = "Reload";
    btn.style.cssText = "background:#b23b3b;color:#fff;border:0;border-radius:7px;padding:6px 14px;cursor:pointer;font:inherit;";
    btn.onclick = () => { btn.textContent = "Updating…"; btn.disabled = true; _updateAccepted = true; worker.postMessage({ type: "SKIP_WAITING" }); };
    bar.appendChild(span); bar.appendChild(btn);
    document.body.appendChild(bar);
  }

  let _updateAccepted = false;
  if ("serviceWorker" in navigator) {
    // Reload the page only AFTER the user accepted an update and the new worker
    // took control — never on first install or a background control change.
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (_updateAccepted) location.reload();
    });
    // updateViaCache:"none" => the browser always revalidates sw.js itself, so a
    // new deploy is detected instead of being masked by the HTTP cache (up to 24h).
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
      // A worker in the WAITING state only ever happens when it is REPLACING an
      // existing one (first installs activate straight away) — so its mere
      // presence means a genuine update is ready. No controller check needed
      // (controller can be momentarily null right after a hard reload). reg.waiting
      // can populate a beat AFTER register() resolves, so re-check a few times.
      const maybeBanner = () => { if (reg.waiting) showUpdateBanner(reg.waiting); };
      maybeBanner();
      navigator.serviceWorker.ready.then(maybeBanner).catch(() => {});
      [400, 1500, 4000].forEach((t) => setTimeout(maybeBanner, t));
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) showUpdateBanner(nw);
        });
      });
      // A long-open tab won't otherwise notice a deploy; re-check hourly.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(() => {});
  }
})();
