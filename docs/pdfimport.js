/* In-browser PDF import for the MonsterBox PWA.
 *
 * A JavaScript port of the desktop ingest pipeline (columns.py + parser.py +
 * pipeline.py), using pdf.js to extract word positions + fonts. Runs entirely
 * client-side: the DM's own PDF never leaves their browser, and the parsed stat
 * blocks are stored only in their local IndexedDB.
 */
(function () {
  "use strict";

  // =========================================================== pdf.js extraction
  function normFont(name) {
    return String(name || "").split("+").pop().split("-")[0].split(",")[0];
  }

  // Field labels / row starters that are ALSO bold in many books — never treat
  // these as an entry name (they'd corrupt "Armor Class 15", the ability row, etc.)
  const BOLD_NAME_SKIP = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan",
    "armor", "hit", "speed", "skills", "senses", "languages", "saving", "damage", "condition",
    "challenge", "proficiency", "initiative", "gear", "str", "dex", "con", "int", "wis", "cha",
    "ac", "hp", "cr", "melee", "ranged"]);

  // FONT-AWARE name delimiting. Homebrew books print trait/action names in BOLD
  // with NO period ("Vigil The warforged has advantage…"). pdf.js gives bold a
  // different embedded-font id than the body, so when a line starts with a short
  // run in a font distinct from the rest, treat that run as a NAME and insert a
  // period — then the normal period-based entry parser picks it up. Heavily
  // guarded so stat-field lines, the ability row, names and headers are untouched.
  function insertBoldNamePeriod(words, text) {
    if (words.length < 2) return text;
    let run = 0;
    // signal A: faux-bold via double-strike — a leading run of double-drawn words
    if (words[0].bold) { while (run < words.length && words[run].bold) run++; }
    // signal B: the line STARTS in one embedded font and CHANGES font after a short
    // leading run — that run is the bold name. (Don't weight by char count: on a
    // wrapped line the bold name can be longer than the visible body fragment.)
    if (run === 0) {
      const leadId = words[0].fontId;
      if (leadId) { let r = 0; while (r < words.length && words[r].fontId === leadId) r++; if (r < words.length) run = r; }
    }
    if (run < 1 || run > 5 || run === words.length) return text;   // not "short name + body"
    const name = words.slice(0, run).map(w => w.text).join(" ").replace(/\s+/g, " ").trim();
    if (!name || !isUpper(name[0])) return text;
    // already delimited? only true sentence terminators count — NOT a trailing ")"
    // ("Steam Blast(Replaces Catapult)" / "Frightful Presence (Recharge 6)" still need one)
    if (/[.:!?]$/.test(name)) return text;
    if (BOLD_NAME_SKIP.has(name.toLowerCase().split(/\s+/)[0])) return text;
    const rest = words.slice(run).map(w => w.text).join(" ").replace(/\s+/g, " ").trim();
    if (!rest || !/^[A-Za-z(]/.test(rest)) return text;        // description starts a word/paren
    return name + ". " + rest;
  }

  // group words into (text, dominant-font) lines, top->bottom, left->right
  function linesFromWords(words) {
    words = words.slice().sort((a, b) => (a.top - b.top) || (a.x0 - b.x0));
    const lines = [];
    let cur = [], curTop = null;
    const flush = () => {
      if (!cur.length) return;
      const ordered = cur.slice().sort((a, b) => a.x0 - b.x0);
      let text = ordered.map(w => w.text).join(" ").replace(/\s+/g, " ").trim();
      const counts = {};
      ordered.forEach(w => { counts[w.font] = (counts[w.font] || 0) + 1; });
      let best = "", bn = -1;
      for (const k in counts) if (counts[k] > bn) { bn = counts[k]; best = k; }
      if (text) { text = insertBoldNamePeriod(ordered, text); lines.push([text, best]); }
    };
    for (const w of words) {
      if (curTop === null || Math.abs(w.top - curTop) <= 4) { cur.push(w); if (curTop === null) curTop = w.top; }
      else { flush(); cur = [w]; curTop = w.top; }
    }
    flush();
    return lines;
  }

  // Return the page as an array of COLUMNS (each a list of lines). A stat block
  // that flows from the bottom of one column to the top of the next is then
  // handled by the same continuation logic that joins a block across a page break
  // — far more reliable than mashing both columns into one text and guessing
  // boundaries. Single-column pages return one column.
  // Find a vertical GUTTER splitting the page into two columns: a central x where
  // most text rows have a gap. Robust to a full-width header over a two-column body
  // (which defeats a simple straddle ratio), and it splits at the actual gutter
  // rather than the page midpoint. Returns { bestX, L, R } or null (single column).
  function findGutter(words) {
    const sorted = words.slice().sort((a, b) => a.top - b.top);
    const rows = []; let cur = [], curTop = null;
    for (const w of sorted) {
      if (curTop === null || Math.abs(w.top - curTop) <= 4) { cur.push(w); if (curTop === null) curTop = w.top; }
      else { rows.push(cur); cur = [w]; curTop = w.top; }
    }
    if (cur.length) rows.push(cur);
    const left = Math.min(...words.map(w => w.x0));
    const right = Math.max(...words.map(w => w.x1));
    const span = right - left;
    if (span < 80 || rows.length < 6) return null;
    let bestX = -1, bestEmpty = -1;
    for (let f = 0.34; f <= 0.66; f += 0.02) {
      const gx = left + span * f;
      let empty = 0;
      for (const row of rows) if (!row.some(w => w.x0 <= gx && w.x1 >= gx)) empty++;
      const frac = empty / rows.length;
      if (frac > bestEmpty) { bestEmpty = frac; bestX = gx; }
    }
    if (bestEmpty < 0.60) return null;                       // no clear gutter
    const L = words.filter(w => (w.x0 + w.x1) / 2 < bestX);
    const R = words.filter(w => (w.x0 + w.x1) / 2 >= bestX);
    if (L.length / words.length < 0.12 || R.length / words.length < 0.12) return null;   // real content both sides
    return { bestX, L, R };
  }
  // an AC anchor ("AC 14 …" / "Armor Class 15") starts a stat block; its presence in
  // a column means that column carries a stat block of its own.
  const wordsHaveAc = (ws) => ws.some(w => /^(?:AC|Armor)$/i.test(w.text));
  // BOOK column mode, set per import before splitting (see extractColumnLinePages):
  // "one" (single-column stat blocks), "two", or "mixed".
  let _bookColMode = "mixed";

  function pageColumns(words, pageWidth) {
    if (!words.length) return [[]];
    const g = findGutter(words);
    if (!g) return [linesFromWords(words)];
    const { L, R } = g;
    // BOOK-LEVEL STABILISATION. In a single-column book the stat blocks never sit
    // two-to-a-row, so a real split needs BOTH halves to carry their own AC anchor
    // (two stat blocks side by side). A lone strong gutter on a one-block page is a
    // FALSE gutter from short left-aligned stat lines (the 2024 / D&D Beyond layout),
    // and splitting there severs the full-width ability grid — losing every score.
    // Keep one column unless both halves are genuinely independent stat blocks.
    if (_bookColMode === "one" && !(wordsHaveAc(L) && wordsHaveAc(R))) return [linesFromWords(words)];
    // Guard A: a false gutter that SEVERS an ability TABLE's labels from its values.
    // The 2024 / D&D Beyond layout prints abilities as a grid: a label column
    // (Str/Dex/Con/Int/Wis/Cha) far to the left of the Score|Mod|Save value columns.
    // A page of short, left-aligned stat lines then shows a strong empty band between
    // them, so the gutter detector splits there — scattering the labels (left) from
    // their numbers (right) and losing every ability score (Monster Manual, ~50 blocks).
    // Signature: the LEFT side carries >=4 bare ability labels but almost no COMPLETE
    // "Str 16 …" rows (its numbers went right). A genuine two-column page keeps each
    // block's labels and numbers TOGETHER, so its left side has complete rows and this
    // never fires. When detected, keep ONE column so the rows reassemble.
    const ABBR = /^(?:str|dex|con|int|wis|cha)$/i;
    const labelWords = L.filter(w => ABBR.test(w.text));
    // Require the labels to be stacked VERTICALLY (>=4 distinct rows) — that is the
    // 2024 transposed grid. The 2014 ability header prints all six on ONE row
    // ("STR DEX CON INT WIS CHA"); firing on that would wrongly merge the two real
    // columns of a 2014 book and mash its side-by-side stat blocks together.
    const labelRows = new Set(labelWords.map(w => Math.round(w.top / 5)));
    if (labelRows.size >= 4) {
      // ...and the left side must LACK complete "Str 16 …" rows (its numbers were
      // severed to the right). A 2024 single-column page keeps label+numbers on one
      // row, so leftComplete>=2 and this never fires there.
      const leftComplete = linesFromWords(L).filter(([t]) => /\b(?:str|dex|con|int|wis|cha)\b\s+\d/i.test(t)).length;
      if (leftComplete < 2) return [linesFromWords(words)];
    }
    // Guard B: a false gutter through the Score|Mod|Save columns of a SINGLE ability
    // table — the right side is then almost entirely numbers (+3, −2) plus the
    // "Mod"/"Save" headers. If so, keep ONE column so the rows stay intact.
    const numish = R.filter(w => /^[+\-−]?\d+$/.test(w.text) || /^(Mod|Save)$/.test(w.text)).length;
    if (numish / R.length > 0.5) return [linesFromWords(words)];
    return [linesFromWords(L), linesFromWords(R)];
  }

  // Decide the book's column mode. The telling signal is whether gutter pages are
  // BALANCED: a real two-column text layout (Crooked Moon) fills both columns to a
  // similar word count, whereas a single-column book's gutters split a full-width
  // stat block from ART beside it (Monster Manual) — dense left, sparse right. So a
  // book is "two" only when most of its gutter pages are balanced; one that gutters
  // rarely, or whose gutters are lopsided (stat-block-vs-art), is "one". This keeps
  // a column-spanning book like Crooked Moon "two" while catching MM as "one".
  function voteColMode(pageWords) {
    let gutterPages = 0, balanced = 0, content = 0;
    for (const words of pageWords) {
      if (words.length < 20) continue;                       // skip near-empty pages
      content++;
      const g = findGutter(words);
      if (!g) continue;
      gutterPages++;
      // Balance by ROW count (distinct text rows per side), not word count. A real
      // two-column text layout fills both columns with a similar number of lines;
      // a stat-block-vs-ART gutter leaves the art side with very few text rows.
      // Row balance separates the two cleanly where raw word counts overlap (a
      // text column with short lines can still have few words but many rows).
      const lr = new Set(g.L.map(w => Math.round(w.top / 5))).size;
      const rr = new Set(g.R.map(w => Math.round(w.top / 5))).size;
      if (Math.min(lr, rr) / Math.max(lr, rr) >= 0.5) balanced++;
    }
    if (content < 6) return "mixed";
    if (gutterPages < Math.max(4, 0.15 * content)) return "one";   // gutters too rare -> single column
    const frac = balanced / gutterPages;
    return frac >= 0.45 ? "two" : frac <= 0.35 ? "one" : "mixed";
  }

  async function extractColumnLinePages(arrayBuffer, progress) {
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    // PASS 1: extract every page's words (no split yet) so we can vote the book's
    // column mode before committing to per-page splits. The mode then stabilises
    // splitting (see pageColumns), e.g. it stops a single-column book's false
    // gutters from severing the full-width 2024 ability grid.
    const pageWords = [];
    for (let p = 1; p <= pdf.numPages; p++) {
      if (_abort) { try { pdf.destroy && pdf.destroy(); } catch (e) {} throw new Error("__abort__"); }
      const page = await pdf.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const styles = tc.styles || {};
      const words = [];
      // map key -> first word at that spot. A glyph run drawn twice at ~one spot
      // is FAUX BOLD (many homebrew/GM Binder PDFs bold by double-striking): we
      // drop the duplicate but flag the original `bold`, which the font-aware
      // name detector uses to find period-less trait/action names.
      const seen = new Map();
      for (const it of tc.items) {
        const s = it.str;
        if (!s || !s.trim()) continue;
        // skip rotated / vertical text — sidebar watermarks (e.g. "WYRMLING",
        // "SUMMER") that pdf.js interleaves into the stat-block lines
        if (Math.abs(it.transform[1]) > 0.5 * Math.abs(it.transform[0] || 1)) continue;
        const x0 = it.transform[4];
        const top = vp.height - it.transform[5];
        const key = s + "@" + Math.round(x0 / 2) + "," + Math.round(top / 2);
        if (seen.has(key)) { const o = seen.get(key); if (o) o.bold = true; continue; }
        const size = Math.hypot(it.transform[0], it.transform[1]) || (it.height || 10);
        const fam = (styles[it.fontName] && styles[it.fontName].fontFamily) || it.fontName || "";
        const w = { text: s, x0, x1: x0 + (it.width || 0), top, font: normFont(fam) + "#" + Math.round(size), fontId: it.fontName || "", bold: false };
        seen.set(key, w);
        words.push(w);
      }
      words._w = vp.width; words._page = p;
      pageWords.push(words);
      page.cleanup && page.cleanup();
      if (progress) progress(p, pdf.numPages);
    }
    pdf.destroy && pdf.destroy();
    // PASS 2: split each page into columns using the book's voted mode.
    _bookColMode = voteColMode(pageWords);
    const pages = [];
    for (const words of pageWords) {
      for (const col of pageColumns(words, words._w)) { col._page = words._page; pages.push(col); }
    }
    return pages;
  }

  // Render one PDF page to a JPEG data URL (capped width). Shared by the review
  // screenshot capture and (later) the OCR fallback.
  async function renderPageToDataUrl(pdfPage, targetWidth, quality) {
    const v1 = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(3, Math.max(1, (targetWidth || 1100) / v1.width));
    const vp = pdfPage.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await pdfPage.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    return canvas.toDataURL("image/jpeg", quality || 0.7);
  }

  // LOCAL-ONLY: store a screenshot of each flagged stat block's source PDF page so
  // the review editor can show it beside the form. Best-effort; never blocks import.
  async function captureReviewShots(file, flagged) {
    if (!flagged || !flagged.length || !window.pdfjsLib || !window.sfSaveShot) return;
    let buf, pdf;
    try { buf = await file.arrayBuffer(); pdf = await window.pdfjsLib.getDocument({ data: buf }).promise; }
    catch (e) { return; }
    const cache = new Map();   // page -> dataURL (several blocks can share a page)
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("render timeout")), ms))]);
    for (const { id, page } of flagged.slice(0, 80)) {   // cap work; review sets are small
      if (!page || page < 1 || page > pdf.numPages) continue;
      try {
        let url = cache.get(page);
        if (!url) { const pg = await pdf.getPage(page); url = await withTimeout(renderPageToDataUrl(pg, 1500, 0.72), 20000); pg.cleanup && pg.cleanup(); cache.set(page, url); }
        await window.sfSaveShot(id, url);
      } catch (e) {}
    }
    pdf.destroy && pdf.destroy();
  }

  // ===================================================================== regexes
  const TYPES = "aberration|beast|celestial|construct|dragon|elemental|fey|fiend|giant|humanoid|monstrosity|ooze|plant|undead";
  const SIZE_ALT = "Tiny|Small|Medium|Large|Huge|Gargantuan";
  // allow a dual size like "Medium or Small" (2024 SRD) — capture the first size
  const RE_META = new RegExp("^(" + SIZE_ALT + ")(?:\\s+or\\s+\\w+)?\\s+((?:swarm of \\w+ )?(?:" + TYPES + ")s?(?:\\s*\\([^)]*\\))?)\\s*,\\s*(.+)$", "i");
  const RE_META_LOOSE = new RegExp("^\\w+\\s+((?:" + TYPES + ")s?(?:\\s*\\([^)]*\\))?)\\s*,\\s*(.+)$", "i");
  const RE_META_SIZETYPE = new RegExp("^(" + SIZE_ALT + ")(?:\\s+or\\s+\\w+)?\\s+((?:" + TYPES + ")s?(?:\\s*\\([^)]*\\))?)\\s*$", "i");
  // Homebrew creature TYPES the standard list doesn't know (Obojima "Medium Spirit,
  // Unaligned"). Size + any type word(s) + an alignment-looking tail. Used only as
  // a fallback, and the tail is validated against RE_ALIGNMENTish so it can't grab
  // an ordinary "Large pile of gold, worth…" line.
  const RE_META_ANYTYPE = new RegExp("^(" + SIZE_ALT + ")(?:\\s+or\\s+\\w+)?\\s+([A-Za-z][A-Za-z'\\u2019]*(?:\\s+[A-Za-z'\\u2019]+){0,2}?)\\s*,\\s*(.+)$", "i");
  const RE_ALIGNMENTish = /^(?:any\b|unaligned|lawful|chaotic|neutral|good|evil|typically|no alignment)/i;
  // Compact layouts print the NAME and the size/type/alignment on ONE line, e.g.
  // "Kyanos B'lot Large Aberration (Shapechanger), Chaotic" — split name off the meta.
  const RE_NAME_META = new RegExp("^(.+?)\\s+(" + SIZE_ALT + ")\\s+((?:swarm of \\w+ )?(?:" + TYPES + ")s?(?:\\s*\\([^)]*\\))?)\\s*,?\\s*(.*)$", "i");
  // an optional ":" after every field label — some books write "Armor Class: 16"
  const RE_AC = /(?:Armor Class|AC):?\s+(\d+)\s*(\([^)]*\))?/i;
  const RE_HP = /(?:Hit Points|HP):?\s+(\d+)\s*(?:\(([^)]*)\))?/i;
  const RE_SPEED = /Speed:?\s+(.+)/i;
  // The score is 1-2 digits, but pdf.js sometimes splits a two-digit score with a
  // space ("13" -> "1 3", NPCs Outclassed), so allow one internal space. Without it
  // only the digit adjacent to "(" was captured and two-digit scores lost a digit
  // (DEX 13 -> 3). Strip the space when reading the score (see parseAbilities).
  const RE_ABILITY_PAIR = /(\d(?:\s*\d)?)\s*\(\s*[^)\d]*?(\d+)\s*\)/g;
  // matches 2014 "Challenge 5 (1,800 XP)", Free5e "Challenge 21", and 2024 "CR 2 (XP 450; PB +2)"
  const RE_CHALLENGE = /(?:Challenge(?:\s+Rating)?s?|\bCR):?\s+([0-9/]+)\s*(?:\(\s*(?:([\d,]+)\s*XP|XP\s*([\d,]+))[^)]*\))?/i;
  const RE_PROF = /Proficiency Bonus:?\s+\+?(\d+)/i;
  const RE_SPEED_PART = /(?:(\w+)\s+)?(\d+)\s*ft/gi;
  const RE_AC_LINE = /^\s*[•▪◦·*\-]?\s*(?:Armor Class|AC):?\s+\d/i;
  const RE_SAVES = /Saving Throws:?\s+(.+)/i;
  const RE_SKILLS = /Skills:?\s+(.+)/i;
  const RE_SENSES = /Senses:?\s+(.+)/i;
  const RE_LANGS = /Languages:?\s+(.+)/i;
  const RE_PASSIVE = /passive Perception:?\s+(\d+)/i;
  const RE_DMG = /Damage (Vulnerabilities|Resistances|Immunities):?\s+(.+)/gi;
  const RE_COND = /Condition Immunities:?\s+(.+)/i;
  const RE_BONUS_PAIR = /(.+?)\s*([+-]\d+)/;
  const RE_ATTACK = /(Melee|Ranged)\s+(Weapon|Spell)\s+Attack[.:]?\s*\+?(\d+)\s*to hit(?:,\s*(?:reach\s*(\d+)\s*ft|range\s*([\d/]+)\s*ft))?/i;
  // 2024 form: "Melee Attack Roll: +5, reach 5 ft." / "Ranged Attack Roll: +5, range 30/90 ft."
  const RE_ATTACK_2024 = /(Melee|Ranged)\s+Attack Roll:\s*\+?(\d+)(?:,\s*(?:reach\s*(\d+)\s*ft|range\s*([\d/]+)\s*ft))?/i;
  const RE_DAMAGE = /(\d+)\s*\(\s*(\d+d\d+)\s*([+-]\s*\d+)?\s*\)\s*([a-zA-Z]+)?\s*damage/gi;
  const RE_SAVE = /DC\s*(\d+)\s*(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s*saving throw/i;
  const RE_LEG_COUNT = /(\d+)\s+legendary action/i;
  const SECTION_SRC = "^[ \\t]*(LEGENDARY ACTIONS?|BONUS ACTIONS?|REACTIONS?|ACTIONS?)[ \\t]*$";
  const RE_SECTION_LINE = new RegExp(SECTION_SRC, "i");
  const reSectionG = () => new RegExp(SECTION_SRC, "gim");
  const RE_ENTRY_SRC = "^[ \\t>\\u2022*\\-]*([A-Z][A-Za-z0-9:\\u2019'/\\-]+(?:\\s+[A-Za-z0-9:\\u2019'/\\-]+){0,5}?(?:\\s*\\([^)]*\\))?)[ \\t]*\\.[ \\t]+(?=[A-Z(])";
  const reEntryG = () => new RegExp(RE_ENTRY_SRC, "gm");
  // Homebrew books (GM Binder: Expanded Warforged/Golems/Clockwork) print attack
  // actions with NO period after the bold name — "Stun Mace Melee Weapon Attack:
  // +4 ...". Detect a Title-Case name immediately followed by an attack clause;
  // that clause is a strong enough signal that no period (or sentence-end) is needed.
  const RE_ENTRY_ATTACK_SRC = "^[ \\t>\\u2022*\\-]*([A-Z][A-Za-z0-9\\u2019'/\\-]+(?:\\s+[A-Za-z0-9\\u2019'/\\-]+){0,4}?)\\.?\\s+(?=(?:Melee|Ranged)(?:\\s+or\\s+(?:Melee|Ranged))?\\s+(?:Weapon\\s+|Spell\\s+)?Attack(?:\\s+Roll)?\\b)";
  const reEntryAttackG = () => new RegExp(RE_ENTRY_ATTACK_SRC, "gm");
  // single-line test: does this line START a trait/action entry ("Name. Desc")?
  const RE_ENTRY_LINE = new RegExp(RE_ENTRY_SRC);

  // ADAPTIVE RECOVERY (big-win #2): slower, looser ability layouts tried only when
  // the standard parse fails. Returns scores or null; never overwrites a good parse.
  function recoverAbilities(text) {
    const lines = String(text).replace(/\r/g, "").split("\n");
    // layout A: an ability header row, then a row of six BARE integers
    // ("STR DEX CON INT WIS CHA" / "15 14 13 12 10 8")
    for (let i = 0; i < lines.length; i++) {
      const up = lines[i].toUpperCase();
      if ((up.match(/\b(STR|DEX|CON|INT|WIS|CHA)\b/g) || []).length >= 5) {
        for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
          const nums = (lines[j].match(/\b\d{1,2}\b/g) || []).map(Number);
          if (nums.length >= 6) return { strength: nums[0], dexterity: nums[1], constitution: nums[2], intelligence: nums[3], wisdom: nums[4], charisma: nums[5] };
        }
      }
    }
    // layout B: inline named scores without modifiers ("Str 15 Dex 14 Con 13 …")
    const re = /\b(Str|Dex|Con|Int|Wis|Cha)\b\s+(\d{1,2})\b/gi; const out = {}; let m;
    while ((m = re.exec(text))) { const k = ABIL_KEY[m[1].toLowerCase()]; if (k && !(k in out)) out[k] = +m[2]; }
    return Object.keys(out).length >= 6 ? out : null;
  }

  const SIZES = { tiny: "Tiny", small: "Small", medium: "Medium", large: "Large", huge: "Huge", gargantuan: "Gargantuan" };
  const ABIL_BY_NAME = { strength: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
  const SECTION_HEADER_WORDS = new Set(["aberrations", "beasts", "celestials", "constructs", "dragons", "elementals", "fey", "fiends", "giants", "humanoids", "monstrosities", "oozes", "plants", "undead"]);
  const NON_NAME_WORDS = new Set(["alignment", "actions", "reactions", "traits", "description"]);
  const NON_HEADER_NAMES = new Set(["strength", "dexterity", "constitution", "intelligence", "wisdom", "charisma",
    // stat-field labels that get absorbed from interleaved rules/archetype text
    "skills", "senses", "languages", "hd", "cr", "hit dice", "proficiency bonus", "ability score increase",
    "natural armor", "damage vulnerabilities", "damage immunities", "damage resistances", "condition immunities",
    // Open Game License / legal boilerplate terms (backstop to the license cut)
    "content", "identity", "trademark", "registered trademark", "product identity", "open game content",
    "open game license", "copyright", "contributors", "derivative material"]);
  const NAME_CONNECTORS = new Set(["of", "with", "and", "the", "to", "a", "an", "in", "or", "from", "by", "for", "on", "at", "as", "into", "upon", "but"]);
  // Words that begin prose, never an entry NAME. Used to keep the relaxed entry
  // boundary (below) from grabbing a wrapped sentence that starts "Word. Capital".
  const SENTENCE_STARTERS = new Set(["the", "this", "that", "these", "those", "a", "an", "it", "its",
    "if", "when", "while", "as", "on", "at", "once", "each", "any", "all", "after", "before", "during",
    "your", "you", "he", "she", "they", "then", "but", "and", "or", "also", "in", "of", "to", "with",
    "for", "upon", "whenever", "until", "because", "however", "additionally"]);
  const STAT_FIELD_PREFIXES = ["armor class", "hit points", "speed", "saving throws", "skills", "senses", "languages", "challenge", "damage ", "condition ", "proficiency",
    "ac ", "hp ", "cr ", "initiative", "immunities", "resistances", "vulnerabilities", "gear ", "mod save"];
  const SENTENCE_END = ".!?\"')’”";
  const HEADER_TO_CAT = { ACTIONS: "action", ACTION: "action", "BONUS ACTIONS": "bonus_action", "BONUS ACTION": "bonus_action", REACTIONS: "reaction", REACTION: "reaction", "LEGENDARY ACTIONS": "legendary", "LEGENDARY ACTION": "legendary" };

  // ===================================================================== helpers
  // Title-case but keep connector words lowercase mid-string, so a type like
  // "swarm of tiny fey" reads "Swarm of Tiny Fey" (not "Swarm Of Tiny Fey").
  const TITLE_SMALL = new Set(["of", "the", "and", "a", "an", "to", "in", "or", "with"]);
  const titleCase = (s) => String(s || "").toLowerCase().split(/\s+/)
    .map((w, i) => (i > 0 && TITLE_SMALL.has(w)) ? w : w.replace(/^[a-z]/, c => c.toUpperCase()))
    .join(" ");
  const isUpper = (c) => c >= "A" && c <= "Z";
  const stripEdge = (s, chars) => { let i = 0, j = s.length; while (i < j && chars.includes(s[i])) i++; while (j > i && chars.includes(s[j - 1])) j--; return s.slice(i, j); };
  // Bold text is faked in some PDFs by drawing the glyphs twice with a tiny offset,
  // which surfaces as a fully-doubled line ("Actions Actions", "Warforged Enforcer
  // Warforged Enforcer"). Collapse a line that is exactly two identical halves.
  function dedupeLine(s) {
    // Never collapse a numeric stat row: an all-equal ability line
    // ("10 (+0) 10 (+0) 10 (+0) 10 (+0) 10 (+0) 10 (+0)") has identical halves but
    // is NOT a doubled bold artifact — collapsing it halved the ability scores.
    if (/\d\s*\(\s*[+\-−]?\d/.test(s)) return s;
    const w = s.trim().split(/\s+/);
    // whole-line doubling ("Warforged Enforcer Warforged Enforcer", "Actions Actions")
    if (w.length >= 2 && w.length % 2 === 0) {
      const h = w.length / 2;
      if (w.slice(0, h).join(" ").toLowerCase() === w.slice(h).join(" ").toLowerCase()) return w.slice(0, h).join(" ");
    }
    return s;
  }

  function parseSpeed(text) { const out = {}; let m; RE_SPEED_PART.lastIndex = 0; while ((m = RE_SPEED_PART.exec(text))) out[(m[1] || "walk").toLowerCase()] = +m[2]; return out; }
  function parseSenses(text) { const out = {}; let m; RE_SPEED_PART.lastIndex = 0; while ((m = RE_SPEED_PART.exec(text))) if (m[1]) out[m[1].toLowerCase()] = +m[2]; return out; }
  const ABIL_KEY = { str: "strength", dex: "dexterity", con: "constitution", int: "intelligence", wis: "wisdom", cha: "charisma" };
  function parseAbilities(text) {
    // 2014 / Free5e: "18 (+4)" pairs, six in a row (score then modifier in parens)
    const pairs = []; let m; RE_ABILITY_PAIR.lastIndex = 0;
    while ((m = RE_ABILITY_PAIR.exec(text))) pairs.push(+m[1].replace(/\s+/g, ""));
    if (pairs.length >= 6) return { strength: pairs[0], dexterity: pairs[1], constitution: pairs[2], intelligence: pairs[3], wisdom: pairs[4], charisma: pairs[5] };
    return parseAbilities2024(text);
  }
  // 2024 SRD ability TABLE: "Str 15 +2 +4 Dex 16 +3 +5 Con 14 +2 +2" over two rows.
  // pdf.js often splits a letter off the abbreviation ("S tr", "Wi S", "W is"), so
  // allow a space between ANY of its letters (e.g. Crooked Moon prints "WiS" which
  // extracts as "Wi S"). The trailing \b keeps these from matching inside words
  // like Strength / Wisdom / Charisma.
  function parseAbilities2024(text) {
    const norm = text
      .replace(/\bS[ \t]*t[ \t]*r\b/gi, "Str").replace(/\bD[ \t]*e[ \t]*x\b/gi, "Dex")
      .replace(/\bC[ \t]*o[ \t]*n\b/gi, "Con").replace(/\bI[ \t]*n[ \t]*t\b/gi, "Int")
      .replace(/\bW[ \t]*i[ \t]*s\b/gi, "Wis").replace(/\bC[ \t]*h[ \t]*a\b/gi, "Cha");
    // mod + save follow the score; pdf.js sometimes drops a +/− sign, so keep them
    // optional. Some books (Conflux "2024 Adventurers" / "Assassins") render a
    // negative as an EN DASH (U+2013) with a SPACE before the digit ("Cha 8 – 1 – 1");
    // include –/— in the sign class and allow the gap, or every block with a negative
    // ability lost ALL six scores and got flagged.
    const re = /\b(Str|Dex|Con|Int|Wis|Cha)\b\s+(\d{1,2})\s+[+\-−–—]?\s*\d+\s+[+\-−–—]?\s*\d+/gi;
    const out = {}; let m;
    while ((m = re.exec(norm))) { const k = ABIL_KEY[m[1].toLowerCase()]; if (k && !(k in out)) out[k] = +m[2]; }
    if (Object.keys(out).length >= 6) return out;
    return null;
  }
  function parseBonuses(text) { const out = {}; for (const part of String(text).split(",")) { const m = RE_BONUS_PAIR.exec(part); if (m && m[1].trim()) out[m[1].trim()] = +m[2]; } return out; }
  function parseList(text) { text = String(text).trim(); if (["none", "-", "—", "–", ""].includes(text.toLowerCase())) return []; return text.split(/[,;]/).map(s => s.trim()).filter(Boolean); }
  function parseDamage(text) {
    const comps = []; let m; RE_DAMAGE.lastIndex = 0;
    while ((m = RE_DAMAGE.exec(text))) comps.push({ dice: m[2], bonus: m[3] ? +m[3].replace(/\s+/g, "") : 0, average: +m[1], damage_type: (m[4] || "").toLowerCase() || null, notes: null });
    return comps;
  }

  function looksLikeTitle(line) {
    const s = line.trim();
    if (!s || s.length > 50 || s.split(/\s+/).length > 6) return false;
    if (".,:;".includes(s[s.length - 1])) return false;
    if (!isUpper(s[0])) return false;
    if (SECTION_HEADER_WORDS.has(s.toLowerCase())) return false;
    if (RE_SECTION_LINE.test(s)) return false;   // "Actions"/"Reactions" labels aren't names
    // reject stat-field lines (e.g. "Challenge 21", "AC 17") — not creature names
    if (STAT_FIELD_PREFIXES.some(k => s.toLowerCase().startsWith(k))) return false;
    return !RE_AC_LINE.test(s);
  }
  function nameLike(line) {
    const s = line.trim();
    if (!s || s.length > 45) return false;
    const words = s.split(/\s+/);
    if (words.length > 6 || ".,:;".includes(s[s.length - 1])) return false;
    const low = s.toLowerCase();
    if (SECTION_HEADER_WORDS.has(low) || NON_NAME_WORDS.has(low) || RE_AC_LINE.test(s)) return false;
    if (RE_SECTION_LINE.test(s)) return false;
    if (RE_META.test(s) || RE_META_LOOSE.test(s)) return false;
    if (STAT_FIELD_PREFIXES.some(k => low.startsWith(k))) return false;
    const toks = s.toUpperCase().split(/\s+/);
    if (toks.filter(t => ["STR", "DEX", "CON", "INT", "WIS", "CHA"].includes(t)).length >= 3) return false;
    const letters = (s.match(/[A-Za-z]/g) || []);
    if (letters.length < 2) return false;
    if (letters.filter(c => isUpper(c)).length / letters.length >= 0.6) return true;
    const sig = words.filter(w => !NAME_CONNECTORS.has(w.toLowerCase()));
    return sig.length > 0 && sig.every(w => !/[A-Za-z]/.test(w[0]) || isUpper(w[0]));
  }
  // Names that are NOT creatures: decorative zine headers ("LAIR", "HOARD THEMES",
  // "REGIONAL EFFECTS"), stat-field fragments ("Perception 15", "from Nonmagical
  // Attacks"), or anything starting with a number. Used to reject bad name guesses.
  const DECOR_WORDS = new Set(["lair", "hoard", "themes", "locations", "regional", "effects",
    "traits", "actions", "reactions", "reaction", "legendary", "bonus", "description",
    "variant", "variants", "options", "table", "lore", "encounter", "tactics", "treasure",
    "sidebar", "preferences", "behavior"]);
  // strip a trailing run of decorative headers glued onto a name by a zine layout
  // ("Spring Fey Dragon. LAIR LAIR TRAITS" -> "Spring Fey Dragon")
  function stripTrailingDecor(name) {
    const w = name.split(/\s+/);
    let end = w.length;
    while (end > 1 && DECOR_WORDS.has(w[end - 1].toLowerCase().replace(/[^a-z]/g, ""))) end--;
    return end < w.length ? (w.slice(0, end).join(" ").replace(/[.\s]+$/, "").trim() || name) : name;
  }
  function looksLikeJunkName(s) {
    s = (s || "").trim(); if (!s) return true;
    const low = s.toLowerCase();
    if (/^\W*\d/.test(s)) return true;
    if (/^(perception|passive perception|senses|languages|skills|saving throws?|damage|condition|hit points|armor class|speed|challenge|proficiency|initiative)\b/.test(low)) return true;
    if (/\bnonmagical attacks?\b|\bfrom nonmagical\b/.test(low)) return true;
    const words = low.replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
    if (words.length && words.every(w => DECOR_WORDS.has(w) || NAME_CONNECTORS.has(w))) return true;
    return false;
  }
  // Resolve a creature name from the 1–2 title lines above the meta line. Layouts
  // that print a family/group header above the name produce "Aboleth Aboleth",
  // "Air Elemental Air Elemental", "Bandits Bandit", "Black Dragons Black Dragon
  // Wyrmling" — collapse those, but still join a genuinely wrapped two-line name.
  function resolveName(titles) {
    titles = titles.map(t => t.trim()).filter(Boolean);
    if (titles.length <= 1) return titles[0] || "";
    const a = titles[0], b = titles[1], al = a.toLowerCase(), bl = b.toLowerCase();
    if (al === bl) return a;                                   // exact doubling
    const aLast = a.split(/\s+/).pop();
    if (/s$/i.test(aLast) && aLast.length > 3) return b;       // plural family header above the name
    if (bl.startsWith(al + " ")) return b;                     // "Azer" + "Azer Sentinel"
    if (al.startsWith(bl + " ")) return a;
    return a + " " + b;                                        // a genuinely wrapped name
  }
  function findName(lines, metaI, lower, titleFonts) {
    lower = lower || 0;
    const titles = [];
    let j = metaI - 1;
    // cap at 2 lines: the creature name sits directly above the meta line; grabbing
    // more pulls in family/running headers ("Monsters A–Z", "Bronze Dragons")
    while (j >= lower && lines[j].trim() && looksLikeTitle(lines[j]) && titles.length < 2) {
      // a wrapped two-line name shares one font; a section heading above the name
      // is set in a DIFFERENT font ("Urban Fauna" over "Cat") — stop at the change
      if (titles.length === 1 && titleFonts && titleFonts[j] && titleFonts[j + 1]
          && titleFonts[j] !== titleFonts[j + 1]) break;
      titles.unshift(lines[j].trim()); j--;
    }
    // title path: titles sit directly above the meta line, so the body starts at meta
    if (titles.length) {
      const nm = stripTrailingDecor(resolveName(titles));
      if (!looksLikeJunkName(nm)) return { name: nm, bodyStart: metaI };
      // junk title (decorative header / field fragment): fall through and look higher
    }
    // fallback: name is further up (e.g. a flavour line or a "Challenge N" line sits
    // between it and the meta line). Include those in-between lines in the body so
    // fields printed above the meta line (some layouts put Challenge there) aren't lost.
    j = metaI - 1; let steps = 0;
    while (j >= lower && steps < 30) { const s = lines[j].trim(); if (s && nameLike(s) && !looksLikeJunkName(s)) return { name: stripTrailingDecor(s), bodyStart: j + 1 }; j--; steps++; }
    // LAST-DITCH SALVAGE — a decorative / small-caps title font can scramble spacing
    // and case so the title line fails every name test ("m erfol K s torm CA ller" =
    // Merfolk Stormcaller). Collapse stray single-letter spacing on the nearest line
    // above the meta and Title-case it. Reached ONLY when no name was found, so it can
    // never change a good parse — at worst the block stays unnamed as before.
    const sv = salvageTitle(lines, metaI, lower);
    if (sv) return { name: sv, bodyStart: metaI };
    return { name: "", bodyStart: metaI };
  }
  function salvageTitle(lines, metaI, lower) {
    lower = lower || 0;
    for (let j = metaI - 1; j >= lower && j >= metaI - 4; j--) {
      const s = (lines[j] || "").trim();
      if (!s) continue;
      if (isStatLine(s) || RE_SECTION_LINE.test(s) || RE_AC_LINE.test(s)) break;
      if (STAT_FIELD_PREFIXES.some(k => s.toLowerCase().startsWith(k))) continue;
      // join stray single letters to their neighbour ("m erfol K" -> "merfolK")
      let c = s.replace(/\b([A-Za-z])\s+(?=[A-Za-z])/g, "$1").replace(/\s{2,}/g, " ").trim();
      const letters = (c.match(/[A-Za-z]/g) || []).length;
      const dense = c.replace(/\s/g, "").length;
      if (letters < 3 || !dense || letters / dense < 0.7) continue;
      const nm = titleCase(c);
      if (nm && !looksLikeJunkName(nm) && nm.split(/\s+/).length <= 6) return nm;
    }
    return "";
  }
  // Parse a spellcasting entry's body into { ability, save_dc, to_hit, groups:[{header,
  // spells:[...]}] }. Handles the 2024 ("...using Charisma as the spellcasting ability
  // (spell save DC 17): At Will: ... 1/Day Each: ..."), 2014 prepared ("Cantrips (at
  // will): ... 1st level (4 slots): ...") and innate ("At will: ... 3/day each: ...")
  // forms. Returns null when no spell groups are present (e.g. a "Spellcasting Focus"
  // magic-item trait), so the caller ignores it.
  const RE_SC_GROUP = /(At[-\s]Will|Cantrips?\s*\([^)]*\)|\d+(?:st|nd|rd|th)\s+level\s*\([^)]*\)|\d+\s*\/\s*day(?:\s+each)?|Constant|Encounter|Recharge[^:]*)\s*:/gi;
  function parseSpellcasting(text) {
    text = String(text || "");
    if (!text.trim()) return null;
    const out = { ability: null, save_dc: null, to_hit: null, groups: [] };
    let m;
    if ((m = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\b\s+as the spellcasting ability/i.exec(text))
      || (m = /spellcasting ability is\s+(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)/i.exec(text)))
      out.ability = titleCase(m[1]);
    if ((m = /spell save DC\s*(\d+)/i.exec(text))) out.save_dc = +m[1];
    if ((m = /([+\-]\d+)\s+to hit with spell/i.exec(text))) out.to_hit = m[1];
    // locate every group header, then take the spell list between this header and the next.
    const heads = []; let g; RE_SC_GROUP.lastIndex = 0;
    while ((g = RE_SC_GROUP.exec(text))) heads.push({ label: g[1].replace(/\s+/g, " ").trim(), at: g.index, end: RE_SC_GROUP.lastIndex });
    for (let i = 0; i < heads.length; i++) {
      const stop = i + 1 < heads.length ? heads[i + 1].at : text.length;
      const list = text.slice(heads[i].end, stop).replace(/\s*\n\s*/g, " ").trim();
      const spells = list.split(/\s*,\s*/).map(s => s.replace(/\s+/g, " ").trim()).filter(s => s && /[A-Za-z]/.test(s) && s.length <= 60);
      if (spells.length) out.groups.push({ header: titleCase(heads[i].label), spells });
    }
    return out.groups.length ? out : null;
  }
  // A narrow column can wrap a stat-field value onto the next line(s) (Languages
  // "...but can't\nspeak", a long Skills/Senses/Damage list). Given the field's
  // regex match, stitch trailing continuation lines back onto the captured value.
  // Stops at a blank line, the next stat field/CR line, or a capitalised word that
  // is NOT continuing a comma-separated list — so it never swallows the next field.
  function stitchWrapped(text, m, firstVal) {
    let val = firstVal;
    const after = text.slice(m.index + m[0].length).split("\n");
    for (let li = 1; li < after.length; li++) {
      const ln = after[li].trim();
      if (!ln || isStatLine(ln) || RE_CHALLENGE.test(ln)) break;
      if (/^[A-Z]/.test(ln) && !/[,;]\s*$/.test(val)) break;
      val += " " + ln;
      if (/[.;]$/.test(ln)) break;
    }
    return val;
  }
  function stripFooter(body) { return body.replace(/[ \t\r\n]+\d{1,4}\s*$/, "").replace(/\s+$/, ""); }
  const hasActionsSection = (text) => reSectionG().test(text);

  // A block whose ACTIONS section opens with a Multiattack but carries NO actual
  // attack entry after it has had its named attacks severed to the next column /
  // page (dense two-column 2024 books: a CR-high creature shows ONLY "Multiattack.
  // makes three Earthen Maul attacks" then the page ends — Earthen Maul itself is
  // in the next column). Multiattack ALWAYS references other attacks, so an Actions
  // list that is JUST a Multiattack is incomplete: signal it so the column/page
  // continuation merge runs (same path that joins an action-less block).
  function actionsTruncated(text) {
    const re = reSectionG();
    let aStart = -1, mm;
    while ((mm = re.exec(text))) if (HEADER_TO_CAT[mm[1].toUpperCase()] === "action") aStart = mm.index + mm[0].length;
    if (aStart < 0) return false;
    let aEnd = text.length; const re2 = reSectionG(); re2.lastIndex = aStart; let m2;
    if ((m2 = re2.exec(text))) aEnd = m2.index;            // stop at the next section header
    const seg = text.slice(aStart, aEnd);
    if (!/\bmultiattack\b/i.test(seg)) return false;       // only Multiattack-led blocks
    // count entry-name starts in the Actions segment: Multiattack alone => truncated,
    // Multiattack + >=1 named attack => complete.
    let entries = 0;
    for (const ln of seg.split("\n"))
      if (RE_ENTRY_LINE.test(ln) || RE_ATTACK.test(ln) || RE_ATTACK_2024.test(ln)) entries++;
    return entries <= 1;
  }

  function isFeatureName(name) {
    const words = name.replace(/\([^)]*\)/g, "").split(/\s+/);
    for (let i = 1; i < words.length; i++) {
      const token = stripEdge(words[i], ".,:;'’\"");
      if (token && token[0] === token[0].toLowerCase() && /[a-z]/i.test(token[0]) && !NAME_CONNECTORS.has(token.toLowerCase())) return false;
    }
    return true;
  }

  function buildAction(name, body, category) {
    const cleanName = name.replace(/\s*\([^)]*\)/g, "").trim() || name.trim();
    const action = { name: cleanName, category, raw_text: body.trim(), attack: null, damage: [], save: null, recharge: null, usage: null, legendary_cost: 1 };
    const paren = /\(([^)]*)\)/.exec(name);
    if (paren) {
      const p = paren[1]; let mm;
      if ((mm = /recharge\s+([0-9–\-]+)/i.exec(p))) action.recharge = "Recharge " + mm[1];
      else if (/\d+\s*\/\s*day/i.test(p)) action.usage = p.trim();
      else if ((mm = /costs?\s+(\d+)\s+actions?/i.exec(p))) action.legendary_cost = +mm[1];
      else if ((mm = /replaces?\s+(.+)/i.exec(p))) action.replaces = mm[1].trim();   // variant action supersedes a base action
    }
    const am = RE_ATTACK.exec(body);
    if (am) action.attack = { kind: am[1].toLowerCase() + "_" + am[2].toLowerCase(), to_hit: +am[3], reach_ft: am[4] ? +am[4] : null, range_ft: am[5] || null, targets: "one target" };
    else { const a2 = RE_ATTACK_2024.exec(body); if (a2) action.attack = { kind: a2[1].toLowerCase() + "_weapon", to_hit: +a2[2], reach_ft: a2[3] ? +a2[3] : null, range_ft: a2[4] || null, targets: "one target" }; }
    action.damage = parseDamage(body);
    const sm = RE_SAVE.exec(body);
    if (sm) action.save = { ability: ABIL_BY_NAME[sm[2].toLowerCase()], dc: +sm[1], on_success: /half/i.test(body) ? "half damage" : null };
    // looser save fallback: ability + 'saving throw' and a DC anywhere in the body
    // (handles "...Dexterity saving throw. The DC equals 15", DC-after phrasings).
    else {
      const dc = /\bDC\s*(\d+)\b/i.exec(body);
      const ab = /\b(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)\s+saving throw/i.exec(body);
      if (dc && ab) action.save = { ability: ABIL_BY_NAME[ab[1].toLowerCase()], dc: +dc[1], on_success: /half/i.test(body) ? "half damage" : null };
    }
    // recharge / usage stated in the BODY rather than the name (some books do this)
    if (!action.recharge && !action.usage) {
      let mm;
      if ((mm = /\brecharge\s+([0-9–\-]+)/i.exec(body))) action.recharge = "Recharge " + mm[1];
      else if ((mm = /recharges?\s+after\s+a\s+(?:short|long)(?:\s+or\s+(?:short|long))?\s+rest/i.exec(body))) action.usage = mm[0].trim();
      else if ((mm = /(\d+)\s*\/\s*(?:day|short rest|long rest|round|turn)/i.exec(body))) action.usage = mm[0].trim();
    }
    return action;
  }

  // words that end an action name (so "Bite Melee Weapon Attack" -> name "Bite")
  const NAME_STOP = new Set(["melee", "ranged", "weapon", "spell", "attack", "hit", "recharge", "save", "dc", "saving", "ranged", "reach", "range"]);
  // 2024 stat blocks break an action's mechanics onto their own lines
  // ("Strength Saving Throw: DC 25", "Melee Attack Roll: +9", "Failure:"/"Success:").
  // These are clauses WITHIN an action, never action names — they must not start a
  // new entry (it stole the save off "Engulfing Bite" as a phantom "Strength Saving
  // Throw" action). No real action name contains "Saving Throw"/"Attack Roll".
  // Also skip a bare "DC 15" candidate: when a "... Saving Throw:" clause wraps so
  // the "DC 15. Failure:" tail starts a line, that tail is mis-read as an action.
  // No real action name is just "DC <number>".
  const RE_CLAUSE_HEAD = /\b(?:Saving Throw|Attack Roll)\b|^DC\s+\d/i;
  // A recovered (column/page-continuation) entry name can span a newline because
  // the next column opens with page chrome — a running header ("Genies of the
  // Earth"), a quote attribution ("- Grand Sultan Marrake") or a subtitle — glued
  // to the first severed attack ("...\nLava Burst"). Real entry names never wrap a
  // running header, so when a captured name spans a line, drop the stranded prefix
  // IF it is clearly chrome: a quote attribution, or a >=3-word phrase (a header).
  // A genuinely wrapped short name ("Frightful\nPresence", 1-word prefix) is kept
  // and merely un-wrapped.
  function cleanEntryName(name) {
    if (!name.includes("\n")) return name;
    const parts = name.split(/\n/);
    const tail = parts[parts.length - 1].trim();
    const head = parts.slice(0, -1).join(" ").replace(/^[\-–—]\s*/, "").trim();
    const headWords = head ? head.split(/\s+/).length : 0;
    const isQuote = /^[\-–—]/.test(parts[0].trim());
    if (tail && (isQuote || headWords >= 3)) return tail;     // drop the chrome prefix
    return name.replace(/\s+/g, " ").trim();                  // wrapped name: un-wrap
  }
  function parseEntries(sectionText, category, ocr) {
    if (!sectionText.trim()) return [];
    const accepted = []; const seenStart = new Set();
    const add = (name, start, end) => { if (!seenStart.has(start)) { seenStart.add(start); accepted.push({ name, start, end }); } };
    // (1) standard period-delimited entries: "Slam. Melee Weapon Attack: ..."
    let m; const re = reEntryG();
    while ((m = re.exec(sectionText))) {
      const nm = m[1].replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
      if (NON_HEADER_NAMES.has(nm)) continue;
      if (RE_CLAUSE_HEAD.test(m[1])) continue;
      if (!isFeatureName(m[1])) continue;
      const prev = sectionText.slice(0, m.index).replace(/\s+$/, "");
      // Accept when the previous text ends a sentence OR the name simply starts a
      // new line (homebrew books frequently omit the trailing period on the prior
      // entry). The sentence-starter guard stops wrapped prose from being grabbed.
      const atLineStart = m.index === 0 || sectionText[m.index - 1] === "\n";
      const firstWord = nm.split(/\s+/)[0];
      const boundary = !prev || SENTENCE_END.includes(prev[prev.length - 1]) || atLineStart;
      if (boundary && !SENTENCE_STARTERS.has(firstWord)) add(m[1], m.index, re.lastIndex);
    }
    // (2) homebrew attack actions with NO period after the name: "Stun Mace Melee
    // Weapon Attack: ...". The attack clause is signal enough — no sentence-end guard.
    let am; const reA = reEntryAttackG();
    while ((am = reA.exec(sectionText))) {
      const nm = am[1].replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
      if (NON_HEADER_NAMES.has(nm)) continue;
      if (RE_CLAUSE_HEAD.test(am[1])) continue;
      if (!isFeatureName(am[1])) continue;
      add(am[1], am.index, reA.lastIndex);
    }
    // (3) OCR ONLY, and only when (1)+(2) found nothing: scanned pages carry no
    // bold/period cues, so detect entries as lines that START with a short
    // Title-Case phrase (stopping at sentence-starters / attack keywords). Recovers
    // action NAMES as stubs to flesh out from the screenshot, instead of zero.
    if (ocr && !accepted.length) {
      let pos = 0;
      for (const line of sectionText.split("\n")) {
        const at = pos; pos += line.length + 1;
        const s = line.trim(); if (s.length < 3) continue;
        const words = s.split(/\s+/); const nameWords = [];
        for (const w of words) {
          const lw = w.toLowerCase().replace(/[^a-z]/g, "");
          if (nameWords.length >= 4) break;
          if (!/^[A-Z][A-Za-z'’/\-]*$/.test(w)) break;
          if (SENTENCE_STARTERS.has(lw) || NAME_STOP.has(lw)) break;
          nameWords.push(w);
        }
        const nm = nameWords.join(" ");
        if (nm.length < 3 || nm.length > 40) continue;
        if (NON_HEADER_NAMES.has(nm.toLowerCase()) || !isFeatureName(nm)) continue;
        if (s.length <= nm.length + 1) continue;   // require a description after the name
        const nameAt = at + (line.length - line.replace(/^\s+/, "").length);
        add(nm, nameAt, nameAt + nm.length);
      }
    }
    accepted.sort((a, b) => a.start - b.start);
    const entries = [];
    for (let i = 0; i < accepted.length; i++) {
      const end = i + 1 < accepted.length ? accepted[i + 1].start : sectionText.length;
      entries.push(buildAction(cleanEntryName(accepted[i].name), sectionText.slice(accepted[i].end, end), category));
    }
    // Collapse accidental duplicate entries that share a name — a running header or
    // column seam can make the name regex match one action twice (e.g. once across
    // the header line with an empty body, once cleanly with the real body). Real
    // stat blocks never repeat an action/trait name, so keep the richest body and
    // preserve first-seen order. Also fixes the "duplicate trait" reports.
    const byName = new Map();
    for (const e of entries) {
      const key = (e.name || "").trim().toLowerCase();
      if (!key) { byName.set(" " + byName.size, e); continue; }   // keep unnamed as-is
      const prev = byName.get(key);
      if (!prev || (e.raw_text || "").length > (prev.raw_text || "").length) byName.set(key, e);
    }
    return Array.from(byName.values());
  }

  function trimStatHeader(region) {
    let cut = 0;
    for (const reSrc of [RE_PROF, RE_CHALLENGE]) {
      const re = new RegExp(reSrc.source, "gi"); let m, last = null;
      while ((m = re.exec(region))) last = m;
      if (last) { const nl = region.indexOf("\n", last.index + last[0].length); cut = Math.max(cut, nl !== -1 ? nl + 1 : last.index + last[0].length); }
    }
    return region.slice(cut);
  }
  function splitSections(text) {
    const matches = []; let m; const re = reSectionG();
    while ((m = re.exec(text))) matches.push({ head: m[1], start: m.index, end: re.lastIndex });
    const first = matches.length ? matches[0].start : text.length;
    const traitsText = trimStatHeader(text.slice(0, first));
    const sections = {};
    for (let i = 0; i < matches.length; i++) {
      const cat = HEADER_TO_CAT[matches[i].head.toUpperCase()];
      const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
      sections[cat] = text.slice(matches[i].end, end);
    }
    return { traitsText, sections };
  }

  // A line that belongs to a stat block (a field, a section header, the ability
  // row, or anything carrying combat mechanics). Used to tell stat-block content
  // apart from the lore/rules prose some books pack between creatures.
  function isStatLine(s) {
    s = (s || "").trim(); if (!s) return false;
    if (RE_AC_LINE.test(s) || RE_SECTION_LINE.test(s)) return true;
    const low = s.toLowerCase().replace(/^[•▪◦·*\-\s]+/, "");
    if (STAT_FIELD_PREFIXES.some(p => low.startsWith(p))) return true;
    const up = s.toUpperCase();
    if ((up.match(/\b(STR|DEX|CON|INT|WIS|CHA)\b/g) || []).length >= 3) return true;   // ability header
    if ((s.match(/\d+\s*\(\s*[+\-−]?\d+\s*\)/g) || []).length >= 3) return true;        // "12 (+1) 15 (+2) ..."
    if (RE_ATTACK.test(s) || RE_ATTACK_2024.test(s) || RE_SAVE.test(s)) return true;
    if (/\bHit:?\s/i.test(s) || /\d+d\d+/.test(s) || /recharge/i.test(s)) return true;
    if (/^[•▪◦·*\-\s]*Multiattack\b/i.test(s)) return true;
    if (RE_CHALLENGE.test(s) || RE_PROF.test(s)) return true;
    // a trait/action entry start ("False Appearance. While motionless…") — now that
    // the font pass adds periods to bold names, these are detectable and must NOT be
    // mistaken for trimmable lore (they were dropping whole trait blocks).
    if (RE_ENTRY_LINE.test(s)) return true;
    return false;
  }
  // Trim trailing lore/rules prose that gets swept into a block when stat blocks
  // are packed between pages of flavour (e.g. Fateforge's bestiary). Cut at the
  // start of the first long run of non-stat-block lines after the Armor Class.
  const FLAVOR_RUN = 16;
  function trimFlavor(lines) {
    const ac = lines.findIndex(l => RE_AC_LINE.test(l));
    if (ac < 0) return lines;
    // Splice out long runs of non-stat-block lines (lore/rules prose) wherever
    // they appear — at the end of the block OR sandwiched between the traits and
    // the actions (a two-column NPC whose halves were stitched together). Keep
    // the real stat content on both sides; short runs (entry descriptions) stay.
    const out = lines.slice(0, ac);
    let run = [];
    const flush = () => { if (run.length) { if (run.filter(l => l.trim()).length < FLAVOR_RUN) out.push(...run); run = []; } };
    for (let i = ac; i < lines.length; i++) {
      if (lines[i].trim() && isStatLine(lines[i])) { flush(); out.push(lines[i]); }
      else run.push(lines[i]);
    }
    flush();
    return out;
  }

  // Some books (e.g. Crooked Moon) interleave a flavour SIDEBAR into the stat
  // block via column ordering: a repeated all-caps NAME heading, a subtitle, a
  // "Habitat:/Treasure:" line, a prose paragraph, and a "Secret." flavour note —
  // sometimes BETWEEN the real entries, and the next creature's heading + lore can
  // trail in too. Excise each such region in place: it starts at a name-style
  // heading or Habitat/Treasure line and runs through the flavour until genuine
  // stat-block content (a real entry or a stat line) resumes. Unlike a blunt
  // trailing cut, this keeps the real entries that follow embedded lore.
  const LORE_LABELS = new Set(["secret"]);   // recurring flavour label, never a real trait
  const loreEntryName = (raw) => (raw.match(RE_ENTRY_LINE) || [,""])[1]
    .replace(/\s*\([^)]*\)/g, "").trim().toLowerCase();
  function isNameHeading(raw) {
    if (!raw || raw !== raw.toUpperCase() || !/[A-Z]/.test(raw)) return false;   // all-caps only
    if (raw.length < 4 || raw.length > 40) return false;
    if (!/^[A-Z][A-Z0-9.'’\-]*(?:\s+[A-Z0-9.'’\-]+){0,4}$/.test(raw)) return false;  // <=5 short words
    if (isStatLine(raw)) return false;          // not a section header / ability row / field
    return true;
  }
  const isLoreStart = (raw) => isNameHeading(raw) || /\b(?:HABITAT|TREASURE)\s*:/i.test(raw);
  function stripLoreRegions(text) {
    const bl = text.split("\n");
    const out = [];
    for (let i = 0; i < bl.length; i++) {
      const raw = bl[i].trim();
      // never touch the stat header (name/meta/AC/abilities); lore sidebars only
      // appear once entries have started, so begin looking a few lines in.
      if (i >= 4 && isLoreStart(raw)) {
        let j = i + 1;
        for (; j < bl.length; j++) {
          const r = bl[j].trim();
          if (!r || isLoreStart(r)) continue;                 // blank / another lore heading -> still lore
          if (RE_ENTRY_LINE.test(r)) { if (LORE_LABELS.has(loreEntryName(r))) continue; break; }
          if (isStatLine(r)) break;                           // a real field / attack / save resumes
          // otherwise prose (subtitle, flavour paragraph) -> still lore
        }
        i = j - 1;   // skip the excised region (the for-loop ++ lands on j)
        continue;
      }
      out.push(bl[i]);
    }
    return out.join("\n");
  }

  // Conflux books (2024 Adventurers, Assassins) print the NAME heading in a broken
  // font where EVERY letter is its own text item, so pdf.js extracts it as single
  // spaced capitals with the challenge rating glued on:
  //   "A S S A S S I N C U T -T H R O A T C R 5"
  // Word boundaries are destroyed (uniform single spaces), so the best we can do is
  // collapse the letters into one token and peel off a trailing "C R <n>" as the CR.
  // Gated hard: every core token must be a lone letter (optionally hyphen-joined),
  // so ability rows ("S T R 14 +2") and spaced prose (which carries punctuation or
  // lowercase words) are left untouched.
  // Collapsing a spaced heading loses the spaces BETWEEN words too, so the name
  // comes out as one run ("BARBARIANOUTLANDER", "ASSASSINCUTTHROAT"). These books
  // name creatures "<class/role> <subtype>", so peel a recognised leading word off
  // the front and treat the rest as the subtype — recovering the space. Falls back
  // to the single token when nothing matches, so it never mangles a real name.
  const NAME_LEAD_WORDS = ["barbarian", "bard", "cleric", "druid", "fighter", "monk",
    "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard", "artificer", "assassin"];
  const capWord = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  function splitCollapsedName(word) {
    const low = word.toLowerCase();
    for (const w of NAME_LEAD_WORDS) {
      if (low.startsWith(w) && word.length > w.length + 1) {
        return capWord(word.slice(0, w.length)) + " " + capWord(word.slice(w.length));
      }
    }
    return capWord(word);
  }
  function collapseSpacedCaps(line) {
    const toks = line.trim().split(/\s+/);
    if (toks.length < 5) return line;
    let core = toks, crTail = "";
    const n = toks.length;
    if (/^[Cc]$/.test(toks[n - 3]) && /^[Rr]$/.test(toks[n - 2]) && /^\d+(?:\/\d+)?$/.test(toks[n - 1])) {
      crTail = " CR " + toks[n - 1]; core = toks.slice(0, n - 3);
    }
    if (core.length < 4 || !core.every(t => /^-?[A-Za-z]-?$/.test(t))) return line;
    return splitCollapsedName(core.join("")) + crTail;
  }

  // ============================================================ split into blocks
  function splitIntoBlocks(pageText, fonts, titleFonts) {
    const lines = pageText.split("\n").map(collapseSpacedCaps);
    if (fonts && fonts.length !== lines.length) fonts = null;
    if (titleFonts && titleFonts.length !== lines.length) titleFonts = null;
    const acIdxs = []; lines.forEach((ln, i) => { if (RE_AC_LINE.test(ln)) acIdxs.push(i); });
    if (!acIdxs.length) return [];
    const specs = acIdxs.map(ac => { let mi = ac - 1; while (mi >= 0 && !lines[mi].trim()) mi--; return [mi, ac]; });
    const blocks = [];
    for (let k = 0; k < specs.length; k++) {
      const [metaI, ac] = specs[k];
      const lower = k > 0 ? specs[k - 1][1] + 1 : 0;
      const nm = findName(lines, metaI, lower, titleFonts);
      const name = nm.name || "Unknown Creature";
      const hardEnd = k + 1 < specs.length ? specs[k + 1][0] : lines.length;
      let rest;
      if (fonts) {
        const sampleEnd = Math.min(ac + 8, hardEnd);
        const sample = [];
        for (let j = ac + 1; j < sampleEnd; j++) if (j < fonts.length && fonts[j]) sample.push(fonts[j]);
        let sbFont;
        if (sample.length) { const c = {}; let bn = -1; sample.forEach(f => { c[f] = (c[f] || 0) + 1; if (c[f] > bn) { bn = c[f]; sbFont = f; } }); }
        else sbFont = fonts[ac];
        const kept = [lines[metaI]];
        for (let i = metaI + 1; i < hardEnd; i++) if (i === ac || fonts[i] === sbFont || RE_SECTION_LINE.test(lines[i])) kept.push(lines[i]);
        rest = kept.join("\n");
      } else rest = trimFlavor(lines.slice(nm.bodyStart, hardEnd)).join("\n");
      const body = stripFooter((name + "\n" + rest).trim());
      if (body) blocks.push(body);
    }
    return blocks;
  }

  // ===================================================================== parseText
  // PDF text artifacts. Print layouts hyphenate words across line breaks
  // ("sav-\ning throws"); when lines are joined for display that surfaces as
  // "sav- ing". Rejoin them here, before any parsing. Also map ligature glyphs
  // (ﬁ ﬂ …) to plain letters and strip soft hyphens.
  const LIGATURES = { "ﬁ": "fi", "ﬂ": "fl", "ﬀ": "ff", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "ft", "ﬆ": "st" };
  // true prefix compounds keep their hyphen when rejoined: "half-\norc" -> "half-orc"
  const KEEP_HYPHEN = new Set(["self", "off", "non", "half", "well", "ill", "quasi", "semi", "pseudo", "demi", "anti", "multi"]);
  // OCR ONLY: scanned pages glue margin/gutter artifacts onto the START of lines
  // ("hi | ACTIONS", "i Bite.", "| Hit Points"). Those break line-start detection
  // of section headers and entry names, so strip them. Text-layer PDFs never see this.
  function cleanOcrLines(text) {
    return String(text).split("\n").map(l => l
      .replace(/^\s*[A-Za-z0-9)\]}·•*§¥]{0,3}\s*\|\s*/, "")        // "hi | ", "| ", "ld | "
      .replace(/^\s*[a-z)\]}·•*§¥]{1,2}\s+(?=[A-Z0-9])/, "")        // "i Bite", ") -", "§ The"
    ).join("\n");
  }

  function cleanExtractedText(text) {
    text = String(text).replace(/[ﬁﬂﬀﬃﬄﬅﬆ]/g, c => LIGATURES[c] || c).replace(/\u00AD/g, "");
    // a word fragment + hyphen at a line end, continued by a lowercase fragment:
    // merge across the break ("sav-\ning" -> "saving"). Uppercase continuations
    // are left alone — they're headings/names, not split words.
    // strip DriveThruRPG per-purchaser watermark glued into the text
    // ("Iari Bettoli Transaction: CRITEU27881") — optional name + transaction code.
    text = text.replace(/(?:[A-Z][a-z]+\s+){0,4}Transaction:\s*[A-Z0-9]+/g, " ");
    // Allow a space BEFORE the hyphen too ("night -\nmare", "Cha -\nrisma").
    text = text.replace(/([A-Za-z]+)[ \t]*-\n([a-z][A-Za-z]*)/g, (m, a, b) =>
      KEEP_HYPHEN.has(a.toLowerCase()) ? a + "-" + b : a + b);
    // missing space after a sentence period ("damage.Upon", "Multiattack.The golem")
    // — insert one so entry/sentence boundaries parse. Only a lowercase letter +
    // period + uppercase letter (never decimals, which are digit.digit).
    text = text.replace(/([a-z])\.([A-Z])/g, "$1. $2");
    // hyphen + SPACE mid-line ("30-foot- radius", "pre- defined"): the source
    // text broke a compound after its hyphen — rejoin keeping the hyphen, but
    // leave suspended hyphens alone ("one- or two-handed").
    text = text.replace(/([A-Za-z])- (?!(?:and|or|nor|to)\b)([a-z][A-Za-z]*)/g, "$1-$2");
    // Some books (Crooked Moon) split the trailing small-cap 's' off section
    // headers, so pdf.js extracts "Bonu S Action S" / "Reaction S". Rejoin so the
    // section detector sees real "Bonus Actions" / "Reactions" / "Actions" headers.
    // A wrapped stat clause splits "Saving Throw" / "Attack Roll" across a line so
    // the tail ("Throw: DC 10", "Roll: +4") starts a line and is mis-read as an
    // action entry (Drakkenheim's "Critical Hit: Constitution Saving\nThrow: DC 10").
    // Rejoin the phrase so the clause-head guard recognises and skips it.
    text = text.replace(/\bSaving\s*\n\s*Throw\b/g, "Saving Throw").replace(/\bAttack\s*\n\s*Roll\b/g, "Attack Roll");
    return text.replace(/\bBonu[ \t]+S\b/g, "Bonus")
               .replace(/\bReaction[ \t]+S\b/g, "Reactions")
               .replace(/\bAction[ \t]+S\b/g, "Actions");
  }

  function parseText(text, sourcePage, source, ocr) {
    if (ocr) text = cleanOcrLines(text);   // strip scanned-page margin junk first
    text = cleanExtractedText(text);
    let lines = text.split(/\r?\n/).map(l => l.replace(/\s+$/, "")).filter(l => l.trim());
    lines = lines.map(dedupeLine);      // collapse bold double-draw ("Actions Actions")
    lines = trimFlavor(lines);          // drop trailing lore/rules prose (any assembly path)
    // Drakkenheim prints a "Harvestable Components" crafting sidebar that column
    // ordering can splice onto a stat block. It is not stat-block mechanics, and its
    // "Animus:/Fluid:/Organs:/Hide:" lines otherwise parse as phantom actions (and a
    // trailing next-creature heading leaks in). The table always opens with either the
    // "Harvestable Components" header or its first field "Animus:" (never a real stat
    // line), so cut the block at whichever appears first.
    const hcI = lines.findIndex(l => /^(?:Harvestable Components\b|Animus[:.]\s)/i.test(l.trim()));
    if (hcI > 0) lines = lines.slice(0, hcI);
    text = lines.join("\n");            // so the regexes + raw_text use the trimmed body
    let found = 0;
    const sb = {
      name: lines.length ? lines[0].trim() : "Unknown Creature",
      size: null, creature_type: null, alignment: null,
      armor_class: 10, armor_desc: null, hit_points: 1, hit_dice: null,
      speed: {}, abilities: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 },
      saving_throws: {}, skills: {}, damage_vulnerabilities: [], damage_resistances: [], damage_immunities: [],
      condition_immunities: [], senses: {}, passive_perception: null, languages: [],
      challenge_rating: null, xp: null, proficiency_bonus: null,
      traits: [], actions: [], bonus_actions: [], reactions: [], legendary_actions: [], legendary_action_count: 0,
      spellcasting: null, has_spellcasting: false, source: source || null, source_page: sourcePage || null,
      raw_text: text || null, parse_confidence: 0, parse_warnings: [],
    };
    for (const ln of lines.slice(1, 7)) {
      const t = ln.trim();
      let m = RE_META.exec(t);
      if (m) { sb.size = SIZES[m[1].toLowerCase()] || null; sb.creature_type = titleCase(m[2]); sb.alignment = m[3].trim(); break; }
      const lm = RE_META_LOOSE.exec(t);
      if (lm) { sb.creature_type = titleCase(lm[1]); sb.alignment = lm[2].trim(); break; }
      // size + type with no alignment, e.g. "Large Celestial" (Free5e layout)
      const sm = RE_META_SIZETYPE.exec(t);
      if (sm) { sb.size = SIZES[sm[1].toLowerCase()] || null; sb.creature_type = titleCase(sm[2]); break; }
      // non-standard creature type (Obojima "Medium Spirit, Unaligned"): accept any
      // type word(s) when the tail looks like an alignment.
      const anym = RE_META_ANYTYPE.exec(t);
      if (anym && RE_ALIGNMENTish.test(anym[3].trim())) {
        sb.size = SIZES[anym[1].toLowerCase()] || null; sb.creature_type = titleCase(anym[2].trim()); sb.alignment = anym[3].trim(); break;
      }
    }
    // compact layout: the name line itself carries the size/type (alignment may
    // wrap to the next line), e.g. "Kyanos B'lot Large Aberration (Shapechanger), Chaotic"
    if (!sb.creature_type) {
      const nmeta = RE_NAME_META.exec(sb.name);
      if (nmeta && SIZES[nmeta[2].toLowerCase()]) {
        sb.name = nmeta[1].trim();
        sb.size = SIZES[nmeta[2].toLowerCase()] || null;
        sb.creature_type = titleCase(nmeta[3]);
        let align = (nmeta[4] || "").trim();
        const nxt = (lines[1] || "").trim();   // alignment often wraps: "...Chaotic" / "Neutral"
        if (/^(Lawful|Chaotic|Neutral|Any)$/i.test(align) && /^(Good|Evil|Neutral)$/i.test(nxt)) align += " " + nxt;
        if (align) sb.alignment = align;
      }
    }
    // strip a single-word family-header prefix written as "FAMILY - Name"
    // (e.g. "BUGBEAR - BUGBEAR ASCETIC" -> "BUGBEAR ASCETIC", "LYCANTHROPE - WEREBAT" -> "WEREBAT")
    sb.name = sb.name.replace(/^[A-Za-z][\w'’]*\s+[-–—]\s+(?=[A-Za-z])/, "");
    // strip a running-header prefix glued to the name, e.g.
    // "Z-Coin | Crystalline Dragons | Agate Adult Agate Dragon"
    if (sb.name.includes(" | ")) sb.name = sb.name.replace(/^.*\s\|\s/, "").trim();
    // drop a leading family word that repeats later ("Agate Adult Agate Dragon" -> "Adult Agate Dragon")
    { const w = sb.name.split(/\s+/);
      if (w.length > 2 && w.slice(1).some(x => x.toLowerCase() === w[0].toLowerCase())) sb.name = w.slice(1).join(" "); }
    // Strip a CR (and anything after it) glued onto the name. Covers a collapsed
    // Conflux heading ("Assassincut-throat CR 5") AND the Flee Mortals title line
    // "Name. CR 1/2 Ambusher" (CR rating followed by a role word), which the old
    // end-anchored strip missed. RE_CHALLENGE still reads the real CR from the body.
    sb.name = sb.name.replace(/\s*\.?\s*\bCR\s+\d+(?:\/\d+)?\b.*$/i, "").trim();
    // Repair stray spaces that strand a CAPITAL letter from the rest of its word —
    // a decorative/broken display font (Exploring Eberron) drops the first glyph onto
    // its own text item: "P lasmid" -> "Plasmid", "M eld" -> "Meld", "V alaara" ->
    // "Valaara". Run twice to chain ("D u ' ulora Q uori" -> "Du'ulora Quori"). The
    // capital-then-lowercase shape leaves correctly-spaced multi-word names and
    // ALL-CAPS names (no lowercase to glue to) untouched.
    for (let k = 0; k < 2; k++) {
      sb.name = sb.name
        .replace(/\b([A-Z])\s+([a-z])/g, "$1$2")
        .replace(/([A-Za-z])\s+([''])\s*([a-z])/g, "$1$2$3");
    }
    sb.name = sb.name.replace(/\s{2,}/g, " ").trim();
    let m;
    let acF = false, hpF = false, spdF = false, abF = false, crF = false;
    if ((m = RE_AC.exec(text))) { sb.armor_class = +m[1]; sb.armor_desc = (m[2] || "").replace(/^[()\s]+|[()\s]+$/g, "") || null; found++; acF = true; }
    if ((m = RE_HP.exec(text))) { sb.hit_points = +m[1]; sb.hit_dice = (m[2] || "").trim() || null; found++; hpF = true; }
    if ((m = RE_SPEED.exec(text))) { sb.speed = parseSpeed(m[1]); found++; spdF = true; }
    const ab = parseAbilities(text); if (ab) { sb.abilities = ab; found++; abF = true; }
    if ((m = RE_CHALLENGE.exec(text))) { sb.challenge_rating = m[1]; const xp = m[2] || m[3]; if (xp) sb.xp = +xp.replace(/,/g, ""); found++; crF = true; }
    if ((m = RE_PROF.exec(text))) sb.proficiency_bonus = +m[1];
    if ((m = RE_SAVES.exec(text))) sb.saving_throws = parseBonuses(stitchWrapped(text, m, m[1]));
    if ((m = RE_SKILLS.exec(text))) sb.skills = parseBonuses(stitchWrapped(text, m, m[1]));
    if ((m = RE_SENSES.exec(text))) sb.senses = parseSenses(stitchWrapped(text, m, m[1]));
    if ((m = RE_PASSIVE.exec(text))) sb.passive_perception = +m[1];
    if ((m = RE_LANGS.exec(text))) sb.languages = parseList(stitchWrapped(text, m, m[1]));
    let dm; RE_DMG.lastIndex = 0;
    while ((dm = RE_DMG.exec(text))) { const lst = parseList(stitchWrapped(text, dm, dm[2])); const k = dm[1].toLowerCase(); if (k === "vulnerabilities") sb.damage_vulnerabilities = lst; else if (k === "resistances") sb.damage_resistances = lst; else if (k === "immunities") sb.damage_immunities = lst; }
    if ((m = RE_COND.exec(text))) sb.condition_immunities = parseList(stitchWrapped(text, m, m[1]));

    // Excise interleaved/trailing lore sidebars (repeated NAME heading, subtitle,
    // Habitat/Treasure, flavour prose, "Secret." note, and any next-creature lore
    // that trailed in). Done after the stat fields are read above, before entries
    // are parsed below.
    text = stripLoreRegions(text);

    const { traitsText, sections } = splitSections(text);
    sb.traits = parseEntries(traitsText, "trait", ocr);
    sb.actions = parseEntries(sections["action"] || "", "action", ocr);
    sb.bonus_actions = parseEntries(sections["bonus_action"] || "", "bonus_action", ocr);
    sb.reactions = parseEntries(sections["reaction"] || "", "reaction", ocr);
    const legText = sections["legendary"] || "";
    sb.legendary_actions = parseEntries(legText, "legendary", ocr);
    const lm = RE_LEG_COUNT.exec(legText); if (lm) sb.legendary_action_count = +lm[1];

    // Some books (e.g. Fey Dragons) omit the "Actions" header, so attacks land in
    // the traits bucket. If there are no actions, split the traits at the first
    // action-like entry (Multiattack / an attack roll) and move the rest across.
    if (!sb.actions.length && sb.traits.length > 1) {
      const isAct = (e) => /^multiattack\b/i.test(e.name) || e.attack
        || RE_ATTACK.test(e.raw_text || "") || RE_ATTACK_2024.test(e.raw_text || "");
      const idx = sb.traits.findIndex(isAct);
      if (idx >= 0) { sb.actions = sb.traits.slice(idx).map(e => (e.category = "action", e)); sb.traits = sb.traits.slice(0, idx); }
    }

    // spellcasting flag (drives the "Innate Spellcasting" filter, which had nothing
    // setting it). The spell list itself stays in the trait/action text.
    sb.has_spellcasting = [].concat(sb.traits, sb.actions, sb.bonus_actions)
      .some(e => /\bspellcasting\b/i.test(e && e.name || ""));
    // STRUCTURED spell list — pull the casting ability / save DC / to-hit and the
    // grouped spell lists ("At Will:", "1/Day Each:", "Cantrips (at will):",
    // "1st level (4 slots):") out of the spellcasting entry into sb.spellcasting, so
    // the compendium can show a clean reference and a VTT export has real data. The
    // raw entry text is left untouched. Additive only — never affects block counts.
    for (const e of [].concat(sb.traits, sb.actions, sb.bonus_actions)) {
      if (!e || !/\bspellcasting\b/i.test(e.name || "")) continue;
      const sc = parseSpellcasting(e.raw_text || "");
      if (sc && sc.groups.length) { sb.spellcasting = sc; break; }   // first real one wins
    }

    // ---- ADAPTIVE RECOVERY (#2): for any field that FAILED, try slower/looser
    // logic. Only fills gaps (never overwrites a good parse), so confidence can
    // only rise — safe to run on every low-yield block. ----
    if (!abF) { const ab2 = recoverAbilities(text); if (ab2) { sb.abilities = ab2; abF = true; found++; } }
    if (!crF) { const cm = /\b(?:CR|Challenge(?:\s+Rating)?)\s*[:\-]?\s*([0-9]+(?:\/[0-9]+)?)\b/i.exec(text); if (cm) { sb.challenge_rating = cm[1]; crF = true; found++; } }
    if (!hpF) { const hm = /(\d+)\s*(?:hit points|hp)\b/i.exec(text); if (hm) { sb.hit_points = +hm[1]; hpF = true; found++; } }

    // ---- quality scoring: weighted confidence + human-readable warnings ----
    // Unlike a raw field count, this catches the failure modes that matter:
    // a block missing its actions, or with ability scores that never parsed.
    const warns = [];
    const hasName = sb.name && sb.name !== "Unknown Creature" && sb.name.trim().length > 1;
    const bodyCount = sb.actions.length + sb.traits.length + sb.reactions.length
                    + sb.bonus_actions.length + sb.legendary_actions.length;
    // CR < 1 creatures (0, 1/8, 1/4, 1/2) very often genuinely have no actions, so
    // missing actions alone shouldn't flag them. Other errors still count normally.
    const cr = (sb.challenge_rating || "").trim();
    const crLow = cr === "0" || cr === "1/8" || cr === "1/4" || cr === "1/2";
    const bodyOk = bodyCount > 0 || crLow;
    if (!hasName) warns.push("No name parsed");
    if (!acF)     warns.push("No armor class");
    if (!hpF)     warns.push("No hit points");
    if (!abF)     warns.push("Ability scores look unparsed");
    if (!crF)     warns.push("No challenge rating");
    if (!bodyCount && !crLow) warns.push("No actions or traits");
    const score = (hasName ? 0.12 : 0) + (acF ? 0.15 : 0) + (hpF ? 0.15 : 0)
                + (abF ? 0.20 : 0) + (crF ? 0.10 : 0) + (spdF ? 0.08 : 0)
                + (bodyOk ? 0.20 : 0);
    sb.parse_confidence = Math.round(score * 100) / 100;
    sb.parse_warnings = warns;
    return sb;
  }

  // ============================================================= page chrome strip
  const SIZE_WORDS = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan"]);
  // Never strip stat-block field lines as "page furniture" — identical field
  // lines legitimately repeat across creatures (every CR-2 monster prints the
  // same "CR 2 (XP 450; PB +2)"), so they must be protected from the chrome strip.
  const CHROME_PROTECT = ["armor class", "hit points", "speed", "saving throws", "skills", "senses", "languages", "challenge", "damage ", "condition ", "proficiency",
    "ac ", "hp ", "cr ", "initiative", "immunities", "resistances", "vulnerabilities", "gear "];
  function isStructuralLine(s) {
    if (RE_SECTION_LINE.test(s)) return true;
    const toks = s.toUpperCase().split(/\s+/);
    if (toks.filter(t => ["STR", "DEX", "CON", "INT", "WIS", "CHA"].includes(t)).length >= 3) return true;
    // A single 2024 ability row ("Str 16 +3 +3", "Dex 14 +2 +2"). These repeat
    // identically across creatures (Dex 14 is extremely common), so without this
    // they hit the chrome threshold and get stripped — wiping the ability scores
    // from every D&D Beyond / 2024-layout stat block.
    if (/^(?:str|dex|con|int|wis|cha)\b\s*\d/i.test(s.replace(/^[•▪◦·*\-\s]+/, ""))) return true;
    // de-bullet before matching: Fateforge prints fields as "• Armor Class 12",
    // and identical short field lines repeat across its many small creatures —
    // without this they get classified as page chrome and stripped (losing the
    // AC anchor, and with it the whole stat block)
    const low = s.toLowerCase().replace(/^[•▪◦·*\-\s]+/, "");
    const w0 = low.split(/\s+/)[0];
    if (SIZE_WORDS.has(w0)) return true;
    return CHROME_PROTECT.some(p => low.startsWith(p));
  }
  const RE_FURNITURE = /^(?:[A-Za-z]|\d{1,4}|[A-Za-z]\s+\d{1,4}|\d{1,4}\s+[A-Za-z])$/;
  const isFurniture = (s) => RE_FURNITURE.test(s.trim());
  // Some books (Drakkenheim) render section headers in a small-caps font that
  // pdf.js extracts as spaced/mixed-case single glyphs — "a c T ions",
  // "B onus a c T ions", "r E ac T ions". Left as-is they (a) don't match the
  // section regex, so a block's Actions look absent (it wrongly merges with the
  // next column and drops its tail — e.g. an apprentice's whole spell list), and
  // (b) recur across pages, so the chrome filter strips them as running headers.
  // Canonicalise any line whose letters-only, space-stripped, upper-cased form is
  // EXACTLY a section keyword back to the real header. The exact-match guard means
  // no ordinary content line is ever rewritten.
  const SECT_CANON = { ACTIONS: "Actions", ACTION: "Actions", BONUSACTIONS: "Bonus Actions",
    BONUSACTION: "Bonus Actions", REACTIONS: "Reactions", REACTION: "Reactions",
    LEGENDARYACTIONS: "Legendary Actions", LEGENDARYACTION: "Legendary Actions" };
  function canonSectionHeader(s) {
    const t = (s || "").trim();
    if (!t || t.length > 30 || !/^[A-Za-z][A-Za-z\s]*$/.test(t)) return s;   // letters + spaces only
    return SECT_CANON[t.replace(/\s+/g, "").toUpperCase()] || s;
  }
  function stripPageChrome(linePages) {
    const n = linePages.length;
    if (n < 4) return linePages;
    // Count repeats per (text, font) pair, not text alone: real running
    // headers/footers repeat in ONE font, while a creature's name legitimately
    // recurs across the book in DIFFERENT fonts (contents list, stat-block
    // title, lore heading, index) — Nerzugal's bestiary hit the threshold that
    // way and lost real names to the chrome filter.
    const key = (t, f) => t + "\u0000" + (f || "");
    const freq = {};
    for (const page of linePages) {
      const seen = new Set();
      for (const [t, f] of page) { const s = t.trim(); if (s) seen.add(key(s, f)); }
      for (const k of seen) freq[k] = (freq[k] || 0) + 1;
    }
    const threshold = Math.max(5, Math.floor(0.03 * n));
    const chrome = new Set();
    for (const k in freq) {
      const s = k.slice(0, k.indexOf("\u0000"));
      if (freq[k] >= threshold && s.length <= 30 && !".!?".includes(s[s.length - 1]) && !isStructuralLine(s)) chrome.add(k);
    }
    // SECOND PASS - numbered page footers / running headers ("47 Dao", "65 Efreet",
    // "Genies of the Earth 48"). The header word changes per section so it never
    // repeats enough for the freq pass; but the NUMBER is the printed page number,
    // so across the whole book (number - pageIndex) is a CONSTANT offset. Find
    // footer-shaped standalone lines, take the dominant offset, and strip lines that
    // match it. Real content ("16 Bludgeoning") has numbers scattered across pages,
    // so it forms no consistent offset and is left alone.
    const FOOT_LINE = /^\s*(\d{1,4})\s+[A-Z][A-Za-z'’ ]{0,26}$|^[A-Z][A-Za-z'’ ]{0,26}?\s+(\d{1,4})\s*$/;
    const footCand = [];
    linePages.forEach((page, pi) => {
      const pn = page._page || (pi + 1);
      for (const pair of page) {
        const s = (pair[0] || "").trim();
        const m = FOOT_LINE.exec(s);
        if (m && !isStructuralLine(s)) footCand.push({ off: (+(m[1] || m[2])) - pn, pair });
      }
    });
    const offCount = {};
    for (const c of footCand) offCount[c.off] = (offCount[c.off] || 0) + 1;
    let bestOff = null, bestN = 0;
    for (const o in offCount) if (offCount[o] > bestN) { bestN = offCount[o]; bestOff = +o; }
    const footerPairs = new Set();
    if (bestN >= 4) for (const c of footCand) if (c.off === bestOff) footerPairs.add(c.pair);
    return linePages.map(page => { const f = page.filter(pair => { const s = (pair[0] || "").trim(); return !chrome.has(key(s, pair[1])) && !isFurniture(s) && !footerPairs.has(pair); }); f._page = page._page; return f; });
  }

  // ============================================================ blocks from pages
  const RE_AC_PLAIN = /^\s*[•▪◦·*\-]?\s*(?:Armor Class|AC):?\s+\d/i;
  // NOTE: unlike the desktop parser, we do NOT font-filter blocks. pdf.js gives
  // much coarser font info than pdfplumber (it doesn't cluster a stat block's
  // body into one font), so a majority-font filter wrongly discards the ability
  // row and the whole actions section. The two-column split already isolates
  // each stat block from its lore, so a font-less split is both simpler and far
  // more reliable in the browser (ToB3: 12/406 with actions -> 405/406).
  const pageAllText = (page) => page.map(([t]) => t).join("\n");
  function preAcTextLines(lines) { const kept = []; for (const t of lines) { if (RE_AC_PLAIN.test(t)) break; kept.push(t); } return kept.join("\n"); }

  // A creature name stranded at the bottom of a column (its stat block starts in
  // the NEXT column). Detect a trailing title line with no AC after it so we can
  // carry it forward instead of losing the name / polluting the previous block.
  function orphanStart(lines) {
    // Scan the last few lines for a creature name that has no Armor Class after it
    // in this column (its stat block starts in the next column). The lead-in may
    // include flavour and a "Challenge N" line (Free5e prints it before the block),
    // so don't stop at stat-field lines — only stop at an actual stat block (AC).
    let found = -1;
    for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
      const s = (lines[i] || "").trim();
      if (!s) continue;
      if (RE_AC_LINE.test(s)) break;
      if (looksLikeTitle(s)) found = i;
    }
    return found;
  }
  const allTen = (ab) => ab.strength === 10 && ab.dexterity === 10 && ab.constitution === 10 && ab.intelligence === 10 && ab.wisdom === 10 && ab.charisma === 10;
  // A block that anchored on an "AC" but is not actually a creature:
  //  (a) no name, default AC + HP + abilities (an "AC" mentioned in rules prose), or
  //  (b) it has NO ability scores, NO hit points, NO challenge rating and NO
  //      actions/traits — i.e. only a stray AC (magic items like "Transmuter Stone",
  //      decorative sidebars). Real creatures always carry more than a lone AC.
  const isFalseAnchor = (sb) => {
    const noAbil = allTen(sb.abilities), noHp = sb.hit_points === 1, noCr = !sb.challenge_rating;
    // Every real creature has ability scores AND a hit-point/CR line; a thing that
    // anchored on an AC but has none of abilities, HP or CR is a magic item / rules
    // sidebar (e.g. "Transmuter Stone"), not a creature — even if stray text became
    // a "trait".
    if (noAbil && noHp && noCr) return true;
    return (!sb.name || sb.name === "Unknown Creature") && sb.armor_class === 10 && noHp && noAbil;
  };

  // Strip the Open Game License / legal boilerplate that trails many SRD-style PDFs.
  // Its definition list ("Open Game Content", "Product Identity", "Registered
  // Trademark"...) was being parsed as bogus stat blocks or absorbed into the last
  // creature's actions. Cut the line stream at the first license header.
  const RE_OGL = /^\s*open\s*game\s*license\b|^\s*designation\s+of\s+(?:product\s+identity|open\s+game\s+content)\b/i;
  function cutAtLicense(linePages) {
    for (let i = 0; i < linePages.length; i++) {
      const col = linePages[i];
      for (let j = 0; j < col.length; j++) {
        if (RE_OGL.test(col[j][0] || "")) {
          const head = col.slice(0, j); head._page = col._page;
          return linePages.slice(0, i).concat(head.length ? [head] : []);
        }
      }
    }
    return linePages;
  }

  function blocksFromPages(linePages, source, ocr) {
    // canonicalise spaced small-caps section headers ("a c T ions" -> "Actions")
    // BEFORE chrome-stripping, so the header is protected and its section parses
    linePages = linePages.map(page => { const f = page.map(([t, ft]) => [canonSectionHeader(t), ft]); f._page = page._page; return f; });
    linePages = cutAtLicense(stripPageChrome(linePages));
    const results = [];
    let pending = null, carry = [];
    const push = (sb) => { if (sb && !isFalseAnchor(sb)) results.push(sb); };
    const flush = () => { if (pending !== null) { try { push(parseText(pending.body, pending.page, source, ocr)); } catch (e) {} pending = null; } };
    let carryF = [];
    for (let i = 0; i < linePages.length; i++) {
      const pageNo = linePages[i]._page || (i + 1);   // true PDF page (for review screenshots)
      let lines = carry.concat(linePages[i].map(([t]) => t));
      let lfonts = carryF.concat(linePages[i].map(([, f]) => f || ""));
      carry = []; carryF = [];
      // peel a stranded trailing name off this column to prepend to the next one
      const oi = orphanStart(lines);
      if (oi >= 0) { carry = lines.slice(oi); carryF = lfonts.slice(oi); lines = lines.slice(0, oi); lfonts = lfonts.slice(0, oi); }
      const pageText = lines.join("\n");
      const blocks = splitIntoBlocks(pageText, null, lfonts);   // body stays font-less; fonts only inform the title scan
      if (!blocks.length) {
        if (pending !== null && pageText.trim()) pending.body += "\n" + pageText;
        continue;
      }
      if (pending !== null) { const pre = preAcTextLines(lines); if (pre.trim()) pending.body += "\n" + pre; flush(); }
      for (let j = 0; j < blocks.length; j++) {
        const isLast = j === blocks.length - 1;
        if (isLast && (!hasActionsSection(blocks[j]) || actionsTruncated(blocks[j]))) pending = { body: blocks[j], page: pageNo };
        else { try { push(parseText(blocks[j], pageNo, source, ocr)); } catch (e) {} }
      }
    }
    flush();
    return results;
  }

  // ============================================================ variant synthesis
  // Homebrew families (e.g. GM Binder golems) print one BASE stat block plus a set
  // of "variant" blocks that are DELTAS — a title + a few field changes ("Armor
  // Class Increases by 3", added resistances) + extra traits/actions, with no AC,
  // HP or ability scores of their own. We combine each delta onto the Standard
  // base to emit a ready-to-run "Standard X (Variant)" stat block.
  const RE_DELTA = /\b(Armor Class|Challenge Rating|Hit Points|Speed)\s+(Increases|Decreases)\s+by\s+(\d+)/i;
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cloneSb = (sb) => JSON.parse(JSON.stringify(sb));
  function bumpCR(cr, delta) {
    if (cr == null) return cr;
    const m = /^(\d+)/.exec(String(cr).trim());
    return m ? String(Math.max(0, parseInt(m[1], 10) + delta)) : cr;
  }

  function parseVariantRegion(region, family) {
    const lines = region.map(dedupeLine).map(l => l.replace(/\s+$/, "")).filter(l => l.trim());
    if (lines.length < 2) return null;
    const famTail = new RegExp("\\s*\\b" + reEsc(family) + "\\b\\s*$", "i");
    const qualifier = lines[0].trim().replace(famTail, "").trim() || lines[0].trim();
    const text = cleanExtractedText(lines.slice(1).join("\n"));
    const v = { qualifier, acDelta: 0, crDelta: 0, hpDelta: 0, resist: [], immun: [], vuln: [],
                condImmun: [], traits: [], actions: [], bonus_actions: [], reactions: [], replaces: [] };
    let dm; const reD = new RegExp(RE_DELTA.source, "gi");
    while ((dm = reD.exec(text))) {
      const n = (/increase/i.test(dm[2]) ? 1 : -1) * parseInt(dm[3], 10), f = dm[1].toLowerCase();
      if (f === "armor class") v.acDelta += n; else if (f === "challenge rating") v.crDelta += n; else if (f === "hit points") v.hpDelta += n;
    }
    let gm; const reDmg = new RegExp(RE_DMG.source, "gi");
    while ((gm = reDmg.exec(text))) { const lst = parseList(gm[2]), k = gm[1].toLowerCase();
      if (k === "resistances") v.resist.push(...lst); else if (k === "immunities") v.immun.push(...lst); else if (k === "vulnerabilities") v.vuln.push(...lst); }
    const cmi = RE_COND.exec(text); if (cmi) v.condImmun.push(...parseList(cmi[1]));
    // strip the field-delta / defense lines before parsing traits, so they don't
    // bleed into the first trait's name ("Damage Resistances Necrotic Fire Powered")
    const bodyText = cleanExtractedText(lines.slice(1).filter(l => {
      const s = l.trim();
      return !RE_DELTA.test(s) && !/^Damage (Vulnerabilities|Resistances|Immunities)\b/i.test(s)
        && !/^Condition Immunities\b/i.test(s) && !/^(Armor Class|Hit Points|Speed|Challenge Rating)\b/i.test(s);
    }).join("\n"));
    const { traitsText, sections } = splitSections(bodyText);
    v.traits = parseEntries(traitsText, "trait");
    v.actions = parseEntries(sections["action"] || "", "action");
    v.bonus_actions = parseEntries(sections["bonus_action"] || "", "bonus_action");
    v.reactions = parseEntries(sections["reaction"] || "", "reaction");
    for (const a of v.actions.concat(v.bonus_actions, v.reactions)) if (a.replaces) v.replaces.push(a.replaces.toLowerCase());
    // require STRUCTURED delta content (so flavour prose with the same heading is ignored)
    const structured = v.acDelta || v.crDelta || v.hpDelta || v.resist.length || v.immun.length
      || v.condImmun.length || v.actions.length || v.bonus_actions.length || v.reactions.length;
    return structured ? v : null;
  }

  function cloneBaseWithVariant(base, v, source) {
    const sb = cloneSb(base);
    sb.name = base.name + " (" + v.qualifier + ")";
    sb.armor_class = Math.max(0, (sb.armor_class || 10) + v.acDelta);
    if (v.hpDelta) sb.hit_points = Math.max(1, (sb.hit_points || 1) + v.hpDelta);
    if (v.crDelta) sb.challenge_rating = bumpCR(sb.challenge_rating, v.crDelta);
    const merge = (a, b) => Array.from(new Set([...(a || []), ...b]));
    sb.damage_resistances = merge(sb.damage_resistances, v.resist);
    sb.damage_immunities = merge(sb.damage_immunities, v.immun);
    sb.damage_vulnerabilities = merge(sb.damage_vulnerabilities, v.vuln);
    sb.condition_immunities = merge(sb.condition_immunities, v.condImmun);
    sb.traits = (sb.traits || []).concat(v.traits);
    if (v.replaces.length) sb.actions = (sb.actions || []).filter(a => !v.replaces.includes((a.name || "").trim().toLowerCase()));
    sb.actions = (sb.actions || []).concat(v.actions);
    sb.bonus_actions = (sb.bonus_actions || []).concat(v.bonus_actions);
    sb.reactions = (sb.reactions || []).concat(v.reactions);
    sb.is_variant = true; sb.variant_of = base.name; sb.source = source || base.source;
    sb.raw_text = null; sb.parse_confidence = 0.95; sb.parse_warnings = [];
    return sb;
  }

  // size/tier words that distinguish base stat blocks of ONE creature (e.g. golems:
  // Small/Medium/Standard Golem, Golem Colossus). Variants apply to every tier base.
  const TIER_WORDS = new Set(["tiny", "small", "medium", "large", "huge", "gargantuan",
    "standard", "colossus", "greater", "lesser", "elder", "young", "adult", "ancient"]);

  function synthesizeVariants(linePages, baseBlocks, source) {
    if (!baseBlocks.length) return [];
    // family = the word shared by >=2 base names (anywhere in the name, so
    // "Golem Colossus" counts toward the "golem" family too)
    const wordFreq = {};
    for (const b of baseBlocks) for (const w of (b.name || "").toLowerCase().split(/\s+/)) if (/^[a-z]/.test(w) && !TIER_WORDS.has(w)) wordFreq[w] = (wordFreq[w] || 0) + 1;
    let family = null, fc = 1;
    for (const k in wordFreq) if (wordFreq[k] > fc) { fc = wordFreq[k]; family = k; }
    if (!family) return [];
    // bases to combine onto = family members distinguished ONLY by tier words
    // (Small/Medium/Standard Golem, Golem Colossus). Avoids blanket-applying a
    // variant to a family of DISTINCT creatures (e.g. the named clockworks).
    const familyBases = baseBlocks.filter(b => {
      const words = (b.name || "").toLowerCase().split(/\s+/);
      if (!words.includes(family)) return false;
      return words.every(w => w === family || TIER_WORDS.has(w));
    });
    if (!familyBases.length) return [];
    const baseNames = new Set(baseBlocks.map(b => (b.name || "").trim().toLowerCase()));
    const lines = [];
    for (const page of linePages) for (const [t] of page) lines.push(t);
    const famEnd = new RegExp("\\b" + reEsc(family) + "$", "i");
    const idx = [];
    for (let i = 0; i < lines.length; i++) {
      const s = dedupeLine(lines[i] || "").trim();
      if (!s || !famEnd.test(s) || !looksLikeTitle(s) || baseNames.has(s.toLowerCase())) continue;
      let acNear = false; for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) if (RE_AC_LINE.test(lines[j])) { acNear = true; break; }
      if (!acNear) idx.push(i);
    }
    // collect each unique variant delta, then combine with EVERY tier base
    const seenQual = new Set(), deltas = [];
    for (let k = 0; k < idx.length; k++) {
      let end = Math.min(k + 1 < idx.length ? idx[k + 1] : lines.length, idx[k] + 45);
      for (let j = idx[k] + 1; j < end; j++) if (RE_AC_LINE.test(lines[j])) { end = j; break; }   // stop at next base block
      const v = parseVariantRegion(lines.slice(idx[k], end), family);
      if (!v) continue;
      const q = v.qualifier.toLowerCase();
      if (q && !seenQual.has(q)) { seenQual.add(q); deltas.push(v); }
    }
    const out = [];
    for (const v of deltas) for (const base of familyBases) out.push(cloneBaseWithVariant(base, v, source));
    return out;
  }

  // ================================================================ public: import
  let _abort = false;   // set by the Cancel button; checked between pages + inserts

  // a stat block's identity for de-duplication: same name + AC + HP + CR means
  // it is the same creature, so re-importing a PDF won't add it twice
  const fingerprint = (b) => `${(b.name || "").trim().toLowerCase()}|${b.armor_class}|${b.hit_points}|${b.challenge_rating}`;

  // de-dupe + insert a parsed set of blocks; capture review screenshots. Shared by
  // the text path and the OCR fallback. Returns { added, dup, flagged }.
  async function persistBlocks(file, blocks) {
    let existing = [];
    try { existing = await (await fetch("/api/statblocks")).json(); } catch (e) {}
    const seen = new Set((existing || []).map(fingerprint));
    let added = 0, dup = 0, flagged = 0; const flaggedShots = [];
    for (const sb of blocks) {
      if (_abort) return { added, dup, flagged, aborted: true };
      const f = fingerprint(sb);
      if (seen.has(f)) { dup++; continue; }
      seen.add(f);
      sb.id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "sb-" + Date.now() + "-" + added;
      try {
        await fetch("/api/statblocks/" + sb.id, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(sb) });
        added++; if (sb.parse_confidence < 0.85) { flagged++; flaggedShots.push({ id: sb.id, page: sb.source_page }); }
      } catch (e) {}
    }
    // LOCAL-ONLY review screenshots for the flagged blocks. Fire-and-forget so a
    // slow/blocked render can NEVER delay or hang the import itself.
    captureReviewShots(file, flaggedShots).catch(() => {});
    return { added, dup, flagged };
  }

  // parse + insert ONE file via the normal TEXT path. Returns a summary; flags
  // needsOcr when there's no readable text layer or no stat blocks were found, so
  // the caller can offer the (slower) OCR fallback.
  // Some PDFs carry a BROKEN text layer: a bad font encoding sprinkles spaces
  // inside words ("Hi t Points", "C hallenge", "(+ O)"), so the text is present
  // but unparseable. Signature: a high fraction of one-letter "words". A clean
  // book sits near 0.05; a scrambled one (Jimothy Timothy) is far higher. We only
  // ACT on this when parsing also largely failed, so a book that merely space-
  // splits its labels (Conflux) but still parses is never misrouted to OCR.
  function scrambleScore(pages) {
    let single = 0, total = 0;
    for (const pg of pages) for (const [t] of pg) {
      for (const tok of String(t).split(/\s+/)) {
        if (!/[A-Za-z]/.test(tok)) continue;
        total++;
        if (tok.replace(/[^A-Za-z]/g, "").length === 1) single++;
      }
    }
    return total ? single / total : 0;
  }

  // A creature name that reads as gibberish — the signature of a broken display font
  // (Monster Manual 2024: "AeoLerH", "Vluprne FaullllR", "Srn"). A name is garbled
  // when at least half its words are implausible: an internal lower->UPPER transition
  // ("AeoLerH"), no vowel at all ("Srn"), or a run of 5+ consonants. Real names —
  // including Conflux run-ons ("Assassincutthroat") and hyphenates — stay near zero.
  function garbledName(nm) {
    const words = String(nm || "").split(/\s+/).filter(w => /[A-Za-z]/.test(w));
    if (!words.length) return true;
    let bad = 0;
    for (const w of words) {
      const c = w.replace(/[^A-Za-z]/g, "");
      if (c.length < 2 || /[a-z][A-Z]/.test(c) || !/[aeiouAEIOU]/.test(c) || /[^aeiouAEIOU]{5,}/i.test(c)) bad++;
    }
    return bad / words.length >= 0.5;
  }

  async function importOneFile(file, onProgress) {
    if (!/\.pdf$/i.test(file.name)) return { ok: false, name: file.name, error: "Not a PDF file." };
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { return { ok: false, name: file.name, error: "Couldn't read the file." }; }
    let pages;
    try { pages = await extractColumnLinePages(buf, onProgress); }
    catch (e) { if (String(e && e.message).includes("__abort__")) return { ok: false, name: file.name, aborted: true }; return { ok: false, name: file.name, error: "Couldn't parse the PDF." }; }
    const totalChars = pages.reduce((a, pg) => a + pg.reduce((b, [t]) => b + t.length, 0), 0);
    if (!pages.length || totalChars < 40 * pages.length)
      return { ok: false, name: file.name, error: "No readable text layer; the stat blocks look image-based.", needsOcr: true };
    let blocks;
    try { blocks = blocksFromPages(pages, file.name); } catch (e) { return { ok: false, name: file.name, error: "Parse error." }; }
    // delta-style variants (base + "Increases by"/added abilities) -> "Standard X (Variant)"
    try { const vb = synthesizeVariants(pages, blocks, file.name); if (vb.length) blocks = blocks.concat(vb); } catch (e) {}
    if (!blocks.length) return { ok: false, name: file.name, error: "No stat blocks found in the text.", needsOcr: true };
    // BROKEN TEXT LAYER -> offer OCR. A bad font encoding (Jimothy Timothy) leaves a
    // readable-looking but unparseable text layer: only a block or two come out and
    // they are mostly flagged. We require ALL of: very few blocks (<=3, so big books
    // are never discarded), most of them flagged, AND elevated scramble — together a
    // reliable "this text is garbage, try OCR" signal that the Conflux books (which
    // space-split labels yet parse dozens of clean blocks) never trip.
    if (blocks.length <= 3 && scrambleScore(pages) > 0.10) {
      const flagged = blocks.filter(b => (b.parse_confidence || 0) < 0.85).length;
      if (flagged / blocks.length >= 0.5)
        return { ok: false, name: file.name, error: "The text layer looks scrambled (a broken font); the stat blocks are unreadable as text.", needsOcr: true };
    }
    // BROKEN FONT ENCODING AT SCALE (Monster Manual 2024). A subsetted display/label
    // font extracts as garbage Unicode, so hundreds of "blocks" form but their name,
    // ability scores, HP and CR are all lost ("AeoLerH", "Srn/Cott/lNr", "HP ls0",
    // "CR l0") even though the body prose survives. A statless, gibberish-named block
    // is unusable, so route the book to OCR (which reads the visually-correct glyphs)
    // rather than importing a wall of junk. Gate on nearly ALL blocks being both
    // low-confidence AND missing their core numbers — healthy books sit far below
    // (flagged <5%, HP/CR populated), so a good import can never trip this.
    if (blocks.length >= 8) {
      const flagged = blocks.filter(b => (b.parse_confidence || 0) < 0.85).length;
      const garbled = blocks.filter(b => garbledName(b.name)).length;
      if (flagged / blocks.length >= 0.9 && garbled / blocks.length >= 0.2)
        return { ok: false, name: file.name, error: "The text layer is scrambled (a broken embedded font); names and stats can't be read as text.", needsOcr: true };
    }
    const r = await persistBlocks(file, blocks);
    if (r.aborted) return { ok: false, name: file.name, aborted: true, added: r.added, dup: r.dup, flagged: r.flagged };
    return { ok: true, name: file.name, parsed: blocks.length, added: r.added, dup: r.dup, flagged: r.flagged };
  }

  // ============================================================ OCR FALLBACK
  // FREE, fully client-side OCR (Tesseract.js, WASM) for PDFs whose stat blocks
  // are images or use a broken font encoding (so the text layer is unreadable).
  // Only ever runs when the normal text path finds nothing, so it can't affect
  // books that already import. Tesseract loads from a CDN on first use and is
  // cached by the browser thereafter — no bundling, no server, no cost.
  let _tessPromise = null;
  function loadTesseract() {
    if (window.Tesseract) return Promise.resolve(window.Tesseract);
    if (_tessPromise) return _tessPromise;
    _tessPromise = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.onload = () => res(window.Tesseract);
      s.onerror = () => { _tessPromise = null; rej(new Error("OCR engine failed to load (no connection?)")); };
      document.head.appendChild(s);
    });
    return _tessPromise;
  }

  // Render each page, OCR it to words+boxes, then reuse the SAME column/line/block
  // pipeline as the text path (so all the existing parsing logic applies).
  async function extractOcrLinePages(arrayBuffer, progress) {
    _bookColMode = "mixed";   // OCR boxes are noisier; don't force a column mode
    const Tesseract = await loadTesseract();
    const pdfjsLib = window.pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const worker = await Tesseract.createWorker("eng");
    const pages = [];
    try {
      for (let p = 1; p <= pdf.numPages; p++) {
        if (_abort) throw new Error("__abort__");
        const page = await pdf.getPage(p);
        const v1 = page.getViewport({ scale: 1 });
        const scale = Math.min(4, Math.max(2.5, 2400 / v1.width));   // ~300 dpi: far cleaner OCR
        const vp = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height);   // flatten transparency to white
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        // Preprocess: grayscale + contrast stretch so coloured / low-contrast art
        // (textured stat-block backgrounds) reads much cleaner.
        try {
          const im = ctx.getImageData(0, 0, canvas.width, canvas.height), d = im.data;
          for (let k = 0; k < d.length; k += 4) {
            let g = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
            g = (g - 128) * 1.4 + 128;          // boost contrast around mid-grey
            g = g < 0 ? 0 : g > 255 ? 255 : g;
            d[k] = d[k + 1] = d[k + 2] = g;
          }
          ctx.putImageData(im, 0, 0);
        } catch (e) { /* tainted/oversized canvas: OCR the raw render instead */ }
        let data = {};
        try { data = (await worker.recognize(canvas, {}, { blocks: true })).data || {}; } catch (e) { data = {}; }
        // Prefer word-level boxes; fall back to line-level if words are absent.
        let items = (data.words && data.words.length) ? data.words
                  : [].concat(...((data.lines || []).map(l => l.words || [l])));
        const words = [];
        for (const w of items) {
          const t = (w.text || "").trim(); if (!t) continue;
          const b = w.bbox || w; if (b.x0 == null) continue;
          words.push({ text: t, x0: b.x0 / scale, x1: b.x1 / scale, top: b.y0 / scale, font: "ocr#10", fontId: "ocr", bold: false });
        }
        for (const col of pageColumns(words, vp.width / scale)) { col._page = p; pages.push(col); }
        page.cleanup && page.cleanup();
        if (progress) progress(p, pdf.numPages);
      }
    } finally { try { await worker.terminate(); } catch (e) {} pdf.destroy && pdf.destroy(); }
    return pages;
  }

  async function ocrOneFile(file, onProgress) {
    let buf;
    try { buf = await file.arrayBuffer(); } catch (e) { return { ok: false, name: file.name, error: "Couldn't read the file." }; }
    let pages;
    try { pages = await extractOcrLinePages(buf, onProgress); }
    catch (e) { if (String(e && e.message).includes("__abort__")) return { ok: false, name: file.name, aborted: true }; return { ok: false, name: file.name, error: "OCR failed: " + (e && e.message || e) }; }
    let blocks;
    try { blocks = blocksFromPages(pages, file.name, true); } catch (e) { return { ok: false, name: file.name, error: "Parse error after OCR." }; }
    try { const vb = synthesizeVariants(pages, blocks, file.name); if (vb.length) blocks = blocks.concat(vb); } catch (e) {}
    if (!blocks.length) return { ok: false, name: file.name, error: "OCR found no stat blocks." };
    // OCR is imperfect: force every OCR'd block into the review queue (so it gets a
    // screenshot and a human check) and tag its provenance.
    blocks.forEach(b => { b.ocr = true; b.parse_confidence = Math.min(b.parse_confidence || 0, 0.8); (b.parse_warnings = b.parse_warnings || []).push("Imported via OCR. Please verify every field against the screenshot."); });
    const r = await persistBlocks(file, blocks);
    if (r.aborted) return { ok: false, name: file.name, aborted: true, added: r.added, dup: r.dup, flagged: r.flagged };
    return { ok: true, name: file.name, parsed: blocks.length, added: r.added, dup: r.dup, flagged: r.flagged, ocr: true };
  }

  // import one OR MANY PDFs in sequence, with shared progress + a combined result
  async function sfImportPdfs(files) {
    const prog = document.getElementById("importprogress");
    const empty = document.getElementById("emptylabel");
    const showProg = (html) => { if (prog) { prog.innerHTML = html || ""; prog.classList.toggle("show", !!html); } };
    let emptyWasShown = false;
    const hideEmpty = () => { if (empty && getComputedStyle(empty).display !== "none") { emptyWasShown = true; empty.style.display = "none"; } };
    const showEmpty = () => { if (empty && emptyWasShown) { empty.style.display = "flex"; emptyWasShown = false;
      if (empty.animate) try { empty.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 450, easing: "ease" }); } catch (e) {} } };

    const list = Array.from(files || []).filter(Boolean);
    if (!list.length) return;
    if (!window.pdfjsLib) { hideEmpty(); showProg("PDF engine failed to load."); setTimeout(() => { showProg(""); showEmpty(); }, 4000); return; }
    const pdfs = list.filter(f => /\.pdf$/i.test(f.name));
    if (!pdfs.length) { hideEmpty(); showProg("Please choose PDF files."); setTimeout(() => { showProg(""); showEmpty(); }, 4000); return; }

    hideEmpty();
    _abort = false;   // fresh run
    const cancelBtn = '<div style="margin-top:10px"><button class="btn" onclick="sfCancelImport()">Cancel</button></div>';
    let totAdded = 0, totDup = 0, totFlagged = 0, aborted = false; const errors = []; const ocrCandidates = [];
    for (let i = 0; i < pdfs.length; i++) {
      const file = pdfs[i];
      if (window.sfBetaUploadPdf) window.sfBetaUploadPdf(file);   // BETA-only: send the PDF to the dev (best-effort)
      const head = (pdfs.length > 1 ? "Importing " + (i + 1) + " of " + pdfs.length + ": " : "Importing ") + escapeHtml(file.name);
      showProg(head + "…" + cancelBtn);
      const res = await importOneFile(file, (cur, total) => {
        const pct = total ? Math.round((100 * cur) / total) : 0;
        showProg(head + "<br>" + cur + "/" + total + " pages complete" +
          '<div class="pbar"><div style="width:' + pct + '%"></div></div>' + cancelBtn);
      });
      if (res.aborted) { totAdded += res.added || 0; totDup += res.dup || 0; totFlagged += res.flagged || 0; aborted = true; break; }
      if (!res.ok) { if (res.needsOcr) ocrCandidates.push(file); else errors.push(escapeHtml(res.name) + ": " + escapeHtml(res.error)); continue; }
      totAdded += res.added; totDup += res.dup; totFlagged += res.flagged;
    }
    if (typeof window.loadLibrary === "function") window.loadLibrary();

    // combined result message
    const dupNote = totDup ? " " + totDup + " already in your compendium." : "";
    let result;
    if (aborted) {
      result = "<b>Import cancelled.</b>" + (totAdded ? "<br><i>" + totAdded + " " + (totAdded === 1 ? "monster" : "monsters") + " kept.</i>" : "");
    } else if (totAdded > 0) {
      const from = pdfs.length > 1 ? " from " + pdfs.length + " PDFs" : "";
      const review = totFlagged ? totFlagged + (totFlagged === 1 ? " needs" : " need") + " review." : "All parsed cleanly.";
      result = "<b>Imported " + totAdded + " " + (totAdded === 1 ? "monster" : "monsters") + from + ":</b><br><i>" + review + dupNote + "</i>";
    } else if (totDup > 0) {
      result = "<b>These monsters have already been imported.</b>";
    } else if (errors.length) {
      result = "<b>Import failed:</b><br><i>" + errors.join("<br>") + "</i>";
    } else {
      result = "<b>No stat blocks found in " + (pdfs.length > 1 ? "these PDFs." : "this PDF.") + "</b>";
    }
    if (errors.length && totAdded > 0) result += "<br><i>" + errors.join("<br>") + "</i>";
    // Offer the OCR fallback for files with no readable text / no stat blocks.
    if (!aborted && ocrCandidates.length) {
      _ocrFiles = ocrCandidates;
      const n = ocrCandidates.length;
      result += '<div style="margin-top:10px"><i>' + n + (n === 1 ? " PDF has" : " PDFs have") +
        ' image-based or unreadable stat blocks.</i><br>' +
        '<button class="btn" style="margin-top:6px" onclick="sfRunOcr()">Read images with OCR (slower, free)</button> ' +
        '<button class="btn" onclick="sfDismissImport()">Dismiss</button></div>';
      showProg(result);
      return;   // keep the offer on screen until the user acts
    }
    showProg(result);
    setTimeout(() => { showProg(""); showEmpty(); }, 4500);
  }

  // Run the OCR fallback on the files the text path couldn't read (user-initiated).
  let _ocrFiles = null;
  async function runOcrImport() {
    const files = _ocrFiles || []; if (!files.length) return;
    _ocrFiles = null;
    const prog = document.getElementById("importprogress");
    const showProg = (html) => { if (prog) { prog.innerHTML = html || ""; prog.classList.toggle("show", !!html); } };
    _abort = false;
    const cancelBtn = '<div style="margin-top:10px"><button class="btn" onclick="sfCancelImport()">Cancel</button></div>';
    let totAdded = 0, totFlagged = 0, aborted = false; const errors = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const head = (files.length > 1 ? "Reading " + (i + 1) + " of " + files.length + ": " : "Reading ") + escapeHtml(file.name) + " with OCR";
      showProg(head + "<br><i>This is much slower than text import.</i>" + cancelBtn);
      const res = await ocrOneFile(file, (cur, total) => {
        const pct = total ? Math.round((100 * cur) / total) : 0;
        showProg(head + "<br>" + cur + "/" + total + " pages read" +
          '<div class="pbar"><div style="width:' + pct + '%"></div></div>' + cancelBtn);
      });
      if (res.aborted) { totAdded += res.added || 0; aborted = true; break; }
      if (!res.ok) { errors.push(escapeHtml(res.name) + ": " + escapeHtml(res.error)); continue; }
      totAdded += res.added; totFlagged += res.flagged;
    }
    if (typeof window.loadLibrary === "function") window.loadLibrary();
    let result;
    if (aborted) result = "<b>OCR cancelled.</b>" + (totAdded ? "<br><i>" + totAdded + " kept.</i>" : "");
    else if (totAdded > 0) result = "<b>OCR imported " + totAdded + " " + (totAdded === 1 ? "monster" : "monsters") + ":</b><br><i>" +
        (totFlagged ? totFlagged + " in the review queue; check each against its screenshot." : "Review recommended.") + "</i>";
    else result = "<b>OCR couldn't find stat blocks.</b>" + (errors.length ? "<br><i>" + errors.join("<br>") + "</i>" : "");
    showProg(result);
    setTimeout(() => { showProg(""); }, 6000);
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }

  // single-file entry point kept for compatibility (delegates to the batch path)
  window.sfImportPdf = (file) => sfImportPdfs(file ? [file] : []);
  window.sfImportPdfs = sfImportPdfs;
  window.sfCancelImport = () => { _abort = true; };
  window.sfRunOcr = runOcrImport;
  window.sfDismissImport = () => { _ocrFiles = null; const p = document.getElementById("importprogress"); if (p) { p.innerHTML = ""; p.classList.remove("show"); } };
})();
