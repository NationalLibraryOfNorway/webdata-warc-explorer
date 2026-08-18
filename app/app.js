/*!
  WARC Explorer (v0.8.4)
  ----------------------------------------------------------------
  A tiny client-side web application for exploring WARC and ARC
  files in a browser. No uploading, no installation, no
  command-line. Just open "index.html" in your browser and explore
  your files.
  
  The app is inspired by Warchaeology's console
  (https://github.com/NationalLibraryOfNorway/warchaeology).
  Parsing of WARC is done with a bundled version of Webrecorder's
  warcio.js (https://github.com/webrecorder/warcio.js).

  ARC support (added separately, see "ARC file support" below):
  warcio.js has no ARC parsing of its own
  (https://github.com/webrecorder/warcio.js/issues/5), so .arc /
  .arc.gz files are read with a small hand-rolled parser instead.
  ARC is the older, pre-WARC container format: each record is just
  one plain-text header line (URL, IP, date, content-type, length,
  ...) directly followed by the raw captured HTTP response bytes —
  there's no WARC-style header block and no request/warcinfo/
  metadata record types, only response-like captures (plus a
  special "filedesc://" record describing the file itself, and
  occasionally inline "dns:" lookups).
  
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
    headerPaneLabel: document.getElementById("headerPaneLabel"),
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
    // ARC-specific pseudo-types (ARC has no WARC-Type field; these are
    // inferred from the record's URL, see indexArcFile below).
    filedesc: "ARC-specific: describes the ARC file itself (version, field layout). Plays the same role as a WARC's warcinfo record.",
    dns: "ARC-specific: a captured DNS lookup, stored inline as its own entry.",
  };

  const state = {
    treeRoot: { name: "", type: "dir", children: new Map(), open: true },
    currentFile: null,
    currentFileName: "",
    currentFileKind: "warc", // "warc" | "arc" — which parser drives pass 2
    arcDecompressedBytes: null, // cached fully-decompressed bytes for a loaded .arc.gz (see decompressGzipFile)
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

  function isArcName(name) {
    const lower = name.toLowerCase();
    return lower.endsWith(".arc") || lower.endsWith(".arc.gz");
  }

  function isArchiveName(name) {
    return isWarcName(name) || isArcName(name);
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
        '<div class="empty-hint">Huge WARC/ARC repositories may take some time to index. <br><br>Please be patient while folders and files are loading... ⏳</div>';
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
    await loadArchiveFile(node.file, node.name);
  }

  // ---------------------------------------------------------------
  // Choosing folder or files
  // ---------------------------------------------------------------
  els.btnChooseFolder.addEventListener("click", () => els.folderInput.click());
  els.btnChooseFiles.addEventListener("click", () => els.filesInput.click());

  els.folderInput.addEventListener("change", (e) => {
    const files = [...e.target.files].filter((f) => isArchiveName(f.webkitRelativePath || f.name));
    for (const f of files) addFileToTree(f, f.webkitRelativePath || f.name);
    if (files.length) renderTree();
    els.folderInput.value = "";
  });

  els.filesInput.addEventListener("change", (e) => {
    const files = [...e.target.files].filter((f) => isArchiveName(f.name));
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

  // ---------------------------------------------------------------
  // ARC file support
  // ---------------------------------------------------------------
  // ARC records have no WARC-style header block: each record is a
  // single header line
  //
  //   URL IP-address Archive-date Content-type Archive-length
  //
  // (older/Heritrix-style ARCs use a 10-field line instead, adding
  //  Result-code, Checksum, Location, Offset and Filename before the
  //  final length field — both layouts are handled generically below
  //  by only relying on "first field = URL" and "last field = length")
  //
  // ...immediately followed by exactly `Archive-length` bytes of raw
  // HTTP response (status line + headers + body), then a single "\n"
  // record separator before the next header line.
  //
  // Compressed .arc.gz files use the same "one gzip member per
  // record" convention as .warc.gz. The browser's native
  // DecompressionStream cannot be used for this: per the WHATWG
  // Compression spec, "a gzip stream may only contain one member",
  // and any additional data after that first member is a hard error
  // (Chrome: "Junk found after end of compressed data", Firefox:
  // "Unexpected input after the end of stream", Safari: "Extra bytes
  // past the end" — see https://github.com/whatwg/compression/issues/42).
  // A real .arc.gz/.warc.gz routinely has thousands of members, so
  // that API simply cannot decode one. warcio.js sidesteps this by
  // bundling the pako library internally for its own WARC gzip
  // handling; to avoid adding any external dependency here, a small,
  // self-contained GZIP (RFC 1952) + DEFLATE (RFC 1951) decoder is
  // implemented from scratch below instead (gunzipMultiMember and its
  // helpers) — no bundled files beyond warcio.min.js. It walks
  // concatenated gzip members directly and tolerates trailing
  // zero-padding after the last member. It was verified against
  // Node's zlib byte-for-byte on real multi-record WARC/ARC samples
  // and hundreds of randomized fuzz cases before being wired in here.
  // The whole .arc.gz is decompressed once up front and the
  // decompressed bytes are cached in memory for the lifetime of that
  // file selection; both pass 1 (indexing) and pass 2 (record detail)
  // then operate on that buffer instead of re-slicing the original
  // compressed file. For very large .arc.gz files this trades some
  // memory for simplicity; plain, uncompressed .arc files are still
  // streamed record-by-record like WARC is.

  // ---------------------------------------------------------------
  // Minimal, dependency-free GZIP (RFC 1952) + DEFLATE (RFC 1951)
  // decoder, supporting concatenated multi-member gzip streams. See
  // the design note above for why this exists instead of using the
  // native DecompressionStream API. Only decoding (inflate) is
  // implemented, since that's all this app ever needs.
  // ---------------------------------------------------------------
  const INFLATE_LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
  const INFLATE_LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
  const INFLATE_DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
  const INFLATE_DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
  const INFLATE_CLC_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

  // Bit-level reader over a Uint8Array. DEFLATE packs multi-bit values
  // LSB-first within the byte stream, except Huffman codes themselves,
  // which are conventionally described MSB-first (handled by building
  // codes MSB-first below instead of via this reader).
  class InflateBitReader {
    constructor(bytes) {
      this.bytes = bytes;
      this.pos = 0;
      this.bitBuf = 0;
      this.bitCount = 0;
    }
    alignToByte() {
      this.bitBuf = 0;
      this.bitCount = 0;
    }
    readBits(n) {
      while (this.bitCount < n) {
        if (this.pos >= this.bytes.length) throw new Error("Unexpected end of compressed data.");
        this.bitBuf |= this.bytes[this.pos++] << this.bitCount;
        this.bitCount += 8;
      }
      const val = this.bitBuf & ((1 << n) - 1);
      this.bitBuf >>>= n;
      this.bitCount -= n;
      return val;
    }
    readByteAligned() {
      if (this.pos >= this.bytes.length) throw new Error("Unexpected end of compressed data.");
      return this.bytes[this.pos++];
    }
  }

  // Builds a canonical Huffman decode table from an array of per-symbol
  // code lengths, per RFC 1951 §3.2.2. Small alphabets (<=288 symbols,
  // <=15 bit codes), so a simple per-length Map lookup is fast enough.
  function buildHuffmanTable(lengths) {
    const maxBits = Math.max(0, ...lengths);
    const blCount = new Array(maxBits + 1).fill(0);
    for (const l of lengths) if (l > 0) blCount[l]++;

    const nextCode = new Array(maxBits + 1).fill(0);
    let code = 0;
    for (let bits = 1; bits <= maxBits; bits++) {
      code = (code + blCount[bits - 1]) << 1;
      nextCode[bits] = code;
    }

    const mapsByLen = new Array(maxBits + 1);
    for (let i = 0; i <= maxBits; i++) mapsByLen[i] = new Map();
    for (let sym = 0; sym < lengths.length; sym++) {
      const len = lengths[sym];
      if (len > 0) {
        mapsByLen[len].set(nextCode[len], sym);
        nextCode[len]++;
      }
    }
    return { maxBits, mapsByLen };
  }

  function decodeHuffmanSymbol(br, table) {
    let code = 0;
    for (let len = 1; len <= table.maxBits; len++) {
      code = (code << 1) | br.readBits(1);
      const sym = table.mapsByLen[len].get(code);
      if (sym !== undefined) return sym;
    }
    throw new Error("Invalid Huffman code in compressed data.");
  }

  const INFLATE_FIXED_LIT_LENGTHS = (() => {
    const lens = new Array(288);
    let i = 0;
    for (; i <= 143; i++) lens[i] = 8;
    for (; i <= 255; i++) lens[i] = 9;
    for (; i <= 279; i++) lens[i] = 7;
    for (; i <= 287; i++) lens[i] = 8;
    return lens;
  })();
  const INFLATE_FIXED_DIST_LENGTHS = new Array(30).fill(5);

  // Growable output buffer (doubling strategy), since the total
  // decompressed size isn't known ahead of time.
  class GrowableByteBuffer {
    constructor(initial) {
      this.buf = new Uint8Array(Math.max(initial, 64));
      this.len = 0;
    }
    _ensure(extra) {
      if (this.len + extra <= this.buf.length) return;
      let newCap = this.buf.length * 2;
      while (newCap < this.len + extra) newCap *= 2;
      const next = new Uint8Array(newCap);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    pushByte(b) {
      this._ensure(1);
      this.buf[this.len++] = b;
    }
    pushCopy(distance, length) {
      this._ensure(length);
      const src = this.len - distance;
      if (src < 0) throw new Error("Invalid back-reference in compressed data.");
      // Byte-by-byte (not .set with a subarray) since source and
      // destination ranges can overlap for run-length-style copies.
      for (let i = 0; i < length; i++) this.buf[this.len + i] = this.buf[src + i];
      this.len += length;
    }
    finalize() {
      return this.buf.subarray(0, this.len);
    }
  }

  // Inflates exactly one raw DEFLATE stream (RFC 1951, no gzip/zlib
  // wrapper) starting at the reader's current position, appending
  // decoded bytes to `out`. Leaves `br` byte-aligned right after the
  // stream's final block.
  function inflateRawDeflate(br, out) {
    for (;;) {
      const bfinal = br.readBits(1);
      const btype = br.readBits(2);

      if (btype === 0) {
        // Stored (uncompressed) block.
        br.alignToByte();
        const len = br.readByteAligned() | (br.readByteAligned() << 8);
        br.readByteAligned(); // NLEN low byte (ones' complement of len; unused)
        br.readByteAligned(); // NLEN high byte
        for (let i = 0; i < len; i++) out.pushByte(br.readByteAligned());
      } else if (btype === 1 || btype === 2) {
        let litTable, distTable;
        if (btype === 1) {
          litTable = buildHuffmanTable(INFLATE_FIXED_LIT_LENGTHS);
          distTable = buildHuffmanTable(INFLATE_FIXED_DIST_LENGTHS);
        } else {
          const hlit = br.readBits(5) + 257;
          const hdist = br.readBits(5) + 1;
          const hclen = br.readBits(4) + 4;
          const clcLengths = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) clcLengths[INFLATE_CLC_ORDER[i]] = br.readBits(3);
          const clcTable = buildHuffmanTable(clcLengths);

          const allLengths = new Array(hlit + hdist).fill(0);
          let i = 0;
          while (i < allLengths.length) {
            const sym = decodeHuffmanSymbol(br, clcTable);
            if (sym <= 15) {
              allLengths[i++] = sym;
            } else if (sym === 16) {
              const repeat = br.readBits(2) + 3;
              const prev = allLengths[i - 1];
              for (let k = 0; k < repeat; k++) allLengths[i++] = prev;
            } else if (sym === 17) {
              const repeat = br.readBits(3) + 3;
              for (let k = 0; k < repeat; k++) allLengths[i++] = 0;
            } else if (sym === 18) {
              const repeat = br.readBits(7) + 11;
              for (let k = 0; k < repeat; k++) allLengths[i++] = 0;
            } else {
              throw new Error("Invalid code-length symbol in compressed data header.");
            }
          }
          litTable = buildHuffmanTable(allLengths.slice(0, hlit));
          distTable = buildHuffmanTable(allLengths.slice(hlit));
        }

        for (;;) {
          const sym = decodeHuffmanSymbol(br, litTable);
          if (sym < 256) {
            out.pushByte(sym);
          } else if (sym === 256) {
            break; // end of block
          } else {
            const li = sym - 257;
            if (li >= INFLATE_LEN_BASE.length) throw new Error("Invalid length symbol in compressed data.");
            const length = INFLATE_LEN_BASE[li] + br.readBits(INFLATE_LEN_EXTRA[li]);
            const distSym = decodeHuffmanSymbol(br, distTable);
            if (distSym >= INFLATE_DIST_BASE.length) throw new Error("Invalid distance symbol in compressed data.");
            const distance = INFLATE_DIST_BASE[distSym] + br.readBits(INFLATE_DIST_EXTRA[distSym]);
            out.pushCopy(distance, length);
          }
        }
      } else {
        throw new Error("Reserved/invalid DEFLATE block type in compressed data.");
      }

      if (bfinal) break;
    }
  }

  // Parses and skips exactly one gzip (RFC 1952) member header, leaving
  // `br` positioned at the start of that member's raw DEFLATE payload.
  function skipGzipMemberHeader(br) {
    const id1 = br.readByteAligned();
    const id2 = br.readByteAligned();
    if (id1 !== 0x1f || id2 !== 0x8b) throw new Error("Not a valid gzip member (bad magic bytes).");
    const cm = br.readByteAligned();
    if (cm !== 8) throw new Error("Unsupported gzip compression method (expected DEFLATE).");
    const flg = br.readByteAligned();
    br.readByteAligned(); br.readByteAligned(); br.readByteAligned(); br.readByteAligned(); // MTIME
    br.readByteAligned(); // XFL
    br.readByteAligned(); // OS

    const FEXTRA = 0x04, FNAME = 0x08, FCOMMENT = 0x10, FHCRC = 0x02;
    if (flg & FEXTRA) {
      const xlen = br.readByteAligned() | (br.readByteAligned() << 8);
      for (let i = 0; i < xlen; i++) br.readByteAligned();
    }
    if (flg & FNAME) {
      while (br.readByteAligned() !== 0) { /* consume null-terminated filename */ }
    }
    if (flg & FCOMMENT) {
      while (br.readByteAligned() !== 0) { /* consume null-terminated comment */ }
    }
    if (flg & FHCRC) {
      br.readByteAligned(); br.readByteAligned();
    }
  }

  // Decompresses one or more concatenated gzip members (as produced by
  // Heritrix / warcio / wget --warc-file, one member per WARC/ARC
  // record) into a single continuous Uint8Array. CRC32/ISIZE trailers
  // are skipped, not verified — this app only needs the bytes back,
  // and a corrupt member will already surface as a decode error above.
  function gunzipMultiMember(bytes) {
    const br = new InflateBitReader(bytes);
    const out = new GrowableByteBuffer(bytes.length * 3);

    while (br.pos < bytes.length) {
      skipGzipMemberHeader(br);
      inflateRawDeflate(br, out);
      br.alignToByte();
      // CRC32 (4 bytes) + ISIZE (4 bytes) trailer.
      for (let i = 0; i < 8; i++) br.readByteAligned();
      // Tolerate arbitrary trailing zero-padding after the last member
      // (some tools pad output to a fixed block size).
      if (br.pos < bytes.length) {
        let allZero = true;
        for (let i = br.pos; i < bytes.length; i++) {
          if (bytes[i] !== 0) { allZero = false; break; }
        }
        if (allZero) break;
      }
    }

    return out.finalize();
  }

  // Small pull-based cursor over either a ReadableStream<Uint8Array>
  // (used for plain .arc via file.stream()) or a single already-
  // in-memory Uint8Array (used for a fully-decompressed .arc.gz), so
  // indexArcFile() below can treat both sources identically.
  class ByteCursor {
    constructor(source) {
      this._reader = source && typeof source.getReader === "function" ? source.getReader() : null;
      this._chunkSource = this._reader ? null : source;
      this._chunkConsumed = false;
      this._buf = new Uint8Array(0);
      this._pos = 0;
      this.bytesRead = 0;
    }

    async _more() {
      if (this._reader) {
        const { value, done } = await this._reader.read();
        return done ? null : value;
      }
      if (this._chunkConsumed) return null;
      this._chunkConsumed = true;
      return this._chunkSource;
    }

    async _fill() {
      const chunk = await this._more();
      if (chunk === null) return false;
      if (this._pos > 0) {
        this._buf = this._buf.subarray(this._pos);
        this._pos = 0;
      }
      const merged = new Uint8Array(this._buf.length + chunk.length);
      merged.set(this._buf, 0);
      merged.set(chunk, this._buf.length);
      this._buf = merged;
      return true;
    }

    // Reads up to (and excluding) the next '\n'. Returns null only
    // once every byte of the source has been consumed.
    async readLine() {
      for (;;) {
        const idx = this._buf.indexOf(10, this._pos);
        if (idx !== -1) {
          const line = decodeLatin1(this._buf.subarray(this._pos, idx));
          this.bytesRead += idx - this._pos + 1;
          this._pos = idx + 1;
          return line;
        }
        if (!(await this._fill())) {
          if (this._pos >= this._buf.length) return null;
          const line = decodeLatin1(this._buf.subarray(this._pos));
          this.bytesRead += this._buf.length - this._pos;
          this._pos = this._buf.length;
          return line;
        }
      }
    }

    // Advances exactly n bytes without materializing them (mirrors
    // record.skipFully() in the WARC pass-1 indexer above).
    async skip(n) {
      let remaining = n;
      while (remaining > 0) {
        const avail = this._buf.length - this._pos;
        if (avail > 0) {
          const take = Math.min(avail, remaining);
          this._pos += take;
          this.bytesRead += take;
          remaining -= take;
          continue;
        }
        if (!(await this._fill())) {
          throw new Error("Unexpected end of ARC file while reading a record body.");
        }
      }
    }

    // Consumes the single '\n' (or stray "\r\n") separator between
    // records, if present. Tolerant of EOF / missing separator on a
    // truncated or non-conformant file.
    async skipRecordSeparator() {
      if (this._buf.length - this._pos < 1 && !(await this._fill())) return;
      if (this._buf[this._pos] === 10) {
        this._pos += 1;
        this.bytesRead += 1;
        return;
      }
      if (this._buf[this._pos] === 13) {
        if (this._buf.length - this._pos < 2 && !(await this._fill())) return;
        if (this._buf[this._pos + 1] === 10) {
          this._pos += 2;
          this.bytesRead += 2;
        }
      }
    }
  }

  function decodeLatin1(bytes) {
    return new TextDecoder("windows-1252").decode(bytes);
  }

  // Fully decompresses a .arc.gz File into one Uint8Array using the
  // self-contained gunzipMultiMember() decoder above (see the design
  // note near the top of the ARC section for why the native
  // DecompressionStream API can't be used here). Reads the file
  // incrementally so progress can be reported for large files, then
  // decodes the whole compressed byte array in one call since
  // gunzipMultiMember() already walks every concatenated gzip member
  // internally.
  async function decompressGzipFile(file, onBytes) {
    const reader = file.stream().getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      onBytes && onBytes(total);
      await yieldToUI();
    }
    const compressed = new Uint8Array(total);
    let pos = 0;
    for (const c of chunks) {
      compressed.set(c, pos);
      pos += c.length;
    }

    try {
      return gunzipMultiMember(compressed);
    } catch (err) {
      throw new Error(`Could not decompress this .gz file (${err.message || err}). It may be corrupt or truncated.`);
    }
  }

  // ---------------------------------------------------------------
  // Pass 1 (ARC): walks every record's header line + skips its body,
  // exactly mirroring indexWarcFile()'s role for WARC files.
  // ---------------------------------------------------------------
  async function indexArcFile(source, onProgress) {
    const cursor = new ByteCursor(source);
    const records = [];
    let i = 0;

    while (true) {
      const startOffset = cursor.bytesRead;
      const line = await cursor.readLine();
      if (line === null) break;

      const trimmed = line.trim();
      if (!trimmed) continue; // tolerate stray blank lines between records

      const fields = trimmed.split(/\s+/);
      const length = parseInt(fields[fields.length - 1], 10);
      if (fields.length < 4 || !Number.isFinite(length) || length < 0) {
        if (i === 0) {
          throw new Error("This doesn't look like a valid ARC file (unrecognized first record header line).");
        }
        break; // stop rather than risk mis-parsing the remainder of the file
      }

      const url = fields[0];
      const bodyOffset = cursor.bytesRead;
      await cursor.skip(length);
      await cursor.skipRecordSeparator();

      const lowerUrl = url.toLowerCase();
      const type = lowerUrl.startsWith("filedesc://") ? "filedesc" : lowerUrl.startsWith("dns:") ? "dns" : "response";

      records.push({
        index: i,
        type,
        uri: url,
        recordId: "",
        headerLine: trimmed,
        declaredContentType: fields[3] || null,
        offset: startOffset,
        bodyOffset,
        length,
      });
      i++;
      if (i % 250 === 0) {
        onProgress && onProgress(i);
        await yieldToUI();
      }
    }
    return records;
  }

  // Returns the raw body bytes (the captured HTTP response) for one
  // indexed ARC record, from whichever source backs the currently
  // loaded file (original File for plain .arc, cached decompressed
  // buffer for .arc.gz).
  async function getArcRecordBodyBytes(meta) {
    if (state.arcDecompressedBytes) {
      return state.arcDecompressedBytes.subarray(meta.bodyOffset, meta.bodyOffset + meta.length);
    }
    const slice = state.currentFile.slice(meta.bodyOffset, meta.bodyOffset + meta.length);
    return new Uint8Array(await slice.arrayBuffer());
  }

  // Locates the header/body boundary of a raw HTTP response block
  // (preferring "\r\n\r\n", falling back to a bare "\n\n").
  function findHeaderBodyBoundary(bytes) {
    for (let i = 0; i <= bytes.length - 4; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
        return { headerEnd: i, bodyStart: i + 4 };
      }
    }
    for (let i = 0; i <= bytes.length - 2; i++) {
      if (bytes[i] === 10 && bytes[i + 1] === 10) {
        return { headerEnd: i, bodyStart: i + 2 };
      }
    }
    return null;
  }

  // Splits an ARC "response" record's body into its embedded HTTP
  // status line + headers, and the remaining entity body — the ARC
  // equivalent of a WARC response record's separate HTTP header block.
  function splitArcHttpResponse(bytes) {
    const boundary = findHeaderBodyBoundary(bytes);
    if (!boundary) return { headers: null, body: bytes };

    const headerText = decodeLatin1(bytes.subarray(0, boundary.headerEnd));
    const rawLines = headerText.split(/\r\n|\n/);
    const statusline = (rawLines[0] || "").trim();
    if (!/^HTTP\/\d/i.test(statusline)) {
      return { headers: null, body: bytes }; // doesn't look like an HTTP response after all
    }

    const headerPairs = [];
    for (let i = 1; i < rawLines.length; i++) {
      const line = rawLines[i];
      if (!line) continue;
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      headerPairs.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
    }

    return {
      headers: { statusline, headers: headerPairs },
      body: bytes.subarray(boundary.bodyStart),
    };
  }

  function getArcHeaderCI(pairs, name) {
    const lower = name.toLowerCase();
    for (const [k, v] of pairs) {
      if (k.toLowerCase() === lower) return v;
    }
    return null;
  }

  function buildArcHttpHeaderText(statusline, pairs) {
    const lines = [];
    if (statusline) lines.push(statusline);
    for (const [name, value] of pairs) lines.push(`${name}: ${value}`);
    return lines.join("\n") || "(empty HTTP header block)";
  }

  // Builds the text shown in the "Header" pane for an ARC record.
  // There's no literal WARC-style header block to display, so this
  // reconstructs a labeled breakdown of the record's single header
  // line for the two commonly-seen ARC field layouts.
  function buildArcHeaderText(meta) {
    const fields = meta.headerLine.split(/\s+/);
    const labelSets = {
      5: ["URL", "IP-address", "Archive-date", "Content-type", "Archive-length"],
      10: ["URL", "IP-address", "Archive-date", "Content-type", "Result-code", "Checksum", "Location", "Offset", "Filename", "Archive-length"],
    };
    const labels = labelSets[fields.length];
    const lines = [
      "(ARC files have no separate WARC-style header block — this is",
      " reconstructed from the record's single ARC header line.)",
      "",
      `Raw ARC header line: ${meta.headerLine}`,
      "",
    ];
    if (labels) {
      for (let i = 0; i < fields.length; i++) lines.push(`${labels[i]}: ${fields[i]}`);
    } else {
      fields.forEach((f, i) => lines.push(`Field ${i + 1}: ${f}`));
    }
    return lines.join("\n");
  }

  // ---------------------------------------------------------------
  // Pass 2 (ARC): fetches one record's body on demand and splits it
  // into HTTP header / payload, mirroring loadRecordDetail() for WARC.
  // ---------------------------------------------------------------
  async function loadArcRecordDetail(meta) {
    const bodyBytes = await getArcRecordBodyBytes(meta);

    let httpHeaders = null;
    let httpContentType = null;
    let payloadBytes = bodyBytes;

    if (meta.type === "response") {
      const split = splitArcHttpResponse(bodyBytes);
      if (split.headers) {
        httpHeaders = split.headers;
        payloadBytes = split.body;
        httpContentType = getArcHeaderCI(split.headers.headers, "Content-Type");
      }
    }

    const httpHeaderText = httpHeaders
      ? buildArcHttpHeaderText(httpHeaders.statusline, httpHeaders.headers)
      : meta.type === "response"
        ? "(This record's body doesn't look like a well-formed HTTP response — showing it as raw content below.)"
        : `("${meta.type}" ARC records store plain metadata, not a captured HTTP response — there's no HTTP header to show.)`;

    const displayContentType = httpContentType || meta.declaredContentType || null;
    const { text, note } = decodePayload(payloadBytes, httpContentType);

    const ctLabel = displayContentType || "content-type unknown";
    const metaNote = `${payloadBytes.length.toLocaleString()} bytes · ${ctLabel}` + (note ? ` · ${note}` : "");

    return {
      headerText: buildArcHeaderText(meta),
      httpHeaderText,
      payloadText: text,
      metaNote,
      payloadBytes,
      httpContentType,
    };
  }

  async function loadArchiveFile(file, displayName) {
    state.currentFile = file;
    state.currentFileName = displayName;
    state.currentFileKind = isArcName(displayName) ? "arc" : "warc";
    state.arcDecompressedBytes = null;
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

    els.headerPaneLabel.textContent = state.currentFileKind === "arc" ? "ARC Header" : "WARC Header";
    els.searchInput.placeholder = state.currentFileKind === "arc"
      ? "Search URI or domain…"
      : "Search URI, domain, or Record-ID…";

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
      const onProgress = (n) => {
        els.currentFileLabel.textContent = `Loading: ${displayName} (${n.toLocaleString()} records so far)`;
      };

      let records;
      if (state.currentFileKind === "arc") {
        const isGz = displayName.toLowerCase().endsWith(".gz");
        let source = file.stream();
        if (isGz) {
          setStatus(`Decompressing ${displayName}…`, true);
          const bytes = await decompressGzipFile(file, (n) => {
            els.currentFileLabel.textContent = `Decompressing: ${displayName} (${(n / 1e6).toFixed(1)} MB so far)`;
          });
          state.arcDecompressedBytes = bytes;
          source = bytes;
          setStatus(`Indexing ${displayName}…`, true);
        }
        records = await indexArcFile(source, onProgress);
      } else {
        records = await indexWarcFile(file, onProgress);
      }
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
      const detail = state.currentFileKind === "arc"
        ? await loadArcRecordDetail(rec)
        : await loadRecordDetail(state.currentFile, rec);
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
