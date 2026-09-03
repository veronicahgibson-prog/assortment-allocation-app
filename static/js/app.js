/**
 * Assortment & Allocation Automation — Frontend Wizard Logic
 */
(() => {
    "use strict";

    const $ = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);

    let currentStep = 1;
    let eventName = "";
    let eventYear = "";
    let ldapUser = "";
    let userEmail = "";
    let includesImports = false;
    let multiDcDynamicSelected = false;
    let waveCount = 0;
    let selectedStrategy = "";
    // The most recent successful /api/prior_year_strategy lookup from Step 1
    // (null if none found yet, or the last check came back empty) — Step 2
    // reads this to offer "Follow last year's strategy?".
    let lastPriorYearStrategy = null;
    let assortmentResults = [];
    let resultsPage = 1;
    let resultsSort = "SKU_NBR";
    let resultsDir = "ASC";
    const PAGE_SIZE = 50;

    // Matches the actual FINAL_ALLOCATIONS_WIDE schema — no SISTER_SKU_NBR,
    // MVNDR_NBR, OG_W*_UNITS, or DFC_W5_UNITS column exists on that table.
    const RESULT_COLUMNS = [
        { key: "SKU_NBR",      label: "SKU" },
        { key: "SKU_DESC",     label: "Description" },
        { key: "SUPPLIER",     label: "Supplier" },
        { key: "FACTORY_ID",   label: "Factory" },
        { key: "BP",           label: "BP", fmt: "number" },
        { key: "BUY_UNITS",    label: "Buy Units", fmt: "number" },
        { key: "DC_NBR",       label: "DC" },
        { key: "DFC_PCT",      label: "DFC %", fmt: "pct" },
        { key: "DFC_UNITS",    label: "Units", fmt: "number" },
        { key: "DFC_W1_UNITS", label: "DFC W1", fmt: "number" },
        { key: "DFC_W2_UNITS", label: "DFC W2", fmt: "number" },
        { key: "DFC_W3_UNITS", label: "DFC W3", fmt: "number" },
        { key: "DFC_W4_UNITS", label: "DFC W4", fmt: "number" },
        { key: "ITEM_CUBE",    label: "Cube" },
        { key: "RACK_TYPE",    label: "Rack" },
        { key: "FACTORY_CUBE", label: "Fac Cube", fmt: "number" },
        { key: "FACTORY_CONTAINERS", label: "Fac Cont", fmt: "number" },
    ];

    // ── Formatters ─────────────────────────────────────────────────
    function fmtNum(v) {
        return v == null ? "—" : Number(v).toLocaleString("en-US");
    }
    function fmtPct(v) {
        if (v == null) return "—";
        return (Number(v) * 100).toFixed(1) + "%";
    }
    function fmtCell(v, fmt) {
        if (v == null || v === "") return "—";
        if (fmt === "number") return fmtNum(v);
        if (fmt === "pct") return fmtPct(v);
        return v;
    }

    // ── API Helper ─────────────────────────────────────────────────
    async function api(url, opts) {
        const r = await fetch(url, opts);
        const data = await r.json();
        if (!r.ok && data.error) throw new Error(data.error);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return data;
    }

    // The server tracks what was actually uploaded (includes_imports, set at
    // validation time); the client's own importToggle radio is only read once, at
    // template download, and goes stale after a refresh. Re-sync from the server
    // before anything (like the Multi DC panel) needs to know import vs domestic.
    async function syncIncludesImportsFromServer() {
        try {
            const res = await api("/api/upload_status?event_name=" + encodeURIComponent(eventName || ""));
            // null means the server has no answer (nothing cached this session AND
            // nothing found in EVENTS_SKU_LIST for this event) — keep the client's
            // own value rather than being told "domestic" by a default.
            if (typeof res.includes_imports === "boolean") {
                includesImports = res.includes_imports;
            }
        } catch (e) {
            // Non-fatal — keep whatever includesImports currently is.
        }
    }

    // SKU_GRP must come from the catalog run itself — the tool builds its own key
    // from the event name and strips punctuation along the way (e.g. "3. Example
    // Import DC-Count" becomes "...3 EXAMPLE IMPORT DCCOUNT..."), so guessing it
    // client-side from ldapUser/eventYear/eventName is unreliable. Only overwrite
    // the field when the server actually resolves one; if Run ID isn't filled in
    // yet, leave whatever's there (a fresh Run ID entry re-triggers this via the
    // change listener below).
    async function syncSkuGrpFromServer() {
        const runId = $("#stratRunId")?.value?.trim() || "";
        if (!runId || !eventName) return;
        try {
            const res = await api("/api/resolve_sku_grp?run_id=" + encodeURIComponent(runId)
                + "&event_name=" + encodeURIComponent(eventName));
            if (res.sku_grp && $("#stratSkuGrp")) {
                $("#stratSkuGrp").value = res.sku_grp;
            }
        } catch (e) {
            // Non-fatal — leave the field as-is.
        }
    }

    // ── Loading / Toast ────────────────────────────────────────────
    function showLoading(msg) {
        const el = $("#loadingText");
        if (el) el.textContent = msg || "Loading…";
        $("#loadingOverlay").classList.add("active");
    }
    function hideLoading() { $("#loadingOverlay").classList.remove("active"); }

    function toast(msg, type = "success") {
        const c = $("#toastContainer"), t = document.createElement("div");
        t.className = `toast toast-${type}`;
        const icon = type === "success" ? "check-circle" : type === "error" ? "exclamation-circle" : "info-circle";
        t.innerHTML = `<i class="fas fa-${icon}"></i> ${msg}`;
        c.appendChild(t);
        requestAnimationFrame(() => t.classList.add("show"));
        setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, 4000);
    }

    // ── Step Navigation ────────────────────────────────────────────
    window.goStep = function(n) {
        if (n < 1 || n > 9) return;

        // Block advancing beyond Step 2 if file validation hasn't passed
        if (n >= 5 && $("#btnGoInsert")?.disabled) {
            toast("Please upload a valid SKU list that passes validation before proceeding", "error");
            return;
        }

        // Hide current panel
        $(`#panel-${currentStep}`)?.classList.remove("active");
        // Show target panel
        $(`#panel-${n}`)?.classList.add("active");

        // Update stepper
        $$(".step").forEach(s => {
            const sn = parseInt(s.dataset.step);
            s.classList.remove("active");
            if (sn < n) s.classList.add("completed");
            if (sn === n) { s.classList.add("active"); s.classList.remove("completed"); }
            if (sn > n) s.classList.remove("completed");
        });

        currentStep = n;

        // Auto-fill Step 6 (Run Assortment Tool) run-context defaults
        if (n === 6 && ldapUser && eventName) {
            if ($("#stratEmail") && !$("#stratEmail").value) $("#stratEmail").value = userEmail;
            syncSkuGrpFromServer();
        }

        // Refresh the "Follow last year's strategy?" offer when arriving at
        // Step 2, in case Step 1's lookup changed since last time.
        if (n === 2) refreshFollowLastYearUI();

        // Auto-check if already inserted when arriving at step 5
        if (n === 5) checkAlreadyInserted();

        // Load cost model preview when arriving at step 6
        if (n === 6) loadCostModelPreview();

        // Auto-load results when going to the Allocation step
        if (n === 8) loadResults();
    };

    // Allow clicking step indicators to navigate back
    function setupStepperClicks() {
        $$(".step").forEach(s => {
            s.addEventListener("click", () => {
                const n = parseInt(s.dataset.step);
                if (n < currentStep) goStep(n);
            });
        });
    }

    // ── Section 1: Template Download ───────────────────────────────
    function setupTemplateDownload() {
        function syncImportToggle() {
            includesImports = document.querySelector('input[name="importToggle"]:checked')?.value === "true";
            const csStep1 = $("#containerSizeStep1");
            const titleText = $("#templateTitleText");
            const descText = $("#templateDescText");
            const btnText = $("#btnDownloadTemplate");

            if (csStep1) csStep1.style.display = includesImports ? "block" : "none";
            if (titleText) {
                titleText.innerHTML = `<i class="fas fa-file-excel" style="color:#107c41;margin-right:6px"></i> ${includesImports ? "Import Template" : "Domestic Template"}`;
            }
            if (descText) {
                descText.innerHTML = includesImports ? "*requires Factory ID" : "";
            }
            if (btnText) {
                btnText.innerHTML = `<i class="fas fa-download"></i> Download Template`;
            }
        }

        document.addEventListener("change", (e) => {
            if (e.target && e.target.name === "importToggle") {
                syncImportToggle();
            }
        });
        document.addEventListener("click", (e) => {
            if (e.target && e.target.closest(".import-toggle")) {
                setTimeout(syncImportToggle, 10);
            }
        });

        syncImportToggle();

        $("#containerSizeSelect")?.addEventListener("change", function() {
            const custom = $("#containerSizeCustom");
            if (custom) custom.style.display = this.value === "custom" ? "" : "none";
            recalcFactoryDist();
        });
        $("#containerSizeCustom")?.addEventListener("input", recalcFactoryDist);

        $("#btnDownloadTemplate")?.addEventListener("click", async (e) => {
            e.preventDefault();
            includesImports = document.querySelector('input[name="importToggle"]:checked')?.value === "true";
            const url = `/api/download_template?imports=${includesImports}&_t=${Date.now()}`;
            try {
                showLoading("Preparing Excel template...");
                const resp = await fetch(url);
                if (!resp.ok) throw new Error("Server returned status " + resp.status);
                const blob = await resp.blob();
                const blobUrl = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = blobUrl;
                link.download = includesImports ? "sku_upload_template_import.xlsx" : "sku_upload_template_domestic.xlsx";
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(blobUrl);
                toast("Template downloaded successfully!", "success");
            } catch (err) {
                toast("Failed to download template: " + err.message, "error");
            } finally {
                hideLoading();
            }
        });
    }

    // Step 1's "retrieve strategy if available" — shares last year's recorded
    // snapshot (units/cube/DC breakdown) from the enterprise historical
    // allocation table. This is display-only: acting on it (pre-filtering or
    // greying Step 2's DC options) is a separate, not-yet-built step.
    const fmtCube = v => v != null ? Number(v).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}) : "—";

    async function setupPriorYearStrategy() {
        const select = $("#step1EventNameSelect");
        const customInput = $("#step1EventNameCustom");
        const yearInput = $("#step1EventYear");

        // Default to the current calendar year — the user can still override
        // (e.g. a forward-looking event like Patio planned a year ahead).
        if (yearInput && !yearInput.value) yearInput.value = new Date().getFullYear();

        // Dropdown of event names already in history (data governance — avoids
        // near-duplicate free-text variants like "Gift Center" vs "GIFT CTR"),
        // with an explicit "Other" escape hatch for a genuinely new event.
        if (select) {
            try {
                const res = await api("/api/known_event_names");
                const names = res.event_names || [];
                select.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("")
                    + `<option value="__other__">Other (new event)…</option>`;
            } catch (e) {
                select.innerHTML = `<option value="__other__">Other (new event)…</option>`;
            }
            select.addEventListener("change", () => {
                const isOther = select.value === "__other__";
                if (customInput) {
                    customInput.style.display = isOther ? "block" : "none";
                    if (isOther) customInput.focus();
                }
            });
        }

        function currentEventName() {
            if (select?.value === "__other__") {
                // Uppercased for the same governance reason the dropdown exists —
                // keeps a newly-typed name consistent with the canonical
                // convention instead of introducing a stray-cased variant.
                return (customInput?.value || "").trim().toUpperCase();
            }
            return select?.value || "";
        }

        $("#btnCheckPriorStrategy")?.addEventListener("click", async () => {
            const name = currentEventName();
            const year = yearInput?.value?.trim();
            const section = $("#priorStrategySection");
            if (!section) return;
            if (!name || !year) {
                toast("Enter an event name and year first", "error");
                return;
            }
            const isImportVal = document.querySelector('input[name="importToggle"]:checked')?.value;
            showLoading("Checking for a prior year's strategy…");
            try {
                const params = new URLSearchParams({ event_name: name, event_year: year });
                if (isImportVal) params.set("is_import", isImportVal);
                const result = await api(`/api/prior_year_strategy?${params}`);
                lastPriorYearStrategy = result.found ? result : null;
                section.style.display = "block";
                if (!result.found) {
                    section.innerHTML = `<p style="margin:0;color:#666;font-size:.85rem">
                        <i class="fas fa-circle-info"></i> ${name} has no history.</p>`;
                    return;
                }
                const o = result.overall;
                let html = `<h4 style="margin:0 0 10px 0;font-size:.95rem">
                    <i class="fas fa-clock-rotate-left"></i> ${result.event_name} ${result.event_year} — Last Recorded Strategy</h4>`;
                html += `<table class="detail-table" style="margin-bottom:10px">
                    <tr style="background:var(--hd-bg);font-weight:600">
                        <td>Units</td><td>Cube (ft&sup3;)</td><td>Total SKUs</td><td>DC Count</td></tr>
                    <tr>
                        <td>${fmtNum(o.total_units)}</td><td>${fmtCube(o.total_cube)}</td>
                        <td>${fmtNum(o.distinct_thd_keys)}</td><td>${o.normalized_dc_count ?? "—"}</td></tr>
                    </table>`;
                // Tier strategy: one row per (DC-count tier, individual DC),
                // matching the exact layout requested — Strategy | DC Tier |
                // Campus Pairs Y/N | DC Nbr | DC Name | Units | Cube. Empty for
                // domestic events (no per-factory tier concept) or for an
                // import event whose historical rows never had FACTORY_ID
                // populated (a real data gap, not nothing to show).
                if (result.tier_strategy && result.tier_strategy.length) {
                    html += `<h4 style="margin:14px 0 6px 0;font-size:.9rem">Building Count Strategy</h4>`;
                    html += `<table class="detail-table" style="margin-bottom:10px"><thead><tr>
                        <td>Strategy</td><td style="text-align:right">DC Tier</td>
                        <td>Treat Bulk/Main as Campus Pairs</td>
                        <td>DC Nbr</td><td>DC Name</td>
                        <td style="text-align:right">Units</td><td style="text-align:right">Cube (ft&sup3;)</td></tr></thead><tbody>`;
                    let lastTier = null;
                    for (const t of result.tier_strategy) {
                        const newTier = t.dc_count !== lastTier;
                        lastTier = t.dc_count;
                        html += `<tr${newTier ? ' style="border-top:2px solid #ddd"' : ""}>
                            <td>${t.strategy}</td>
                            <td style="text-align:right">${t.dc_count}${t.has_variants
                                ? ' <span title="Some factories at this tier used a different DC combination — totals reflect only the most common one" style="color:#b8860b"><i class="fas fa-circle-info"></i></span>'
                                : ""}</td>
                            <td>${t.campus_pair}</td>
                            <td>${t.dc_nbr}</td><td>${t.dc_name}</td>
                            <td style="text-align:right">${fmtNum(t.units)}</td>
                            <td style="text-align:right">${fmtCube(t.cube)}</td></tr>`;
                    }
                    html += `</tbody></table>`;
                } else if (isImportVal === "true") {
                    html += `<p style="margin:10px 0;color:#666;font-size:.8rem">
                        <i class="fas fa-circle-info"></i> No per-factory building-count breakdown available for this snapshot
                        (its historical rows don't have FACTORY_ID recorded) — DC totals only, below.</p>`;
                }
                html += `<h4 style="margin:14px 0 6px 0;font-size:.9rem">DC Totals</h4>`;
                html += `<table class="detail-table"><thead><tr>
                    <td>DFC</td><td style="text-align:right">Units</td><td style="text-align:right">Cube (ft&sup3;)</td></tr></thead><tbody>`;
                for (const d of result.by_dc) {
                    html += `<tr><td>${d.dc_name || d.dc_nbr}</td>
                        <td style="text-align:right">${fmtNum(d.units)}</td>
                        <td style="text-align:right">${fmtCube(d.cube)}</td></tr>`;
                }
                html += `</tbody></table>`;
                // Supplier breakdown. Supplier isn't recorded in history — it's
                // taken from the uploaded SKU list for the same event/year, then
                // matched to VENDOR_ALIGNED_STRATEGY, so the DC count and list
                // are the vendor's aligned strategy rather than the DCs the
                // historical rows happened to use.
                if (result.by_supplier && result.by_supplier.length) {
                    html += `<h4 style="margin:14px 0 6px 0;font-size:.9rem">By Supplier</h4>`;
                    html += `<table class="detail-table"><thead><tr>
                        <td>Supplier</td><td style="text-align:right">SKU Count</td>
                        <td>Vendor Strategy</td><td style="text-align:right">DC Count</td>
                        <td>DC List</td></tr></thead><tbody>`;
                    for (const s of result.by_supplier) {
                        const isUnknown = s.supplier === "Unknown";
                        html += `<tr${isUnknown ? ' style="color:#888"' : ""}>
                            <td>${s.supplier}${isUnknown
                                ? ' <span title="These SKUs aren\'t in an uploaded SKU list for this event, so no supplier name is available" style="color:#b8860b"><i class="fas fa-circle-info"></i></span>'
                                : ""}</td>
                            <td style="text-align:right">${fmtNum(s.sku_count)}</td>
                            <td>${s.vendor || "—"}${s.asmt_id ? ` <span style="color:#888">(${s.asmt_id})</span>` : ""}</td>
                            <td style="text-align:right">${s.dc_count ?? "—"}</td>
                            <td>${s.dc_list || "—"}</td></tr>`;
                    }
                    html += `</tbody></table>`;
                }
                section.innerHTML = html;
            } catch (e) {
                toast("Failed to check prior year strategy: " + e.message, "error");
            } finally {
                hideLoading();
            }
        });
    }

    // ── Section 2: File Upload ─────────────────────────────────────
    function setupFileUpload() {
        const dropZone = $("#dropZone");
        const fileInput = $("#fileInput");
        if (!dropZone || !fileInput) return;

        dropZone.addEventListener("click", () => fileInput.click());
        dropZone.addEventListener("dragover", e => { e.preventDefault(); dropZone.classList.add("drag-over"); });
        dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
        dropZone.addEventListener("drop", e => {
            e.preventDefault();
            dropZone.classList.remove("drag-over");
            if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
        });
        fileInput.addEventListener("change", () => {
            if (fileInput.files.length) handleFile(fileInput.files[0]);
        });
    }

    async function handleFile(file) {
        const ext = file.name.split(".").pop().toLowerCase();
        if (!["xlsx", "csv"].includes(ext)) {
            toast("Only .xlsx and .csv files are accepted", "error");
            return;
        }
        if (file.size > 10 * 1024 * 1024) {
            toast("File exceeds 10 MB limit", "error");
            return;
        }

        // Always read the radio at upload time
        includesImports = document.querySelector('input[name="importToggle"]:checked')?.value === "true";

        $("#fileName").textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

        const formData = new FormData();
        formData.append("file", file);
        formData.append("includes_imports", includesImports.toString());

        // Reset mismatch alert
        const mismatchEl = $("#importMismatchAlert");
        if (mismatchEl) mismatchEl.style.display = "none";

        showLoading("Validating file…");
        try {
            const result = await api("/api/upload", { method: "POST", body: formData });
            displayValidation(result);
            if (result.passed && !result.import_mismatch) await doInsert(false);
        } catch (e) {
            toast("Upload failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    function displayValidation(result) {
        const container = $("#validationResults");
        container.style.display = "block";

        // Import mismatch: show only the alert, nothing else
        if (result.import_mismatch) {
            $("#checksList").innerHTML = "";
            $("#successSection").style.display = "none";
            $("#btnGoInsert").disabled = true;
            $("#importMismatchAlert").style.display = "block";
            toast(result.import_mismatch_msg, "error");
            return;
        }

        // Checks list
        const list = $("#checksList");
        list.innerHTML = "";
        for (const c of result.checks) {
            const div = document.createElement("div");
            div.className = "check-item";
            let iconClass, iconName;
            if (!c.passed) { iconClass = "check-fail"; iconName = "times"; }
            else if (c.warning) { iconClass = "check-warn"; iconName = "exclamation-triangle"; }
            else { iconClass = "check-pass"; iconName = "check"; }

            let expandHtml = "";
            const dataCols = ["THD_SKU_NBR","SISTER_SKU_NBR","SKU_DESC","SUPPLIER","MVNDR_NBR","FACTORY_ID","BP","BUY_UNITS","WAVE_1","WAVE_2","WAVE_3","WAVE_4","WAVE_5"];
            if (c.details && c.details.length > 0) {
                const hdrs = `<th>Row</th><th>Column</th><th>Message</th>` + dataCols.map(h => `<th>${h}</th>`).join("");
                const rows = c.details.map(d => {
                    const rd = d.row_data || {};
                    return `<tr><td>${d.row}</td><td>${d.column || ""}</td><td>${d.message}</td>` + dataCols.map(col => `<td>${rd[col] || ""}</td>`).join("") + `</tr>`;
                }).join("");
                expandHtml = `<div class="check-expand" style="display:none;margin-top:6px;max-height:240px;overflow:auto;">
                    <table class="mini-table"><thead><tr>${hdrs}</tr></thead><tbody>${rows}</tbody></table></div>`;
            }
            const hasExpand = c.details && c.details.length > 0;
            div.innerHTML = `
                <div class="check-icon ${iconClass}">
                    <i class="fas fa-${iconName}"></i>
                </div>
                <span class="check-name">${c.name}</span>
                <span class="check-detail">${c.detail}${hasExpand ? ' <i class="fas fa-chevron-down check-toggle" style="cursor:pointer;margin-left:6px;font-size:0.75rem;"></i>' : ''}</span>
                ${expandHtml}
            `;
            if (hasExpand) {
                div.querySelector(".check-toggle").addEventListener("click", function() {
                    const panel = div.querySelector(".check-expand");
                    const open = panel.style.display !== "none";
                    panel.style.display = open ? "none" : "block";
                    this.className = open ? "fas fa-chevron-down check-toggle" : "fas fa-chevron-up check-toggle";
                });
            }
            list.appendChild(div);
        }

        if (result.passed) {
            $("#errorSection") && ($("#errorSection").style.display = "none");
            $("#successSection").style.display = "block";
            $("#sumRows").textContent = fmtNum(result.summary.row_count);
            // Total Buy Units: the raw quantity as uploaded. Optimal Buy Units:
            // each row rounded up to its own BP multiple (what will actually
            // ship), shown with a small "+N" badge for the rounding delta so
            // both the real total and the buy-pack waste are visible together.
            $("#sumBuyUnits").textContent = fmtNum(result.summary.total_buy_units);
            const buDelta = result.summary.buy_units_delta || 0;
            $("#sumOptimalBuy").innerHTML = fmtNum(result.summary.optimal_buy_units)
                + (buDelta > 0
                    ? ` <span style="font-size:0.7em;font-weight:600" title="${fmtNum(buDelta)} units above the raw uploaded quantity, from rounding up to whole buy packs">`
                      + `<span style="display:inline-block;width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid #28a745;margin-right:2px;vertical-align:middle"></span>`
                      + `${fmtNum(buDelta)}</span>`
                    : "");
            $("#sumSuppliers").textContent = fmtNum(result.summary.unique_suppliers);
            if (result.summary.unique_factories != null) {
                $("#sumFactories").textContent = fmtNum(result.summary.unique_factories);
                $("#sumFactoriesCard").style.display = "";
            } else {
                $("#sumFactoriesCard").style.display = "none";
            }
            if (result.summary.thd_key_columns) {
                $("#thdKeyLabel").textContent = result.summary.thd_key_columns.join(" + ");
                $("#thdKeyInfo").style.display = "block";
            }
            const distContainer = $("#factoryDistribution");
            if (result.summary.factory_distribution && result.summary.factory_distribution.length) {
                window._factoryDist = result.summary.factory_distribution;
                distContainer.style.display = "block";
                recalcFactoryDist();
                $("#btnDownloadFactoryDist")?.addEventListener("click", downloadFactoryDist);
            } else if (distContainer) {
                distContainer.style.display = "none";
            }
            eventName = result.summary.event_name || "";
            eventYear = result.summary.event_year || "";
            waveCount = result.summary.wave_count || 0;
            $("#btnGoInsert").disabled = false;
            toast("File validation passed!", "success");
        } else {
            $("#successSection").style.display = "none";
            $("#btnGoInsert").disabled = true;
            // Auto-expand failed check details so the user sees errors immediately
            container.querySelectorAll(".check-item").forEach(item => {
                if (item.querySelector(".check-fail")) {
                    const expand = item.querySelector(".check-expand");
                    const toggle = item.querySelector(".check-toggle");
                    if (expand) expand.style.display = "block";
                    if (toggle) toggle.className = "fas fa-chevron-up check-toggle";
                }
            });
            toast("Validation failed — fix errors before proceeding", "error");
        }

        // Hide FYI section (details now inline under checks)
        const warnSection = $("#warningSection");
        if (warnSection) warnSection.style.display = "none";
    }

    function getContainerDivisor() {
        const sel = $("#containerSizeSelect");
        if (!sel) return 2390;
        if (sel.value === "custom") {
            const v = parseInt($("#containerSizeCustom").value);
            return v > 0 ? v : 2390;
        }
        return parseInt(sel.value);
    }

    function recalcFactoryDist() {
        const dist = window._factoryDist;
        if (!dist) return;
        const divisor = getContainerDivisor();
        const tbody = $("#factoryDistBody");
        if (!tbody) return;
        tbody.innerHTML = "";
        const hasCube = dist.some(f => (f.factory_cube || 0) > 0);
        const sorted = [...dist].sort((a, b) => hasCube
            ? ((b.factory_cube || 0) / divisor) - ((a.factory_cube || 0) / divisor)
            : (b.optimal_buy_units || 0) - (a.optimal_buy_units || 0));
        let totalSkus = 0, totalUnits = 0, totalContainers = 0;
        for (const f of sorted) {
            const c = (f.factory_cube || 0) / divisor;
            const containers = hasCube ? c.toFixed(2) : "—";
            totalSkus += f.sku_count || 0;
            totalUnits += f.optimal_buy_units || 0;
            totalContainers += c;
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${f.factory_id}</td><td style="text-align:right">${fmtNum(f.sku_count)}</td><td style="text-align:right">${fmtNum(f.optimal_buy_units)}</td><td style="text-align:right">${containers}</td>`;
            tbody.appendChild(tr);
        }
        const tfoot = document.createElement("tr");
        tfoot.style.fontWeight = "700";
        tfoot.style.borderTop = "2px solid #333";
        tfoot.innerHTML = `<td>Total</td><td style="text-align:right">${fmtNum(totalSkus)}</td><td style="text-align:right">${fmtNum(totalUnits)}</td><td style="text-align:right">${hasCube ? totalContainers.toFixed(2) : "—"}</td>`;
        tbody.appendChild(tfoot);
    }

    function downloadFactoryDist() {
        const dist = window._factoryDist;
        if (!dist) return;
        const divisor = getContainerDivisor();
        const hasCube = dist.some(f => (f.factory_cube || 0) > 0);
        const sorted = [...dist].sort((a, b) => hasCube
            ? ((b.factory_cube || 0) / divisor) - ((a.factory_cube || 0) / divisor)
            : (b.optimal_buy_units || 0) - (a.optimal_buy_units || 0));
        const header = "Factory ID,Distinct THD SKUs,Optimal BUY_UNITS,Containers\n";
        const rows = sorted.map(f => `${f.factory_id},${f.sku_count},${f.optimal_buy_units},${hasCube ? ((f.factory_cube || 0) / divisor).toFixed(2) : ""}`).join("\n");
        const blob = new Blob([header + rows], {type: "text/csv"});
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "factory_distribution.csv";
        a.click();
    }

    // \u2500\u2500 Section 2b: BQ Validation \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    function setupBqValidation() {
        $("#btnValidateBQ")?.addEventListener("click", validateBQ);
        $("#btnDownloadInvalid")?.addEventListener("click", () => {
            window.location.href = "/api/download_invalid_skus";
        });
    }

    async function validateBQ() {
        showLoading("Validating against BigQuery\u2026");
        try {
            const result = await api("/api/validate_bq", { method: "POST" });
            displayBqValidation(result);
        } catch (e) {
            toast("BigQuery validation failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    function displayBqValidation(result) {
        const list = $("#bqChecksList");
        list.innerHTML = "";

        for (const c of (result.checks || [])) {
            const div = document.createElement("div");
            div.className = "check-item";
            div.innerHTML = `
                <div class="check-icon ${c.passed ? 'check-pass' : 'check-fail'}">
                    <i class="fas fa-${c.passed ? 'check' : 'times'}"></i>
                </div>
                <span class="check-name">${c.name}</span>
                <span class="check-detail">${c.detail}</span>
            `;
            list.appendChild(div);
        }

        if (result.factory_cubes && window._factoryDist) {
            for (const f of window._factoryDist) {
                f.factory_cube = result.factory_cubes[String(f.factory_id)] || 0;
            }
            recalcFactoryDist();
        }

        if (result.passed) {
            $("#bqErrorSection").style.display = "none";
            $("#btnGoInsert").disabled = false;
            $("#btnValidateBQ").disabled = true;
            toast("BigQuery validation passed!", "success");
        } else {
            $("#bqErrorSection").style.display = result.has_download ? "block" : "none";
            $("#btnGoInsert").disabled = true;
            toast("BigQuery validation failed \u2014 see details above", "error");
        }
    }
    // ── Section 3: Insert to BQ ────────────────────────────────────
    async function checkAlreadyInserted() {
        try {
            const result = await api("/api/check_insert_status", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({event_name: eventName, event_year: eventYear, includes_imports: includesImports}),
            });
            if (result.already_inserted || result.exists_different) {
                if (result.factory_cubes && window._factoryDist) {
                    for (const f of window._factoryDist) {
                        f.factory_cube = result.factory_cubes[String(f.factory_id)] || 0;
                    }
                    recalcFactoryDist();
                }
                $("#insertStatus").style.display = "block";
                $("#insertStatus").innerHTML = `
                    <div class="validation-badge badge-warn" style="background:#fff3cd;color:#856404;border:1px solid #ffc107">
                        <i class="fas fa-exclamation-triangle"></i> ${result.message}
                    </div>`;
                $("#btnGoStrategy").disabled = !result.already_inserted;
                $("#btnInsert").disabled = true;
                const replaceBtn = $("#btnReplaceInsert");
                if (replaceBtn) replaceBtn.style.display = "inline-flex";
            }
        } catch (e) { /* ignore — user can still insert manually */ }
    }

    function setupInsert() {
        $("#btnInsert")?.addEventListener("click", () => doInsert(false));
        $("#btnReplaceInsert")?.addEventListener("click", () => doInsert(true));
    }

    async function doInsert(overwrite) {
        showLoading("Inserting into BigQuery…");
        try {
            const result = await api("/api/insert", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ container_divisor: getContainerDivisor(), overwrite }),
            });
            if (result.success) {
                const statusHtml = `
                    <div class="validation-badge badge-pass">
                        <i class="fas fa-check-circle"></i> ${result.message}
                    </div>`;
                [$("#insertStatus"), $("#autoInsertStatus")].forEach(status => {
                    if (status) { status.style.display = "block"; status.innerHTML = statusHtml; }
                });
                $("#btnGoStrategy").disabled = false;
                $("#btnInsert").disabled = true;
                const replaceBtn = $("#btnReplaceInsert");
                if (replaceBtn) replaceBtn.style.display = "none";
                toast("Data inserted successfully!", "success");
            } else if (result.exists) {
                // Event already exists — show replace option
                const statusHtml = `
                    <div class="validation-badge badge-warn" style="background:#fff3cd;color:#856404;border:1px solid #ffc107">
                        <i class="fas fa-exclamation-triangle"></i> ${result.message}
                        <button class="btn btn-secondary auto-replace-insert" style="margin-left:10px;background:#856404;color:#fff;border-color:#856404">
                            <i class="fas fa-rotate"></i> Replace Existing Data
                        </button>
                    </div>`;
                [$("#insertStatus"), $("#autoInsertStatus")].forEach(status => {
                    if (status) { status.style.display = "block"; status.innerHTML = statusHtml; }
                });
                document.querySelectorAll(".auto-replace-insert").forEach(button => {
                    button.addEventListener("click", () => doInsert(true));
                });
                $("#btnInsert").disabled = true;
                const replaceBtn = $("#btnReplaceInsert");
                if (replaceBtn) replaceBtn.style.display = "inline-flex";
                toast("Event already exists — click 'Replace' to overwrite", "error");
            } else {
                throw new Error(result.error || "Insert failed");
            }
        } catch (e) {
            const statusHtml = `
                <div class="validation-badge badge-fail">
                    <i class="fas fa-times-circle"></i> ${e.message}
                </div>`;
            [$("#insertStatus"), $("#autoInsertStatus")].forEach(status => {
                if (status) { status.style.display = "block"; status.innerHTML = statusHtml; }
            });
            toast("Insert failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    // ── Section 4b: Assortment Tool Submission ─────────────────────
    let skuUnitsPieChart = null;
    let skuCountPieChart = null;

    async function loadCostModelPreview() {
        if (!eventName) return;
        try {
            const result = await api("/api/cost_model_preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName }),
            });
            if (result.error) return;

            // Pie chart: count by type
            const unitLabels = ["THD SKU", "Sister SKU"];
            const colors = ["#f96302", "#003865"];
            const countData = [result.thd_count, result.sister_count];
            if (skuCountPieChart) skuCountPieChart.destroy();
            skuCountPieChart = new Chart($("#skuCountPieChart"), {
                type: "pie",
                data: { labels: unitLabels, datasets: [{ data: countData, backgroundColor: colors }] },
                plugins: [ChartDataLabels],
                options: { plugins: { legend: { position: "bottom" }, datalabels: { color: "#fff", font: { weight: "bold", size: 14 }, formatter: (val) => `${val} SKUs` } } },
            });

            // Pie chart: units by type
            const unitData = [result.thd_units, result.sister_units];
            if (skuUnitsPieChart) skuUnitsPieChart.destroy();
            skuUnitsPieChart = new Chart($("#skuUnitsPieChart"), {
                type: "pie",
                data: { labels: unitLabels, datasets: [{ data: unitData, backgroundColor: colors }] },
                plugins: [ChartDataLabels],
                options: { plugins: { legend: { position: "bottom" }, datalabels: { color: "#fff", font: { weight: "bold", size: 14 }, formatter: (val) => val.toLocaleString() } } },
            });

            // Table preview
            // Overlap warning
            let overlapEl = document.getElementById("skuOverlapWarning");
            if (!overlapEl) {
                overlapEl = document.createElement("div");
                overlapEl.id = "skuOverlapWarning";
                overlapEl.style.cssText = "margin:10px 0;padding:8px 12px;border-radius:6px;font-size:0.9em;";
                $("#costModelPreview").insertBefore(overlapEl, $("#costModelPreview").firstChild);
            }
            if (result.overlap_skus && result.overlap_skus.length) {
                overlapEl.style.display = "block";
                overlapEl.style.background = "#fff3cd";
                overlapEl.style.border = "1px solid #ffc107";
                overlapEl.innerHTML = `⚠️ <strong>${result.overlap_skus.length} SKU(s)</strong> appear as both THD and Sister: <strong>${result.overlap_skus.join(", ")}</strong>. Unique SKU count is <strong>${result.thd_count + result.sister_count - result.overlap_skus.length}</strong> (${result.thd_count} THD + ${result.sister_count} Sister − ${result.overlap_skus.length} overlap).`;
            } else {
                overlapEl.style.display = "none";
            }

            const tbody = $("#costModelBody");
            tbody.innerHTML = "";
            for (const r of result.rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${r.sku_nbr}</td><td style="text-align:right">${Number(r.buy_qty).toLocaleString()}</td><td>${r.IS_SISTER_SKU_FLAG ? "Sister" : "THD"}</td>`;
                tbody.appendChild(tr);
            }
            $("#costModelPreview").style.display = "block";
        } catch (e) {
            console.warn("Cost model preview failed:", e.message);
        }
    }

    function downloadCostModelCsv() {
        const table = $("#costModelTable");
        if (!table) return;
        const rows = table.querySelectorAll("tr");
        let csv = "";
        for (const row of rows) {
            const cells = row.querySelectorAll("th, td");
            csv += Array.from(cells).map(c => '"' + c.textContent.replace(/"/g, '""') + '"').join(",") + "\n";
        }
        const blob = new Blob([csv], { type: "text/csv" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (eventName || "cost_model") + "_preview.csv";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function setupAsmtTool() {
        $("#btnSubmitCostModel")?.addEventListener("click", submitCostModel);
        $("#btnDownloadCostModel")?.addEventListener("click", downloadCostModelCsv);
        $("#btnDeleteCostModel")?.addEventListener("click", deleteCostModelSubmission);
        $("#btnRunAsmtTool")?.addEventListener("click", () => {
            window.open("https://dashboard-edw.homedepot.com/workflow/jobDetail?id=1d262d53-4868-41e3-90d2-f67d08d45f29", "_blank");
            $("#btnGoStrategyFromTool").disabled = false;
            $("#asmtToolStatus").style.display = "block";
            $("#asmtToolStatus").innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> Assortment tool launched. Proceed when run completes.
            </div>`;
        });
    }

    async function submitCostModel() {
        showLoading("Submitting to DFC Cost Model…");
        try {
            const resp = await fetch("/api/submit_cost_model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || "Submission failed");

            $("#costModelStatus").innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> ${result.message}
            </div>`;
            $("#btnSubmitCostModel").disabled = true;
            $("#btnRunAsmtTool").style.display = "inline-flex";
            $("#btnRunAsmtTool").disabled = false;
            toast("Cost model submission complete", "success");
        } catch (e) {
            $("#costModelStatus").innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
            toast("Submission failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    async function deleteCostModelSubmission() {
        if (!eventName) { toast("No event loaded", "error"); return; }
        if (!confirm(`Delete all previous cost model submissions for "${eventName}"?`)) return;
        showLoading("Deleting previous submission…");
        try {
            const resp = await fetch("/api/delete_cost_model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || "Delete failed");
            $("#costModelStatus").innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> ${result.message}
            </div>`;
            $("#btnSubmitCostModel").disabled = false;
            toast("Previous submission deleted", "success");
        } catch (e) {
            $("#costModelStatus").innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
            toast("Delete failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    // ── Section 5: Strategy Configuration ──────────────────────────
    function buildDcToggleGrid(containerId) {
        const container = $(containerId);
        if (!container) return;
        container.innerHTML = "";
        for (let i = 1; i <= 13; i++) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "dc-toggle-btn";
            btn.textContent = i;
            btn.dataset.dcCount = i;
            btn.addEventListener("click", () => {
                btn.classList.toggle("active");
                updateDcSelectionCountBadge();
            });
            container.appendChild(btn);
        }
    }

    function updateDcSelectionCountBadge() {
        const selected = getSelectedDcCounts("#dcToggleGrid");
        const badge = $("#dcSelectionCountBadge");
        const cascadingGroup = $("#paramsCascading");
        if (selected.length === 0) {
            if (badge) badge.innerHTML = "";
            if (cascadingGroup) cascadingGroup.style.display = "none";
        } else if (selected.length === 1) {
            if (badge) badge.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.88rem;display:inline-block;padding:6px 12px"><i class="fas fa-info-circle"></i> <strong>1 DC Count (${selected[0]}) selected</strong> — Single DC Strategy</div>`;
            if (cascadingGroup) cascadingGroup.style.display = "none";
        } else {
            if (badge) badge.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.88rem;display:inline-block;padding:6px 12px"><i class="fas fa-info-circle"></i> <strong>${selected.length} DC Counts (${selected.join(", ")}) selected</strong> — Multi DC Strategy</div>`;
            if (cascadingGroup) cascadingGroup.style.display = "block";
        }
    }

    function getSelectedDcCounts(containerId) {
        return [...$(containerId).querySelectorAll(".dc-toggle-btn.active")].map(b => parseInt(b.dataset.dcCount));
    }

    function setupStrategy() {
        const radios = $$('input[name="strategy"]');

        // Once a determination has run, flag any change anywhere on Step 6 as
        // "config may have changed" and relabel the button to "Redetermine" —
        // if nothing actually changed, the button just stays "Determine."
        const markConfigDirty = () => {
            if (!lastAssortmentConfig) return; // nothing determined yet — no need
            const btn = $("#btnDetermineAsmt");
            if (btn) btn.innerHTML = '<i class="fas fa-search"></i> Redetermine Assortment IDs <i class="fas fa-arrow-right"></i>';
        };
        $("#panel-2")?.addEventListener("change", markConfigDirty);
        $("#panel-2")?.addEventListener("input", markConfigDirty);

        // Build 1-13 toggle grid
        buildDcToggleGrid("#dcToggleGrid");

        // Run ID may not be filled in yet when Step 6 first loads — re-resolve
        // SKU_GRP as soon as it is.
        $("#stratRunId")?.addEventListener("blur", syncSkuGrpFromServer);

        radios.forEach(r => {
            r.addEventListener("change", () => {
                const stratVal = r.value;
                selectedStrategy = stratVal;
                $("#strategyParams").style.display = "block";

                // Hide all param groups then show relevant ones
                $$(".param-group").forEach(g => g.style.display = "none");

                if (stratVal === "VENDOR_ALIGNED") {
                    $("#paramsVendor").style.display = "block";
                    if ($("#paramsCascading")) $("#paramsCascading").style.display = "none";
                    $("#paramsCampus").style.display = "none";
                    $("#paramsDcFilter").style.display = "none";
                    campusPairs = [];
                    dcInclusions = [];
                    dcExclusions = [];
                } else if (stratVal === "DC_SELECTION" || stratVal === "SINGLE_DC" || stratVal === "MULTI_DC") {
                    selectedStrategy = "DC_SELECTION";
                    $("#paramsDcSelection").style.display = "block";
                    syncIncludesImportsFromServer();
                    $("#btnDcKnow")?.click();
                    $("#paramsCampus").style.display = "block";
                    $("#paramsDcFilter").style.display = "block";
                }
            });
        });

        // DC Selection: know vs lookup
        $("#btnDcKnow")?.addEventListener("click", () => {
            multiDcDynamicSelected = false;
            $("#dcManual").style.display = "block";
            $("#dcLookup").style.display = "none";
            $("#dcDynamic").style.display = "none";
            updateDcSelectionCountBadge();
        });

        $("#btnDcLookup")?.addEventListener("click", () => {
            multiDcDynamicSelected = includesImports;
            $("#dcManual").style.display = "none";
            $("#dcLookup").style.display = includesImports ? "none" : "block";
            $("#dcDynamic").style.display = includesImports ? "block" : "none";
            if (includesImports && $("#paramsCascading")) {
                $("#paramsCascading").style.display = "block";
            }
        });

        // Match vendors button
        $("#btnMatchVendors")?.addEventListener("click", matchVendorStrategy);

        // Confirm vendor strategies button
        $("#btnConfirmVendorStrategy")?.addEventListener("click", () => {
            vendorStrategyConfirmed = true;
            $("#btnConfirmVendorStrategy").disabled = true;
            $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check-circle"></i> Confirmed';
            toast("Vendor strategies confirmed", "success");
            renderVendorPieChart(vendorMatches);
        });

        // Load DC counts button
        $("#btnLoadDcCounts")?.addEventListener("click", loadAvailableDcCounts);

        // Campus pairing
        $("#btnCampusYes")?.addEventListener("click", () => {
            $("#campusSelection").style.display = "block";
        });
        $("#btnCampusNo")?.addEventListener("click", () => {
            $("#campusSelection").style.display = "none";
            // Deactivate both buttons
            $("#btnCampusPerris")?.classList.remove("active");
            $("#btnCampusLG")?.classList.remove("active");
            $("#campusNotice").style.display = "none";
        });
        $("#btnCampusPerris")?.addEventListener("click", () => toggleCampusBtn("btnCampusPerris"));
        $("#btnCampusLG")?.addEventListener("click", () => toggleCampusBtn("btnCampusLG"));

        // DC Inclusions / Exclusions
        $("#btnDcFilterYes")?.addEventListener("click", () => {
            $("#dcFilterSelection").style.display = "block";
            buildDcFilterLists();
        });
        $("#btnDcFilterNo")?.addEventListener("click", () => {
            $("#dcFilterSelection").style.display = "none";
            dcInclusions = [];
            dcExclusions = [];
            $("#dcFilterNotice").style.display = "none";
        });

        // Determine assortment IDs button
        $("#btnDetermineAsmt")?.addEventListener("click", determineAssortment);

        // Force a fresh determination even if the configuration hasn't changed
        // (e.g. the user suspects upstream BigQuery data changed)
        $("#btnRedetermineAsmt")?.addEventListener("click", () => {
            forceRedetermine = true;
            determineAssortment();
        });

        // Follow last year's strategy? — pre-fills from Step 1's lookup but
        // leaves every control below editable, since a building can change
        // year to year (e.g. Baltimore -> Hagerstown) and the user still needs
        // to be able to override.
        $("#followLastYearToggle")?.addEventListener("change", e => applyLastYearStrategy(e.target.checked));
    }

    // Shows/hides the Step 2 "Follow last year's strategy?" offer based on
    // whatever Step 1's most recent check found. Resets the toggle (and any
    // previously-applied pre-fill) when there's nothing to offer, so a stale
    // pre-fill from a different event never lingers.
    function refreshFollowLastYearUI() {
        const box = $("#followLastYearBox");
        if (!box) return;
        if (lastPriorYearStrategy) {
            box.style.display = "block";
            const lbl = $("#followLastYearEventLabel");
            if (lbl) lbl.textContent = `${lastPriorYearStrategy.event_name} ${lastPriorYearStrategy.event_year}'s`;
        } else {
            box.style.display = "none";
            const toggle = $("#followLastYearToggle");
            if (toggle && toggle.checked) { toggle.checked = false; applyLastYearStrategy(false); }
        }
    }

    // Applies (or clears) last year's recorded strategy onto Step 2's controls.
    // Uses tier_strategy (per-factory building counts) when available — the
    // real import case this was built for — and falls back to the flat by_dc
    // rollup for domestic events, which have no per-factory tier concept.
    function applyLastYearStrategy(enable) {
        const note = $("#followLastYearNote");
        const pys = lastPriorYearStrategy;
        if (!enable || !pys) {
            if (note) note.style.display = "none";
            return;
        }

        const hasTiers = !!(pys.tier_strategy && pys.tier_strategy.length);
        const dcCounts = hasTiers
            ? [...new Set(pys.tier_strategy.map(t => t.dc_count))]
            : [pys.overall?.normalized_dc_count || 1];
        const dcNbrs = hasTiers
            ? [...new Set(pys.tier_strategy.map(t => t.dc_nbr))]
            : (pys.by_dc || []).map(d => d.dc_nbr);
        const perrisOn = hasTiers
            ? pys.tier_strategy.some(t => t.dc_nbr === 6007 && t.campus_pair === "Y")
            : dcNbrs.includes(6007);
        const lgOn = hasTiers
            ? pys.tier_strategy.some(t => t.dc_nbr === 6777 && t.campus_pair === "Y")
            : dcNbrs.includes(6777);
        const isSingle = dcCounts.length === 1 && dcCounts[0] === 1;
        const strategyVal = isSingle ? "SINGLE_DC" : "MULTI_DC";

        const dcSelRadio = document.querySelector('input[name="strategy"][value="DC_SELECTION"]');
        if (dcSelRadio) {
            dcSelRadio.checked = true;
            dcSelRadio.dispatchEvent(new Event("change"));
        }

        $("#btnDcKnow")?.click();

        $$("#dcToggleGrid .dc-toggle-btn").forEach(b => {
            b.classList.toggle("active", dcCounts.includes(parseInt(b.dataset.dcCount)));
        });
        updateDcSelectionCountBadge();

        if (perrisOn || lgOn) {
            if ($("#campusSelection")?.style.display === "none") $("#btnCampusYes")?.click();
            if (perrisOn !== !!$("#btnCampusPerris")?.classList.contains("active")) $("#btnCampusPerris")?.click();
            if (lgOn !== !!$("#btnCampusLG")?.classList.contains("active")) $("#btnCampusLG")?.click();
        } else {
            $("#btnCampusNo")?.click();
        }

        if ($("#dcFilterSelection")?.style.display === "none") $("#btnDcFilterYes")?.click();
        buildDcFilterLists();
        $$(".dc-incl-cb").forEach(cb => { cb.checked = dcNbrs.includes(parseInt(cb.dataset.dc)); });
        updateDcFilters();

        if (note) {
            const names = dcNbrs.map(n => ALL_DCS.find(d => d.nbr === n)?.name || n).join(", ");
            note.innerHTML = `<i class="fas fa-info-circle"></i> Applied ${pys.event_name} ${pys.event_year}: `
                + `${isSingle ? "Single DC" : "Multi DC"} — ${names}`
                + `${(perrisOn || lgOn) ? " (campus pairing on)" : ""}. `
                + `Adjust anything below if this event's buildings have changed.`;
            note.style.display = "block";
        }
    }

    let vendorStrategyConfirmed = false;
    let vendorMatches = [];
    let campusPairs = [];

    const CAMPUS_INFO = {
        perris: { main: 6007, bulk: 6006, name: "Perris" },
        locust_grove: { main: 6777, bulk: 6705, name: "Locust Grove" },
    };

    function toggleCampusBtn(btnId) {
        const btn = $(`#${btnId}`);
        btn.classList.toggle("active");
        updateCampusNotice();
    }

    function updateCampusNotice() {
        campusPairs = [];
        const notice = $("#campusNotice");
        const lines = [];
        if ($("#btnCampusPerris")?.classList.contains("active")) {
            campusPairs.push("perris");
            lines.push("<strong>Perris:</strong> DC 6007 (Main) &amp; DC 6006 (Bulk) treated as one campus");
        }
        if ($("#btnCampusLG")?.classList.contains("active")) {
            campusPairs.push("locust_grove");
            lines.push("<strong>Locust Grove:</strong> DC 6777 (Main) &amp; DC 6705 (Bulk) treated as one campus");
        }
        if (lines.length) {
            notice.innerHTML = '<i class="fas fa-info-circle" style="color:#856404"></i> ' + lines.join("<br>");
            notice.style.display = "block";
        } else {
            notice.style.display = "none";
        }
    }

    // DC filter variables
    let dcInclusions = [];
    let dcExclusions = [];

    const ALL_DCS = [
        { nbr: 5523, name: "Columbus" },
        { nbr: 5820, name: "Chicago" },
        { nbr: 5823, name: "Dallas" },
        { nbr: 5829, name: "Baltimore" },
        { nbr: 5831, name: "Houston" },
        { nbr: 5832, name: "Lacey" },
        { nbr: 5841, name: "Miami" },
        { nbr: 5854, name: "Newark" },
        { nbr: 5855, name: "Tampa" },
        { nbr: 5857, name: "Tracy" },
        { nbr: 5860, name: "Atlanta" },
        { nbr: 5882, name: "Boston" },
        { nbr: 5938, name: "Mexico, MO" },
        { nbr: 6006, name: "Perris Bulk" },
        { nbr: 6007, name: "Perris" },
        { nbr: 6705, name: "Locust Grove Bulk" },
        { nbr: 6707, name: "Troy" },
        { nbr: 6760, name: "Hagerstown" },
        { nbr: 6777, name: "Locust Grove" },
    ];

    function buildDcFilterLists() {
        const inclContainer = $("#dcIncludeList");
        const exclContainer = $("#dcExcludeList");
        if (inclContainer.children.length > 0) return; // already built
        for (const dc of ALL_DCS) {
            inclContainer.innerHTML += `<label><input type="checkbox" data-dc="${dc.nbr}" class="dc-incl-cb" /> ${dc.nbr} — ${dc.name}</label>`;
            exclContainer.innerHTML += `<label><input type="checkbox" data-dc="${dc.nbr}" class="dc-excl-cb" /> ${dc.nbr} — ${dc.name}</label>`;
        }
        inclContainer.addEventListener("change", updateDcFilters);
        exclContainer.addEventListener("change", updateDcFilters);
    }

    function updateDcFilters() {
        dcInclusions = [...$$(".dc-incl-cb:checked")].map(cb => parseInt(cb.dataset.dc));
        dcExclusions = [...$$(".dc-excl-cb:checked")].map(cb => parseInt(cb.dataset.dc));

        // A DC can't be both included and excluded — grey out (disable) each box's
        // counterpart on the other side once it's checked, so it can't be selected there.
        $$(".dc-incl-cb").forEach(cb => {
            const dc = parseInt(cb.dataset.dc);
            cb.closest("label").classList.toggle("dc-filter-disabled", dcExclusions.includes(dc));
            cb.disabled = dcExclusions.includes(dc);
        });
        $$(".dc-excl-cb").forEach(cb => {
            const dc = parseInt(cb.dataset.dc);
            cb.closest("label").classList.toggle("dc-filter-disabled", dcInclusions.includes(dc));
            cb.disabled = dcInclusions.includes(dc);
        });

        const notice = $("#dcFilterNotice");
        const parts = [];
        if (dcInclusions.length) parts.push(`<strong>Include:</strong> ${dcInclusions.join(", ")}`);
        if (dcExclusions.length) parts.push(`<strong>Exclude:</strong> ${dcExclusions.join(", ")}`);
        if (parts.length) {
            notice.innerHTML = '<i class="fas fa-info-circle" style="color:#155724"></i> ' + parts.join(" &nbsp;|&nbsp; ");
            notice.style.display = "block";
        } else {
            notice.style.display = "none";
        }
    }

    async function matchVendorStrategy() {
        showLoading("Matching suppliers to vendor strategies…");
        try {
            const result = await api("/api/match_vendor_strategy", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: $("#paramEventName")?.value || eventName }),
            });
            if (result.error) throw new Error(result.error);

            vendorMatches = result.matches || [];

            const summary = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-info-circle"></i> 
                <strong>${result.supplier_count}</strong> supplier(s) mapped to <strong>${result.strategy_count}</strong> vendor strategy/strategies.
                ${result.unmatched?.length ? `<br><span style="color:#c00">${result.unmatched.length} unmatched: ${result.unmatched.join(", ")}</span>` : ""}
            </div>`;
            $("#vendorMatchSummary").innerHTML = summary;
            renderVendorSupplierSummary(vendorMatches, result.sku_count);
            $("#vendorMatchResult").style.display = "block";
            vendorStrategyConfirmed = false;
            $("#btnConfirmVendorStrategy").disabled = false;
            $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check"></i> Confirm Vendor Strategies';

            toast(`Matched ${result.supplier_count} suppliers`, "success");
        } catch (e) {
            toast("Vendor match failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    function parseVendorDcs(value) {
        const values = Array.isArray(value) ? value : String(value || "").match(/\d+/g) || [];
        return [...new Set(values.map(Number).filter(Number.isFinite))];
    }

    function parseVendorNames(value) {
        if (Array.isArray(value)) return value.map(String);
        return String(value || "").replace(/^\[|\]$/g, "").split(/[,|]/).map(value => value.replace(/^['\"]|['\"]$/g, "").trim()).filter(Boolean);
    }

    function vendorDcName(dcNbr, names, index) {
        if (names[index]) return names[index];
        const known = ALL_DCS.find(dc => dc.nbr === dcNbr);
        return known ? known.name : `DC ${dcNbr}`;
    }

    function toggleVendorDc(matchIndex, dcNbr) {
        const match = vendorMatches[matchIndex];
        const selected = parseVendorDcs(match?.DC_LIST);
        if (!match || (selected.length === 1 && selected[0] === dcNbr)) {
            toast("Each supplier must have at least one DC selected", "error");
            return;
        }
        const next = selected.includes(dcNbr)
            ? selected.filter(dc => dc !== dcNbr)
            : [...selected, dcNbr];
        next.sort((a, b) => a - b);
        match.DC_LIST = next.join(", ");
        match.DC_COUNT = next.length;
        const initialDcs = parseVendorDcs(match._initialDcList);
        const initialNames = parseVendorNames(match._initialDcNames);
        match.DC_NM_LIST = next.map(dc => vendorDcName(dc, initialNames, initialDcs.indexOf(dc))).join(", ");
        renderVendorSupplierSummary(vendorMatches);
    }

    // Per-supplier rollup of the vendor-strategy match: SKU count comes from
    // the uploaded template, DC count/list from the matched VENDOR_ALIGNED_STRATEGY
    // row. Suppliers falling back to the "OTHER" vendor are flagged, since their
    // DCs are a default rather than a real vendor-specific strategy.
    function renderVendorSupplierSummary(matches, totalSkus) {
        const box = $("#vendorSupplierSummary");
        if (!box) return;
        if (!matches.length) {
            box.innerHTML = "";
            return;
        }
        let html = `<h4 style="margin:0 0 6px 0;font-size:.9rem">
            <i class="fas fa-boxes-stacked"></i> Supplier DC Assignments</h4>
            <p class="vendor-dc-help">Select the DC buttons for each supplier. Hover over a DC number to see its name.</p>
            <div class="table-container vendor-dc-table-wrap"><table class="detail-table vendor-dc-table">
            <thead><tr><th>Matched THD Key</th><th>Supplier</th><th>DC Count</th><th>DC Details</th></tr></thead><tbody>`;
        matches.forEach((m, matchIndex) => {
            const isOther = (m.VENDOR || "").toUpperCase() === "OTHER";
            if (!m._initialDcList) m._initialDcList = parseVendorDcs(m.DC_LIST).join(", ");
            if (!m._initialDcNames) m._initialDcNames = Array.isArray(m.DC_NM_LIST) ? m.DC_NM_LIST.join(", ") : (m.DC_NM_LIST || "");
            const selectedDcs = parseVendorDcs(m.DC_LIST);
            const initialDcs = parseVendorDcs(m._initialDcList);
            const names = parseVendorNames(m._initialDcNames);
            html += `<tr><td style="text-align:right">${fmtNum(m.SKU_COUNT)}</td>
                <td><strong>${m.SUPPLIER}${isOther
                    ? ' <span title="No vendor-specific strategy matched — using the OTHER default" style="color:#b8860b"><i class="fas fa-circle-info"></i></span>'
                    : ""}</strong><br><span class="vendor-dc-meta">${m.VENDOR || "—"}</span></td>
                <td class="vendor-dc-count">${selectedDcs.length}</td><td><div class="vendor-dc-buttons">`;
            initialDcs.forEach((dcNbr, dcIndex) => {
                const name = vendorDcName(dcNbr, names, dcIndex);
                html += `<button type="button" class="dc-toggle-btn vendor-dc-btn${selectedDcs.includes(dcNbr) ? " active" : ""}"
                    title="${name}" aria-label="DC ${dcNbr}: ${name}" data-match-index="${matchIndex}" data-dc-nbr="${dcNbr}">${dcNbr}</button>`;
            });
            html += `</div></td></tr>`;
        });
        html += `</tbody><tfoot><tr><td colspan="4" class="vendor-dc-total">Total matched THD Keys: ${fmtNum(totalSkus ?? matches.reduce((sum, m) => sum + Number(m.SKU_COUNT || 0), 0))}</td></tr></tfoot></table></div>`;
        box.innerHTML = html;
        box.querySelectorAll(".vendor-dc-btn").forEach(button => {
            button.addEventListener("click", () => toggleVendorDc(
                Number(button.dataset.matchIndex), Number(button.dataset.dcNbr)
            ));
        });
    }

    let availableDcOptions = [];

    async function loadAvailableDcCounts(mode = "multi") {
        const runId = $("#stratRunId")?.value?.trim() || "";
        const skuGrp = $("#stratSkuGrp")?.value?.trim() || "";
        if (!runId || !skuGrp) {
            toast("Run ID and SKU Group are required — set them in Step 6", "error");
            return;
        }
        showLoading("Querying available DC counts…");
        try {
            const result = await api("/api/available_dc_counts", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ run_id: runId, sku_grp: skuGrp }),
            });
            if (result.error) throw new Error(result.error);

            availableDcOptions = result.options || [];

            if (mode === "single") {
                const container = $("#singleDcCountRadios");
                container.innerHTML = "";
                for (const opt of availableDcOptions) {
                    const lbl = document.createElement("label");
                    lbl.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-right:16px;margin-bottom:8px";
                    lbl.innerHTML = `<input type="radio" name="singleDcRadio" value="${opt.camp_asmt_id}" data-dc-count="${opt.dc_count}" /> ${opt.dc_count} DCs <span style="color:#888;font-size:0.85rem">(ID: ${opt.camp_asmt_id})</span>`;
                    container.appendChild(lbl);
                }
                $("#singleDcCountSummary").innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                    <i class="fas fa-info-circle"></i> Found <strong>${availableDcOptions.length}</strong> DC count option(s). Select one.
                </div>`;
                $("#singleDcCountResult").style.display = "block";
            } else {
                const container = $("#dcCountChecks");
                container.innerHTML = "";
                for (const opt of availableDcOptions) {
                    const lbl = document.createElement("label");
                    lbl.style.cssText = "display:inline-flex;align-items:center;gap:6px;margin-right:16px;margin-bottom:8px";
                    lbl.innerHTML = `<input type="checkbox" value="${opt.camp_asmt_id}" data-dc-count="${opt.dc_count}" /> ${opt.dc_count} DCs <span style="color:#888;font-size:0.85rem">(ID: ${opt.camp_asmt_id})</span>`;
                    container.appendChild(lbl);
                }
                $("#dcCountSummary").innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                    <i class="fas fa-info-circle"></i> Found <strong>${availableDcOptions.length}</strong> DC count option(s). Select one or more.
                </div>`;
                $("#dcCountResult").style.display = "block";
            }
            toast(`Found ${availableDcOptions.length} DC count options`, "success");
        } catch (e) {
            toast("Failed to load DC counts: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    async function determineAssortment() {
        if (!selectedStrategy) {
            toast("Please select a strategy first", "error");
            return;
        }

        const body = {
            strategy: selectedStrategy,
            event_name: eventName,
        };

        if (selectedStrategy === "VENDOR_ALIGNED") {
            if (!vendorStrategyConfirmed) {
                toast("Please match and confirm vendor strategies first", "error");
                return;
            }
            body.vendor_matches = vendorMatches;
        } else if (selectedStrategy === "DC_SELECTION" || selectedStrategy === "SINGLE_DC" || selectedStrategy === "MULTI_DC") {
            const dynamicMode = multiDcDynamicSelected && includesImports;

            if (dynamicMode) {
                body.strategy = "MULTI_DC";
                body.dc_counts = [];
            } else if ($("#dcManual")?.style.display !== "none") {
                const dcCounts = getSelectedDcCounts("#dcToggleGrid");
                if (!dcCounts.length) {
                    toast("Select at least one DC count", "error");
                    return;
                }
                body.strategy = dcCounts.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                body.dc_counts = dcCounts;
            } else {
                const checkboxSelected = [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount));
                if (!checkboxSelected.length) {
                    toast("Select at least one DC count", "error");
                    return;
                }
                body.strategy = checkboxSelected.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                body.dc_counts = checkboxSelected;
            }
            body.min_containers = 5;
            body.is_import = includesImports;
            body.cascading = !!$("#cascadingToggle")?.checked;
            body.campus_pairs = campusPairs;
            body.dc_inclusions = dcInclusions;
            body.dc_exclusions = dcExclusions;
            body.run_id = $("#stratRunId")?.value?.trim() || "";
            body.sku_grp = $("#stratSkuGrp")?.value?.trim() || "";

            // Low-volume factory check
            const dist = dynamicMode ? null : window._factoryDist;
            if (dist && dist.length && body.dc_counts.length > 0) {
                const divisor = getContainerDivisor();
                const minDc = Math.min(...body.dc_counts);
                const threshold = minDc;
                const lowVol = dist.filter(f => (f.factory_cube || 0) / divisor < threshold);
                if (lowVol.length) {
                    const fallbackDefault = 2;
                    const alertEl = $("#lowVolumeAlert");
                    const renderAlert = (t, lv) => `
                        <div class="validation-badge" style="display:block;background:#fff3cd;color:#856404;border:1px solid #ffc107;border-radius:8px;padding:14px 18px;font-size:0.92rem">
                            <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                                <i class="fas fa-exclamation-triangle"></i>
                                <strong>${lv.length} of ${dist.length} factories produce fewer than ${t} containers (min DC count).</strong>
                            </div>
                            <div style="margin-bottom:10px">
                                Factories with fewer containers than the threshold will default to a
                                <input type="number" id="lowVolFallbackDc" value="${fallbackDefault}" min="1" max="13" step="1" style="width:55px;padding:4px 8px;border:1px solid #ccc;border-radius:4px;font-weight:700;text-align:center">
                                <strong>DC strategy</strong>.
                            </div>
                            <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
                                <label style="font-weight:600;font-size:0.85rem">Adjust container threshold:</label>
                                <input type="number" id="minContainersInput" value="${t}" min="0" step="0.5" style="width:70px;padding:4px 8px;border:1px solid #ccc;border-radius:4px">
                            </div>
                            <div id="lowVolSummary" style="margin-bottom:12px;padding:8px 12px;background:#fef9e7;border-radius:6px;font-size:0.85rem;font-style:italic">
                                Factories that produce less than <strong>${t}</strong> containers will be assorted to a <strong>${fallbackDefault}</strong> DC count strategy.
                            </div>
                            <div style="display:flex;justify-content:flex-end;gap:8px">
                                <button class="btn btn-sm btn-primary" id="btnLowVolProceed">
                                    <i class="fas fa-check"></i> Proceed
                                </button>
                                <button class="btn btn-sm btn-secondary" id="btnLowVolCancel">Cancel</button>
                            </div>
                        </div>`;
                    alertEl.innerHTML = renderAlert(threshold, lowVol);
                    alertEl.style.display = "block";
                    window._pendingAssortmentBody = body;
                    const bindAlertEvents = (currentThreshold) => {
                        const updateSummary = () => {
                            const t = $("#minContainersInput")?.value || currentThreshold;
                            const d = $("#lowVolFallbackDc")?.value || 2;
                            $("#lowVolSummary").innerHTML = `Factories that produce less than <strong>${t}</strong> containers will be assorted to a <strong>${d}</strong> DC count strategy.`;
                        };
                        $("#minContainersInput").addEventListener("input", updateSummary);
                        $("#lowVolFallbackDc").addEventListener("input", updateSummary);
                        $("#btnLowVolCancel").onclick = () => { alertEl.style.display = "none"; };
                        $("#btnLowVolProceed").onclick = () => {
                            body.min_containers = parseFloat($("#minContainersInput")?.value) || currentThreshold;
                            body.low_vol_fallback_dc = parseInt($("#lowVolFallbackDc")?.value) || 2;
                            const freshDc = getSelectedDcCounts("#dcToggleGrid");
                            if (freshDc.length) {
                                body.dc_counts = freshDc;
                                body.strategy = freshDc.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                            }
                            alertEl.style.display = "none";
                            _executeAssortment(body);
                        };
                    };
                    bindAlertEvents(threshold);
                    const dcGrids = document.querySelectorAll("#dcToggleGrid .dc-toggle-btn");
                    const onDcChange = () => {
                        const freshDc = getSelectedDcCounts("#dcToggleGrid");
                        if (!freshDc.length) return;
                        const newThreshold = Math.min(...freshDc);
                        const newLowVol = dist.filter(f => (f.factory_cube || 0) / divisor < newThreshold);
                        if (!newLowVol.length) {
                            alertEl.style.display = "none";
                            body.dc_counts = freshDc;
                            body.strategy = freshDc.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                            body.min_containers = newThreshold;
                            _executeAssortment(body);
                            return;
                        }
                        alertEl.innerHTML = renderAlert(newThreshold, newLowVol);
                        body.dc_counts = freshDc;
                        body.strategy = freshDc.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                        bindAlertEvents(newThreshold);
                    };
                    dcGrids.forEach(btn => btn.addEventListener("click", onDcChange));
                    return;
                }
            }
        }

        _executeAssortment(body);
    }

    let lastAssortmentConfig = null;
    let lastAssortmentResults = null;
    let forceRedetermine = false;

    // Running allocation for a factory with no valid assortment mapping is
    // guaranteed to fail the allocation validations — block "Confirm & Run
    // Allocation" instead of letting the user hit that wall downstream.
    // unmapped_options (from FACTORY_UNMAPPED_OPTIONS) is the authoritative
    // source now: it's only populated for factories whose tier had zero
    // fully-priced campus list candidates (the "one list per tier, no
    // exceptions" rule left them without an automatic assignment) — for each,
    // it lists that factory's own best assortment plus every other tier's
    // already-chosen list that prices for all of its SKUs, with expense only
    // (utilization isn't computed per option — it'll show once allocation
    // actually runs on whichever option gets picked).
    function applyConfirmGate(apiResult) {
        const options = apiResult?.unmapped_options || [];
        const byFactory = {};
        for (const o of options) {
            (byFactory[o.FACTORY_ID] = byFactory[o.FACTORY_ID] || []).push(o);
        }
        const unmappedIds = Object.keys(byFactory);
        const warnEl = $("#asmtUnmappedWarning");
        if (unmappedIds.length) {
            if (warnEl) {
                let html = `<i class="fas fa-triangle-exclamation"></i> Factor${unmappedIds.length === 1 ? "y" : "ies"} `
                    + `${unmappedIds.join(", ")} ${unmappedIds.length === 1 ? "has" : "have"} no tier with a campus list priced for `
                    + `all of ${unmappedIds.length === 1 ? "its" : "their"} SKUs — allocation would fail for `
                    + `${unmappedIds.length === 1 ? "it" : "them"} until resolved. Options below (utilization shows once allocation runs):`;
                for (const fid of unmappedIds) {
                    html += `<div style="margin-top:8px;padding-top:8px;border-top:1px solid #dc3545"><b>Factory ${fid}</b><ul style="margin:4px 0 0 18px;padding:0">`;
                    for (const o of byFactory[fid]) {
                        const label = o.OPTION_TYPE === "OWN"
                            ? "Its own best assortment"
                            : `Tier ${o.SOURCE_DC_COUNT}'s assortment`;
                        html += `<li>${label} (${o.CAMPUS_DC_LIST}) — ${o.TOTAL_EXP != null ? "$" + Number(o.TOTAL_EXP).toLocaleString("en-US") : "—"}</li>`;
                    }
                    html += `</ul></div>`;
                }
                html += `<div style="margin-top:8px">Adjust your DC filters/strategy on Step 2 and redetermine, or pick one of the options above once selection is available.</div>`;
                warnEl.style.display = "block";
                warnEl.innerHTML = html;
            }
            $("#btnConfirmAsmt").disabled = true;
            return false;
        }
        if (warnEl) warnEl.style.display = "none";
        $("#btnConfirmAsmt").disabled = !(apiResult?.results || []).length;
        return true;
    }

    async function _executeAssortment(body) {
        const snapshot = JSON.stringify(body);
        const useCache = !forceRedetermine && lastAssortmentResults && snapshot === lastAssortmentConfig;
        forceRedetermine = false; // consumed once, regardless of path taken below

        if (useCache) {
            assortmentResults = lastAssortmentResults.results || [];
            renderAssortmentTable(assortmentResults, lastAssortmentResults.strategy_type || selectedStrategy, lastAssortmentResults);
            goStep(7);
            if ($("#asmtCachedBanner")) $("#asmtCachedBanner").style.display = "flex";
            applyConfirmGate(lastAssortmentResults);
            return;
        }

        if ($("#asmtCachedBanner")) $("#asmtCachedBanner").style.display = "none";
        showLoading("Determining assortment IDs…");
        // Disable the button for the whole submit+poll — the dynamic sweep can
        // run from ~40s to several minutes, and clicking again mid-run used to
        // start a second procedure call racing the first one on the same shared
        // BigQuery scratch tables (one lost the race and errored outright; the
        // other could have silently picked up a partial write from the loser).
        const detBtnEl = $("#btnDetermineAsmt");
        if (detBtnEl) detBtnEl.disabled = true;
        try {
            const started = await api("/api/determine_assortment_start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            let result;
            if (started.job_id) {
                // Long-running dynamic sweep — poll instead of holding one HTTP
                // request open for the whole thing. A single multi-minute fetch
                // doesn't reliably survive a proxy/browser connection timeout,
                // which is what caused "Failed to fetch" here before even
                // though the query kept running fine server-side.
                const startedAt = Date.now();
                while (true) {
                    await new Promise(res => setTimeout(res, 3000));
                    const elapsed = Math.round((Date.now() - startedAt) / 1000);
                    showLoading(`Determining assortment IDs… (${elapsed}s)`);
                    const status = await api("/api/determine_assortment_status?job_id=" + encodeURIComponent(started.job_id));
                    if (status.error) throw new Error(status.error);
                    if (status.done) {
                        result = status.sync_result;
                        break;
                    }
                }
            } else {
                result = started.sync_result;
            }

            assortmentResults = result.results || [];
            renderAssortmentTable(assortmentResults, result.strategy_type || selectedStrategy, result);
            goStep(7);
            lastAssortmentConfig = snapshot;
            lastAssortmentResults = result;
            const detBtn = $("#btnDetermineAsmt");
            if (detBtn) detBtn.innerHTML = '<i class="fas fa-search"></i> Determine Assortment IDs <i class="fas fa-arrow-right"></i>';

            const ok = applyConfirmGate(result);
            if (assortmentResults.length && ok) {
                toast(`Found ${assortmentResults.length} SKU assignments`, "success");
            } else if (!assortmentResults.length) {
                toast("No assortment results returned", "info");
            }
        } catch (e) {
            toast("Assortment determination failed: " + e.message, "error");
        } finally {
            hideLoading();
            if (detBtnEl) detBtnEl.disabled = false;
        }
    }

    let vendorPieChart = null;

    function renderVendorPieChart(matches) {
        const chartContainer = $("#vendorChartContainer");
        if (!matches || !matches.length) { chartContainer.style.display = "none"; return; }
        chartContainer.style.display = "block";
        if (vendorPieChart) vendorPieChart.destroy();
        // Aggregate supplier count per vendor
        const vendorCounts = {};
        for (const m of matches) {
            const v = m.VENDOR || m.vendor || "Unknown";
            vendorCounts[v] = (vendorCounts[v] || 0) + 1;
        }
        const labels = Object.keys(vendorCounts);
        const data = Object.values(vendorCounts);
        const colors = ["#f96302", "#003865", "#4CAF50", "#FFC107", "#9C27B0", "#00BCD4", "#E91E63", "#795548", "#607D8B", "#FF5722"];
        vendorPieChart = new Chart($("#vendorPieChart"), {
            type: "pie",
            data: { labels, datasets: [{ data, backgroundColor: colors.slice(0, labels.length) }] },
            options: {
                plugins: {
                    legend: { position: "bottom" },
                    tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.raw} supplier(s)` } },
                },
            },
        });
    }

    function renderAssortmentTable(rows, strategyType, apiResult) {
        const thead = $("#asmtTable thead tr");
        const tbody = $("#asmtTableBody");
        tbody.innerHTML = "";
        const chartContainer = $("#vendorChartContainerResults");

        if (strategyType === "MULTI_DC" && apiResult) {
            chartContainer.style.display = "none";
            thead.innerHTML = "";

            const fmt$ = v => v != null ? "$" + Number(v).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}) : "—";
            const fmtN = v => v != null ? Number(v).toLocaleString("en-US") : "—";
            const fmtD = (v, d) => v != null ? Number(v).toLocaleString("en-US", {minimumFractionDigits: d, maximumFractionDigits: d}) : "—";

            const tierSummary = apiResult.tier_summary || [];
            const dcFactoryDetail = apiResult.dc_factory_detail || [];
            const C = 12; // colspan for full-width rows

            let html = "";

            // ── Table 1: High-Level Summary ──
            html += `<tr><td colspan="${C}" style="background:var(--hd-orange);color:#fff;font-weight:700;padding:10px;font-size:1rem">High-Level Summary</td></tr>`;
            html += `<tr style="background:var(--hd-bg);font-weight:600">
                <td>DC Tier</td><td style="text-align:right">THD Keys</td><td style="text-align:right">Buy Units</td>
                <td style="text-align:right">Delivery Expense</td><td style="text-align:right">Unit Del. Exp</td>
                <td style="text-align:right">SLA</td><td style="text-align:right" colspan="4">Cube/Unit</td></tr>`;
            let tKeys=0,tBuy=0,tExp=0,tSla=0;
            for (const r of tierSummary) {
                tKeys+=r.THD_KEYS||0; tBuy+=r.BUY_UNITS||0; tExp+=r.DELIVERY_EXPENSE||0; tSla+=(r.SLA||0)*(r.BUY_UNITS||0);
                html += `<tr>
                    <td style="text-align:center;font-weight:600">${r.DC_TIER}</td>
                    <td style="text-align:right">${fmtN(r.THD_KEYS)}</td>
                    <td style="text-align:right">${fmtN(r.BUY_UNITS)}</td>
                    <td style="text-align:right">${fmt$(r.DELIVERY_EXPENSE)}</td>
                    <td style="text-align:right">${fmt$(r.UNIT_DELIVERY_EXP)}</td>
                    <td style="text-align:right">${fmtD(r.SLA,2)}</td>
                    <td style="text-align:right" colspan="4">${fmtD(r.CUBE_PER_UNIT,2)}</td></tr>`;
            }
            html += `<tr style="font-weight:700;border-top:2px solid #333">
                <td>Total</td><td style="text-align:right">${fmtN(tKeys)}</td><td style="text-align:right">${fmtN(tBuy)}</td>
                <td style="text-align:right">${fmt$(tExp)}</td><td style="text-align:right">${fmt$(tBuy?tExp/tBuy:0)}</td>
                <td style="text-align:right">${fmtD(tBuy?tSla/tBuy:0,2)}</td><td colspan="4"></td></tr>`;

            // ── Table 2: Factory & DC List Detail (expandable by tier) —
            // combines the former separate DC List Detail / Factory Detail
            // tables. Grain is (tier, DC list, factory): the D7 fallback can
            // now legitimately put a factory's SKUs on more than one DC_LIST
            // within its own tier, which neither table alone could show without
            // either splitting a factory's row or blending factories together.
            html += `<tr><td colspan="${C}">&nbsp;</td></tr>`;
            html += `<tr><td colspan="${C}" style="background:var(--hd-orange);color:#fff;font-weight:700;padding:10px;font-size:1rem">Factory & DC List Detail</td></tr>`;
            html += `<tr style="background:var(--hd-bg);font-weight:600">
                <td>DC Tier</td><td>Campus DCs</td><td>DC List</td><td>DC Names</td><td>Factory ID</td>
                <td style="text-align:right">Containers</td><td style="text-align:right">THD Keys</td>
                <td style="text-align:right">Buy Units</td>
                <td style="text-align:right">Del. Expense</td><td style="text-align:right">Unit Del. Exp</td>
                <td style="text-align:right">SLA</td><td style="text-align:right">Cube/Unit</td></tr>`;
            const dfTiers = [...new Set(dcFactoryDetail.map(d => d.DC_TIER))];
            let dfBuy=0,dfExp=0,dfSla=0,dfCont=0,dfKeys=0;
            for (const tier of dfTiers) {
                const tRows = dcFactoryDetail.filter(d => d.DC_TIER === tier);
                const sub = tRows.reduce((a,d) => ({keys:a.keys+(d.THD_KEYS||0),buy:a.buy+(d.BUY_UNITS||0),exp:a.exp+(d.DELIVERY_EXPENSE||0),sla:a.sla+(d.SLA||0)*(d.BUY_UNITS||0),cont:a.cont+(d.CONTAINERS||0),cubeSum:a.cubeSum+(d.CUBE_PER_UNIT||0)}),{keys:0,buy:0,exp:0,sla:0,cont:0,cubeSum:0});
                // Overarching Cube/Unit: that one row's value if there's only
                // one, otherwise the average across the rows under this tier.
                const cubeAvg = tRows.length ? sub.cubeSum / tRows.length : 0;
                dfKeys+=sub.keys; dfBuy+=sub.buy; dfExp+=sub.exp; dfSla+=sub.sla; dfCont+=sub.cont;
                const gid = `dcfac_tier_${tier}`;
                // Every row under a tier shares the same Campus DC List (one
                // distinct winning campus list per tier, enforced by the
                // coverage-gated selection) — safe to read off the first row
                // and show once at the rollup level, not left blank.
                const campusList = tRows[0]?.CAMPUS_DC_LIST || "—";
                // The expand/collapse control lives on DC List (not DC Tier) —
                // DC Tier is a plain value, the row count is what's expanding.
                html += `<tr style="font-weight:600;background:#f9f9f9;cursor:pointer" onclick="document.querySelectorAll('.${gid}').forEach(r=>r.style.display=r.style.display==='none'?'':'none');this.querySelector('.tog').textContent=this.querySelector('.tog').textContent==='▶'?'▼':'▶'">
                    <td style="text-align:center">${tier}</td>
                    <td style="font-size:0.85rem">${campusList}</td>
                    <td><span class="tog">▶</span> ${tRows.length} row${tRows.length === 1 ? "" : "s"}</td><td></td><td></td>
                    <td style="text-align:right">${fmtD(sub.cont,2)}</td><td style="text-align:right">${fmtN(sub.keys)}</td>
                    <td style="text-align:right">${fmtN(sub.buy)}</td>
                    <td style="text-align:right">${fmt$(sub.exp)}</td><td style="text-align:right">${fmt$(sub.buy?sub.exp/sub.buy:0)}</td>
                    <td style="text-align:right">${fmtD(sub.buy?sub.sla/sub.buy:0,2)}</td><td style="text-align:right">${fmtD(cubeAvg,2)}</td></tr>`;
                for (const r of tRows) {
                    html += `<tr class="${gid}" style="display:none">
                        <td></td>
                        <td style="font-size:0.85rem">${r.CAMPUS_DC_LIST||'—'}</td>
                        <td style="font-size:0.85rem">${r.DC_LIST||'—'}</td>
                        <td style="font-size:0.85rem">${r.DC_NM_LIST||'—'}</td>
                        <td>${r.FACTORY_ID||'—'}</td>
                        <td style="text-align:right">${fmtD(r.CONTAINERS,2)}</td><td style="text-align:right">${fmtN(r.THD_KEYS)}</td>
                        <td style="text-align:right">${fmtN(r.BUY_UNITS)}</td>
                        <td style="text-align:right">${fmt$(r.DELIVERY_EXPENSE)}</td><td style="text-align:right">${fmt$(r.UNIT_DELIVERY_EXP)}</td>
                        <td style="text-align:right">${fmtD(r.SLA,2)}</td><td style="text-align:right">${fmtD(r.CUBE_PER_UNIT,2)}</td></tr>`;
                }
            }
            html += `<tr style="font-weight:700;border-top:2px solid #333">
                <td>Grand Total</td><td></td><td></td><td></td><td></td>
                <td style="text-align:right">${fmtD(dfCont,2)}</td><td style="text-align:right">${fmtN(dfKeys)}</td>
                <td style="text-align:right">${fmtN(dfBuy)}</td>
                <td style="text-align:right">${fmt$(dfExp)}</td><td style="text-align:right">${fmt$(dfBuy?dfExp/dfBuy:0)}</td>
                <td style="text-align:right">${fmtD(dfBuy?dfSla/dfBuy:0,2)}</td><td></td></tr>`;

            // ── Table 4: Utilization Detail — the actual proof the chosen DC count
            // achieves good container utilization, not just low expense. Populated
            // for both dynamic mode (the §6 decision) and explicit-tier mode
            // (reporting only, since there the tier was your own choice).
            const utilChoice = apiResult.utilization_choice || [];
            // Order by containers desc (largest factories first) — CONTAINERS
            // itself isn't on FACTORY_UTILIZATION_CHOICE, so look it up from
            // dc_factory_detail, keyed by (FACTORY_ID, DC_TIER==ASSIGNED_DC_COUNT).
            // A factory can have multiple dc_factory_detail rows for one tier
            // (one per DC_LIST it resolved onto — see the D7 fallback), so sum
            // rather than overwrite.
            const containersByFactoryTier = {};
            for (const f of dcFactoryDetail) {
                const key = `${f.FACTORY_ID}|${f.DC_TIER}`;
                containersByFactoryTier[key] = (containersByFactoryTier[key] || 0) + (f.CONTAINERS || 0);
            }
            utilChoice.sort((a, b) => {
                const ca = containersByFactoryTier[`${a.FACTORY_ID}|${a.ASSIGNED_DC_COUNT}`] || 0;
                const cb = containersByFactoryTier[`${b.FACTORY_ID}|${b.ASSIGNED_DC_COUNT}`] || 0;
                return cb - ca;
            });
            // Why a factory shows "No": MEETS_UTIL/MEETS_EXP split the combined
            // MEETS_TARGET check back into its two components (utilization floor,
            // expense tolerance vs. this factory's own cheapest option) so the
            // failure reason is visible instead of just the pass/fail flag.
            // MEETS_EXP is NULL (not "not applicable" = true) in explicit-tier
            // mode, where no expense-tolerance check is evaluated at all.
            function explainMiss(r) {
                const failedUtil = r.MEETS_UTIL === false;
                const failedExp = r.MEETS_EXP === false;
                if (!failedUtil && !failedExp) return "";
                const parts = [];
                if (failedUtil) {
                    parts.push(`utilization (${r.UTIL_DC_PCT != null ? r.UTIL_DC_PCT + "%" : "—"}) is below the target`);
                }
                if (failedExp) {
                    const pct = (r.FLOOR_EXP > 0) ? Math.round((r.FACT_EXP / r.FLOOR_EXP - 1) * 1000) / 10 : null;
                    parts.push(`expense (${fmt$(r.FACT_EXP)}) is ${pct != null ? pct + "% " : ""}above this factory's cheapest option${r.FLOOR_EXP != null ? " (" + fmt$(r.FLOOR_EXP) + ")" : ""}, outside tolerance`);
                }
                return parts.join(" and ");
            }
            if (utilChoice.length) {
                html += `<tr><td colspan="${C}">&nbsp;</td></tr>`;
                html += `<tr><td colspan="${C}" style="background:var(--hd-orange);color:#fff;font-weight:700;padding:10px;font-size:1rem">Utilization Detail</td></tr>`;
                html += `<tr style="background:var(--hd-bg);font-weight:600">
                    <td>Factory ID</td><td style="text-align:right">DC Count</td>
                    <td style="text-align:right">Utilization %</td><td style="text-align:right">Expense</td>
                    <td>Meets Target</td><td>Assortment</td></tr>`;
                for (const r of utilChoice) {
                    const meets = r.MEETS_TARGET === true;
                    const unmapped = r.UNMAPPED === true;
                    const reason = meets ? "" : explainMiss(r);
                    html += `<tr>
                        <td>${r.FACTORY_ID}</td><td style="text-align:right">${fmtN(r.ASSIGNED_DC_COUNT)}</td>
                        <td style="text-align:right">${r.UTIL_DC_PCT != null ? r.UTIL_DC_PCT + "%" : "—"}</td>
                        <td style="text-align:right">${fmt$(r.FACT_EXP)}</td>
                        <td>${unmapped
                            ? '—'
                            : meets
                            ? '<i class="fas fa-check-circle" style="color:#28a745"></i> Yes'
                            : `<span title="${reason.replace(/"/g, "&quot;")}"><i class="fas fa-times-circle" style="color:#c00"></i> No <i class="fas fa-circle-question" style="color:#999;font-size:0.8em"></i></span>`}</td>
                        <td>${unmapped
                            ? '<span title="No tier has a campus list priced for all of this factory\'s SKUs — see the options above the results table." style="color:#c00"><i class="fas fa-triangle-exclamation"></i> Unmapped</span>'
                            : 'Shared tier list'}</td></tr>`;
                    if (!unmapped && !meets && reason) {
                        html += `<tr><td></td><td colspan="${C - 1}" style="color:#c00;font-size:0.8rem;padding:2px 10px 8px">${reason}</td></tr>`;
                    }
                }
            }

            tbody.innerHTML = html;
            return;
        }

        if (strategyType === "VENDOR_ALIGNED") {
            chartContainer.style.display = "block";
            thead.innerHTML = "<th>Vendor</th><th>THD Keys</th><th>DC Count</th><th>DC List</th><th>DC Names</th>";
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#666;padding:20px">No results</td></tr>';
                chartContainer.style.display = "none";
                return;
            }
            for (const r of rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${r.VENDOR || "—"}</td>
                    <td style="text-align:center">${r.SKU_COUNT ?? "—"}</td>
                    <td>${r.DC_COUNT ?? "—"}</td>
                    <td>${r.DC_LIST || "—"}</td>
                    <td>${r.DC_NM_LIST || "—"}</td>
                `;
                tbody.appendChild(tr);
            }

            // Pie chart on results page
            let resultsChart = chartContainer._chartInstance;
            if (resultsChart) resultsChart.destroy();
            const labels = rows.map(r => r.VENDOR);
            const data = rows.map(r => r.SKU_COUNT || 0);
            const colors = ["#f96302", "#003865", "#4CAF50", "#FFC107", "#9C27B0", "#00BCD4", "#E91E63", "#795548", "#607D8B", "#FF5722"];
            chartContainer._chartInstance = new Chart($("#vendorPieChartResults"), {
                type: "pie",
                data: {
                    labels,
                    datasets: [{ data, backgroundColor: colors.slice(0, labels.length) }],
                },
                options: {
                    plugins: {
                        legend: { position: "bottom" },
                        tooltip: { callbacks: { label: ctx => `${ctx.label}: ${ctx.raw} THD keys` } },
                    },
                },
            });
        } else {
            chartContainer.style.display = "none";
            thead.innerHTML = "<th>SKU_NBR</th><th>DC_COUNT</th><th>DC_LIST</th><th>CAMPUS_DC_LIST</th><th>TOTAL_EXP</th><th>TOTAL_SLA</th><th>ASMT_ID</th>";
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#666;padding:20px">No results</td></tr>';
                return;
            }
            for (const r of rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${r.SKU_NBR || "—"}</td>
                    <td>${r.ASSIGNED_DC_COUNT ?? "—"}</td>
                    <td>${r.DC_LIST || "—"}</td>
                    <td>${r.CAMPUS_DC_LIST || "—"}</td>
                    <td style="text-align:right">${r.TOTAL_EXP != null ? fmtNum(r.TOTAL_EXP) : "—"}</td>
                    <td style="text-align:right">${r.TOTAL_SLA != null ? fmtNum(r.TOTAL_SLA) : "—"}</td>
                    <td>${r.ASMT_ID || "—"}</td>
                `;
                tbody.appendChild(tr);
            }
        }
    }

    // ── Section 6: Run Allocation ──────────────────────────────────
    function setupAllocation() {
        $("#btnConfirmAsmt")?.addEventListener("click", runAllocation);
    }

    async function runAllocation() {
        showLoading("Executing allocation procedure…");

        const body = {
            strategy: selectedStrategy,
            event_name: eventName,
            wave_count: waveCount,
            run_id: $("#stratRunId")?.value?.trim() || "",
            email: $("#stratEmail")?.value?.trim() || "",
        };

        if (selectedStrategy === "VENDOR_ALIGNED") {
            body.sku_grp = $("#stratSkuGrp")?.value?.trim() || "";
        } else if (selectedStrategy === "DC_SELECTION" || selectedStrategy === "SINGLE_DC" || selectedStrategy === "MULTI_DC") {
            const dynamicMode = multiDcDynamicSelected && includesImports;
            if (dynamicMode) {
                body.strategy = "MULTI_DC";
                body.dc_counts = [];
            } else {
                const dcCounts = getSelectedDcCounts("#dcToggleGrid");
                const checkboxSelected = [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount));
                const sel = dcCounts.length ? dcCounts : checkboxSelected;
                body.strategy = sel.length === 1 ? "SINGLE_DC" : "MULTI_DC";
                body.dc_counts = sel;
            }
            body.is_import = includesImports;
            body.sku_grp = $("#stratSkuGrp")?.value?.trim() || "";
            body.campus_pairs = campusPairs;
            body.dc_inclusions = dcInclusions;
            body.dc_exclusions = dcExclusions;
        }

        try {
            const result = await api("/api/run_allocation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (result.success) {
                toast("Allocation completed!", "success");
                goStep(8); // straight to the renamed Allocation step, no intermediate click
            } else {
                throw new Error(result.error || "Allocation failed");
            }
        } catch (e) {
            toast("Allocation failed: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    // ── Section 7: Results ─────────────────────────────────────────
    async function loadResults() {
        showLoading("Loading allocation results…");
        try {
            await Promise.all([loadResultsKPIs(), loadResultsTable(), loadResultsValidation(), loadFactorySummary()]);
        } finally {
            hideLoading();
        }
    }

    async function loadFactorySummary() {
        const section = $("#factorySummarySection");
        try {
            const divisor = getContainerDivisor();
            const result = await api(`/api/factory_summary?divisor=${divisor}`);
            const data = result.data || [];
            if (!data.length) { section.style.display = "none"; return; }
            section.style.display = "block";
            const tbody = $("#factorySummaryBody");
            tbody.innerHTML = "";
            let gPoCube = 0, gLaneCount = 0, gRaw = 0, gRounded = 0, gLcl = 0;
            for (const r of data) {
                const lclPct = r.lcl_pct || 0;
                const utilPct = r.util_pct || 0;
                const cumPct = r.cumulative_pct || 0;
                const lclColor = lclPct <= 0.20 ? "#c6efce" : "#ffc7ce";
                const utilColor = utilPct >= 0.70 ? "#c6efce" : "#ffc7ce";
                gPoCube += r.po_cube || 0; gLaneCount += r.lane_count || 0;
                gRaw += r.raw_container || 0; gRounded += r.rounded_container || 0;
                gLcl += r.lcl_containers || 0;
                const tr = document.createElement("tr");
                tr.innerHTML = `
                    <td>${r.factory}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(r.po_cube)}</td>
                    <td style="text-align:right">${r.lane_count}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${r.raw_container?.toFixed(1) ?? "—"}</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(r.rounded_container)}</td>
                    <td style="text-align:right">${r.lcl_containers}</td>
                    <td style="text-align:right;background:${lclColor}">${Math.round(lclPct * 100)}%</td>
                    <td style="text-align:right;background:${utilColor}">${(utilPct * 100).toFixed(1)}%</td>
                    <td style="text-align:right;font-variant-numeric:tabular-nums">${Math.round(cumPct * 100)}%</td>`;
                tbody.appendChild(tr);
            }
            const gLclPct = gRounded ? gLcl / gRounded : 0;
            const gUtilPct = gRounded ? gRaw / gRounded : 0;
            const totalRow = document.createElement("tr");
            totalRow.style.fontWeight = "700";
            totalRow.style.borderTop = "2px solid #333";
            totalRow.innerHTML = `
                <td>Grand Total</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(gPoCube)}</td>
                <td style="text-align:right">${fmtNum(gLaneCount)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${gRaw.toFixed(1)}</td>
                <td style="text-align:right;font-variant-numeric:tabular-nums">${fmtNum(gRounded)}</td>
                <td style="text-align:right">${fmtNum(gLcl)}</td>
                <td style="text-align:right">${Math.round(gLclPct * 100)}%</td>
                <td style="text-align:right">${(gUtilPct * 100).toFixed(1)}%</td>
                <td></td>`;
            tbody.appendChild(totalRow);
        } catch (e) {
            section.style.display = "none";
            console.error("Factory summary error:", e);
        }
    }

    async function loadResultsKPIs() {
        try {
            const s = await api("/api/results_summary");
            $("#rKpiSkus").textContent = fmtNum(s.total_skus);
            $("#rKpiUnits").textContent = fmtNum(s.total_buy_units);
            $("#rKpiDcs").textContent = fmtNum(s.total_dcs);
            $("#rKpiFactories").textContent = fmtNum(s.unique_factories);
        } catch (e) {
            console.error("KPI error:", e);
        }
    }

    async function loadResultsTable() {
        try {
            const p = new URLSearchParams();
            p.set("page", resultsPage);
            p.set("page_size", PAGE_SIZE);
            p.set("sort", resultsSort);
            p.set("dir", resultsDir);
            const result = await api(`/api/results?${p}`);
            const total = result.total || 0;
            renderResultsTable(result.data || []);
            const totalPages = Math.ceil(total / PAGE_SIZE);
            renderResultsPagination(result.has_more, result.page, totalPages, total);
        } catch (e) {
            console.error("Results table error:", e);
        }
    }

    function renderResultsTable(data) {
        const headRow = $("#resultsHead");
        headRow.innerHTML = "";
        for (const col of RESULT_COLUMNS) {
            const th = document.createElement("th");
            th.textContent = col.label;
            th.dataset.col = col.key;
            if (resultsSort === col.key) th.textContent += resultsDir === "ASC" ? " ▲" : " ▼";
            th.addEventListener("click", () => {
                if (resultsSort === col.key) resultsDir = resultsDir === "ASC" ? "DESC" : "ASC";
                else { resultsSort = col.key; resultsDir = "ASC"; }
                resultsPage = 1;
                loadResultsTable();
            });
            headRow.appendChild(th);
        }

        const tbody = $("#resultsBody");
        tbody.innerHTML = "";
        if (!data.length) {
            tbody.innerHTML = `<tr><td colspan="${RESULT_COLUMNS.length}" style="text-align:center;color:#666;padding:30px">No results</td></tr>`;
            return;
        }
        for (const row of data) {
            const tr = document.createElement("tr");
            for (const col of RESULT_COLUMNS) {
                const td = document.createElement("td");
                td.textContent = fmtCell(row[col.key], col.fmt);
                if (col.fmt === "number" || col.fmt === "pct") {
                    td.style.textAlign = "right";
                    td.style.fontVariantNumeric = "tabular-nums";
                }
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
    }

    function renderResultsPagination(hasMore, page, totalPages, total) {
        $("#resultRecordCount").textContent = total ? `${fmtNum(total)} records — download CSV for full detail` : "";

        const el = $("#resultsPagination");
        el.innerHTML = "";
        const prev = document.createElement("button");
        prev.className = "page-btn";
        prev.textContent = "‹";
        prev.disabled = page <= 1;
        prev.addEventListener("click", () => { resultsPage--; loadResultsTable(); });
        el.appendChild(prev);

        const info = document.createElement("span");
        info.className = "page-info";
        info.textContent = `Page ${page} of ${totalPages}`;
        el.appendChild(info);

        const next = document.createElement("button");
        next.className = "page-btn";
        next.textContent = "›";
        next.disabled = !hasMore;
        next.addEventListener("click", () => { resultsPage++; loadResultsTable(); });
        el.appendChild(next);
    }

    async function loadResultsValidation() {
        try {
            const result = await api("/api/results_validation");
            const container = $("#postValidation");
            container.innerHTML = "";
            for (const c of (result.checks || [])) {
                const badge = document.createElement("span");
                badge.className = `validation-badge ${c.passed ? 'badge-pass' : 'badge-fail'}`;
                badge.innerHTML = `<i class="fas fa-${c.passed ? 'check' : 'times'}-circle"></i> ${c.name}: ${c.detail}`;
                container.appendChild(badge);
            }
        } catch (e) {
            console.error("Post-validation error:", e);
        }
    }

    function setupExport() {
        $("#btnExportCSV")?.addEventListener("click", () => {
            window.location.href = "/api/export_results";
        });
    }

    // ── Initialize ─────────────────────────────────────────────────
    async function init() {
        try {
            const u = await api("/api/user_info");
            ldapUser = u.ldap_user_id || "";
            userEmail = u.email || "";
            $("#userBadge").innerHTML = `<i class="fas fa-user"></i> ${ldapUser || "—"}`;
        } catch { /* ok */ }

        setupStepperClicks();
        setupTemplateDownload();
        setupPriorYearStrategy();
        setupFileUpload();
        setupBqValidation();
        setupInsert();
        setupAsmtTool();
        setupStrategy();
        setupAllocation();
        setupExport();
    }

    document.addEventListener("DOMContentLoaded", init);
})();
