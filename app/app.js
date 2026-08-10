/*!
  WARC Explorer (v0.8.4)
  ----------------------------------------------------------------
  A tiny client-side web application for exploring WARC files in a
  browser. No uploading, no installation, no command-line. Just
  open "index.html" in your browser and explore your WARC files.
  
  The app is inspired by Warchaeology's console
  (https://github.com/NationalLibraryOfNorway/warchaeology).
  Parsing of WARC is done with a bundled version of Webrecorder's
  warcio.js (https://github.com/webrecorder/warcio.js). 
  
  If you want to ensure that all WARC content is kept safe,
  just download the source files and open "index.html" in your
  browser on an offline computer.
  
  For testing, WARC Explorer can also be loaded from
  https://webdata.nb.no/warc-explorer). All data processing will
  still happen locally, with no data leaving your machine.

  Design notes:

  1. Loading WARC files and records happens in two passes:

      Pass 1 (indexWarcFile):
      Streaming through the whole file, reading each record's WARC
      header. Then, calling record.skipFully() to discard the
      payload without decoding it. This extracts each record's type,
      WARC-Target-URI, WARC-Record-ID (for listing, filtering and
      searching) and its raw byte offset + length.

      Pass 2 (loadRecordDetail):
      When the user clicks a record, the file is "re-sliced" at
      that exact byte range [offset, offset+length) with File.slice()
      and then handed to warcio's WARCParser that decodes the payload.

    To ensure a lightweight client for quick exploration of WARC-files,
    very little information is kept in memory. For searching across
    huge WARC collections or looking at content at scale, we recommend
    using a more advanced system, such as SolrWayback
    (https://github.com/netarchivesuite/solrwayback/releases).

  2. Filtering and searching are pure view-layer operations over the
     `state.records` array in memory. `state.visible` holds the
     currently-matching subset and the list renders from
     `state.visible`. A record's `index` (represented as "[n]" in the
     record list) is not affected by filtration and refers to its
     position in the WARC file.

  3. "Open in new tab" allows for visual representation of the resource.
     It takes the payload bytes + Content-Type already fetched in pass 2,
     so that the click handler can call window.open() synchronously.

      A small allow-list of genuinely inert content types
      (images other than SVG, audio, video, PDF, plain text, CSS,
      JSON) opens as its real media type.
  
      SVG is wrapped in a plain <img> document.
      HTML is wrapped in an <iframe> that should block outgoing network
      requests.
      Everything else should fall back to plain text.
 */

(function () {
  "use strict";

  // ---------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------
  const els = {
    fileTree: document.getElementById("fileTree"),
    btnChooseFolder: document.getElementById("btnChooseFolder"),
    btnChooseFiles: document.getElementById("btnChooseFiles"),
    folderInput: document.getElementById("folderInput"),
    filesInput: document.getElementById("filesInput"),
    currentFileLabel: document.getElementById("currentFileLabel"),
    searchInput: document.getElementById("searchInput"),
    typeChips: document.getElementById("typeChips"),
    recordsCountInline: document.getElementById("recordsCountInline"),
    recordViewport: document.getElementById("recordViewport"),
    recordSpacer: document.getElementById("recordSpacer"),
    headerView: document.getElementById("headerView"),
    httpHeaderView: document.getElementById("httpHeaderView"),
    payloadView: document.getElementById("payloadView"),
    payloadMeta: document.getElementById("payloadMeta"),
    btnOpenNewTab: document.getElementById("btnOpenNewTab"),
    statusLeft: document.getElementById("statusLeft"),
    statusRight: document.getElementById("statusRight"),
    paneFiles: document.getElementById("pane-files"),
    paneRecords: document.getElementById("pane-records"),
    resizer1: document.getElementById("resizer1"),
    resizer2: document.getElementById("resizer2"),
    resizer3: document.getElementById("resizer3"),
    resizer4: document.getElementById("resizer4"),
    detailsTop: document.querySelector(".details-top"),
    detailsMiddle: document.querySelector(".details-middle"),
  };

  const ROW_HEIGHT = 22;
  const MAX_PAYLOAD_CHARS = 50000;
  const BINARY_SAMPLE_SIZE = 4000;
  const HEX_DUMP_BYTES = 2000;
  const SEARCH_DEBOUNCE_MS = 150;
  const URI_LABEL_MAX = 90;
  const TREE_LABEL_MAX = 40;

  // Explanations for users not familiar with WARC terminology,
  // shown as a hovering tip when mouse-pointer is moved over
  // a filter option.
  const TYPE_DESCRIPTIONS = {
    warcinfo: "Information about the capture process itself (software, WARC format version, etc).",
    request: "Requests are messages sent from the archiving crawler to a web server.",
    response: "Responses are messages (often content resources) received from a web server, in respons to a request.",
    resource: "A resource does not have full protocol response information and can hold e.g. references, fulltext or screenshots from harvesting, etc.",
    metadata: "Describes or explains other records with metadata, often with respect to how and why something has been archived.",
    revisit: "Declare content as identical to an earlier record, avoiding to store duplicates.",
    conversion: "Content that was converted from another format during processing.",
    continuation: "Continues a large payload that has been split across multiple records.",
    unknown: "Record type was missing or not recognized when written.",
  };

  const state = {
    treeRoot: { name: "", type: "dir", children: new Map(), open: true },
    currentFile: null,
    currentFileName: "",
    records: [], // full index for the current file (pass 1 results)
    visible: [], // visible subset of records based on filtration and search
    typesPresent: [], // WARC-Type values found in this file
    activeTypes: new Set(), // which typesPresent are shown
    searchQuery: "", // raw input value
    appliedSearchQuery: "", // lower-cased value applied for search
    selectedFileNode: null,
    selectedIndex: -1, // record index/position number
    selectedVisiblePos: -1, // position within `visible` list (for highlighting/scrolling)
    currentPayloadBytes: null,
    currentPayloadType: null,
  };

  let searchDebounceTimer = null;

  // ---------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------
  function isWarcName(name) {
    const lower = name.toLowerCase();
    return lower.endsWith(".warc") || lower.endsWith(".warc.gz");
  }

  function setStatus(left, busy) {
    els.statusLeft.innerHTML = (busy ? '<span class="spinner"></span>' : "") + escapeHtml(left);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Truncates from middle rather than the end, so the part that
  // usually differentiates two similar strings (filename, file
  // extension or hashes in WARC-Target-URIs) survives instead
  // of being cut off.
  function truncateMiddle(str, maxLen) {
    if (!str || str.length <= maxLen) return str;
    const keepEnd = Math.ceil(maxLen * 0.6);
    const keepStart = Math.max(0, maxLen - keepEnd - 1);
    return str.slice(0, keepStart) + "…" + str.slice(str.length - keepEnd);
  }

  function yieldToUI() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  // ---------------------------------------------------------------
  // File tree model & rendering
  // ---------------------------------------------------------------
  function addFileToTree(file, relPath) {
    const parts = relPath.split("/").filter(Boolean);
    let node = state.treeRoot;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.children.has(part)) {
        node.children.set(part, { name: part, type: "dir", children: new Map(), open: true });
      }
      node = node.children.get(part);
    }
    const fname = parts[parts.length - 1];
    node.children.set(fname, { name: fname, type: "file", file, path: relPath });
  }

  function renderTree() {
    const container = els.fileTree;
    container.innerHTML = "";
    if (state.treeRoot.children.size === 0) {
      container.innerHTML =
        '<div class="empty-hint">Huge WARC repositories may take some time to index. <br><br>Please be patient while folders and files are loading... ⏳</div>';
      return;
    }
    container.appendChild(renderTreeChildren(state.treeRoot));
  }

  function renderTreeChildren(node) {
    const wrapper = document.createDocumentFragment();
    const entries = [...node.children.values()].sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const child of entries) wrapper.appendChild(renderTreeNode(child));
    return wrapper;
  }

  function renderTreeNode(node) {
    const container = document.createElement("div");
    container.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row " + node.type;

    const twisty = document.createElement("span");
    twisty.className = "twisty";

    if (node.type === "dir") {
      twisty.textContent = node.open ? "▾" : "▸";
      row.appendChild(twisty);
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = "📂 " + node.name;
      label.title = node.name;
      row.appendChild(label);
      row.addEventListener("click", () => {
        node.open = !node.open;
        renderTree();
      });

      const childrenWrap = document.createElement("div");
      childrenWrap.className = "tree-children" + (node.open ? " open" : "");
      childrenWrap.appendChild(renderTreeChildren(node));

      container.appendChild(row);
      container.appendChild(childrenWrap);
    } else {
      row.appendChild(twisty); // keeps files aligned under relevant folder
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = "🗃️ " + node.name;
      // Full relative path shown on hover.
      label.title = node.path || node.name;
      row.appendChild(label);
      if (state.selectedFileNode === node) row.classList.add("selected");
      row.addEventListener("click", () => selectFileNode(node));
      container.appendChild(row);
    }
    return container;
  }

  async function selectFileNode(node) {
    state.selectedFileNode = node;
    renderTree();
    await loadWarcFile(node.file, node.name);
  }

  // ---------------------------------------------------------------
  // Choosing folder or files
  // ---------------------------------------------------------------
  els.btnChooseFolder.addEventListener("click", () => els.folderInput.click());
  els.btnChooseFiles.addEventListener("click", () => els.filesInput.click());

  els.folderInput.addEventListener("change", (e) => {
    const files = [...e.target.files].filter((f) => isWarcName(f.webkitRelativePath || f.name));
    for (const f of files) addFileToTree(f, f.webkitRelativePath || f.name);
    if (files.length) renderTree();
    els.folderInput.value = "";
  });

  els.filesInput.addEventListener("change", (e) => {
    const files = [...e.target.files].filter((f) => isWarcName(f.name));
    for (const f of files) addFileToTree(f, f.name);
    if (files.length) renderTree();
    els.filesInput.value = "";
  });

  function walkEntry(entry, prefix, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file) => {
            out.push({ file, path: prefix + entry.name });
            resolve();
          },
          () => resolve()
        );
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const collectedEntries = [];
        (function readBatch() {
          reader.readEntries(async (batch) => {
            if (!batch.length) {
              for (const child of collectedEntries) {
                await walkEntry(child, prefix + entry.name + "/", out);
              }
              resolve();
            } else {
              collectedEntries.push(...batch);
              readBatch();
            }
          }, () => resolve());
        })();
      } else {
        resolve();
      }
    });
  }

  // ---------------------------------------------------------------
  // Pass 1: Indexes a WARC file's headers + byte offsets
  // ---------------------------------------------------------------
  async function indexWarcFile(file, onProgress) {
    const records = [];
    const parser = new warcio.WARCParser(file.stream(), {
      keepHeadersCase: true,
      parseHttp: false, // not needed for the list; keeps the first pass fast
    });

    let i = 0;
    for await (const record of parser) {
      await record.skipFully();
      records.push({
        index: i,
        type: record.warcType || "unknown",
        uri: record.warcTargetURI || "N/A",
        recordId: record.warcHeader("WARC-Record-ID") || "",
        offset: parser.offset,
        length: parser.recordLength,
      });
      i++;
      if (i % 250 === 0) {
        onProgress && onProgress(i);
        await yieldToUI();
      }
    }
    return records;
  }

  async function loadWarcFile(file, displayName) {
    state.currentFile = file;
    state.currentFileName = displayName;
    state.records = [];
    state.visible = [];
    state.typesPresent = [];
    state.activeTypes = new Set();
    state.searchQuery = "";
    state.appliedSearchQuery = "";
    state.selectedIndex = -1;
    state.selectedVisiblePos = -1;
    state.currentPayloadBytes = null;
    state.currentPayloadType = null;

    els.headerView.value = "";
    els.httpHeaderView.value = "";
    els.payloadView.value = "";
    els.payloadMeta.textContent = "";
    els.btnOpenNewTab.disabled = true;
    els.searchInput.value = "";
    els.searchInput.disabled = true;
    els.typeChips.innerHTML = "";
    els.recordsCountInline.textContent = "";
    els.currentFileLabel.textContent = `Loading: ${displayName}`;
    els.statusRight.textContent = "";
    setStatus(`Indexing ${displayName}…`, true);
    renderRecordWindow();

    try {
      const t0 = performance.now();
      const records = await indexWarcFile(file, (n) => {
        els.currentFileLabel.textContent = `Loading: ${displayName} (${n.toLocaleString()} records so far)`;
      });
      state.records = records;

      state.typesPresent = [...new Set(records.map((r) => r.type))].sort();
      state.activeTypes = new Set(state.typesPresent);
      renderTypeChips();
      els.searchInput.disabled = false;

      computeVisible();

      const dt = ((performance.now() - t0) / 1000).toFixed(1);
      els.currentFileLabel.textContent = `${records.length.toLocaleString()} records`;
      setStatus(`Indexed ${records.length.toLocaleString()} records in ${dt}s`, false);
    } catch (err) {
      els.currentFileLabel.textContent = `Failed to load ${displayName}`;
      setStatus("Error: " + err.message, false);
      console.error(err);
    }
  }

  // ---------------------------------------------------------------
  // Type filter chips + search narrowing `state.visible`
  // ---------------------------------------------------------------
  function renderTypeChips() {
    const container = els.typeChips;
    container.innerHTML = "";

    const allChip = document.createElement("span");
    allChip.className = "chip" + (state.activeTypes.size === state.typesPresent.length ? " active" : "");
    allChip.textContent = "All";
    allChip.title = "Show every record type";
    allChip.addEventListener("click", () => {
      state.activeTypes = new Set(state.typesPresent);
      renderTypeChips();
      computeVisible();
    });
    container.appendChild(allChip);

    const counts = new Map();
    for (const r of state.records) counts.set(r.type, (counts.get(r.type) || 0) + 1);

    for (const type of state.typesPresent) {
      const chip = document.createElement("span");
      chip.className = "chip" + (state.activeTypes.has(type) ? " active" : "");
      chip.innerHTML = `${escapeHtml(type)}<span class="count">${counts.get(type)}</span>`;
      chip.title = TYPE_DESCRIPTIONS[type] || "WARC record type: " + type;
      chip.addEventListener("click", () => {
        if (state.activeTypes.has(type)) {
          state.activeTypes.delete(type);
        } else {
          state.activeTypes.add(type);
        }
        renderTypeChips();
        computeVisible();
      });
      container.appendChild(chip);
    }
  }

  els.searchInput.addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      state.appliedSearchQuery = state.searchQuery.trim().toLowerCase();
      computeVisible();
    }, SEARCH_DEBOUNCE_MS);
  });

  function computeVisible() {
    const q = state.appliedSearchQuery;
    state.visible = state.records.filter((r) => {
      if (!state.activeTypes.has(r.type)) return false;
      if (q && !r.uri.toLowerCase().includes(q) && !r.recordId.toLowerCase().includes(q)) return false;
      return true;
    });

    if (state.selectedIndex >= 0) {
      const pos = state.visible.findIndex((r) => r.index === state.selectedIndex);
      state.selectedVisiblePos = pos;
      if (pos === -1) {
        state.selectedIndex = -1;
        els.headerView.value = "";
        els.httpHeaderView.value = "";
        els.payloadView.value = "";
        els.payloadMeta.textContent = "";
        els.btnOpenNewTab.disabled = true;
        state.currentPayloadBytes = null;
        state.currentPayloadType = null;
      }
    }

    renderRecordWindow();
    updateRecordsCountStatus();
  }

  // Updating count of filtered records below the filtering chips.
  function updateRecordsCountStatus() {
    const total = state.records.length;
    const shown = state.visible.length;
    const text = total && shown !== total
      ? `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} records`
      : "";
    els.recordsCountInline.textContent = text;
  }

  // ---------------------------------------------------------------
  // Filtered list of records, rendered from `state.visible`.
  // Row position here is NOT the same as a record's index/position
  // in the file (`rec.index`), shown as [n] before the record type)
  // ---------------------------------------------------------------
  let scrollScheduled = false;

  function renderRecordWindow() {
    const vp = els.recordViewport;
    const spacer = els.recordSpacer;
    const total = state.visible.length;

    if (total === 0) {
      spacer.style.height = state.records.length ? "auto" : "0px";
      spacer.innerHTML = state.records.length
        ? '<div class="no-results-hint">No records match the current filter/search.</div>'
        : "";
      return;
    }

    spacer.style.height = total * ROW_HEIGHT + "px";

    const scrollTop = vp.scrollTop;
    const viewHeight = vp.clientHeight || 400;
    const overscan = 10;
    let start = Math.floor(scrollTop / ROW_HEIGHT) - overscan;
    let end = Math.ceil((scrollTop + viewHeight) / ROW_HEIGHT) + overscan;
    start = Math.max(0, start);
    end = Math.min(total, end);

    const frag = document.createDocumentFragment();
    for (let pos = start; pos < end; pos++) {
      const rec = state.visible[pos];
      const row = document.createElement("div");
      row.className = "record-row" + (pos === state.selectedVisiblePos ? " selected" : "");
      row.style.top = pos * ROW_HEIGHT + "px";
      row.dataset.pos = String(pos);
      const typeClass =
        rec.type === "response" ? "rtype-response" : rec.type === "request" ? "rtype-request" : "rtype-other";
      const displayUri = truncateMiddle(rec.uri, URI_LABEL_MAX);
      // Display WARC-Record-Type, WARC-Target-URI and WARC-Record-ID for record on hover
      row.title = `${rec.type}: ${rec.uri}` + (rec.recordId ? `\nWARC-Record-ID: ${rec.recordId}` : "");
      row.innerHTML =
        `[${rec.index + 1}] <span class="${typeClass}">${escapeHtml(rec.type)}</span>: ${escapeHtml(displayUri)}`;
      frag.appendChild(row);
    }
    spacer.innerHTML = "";
    spacer.appendChild(frag);
  }

  els.recordViewport.addEventListener("scroll", () => {
    if (!scrollScheduled) {
      scrollScheduled = true;
      requestAnimationFrame(() => {
        renderRecordWindow();
        scrollScheduled = false;
      });
    }
  });

  els.recordViewport.addEventListener("click", (e) => {
    const row = e.target.closest(".record-row");
    if (!row) return;
    selectRecord(parseInt(row.dataset.pos, 10));
  });

  els.recordViewport.setAttribute("tabindex", "0");
  els.recordViewport.addEventListener("keydown", (e) => {
    if (!state.visible.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      selectRecord(Math.min(state.visible.length - 1, state.selectedVisiblePos + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectRecord(Math.max(0, state.selectedVisiblePos - 1));
    }
  });

  function scrollRowIntoView(pos) {
    const vp = els.recordViewport;
    const rowTop = pos * ROW_HEIGHT;
    const rowBottom = rowTop + ROW_HEIGHT;
    if (rowTop < vp.scrollTop) {
      vp.scrollTop = rowTop;
    } else if (rowBottom > vp.scrollTop + vp.clientHeight) {
      vp.scrollTop = rowBottom - vp.clientHeight;
    }
  }

  // ---------------------------------------------------------------
  // Pass 2: Re-parse a record on demand from its byte range
  // ---------------------------------------------------------------
  async function selectRecord(pos) {
    if (pos < 0 || pos >= state.visible.length) return;
    const rec = state.visible[pos];
    state.selectedVisiblePos = pos;
    state.selectedIndex = rec.index;
    renderRecordWindow();
    scrollRowIntoView(pos);

    els.headerView.value = "Loading…";
    els.httpHeaderView.value = "";
    els.payloadView.value = "";
    els.payloadMeta.textContent = "";
    els.btnOpenNewTab.disabled = true;
    state.currentPayloadBytes = null;
    state.currentPayloadType = null;

    try {
      const detail = await loadRecordDetail(state.currentFile, rec);
      els.headerView.value = detail.headerText;
      els.httpHeaderView.value = detail.httpHeaderText;
      els.payloadView.value = detail.payloadText;
      els.payloadMeta.textContent = detail.metaNote;

      state.currentPayloadBytes = detail.payloadBytes;
      state.currentPayloadType = detail.httpContentType;
      els.btnOpenNewTab.disabled = !(detail.payloadBytes && detail.payloadBytes.length > 0);
    } catch (err) {
      els.headerView.value = "";
      els.httpHeaderView.value = "";
      els.payloadView.value = `Error reading content:\n${err.message}`;
      console.error(err);
    }
  }

  // keepHeadersCase:true is used for the WARC Header pane to show original
  // casing in WARC headers, such as "WARC-Type" and "WARC-Target-URI".
  function getHeaderCI(headers, name) {
    if (!headers) return null;
    let value = headers.get(name);
    if (value == null && headers instanceof Map) {
      const lower = name.toLowerCase();
      for (const key of headers.keys()) {
        if (key.toLowerCase() === lower) {
          value = headers.get(key);
          break;
        }
      }
    }
    return value ?? null;
  }

  // Builds the text in the "HTTP Header" pane with original casing.
  function buildHttpHeaderText(record) {
    if (!record.httpHeaders) {
      return "(This record has no embedded HTTP request/response headers.)";
    }
    const lines = [];
    if (record.httpHeaders.statusline) lines.push(record.httpHeaders.statusline);
    for (const [name, value] of record.httpHeaders.headers) {
      lines.push(`${name}: ${value}`);
    }
    return lines.join("\n") || "(empty HTTP header block)";
  }

  async function loadRecordDetail(file, meta) {
    const slice = file.slice(meta.offset, meta.offset + meta.length);
    const parser = new warcio.WARCParser(slice.stream(), { keepHeadersCase: true, parseHttp: true });
    const record = await parser.parse();
    if (!record) throw new Error(`Could not re-parse record at offset ${meta.offset}`);

    const headerLines = [];
    for (const [name, value] of record.warcHeaders.headers) {
      headerLines.push(`${name}: ${value}`);
    }

    const httpHeaderText = buildHttpHeaderText(record);

    const payloadBytes = await record.readFully(true);
    const httpContentType = record.httpHeaders ? getHeaderCI(record.httpHeaders.headers, "Content-Type") : null;
    // Fall back to Content-Type in WARC Header for records without
    // embedded HTTP headers (e.g. warcinfo, resource, metadata, etc.)
    const displayContentType = httpContentType || record.warcContentType || null;

    const { text, note } = decodePayload(payloadBytes, httpContentType);

    const ctLabel = displayContentType ? displayContentType : "content-type unknown";
    const metaNote =
      `${payloadBytes.length.toLocaleString()} bytes · ${ctLabel}` + (note ? ` · ${note}` : "");

    return {
      headerText: headerLines.join("\n") || "(no WARC headers)",
      httpHeaderText,
      payloadText: text,
      metaNote,
      payloadBytes,
      httpContentType,
    };
  }

  // ---------------------------------------------------------------
  // Payload decoding: utf-8 -> windows-1252 -> hex dump, plus a
  // binary sniff. Aiming that binary payloads (images, fonts, etc.)
  // goes to a hex dump instead of a wall of meaningless characters.
  // ---------------------------------------------------------------
  function isLikelyBinaryContentType(ct) {
    if (!ct) return false;
    const t = ct.toLowerCase();
    if (t.includes("json") || t.includes("xml") || t.includes("javascript") ||
        t.includes("html") || t.includes("css") || t.includes("warc-fields") ||
        t.startsWith("text/")) {
      return false;
    }
    return (
      t.startsWith("image/") || t.startsWith("font/") || t.startsWith("audio/") ||
      t.startsWith("video/") || t.includes("octet-stream") || t.includes("pdf") ||
      t.includes("zip") || t.includes("gzip")
    );
  }

  function looksBinaryByContent(bytes) {
    if (!bytes.length) return false;
    const sample = bytes.subarray(0, Math.min(bytes.length, BINARY_SAMPLE_SIZE));
    let control = 0;
    for (let i = 0; i < sample.length; i++) {
      const b = sample[i];
      if ((b < 0x20 && b !== 9 && b !== 10 && b !== 13) || b === 0x7f) control++;
    }
    return control / sample.length > 0.1;
  }

  function toHexDump(bytes) {
    const slice = bytes.subarray(0, Math.min(bytes.length, HEX_DUMP_BYTES));
    let hex = "";
    for (let i = 0; i < slice.length; i++) hex += slice[i].toString(16).padStart(2, "0");
    let out = `Binary content (${bytes.length.toLocaleString()} bytes):\n${hex}`;
    if (bytes.length > slice.length) out += "\n... (truncated)";
    return out;
  }

  function decodePayload(bytes, httpContentType) {
    if (!bytes || bytes.length === 0) {
      return { text: "No content.", note: "empty" };
    }

    let text;
    let note;

    if (isLikelyBinaryContentType(httpContentType) || looksBinaryByContent(bytes)) {
      text = toHexDump(bytes);
      note = "hex dump (binary content)";
    } else {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        note = "utf-8";
      } catch {
        text = new TextDecoder("windows-1252").decode(bytes);
        note = "windows-1252 (fallback)";
      }
    }

    if (text.length > MAX_PAYLOAD_CHARS) {
      text = text.slice(0, MAX_PAYLOAD_CHARS) + "\n\n[... Content truncated at 50,000 characters ...]";
      note += ", truncated";
    }

    return { text, note };
  }

  // ---------------------------------------------------------------
  // Pressing "Open in new tab" will reuse the payload bytes fetched
  // for the selected record to represent it in a separate tab.
  // Includes some security measures to prevent content from calling
  // home, cf. design comments above.
  // ---------------------------------------------------------------
  function isSafeToRenderNatively(ct) {
    if (!ct) return false;
    const t = ct.toLowerCase();
    if (t.startsWith("image/") && t !== "image/svg+xml") return true;
    if (t.startsWith("audio/") || t.startsWith("video/")) return true;
    if (t === "application/pdf") return true;
    if (t === "text/plain" || t === "text/css") return true;
    if (t === "application/json" || t.endsWith("+json")) return true;
    return false;
  }

  function isSvgContentType(ct) {
    return ct === "image/svg+xml";
  }

  function isHtmlContentType(ct) {
    return ct === "text/html" || ct === "application/xhtml+xml";
  }

  function decodeTextLoose(bytes) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return new TextDecoder("windows-1252").decode(bytes);
    }
  }

  function openBlobUrlInNewTab(blob, revokeExtras) {
    const url = URL.createObjectURL(blob);
    const win = window.open(url, "_blank");
    if (!win) {
      setStatus("Pop-up blocked — allow pop-ups for this page to open payloads in a new tab", false);
    }
    // Allow the new tab time to load blob(s) before revoking.
    setTimeout(() => {
      URL.revokeObjectURL(url);
      (revokeExtras || []).forEach((u) => URL.revokeObjectURL(u));
    }, 60000);
  }

  function openSvgSafely(bytes) {
    const svgBlob = new Blob([bytes], { type: "image/svg+xml" });
    const svgUrl = URL.createObjectURL(svgBlob);
    const wrapperHtml =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>SVG payload</title>" +
      "<style>html,body{margin:0;height:100%;background:#f4f4f4;display:flex;" +
      "align-items:center;justify-content:center}img{max-width:100%;max-height:100vh}</style>" +
      `</head><body><img src="${svgUrl}" alt="SVG payload"></body></html>`;
    openBlobUrlInNewTab(new Blob([wrapperHtml], { type: "text/html" }), [svgUrl]);
  }

  function openHtmlSkeletonSafely(bytes) {
    const html = decodeTextLoose(bytes);

    // Blocking common live fetching by default,
    // while allowing inline-styled markup to render.
    const csp =
      "default-src 'none'; img-src data: blob:; font-src data:; " +
      "style-src 'unsafe-inline'; media-src data: blob:;";
    const cspTag = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
    const withCsp = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + cspTag)
      : cspTag + html;

    const wrapperHtml =
      "<!DOCTYPE html><html><head><meta charset=\"utf-8\">" +
      "<title>Archived HTML (rendered skeleton, scripts disabled)</title>" +
      "<style>html,body{margin:0;height:100%;display:flex;flex-direction:column}" +
      ".notice{font:12px -apple-system,system-ui,sans-serif;background:#fff3cd;" +
      "color:#664d03;padding:5px 10px;border-bottom:1px solid #ffe69c;flex:0 0 auto}" +
      "iframe{flex:1 1 auto;width:100%;border:0}</style></head><body>" +
      '<div class="notice">Static render of the archived HTML — scripts and outgoing network requests are disabled.</div>' +
      `<iframe sandbox srcdoc="${escapeHtml(withCsp)}"></iframe></body></html>`;

    openBlobUrlInNewTab(new Blob([wrapperHtml], { type: "text/html" }));
  }

  function openPayloadInNewTab() {
    if (!state.currentPayloadBytes || !state.currentPayloadBytes.length) return;

    const type = (state.currentPayloadType || "").split(";")[0].trim().toLowerCase();

    if (isSvgContentType(type)) {
      openSvgSafely(state.currentPayloadBytes);
      return;
    }
    if (isHtmlContentType(type)) {
      openHtmlSkeletonSafely(state.currentPayloadBytes);
      return;
    }

    const safeType = isSafeToRenderNatively(type) ? type : "text/plain";
    openBlobUrlInNewTab(new Blob([state.currentPayloadBytes], { type: safeType }));
  }

  els.btnOpenNewTab.addEventListener("click", openPayloadInNewTab);

  // ---------------------------------------------------------------
  // Pane resizers
  // ---------------------------------------------------------------
  function makeColumnResizer(handle, pane) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("active");
      const startX = e.clientX;
      const startWidth = pane.getBoundingClientRect().width;
      function onMove(ev) {
        const width = Math.max(140, startWidth + (ev.clientX - startX));
        pane.style.flex = `0 0 ${width}px`;
      }
      function onUp() {
        handle.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        renderRecordWindow();
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  function makeRowResizer(handle, pane) {
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      handle.classList.add("active");
      const startY = e.clientY;
      const startHeight = pane.getBoundingClientRect().height;
      function onMove(ev) {
        const height = Math.max(60, startHeight + (ev.clientY - startY));
        pane.style.flex = `0 0 ${height}px`;
      }
      function onUp() {
        handle.classList.remove("active");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      }
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }

  makeColumnResizer(els.resizer1, els.paneFiles);
  makeColumnResizer(els.resizer2, els.paneRecords);
  makeRowResizer(els.resizer3, els.detailsTop);
  makeRowResizer(els.resizer4, els.detailsMiddle);

  // ---------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------
  renderTree();
  renderRecordWindow();
  setStatus("Ready", false);
  window.addEventListener("resize", renderRecordWindow);
})();
