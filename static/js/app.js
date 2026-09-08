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
    // Whether the current upload's rows are already written to
    // EVENTS_SKU_LIST — the write happens on Confirm (Vendor-Aligned) or on
    // Step 2's own Next click (DC Selection, which has no separate confirm
    // step), never automatically at upload time. Reset on every new upload.
    let dataInserted = false;
    // The most recent successful /api/prior_year_strategy lookup from Step 1
    // (null if none found yet, or the last check came back empty) — Step 2
    // reads this to offer "Follow last year's strategy?".
    let lastPriorYearStrategy = null;
    // Which lastPriorYearStrategy object (by reference) has already had its
    // "Follow last year's strategy?" default applied — lets a fresh lookup
    // default to checked without re-checking a box the user just unchecked
    // for that same lookup.
    let followLastYearAppliedFor = null;
    // "name|year|isImport" key of the last combination auto-checked for a
    // prior-year match on arrival at Step 2 — avoids re-fetching every time
    // the user revisits Step 2 with the same Step 1 inputs. Set by
    // triggerAutoPriorYearCheck (assigned in setupPriorYearStrategy).
    let autoPriorYearCheckedFor = null;
    let triggerAutoPriorYearCheck = null;
    // True while triggerAutoPriorYearCheck's lookup is in flight — Next is
    // blocked during this window so the user can't proceed a beat before
    // the prior-year strategy (e.g. Vendor-Aligned) actually gets selected.
    let priorYearCheckInFlight = false;
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

    // Display labels for whichever extra column(s) _determine_thd_key (server side)
    // adds beyond THD_SKU_NBR to make an upload's rows distinct — surfaced in the
    // merged-SKU detail rows in Step 3. Falls back to the raw column name for one
    // not listed here.
    const KEY_FIELD_LABELS = {
        MVNDR_NBR: "MVNDR",
        FACTORY_ID: "Factory",
        SUPPLIER: "Supplier",
        BP: "BP",
        WAVE_1: "Wave 1",
        WAVE_2: "Wave 2",
        WAVE_3: "Wave 3",
        WAVE_4: "Wave 4",
        WAVE_5: "Wave 5",
    };

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
        // Step 2, in case Step 1's lookup changed since last time. Also
        // silently checks for a prior-year match on the user's behalf if
        // they never clicked "View Last Year's Strategy" themselves —
        // refreshFollowLastYearUI() runs again once that resolves.
        if (n === 2) {
            triggerAutoPriorYearCheck?.();
            refreshFollowLastYearUI();
        }

        // Load cost model preview when arriving at step 6
        if (n === 6) loadCostModelPreview();

        // Resume watching the OBC pipeline if it's already running (e.g. it
        // was started earlier and this is a fresh page load) rather than
        // requiring another click on "Run Assortment Tool" just to see status.
        if (n === 6 && !obcPollTimer) pollObcPipelineStatus();

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
                btnText.innerHTML = `<i class="fas fa-download"></i> Download`;
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
            const eventSelect = $("#step1EventNameSelect");
            const eventCustom = $("#step1EventNameCustom");
            const selectedEvent = eventSelect?.value === "__other__" ? eventCustom?.value : eventSelect?.value;
            const eventNameValue = (selectedEvent || eventName || "").trim().toUpperCase();
            const eventYearValue = $("#step1EventYear")?.value?.trim() || String(eventYear || "");
            if (!eventNameValue || !eventYearValue) {
                toast("Enter an Event Name and Event Year before downloading", "error");
                return;
            }
            const params = new URLSearchParams({
                imports: String(includesImports),
                event_name: eventNameValue,
                event_year: eventYearValue,
                _t: String(Date.now()),
            });
            const url = `/api/download_template?${params}`;
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
            const updatePriorYearAvailability = () => {
                const isOther = select.value === "__other__";
                const button = $("#btnCheckPriorStrategy");
                const section = $("#priorStrategySection");
                if (button) button.disabled = isOther;
                if (isOther && section) {
                    section.style.display = "none";
                    section.innerHTML = "";
                }
            };
            try {
                const res = await api("/api/known_event_names");
                const names = res.event_names || [];
                select.innerHTML = names.map(n => `<option value="${n}">${n}</option>`).join("")
                    + `<option value="__other__" class="new-event-option">+ ADD A NEW EVENT…</option>`;
            } catch (e) {
                select.innerHTML = `<option value="__other__" class="new-event-option">+ ADD A NEW EVENT…</option>`;
            }
            select.addEventListener("change", () => {
                const isOther = select.value === "__other__";
                if (customInput) {
                    customInput.style.display = isOther ? "block" : "none";
                    if (isOther) customInput.focus();
                }
                updatePriorYearAvailability();
            });
            updatePriorYearAvailability();
            customInput?.addEventListener("input", () => {
                customInput.value = customInput.value.toUpperCase();
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

        // Shared by the manual "View Last Year's Strategy" click and the
        // silent auto-check triggered on arrival at Step 2 — fetches the
        // prior-year lookup, records it onto lastPriorYearStrategy, and (when
        // Step 1's section is present) renders the same summary card either
        // way, so revisiting Step 1 after an auto-check shows the same thing
        // a manual check would have.
        async function performPriorYearCheck(name, year, isImportVal) {
            const params = new URLSearchParams({ event_name: name, event_year: year });
            if (isImportVal) params.set("is_import", isImportVal);
            const result = await api(`/api/prior_year_strategy?${params}`);
            // Stamp the event type used for this lookup onto the result so
            // Step 2's "Follow last year's strategy?" label can name it
            // without guessing at whatever Step 1's toggle currently shows
            // (which could have changed since this fetch ran).
            lastPriorYearStrategy = result.found ? { ...result, _isImportVal: isImportVal } : null;
            const section = $("#priorStrategySection");
            if (!section) return result;
            section.style.display = "block";
            if (!result.found) {
                section.innerHTML = `<p style="margin:0;color:#666;font-size:.85rem">
                    <i class="fas fa-circle-info"></i> ${name} has no history.</p>`;
                return result;
            }
            const o = result.overall;
            const isVendorAligned = (o.strategy_type || "").toUpperCase() === "VENDOR-ALIGNED";
            const strategyLabel = isVendorAligned ? "Vendor-Aligned Strategy" : (o.strategy_type || "Strategy Not Recorded");
            const countLabel = isVendorAligned ? "Suppliers" : "Assortments";
            // Vendor-aligned rows can list more than one vendor per row (rows
            // sharing an identical DC list are merged) so the supplier count
            // is the number of vendor names across all rows, not the row count.
            const countValue = isVendorAligned
                ? (result.strategy_summary || []).reduce((sum, s) => sum + (s.vendor ? s.vendor.split(", ").length : 0), 0)
                : (result.strategy_summary?.length || 0);
            const eventTypeLabel = isImportVal === "true" ? "IMPORT" : isImportVal === "false" ? "DOMESTIC" : "";
            let html = `<div class="prior-strategy-card">
                <div class="prior-strategy-heading">
                    <div><span class="prior-strategy-kicker">${strategyLabel}</span>
                        <h4><i class="fas fa-calendar-days"></i> <span style="color:var(--hd-orange)">${result.event_year}</span> ${result.event_name}${eventTypeLabel ? " " + eventTypeLabel : ""}</h4></div>
                    <span class="prior-strategy-type">${eventTypeLabel || "—"}</span>
                </div>
                <div class="prior-strategy-metrics">
                    <div><span>${countLabel}</span><strong>${fmtNum(countValue)}</strong></div>
                    <div><span>Total Units</span><strong>${fmtNum(o.total_units)}</strong></div>
                    <div><span>Total Cube (ft&sup3;)</span><strong>${fmtCube(o.total_cube)}</strong></div>
                    <div><span>Total THD Keys</span><strong>${fmtNum(o.distinct_thd_keys)}</strong></div>
                    <div><span>Total DCs Used</span><strong>${fmtNum(o.normalized_dc_count)}</strong></div>
                </div>`;
            if (result.strategy_summary?.length) {
                html += `<div class="prior-strategy-details"><div class="prior-strategy-details-title">${isVendorAligned ? "Vendor DC Details" : "Assortment DC Details"}</div>`;
                for (const s of result.strategy_summary) {
                    const label = isVendorAligned ? (s.vendor || "—") : (s.asmt_id ?? "—");
                    const rowClass = isVendorAligned ? " prior-strategy-detail-row-vendor" : "";
                    const thdKeysCell = isVendorAligned ? `<span>${fmtNum(s.thd_key_count)} THD Keys</span>` : "";
                    html += `<div class="prior-strategy-detail-row${rowClass}"><small title="${s.dc_name_list || s.dc_list || ""}">${s.dc_list || "—"}</small><span>${s.dc_count ?? "—"} DC${s.dc_count === 1 ? "" : "s"}</span><strong>${label}</strong>${thdKeysCell}</div>`;
                }
                html += `</div>`;
            }
            html += `</div>`;
            section.innerHTML = html;
            return result;
        }

        $("#btnCheckPriorStrategy")?.addEventListener("click", async () => {
            if (select?.value === "__other__") {
                toast("Last year's strategy is only available for an existing event", "error");
                return;
            }
            const name = currentEventName();
            const year = yearInput?.value?.trim();
            if (!name || !year) {
                toast("Enter an event name and year first", "error");
                return;
            }
            const isImportVal = document.querySelector('input[name="importToggle"]:checked')?.value;
            showLoading("Checking for a prior year's strategy…");
            try {
                await performPriorYearCheck(name, year, isImportVal);
                autoPriorYearCheckedFor = `${name}|${year}|${isImportVal}`;
            } catch (e) {
                toast("Failed to check prior year strategy: " + e.message, "error");
            } finally {
                hideLoading();
            }
        });

        // Silently runs the same lookup when the user reaches Step 2 without
        // ever clicking "View Last Year's Strategy" — if there's a matching
        // prior-year event, Step 2 pre-fills from it just like a manual check
        // would; if there's no match, this quietly does nothing. Skipped for
        // a brand-new ("__other__") event, which by definition has no history.
        triggerAutoPriorYearCheck = async () => {
            if (select?.value === "__other__") return;
            const name = currentEventName();
            const year = yearInput?.value?.trim();
            if (!name || !year) return;
            const isImportVal = document.querySelector('input[name="importToggle"]:checked')?.value;
            const key = `${name}|${year}|${isImportVal}`;
            if (autoPriorYearCheckedFor === key) return;
            autoPriorYearCheckedFor = key;
            priorYearCheckInFlight = true;
            const nextBtn = $("#btnGoInsert");
            const nextBtnWasDisabled = nextBtn?.disabled;
            if (nextBtn) nextBtn.disabled = true;
            try {
                await performPriorYearCheck(name, year, isImportVal);
            } catch (e) {
                return; // best-effort convenience pre-fill — not worth surfacing an error for
            } finally {
                priorYearCheckInFlight = false;
                if (nextBtn) nextBtn.disabled = nextBtnWasDisabled;
            }
            if (currentStep === 2) refreshFollowLastYearUI();
        };
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
        $("#btnDownloadAnnotatedUpload")?.addEventListener("click", () => {
            window.location.href = "/api/download_annotated_upload";
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
        // A fresh file means whatever was previously inserted for this event
        // no longer reflects what's on screen — the next insert must be real,
        // not skipped as "already done."
        dataInserted = false;

        $("#fileName").textContent = `Selected: ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;

        const formData = new FormData();
        formData.append("file", file);
        formData.append("includes_imports", includesImports.toString());

        // Lets the backend warn if the uploaded file's own EVENT_NAME/
        // EVENT_YEAR don't match what was picked in Step 1 — only meaningful
        // when an *existing* event was selected there, not a freshly typed one.
        const step1EventSelect = $("#step1EventNameSelect");
        const step1EventCustom = $("#step1EventNameCustom");
        const step1IsExistingEvent = !!step1EventSelect && step1EventSelect.value !== "" && step1EventSelect.value !== "__other__";
        formData.append("step1_event_name", step1IsExistingEvent ? step1EventSelect.value : (step1EventCustom?.value || ""));
        formData.append("step1_event_year", $("#step1EventYear")?.value || "");
        formData.append("step1_is_existing_event", step1IsExistingEvent.toString());

        // Reset mismatch alert
        const mismatchEl = $("#importMismatchAlert");
        if (mismatchEl) mismatchEl.style.display = "none";

        showLoading("Validating file…");
        try {
            const result = await api("/api/upload", { method: "POST", body: formData });
            displayValidation(result);
            // EVENTS_SKU_LIST isn't written yet at this point — that now only
            // happens once the user commits (Confirm Vendor Strategies, or
            // Step 2's Next for DC Selection), not just because a file passed
            // validation. Match Suppliers itself doesn't need the insert
            // first (it reads the upload cache directly).
            if (result.passed && !result.import_mismatch && selectedStrategy === "VENDOR_ALIGNED") {
                // If last year's strategy was already identified as
                // Vendor-Aligned (and applied via the "Follow last year's
                // strategy?" checkbox before this upload even happened),
                // there's no reason to make the user click Match Suppliers
                // themselves — run it as soon as there's an upload to match.
                noteVendorAlignedApplied();
                await matchVendorStrategy();
            }
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

        // Available whenever there's something worth reviewing row-by-row —
        // failed rows to fix, or rows the validator silently adjusted.
        const downloadAnnotatedBtn = $("#btnDownloadAnnotatedUpload");
        if (downloadAnnotatedBtn) {
            const hasIssues = (result.errors?.length || 0) > 0 || (result.warnings?.length || 0) > 0;
            downloadAnnotatedBtn.style.display = hasIssues ? "inline-flex" : "none";
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
    // The actual EVENTS_SKU_LIST write is gated behind a commit action —
    // Confirm Vendor Strategies for Vendor-Aligned, or this Next button for
    // DC Selection (which has no separate confirm step) — never automatic
    // just because a file passed validation.
    function setupInsert() {
        $("#btnGoInsert")?.addEventListener("click", async () => {
            if (priorYearCheckInFlight) {
                toast("Still checking last year's strategy — try Next again in a moment", "error");
                return;
            }
            if (!selectedStrategy) {
                toast("Please select a strategy first", "error");
                return;
            }
            if (selectedStrategy === "VENDOR_ALIGNED") {
                if (!vendorStrategyConfirmed) {
                    // Matching already ran automatically once a valid file
                    // was uploaded (see handleFile) — proceeding past this
                    // point without an explicit Confirm click just means
                    // running that same commit now, on the user's behalf,
                    // rather than blocking them on a click they skipped.
                    const confirmed = await confirmVendorStrategy();
                    if (!confirmed) return;
                }
            } else if (!dataInserted) {
                // Holding off on the EVENTS_SKU_LIST write for now — commented
                // out on purpose, not deleted.
                // const inserted = await doInsert(false);
                // if (!inserted) return;
            }
            goStep(6);
        });
    }

    // Shared commit path for Vendor-Aligned: writes the upload to
    // EVENTS_SKU_LIST (if not already done) and submits SKU-level rows into
    // DFC_COST_MODEL_SUBMISSION. Used by the explicit "Confirm Vendor
    // Strategies" button and by Step 2's Next button when the user proceeds
    // without clicking Confirm themselves. Returns whether it succeeded.
    async function confirmVendorStrategy() {
        // Holding off on the EVENTS_SKU_LIST write for now — commented out
        // on purpose, not deleted.
        // if (!dataInserted) {
        //     const inserted = await doInsert(false);
        //     if (!inserted) return false;
        // }
        const submitted = await submitCostModel();
        if (!submitted) return false;
        vendorStrategyConfirmed = true;
        $("#btnConfirmVendorStrategy").disabled = true;
        $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check-circle"></i> Confirmed';
        toast("Vendor strategies confirmed", "success");
        renderVendorPieChart(vendorMatches);
        return true;
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
                const status = $("#autoInsertStatus");
                if (status) {
                    status.style.display = "block";
                    status.innerHTML = `<div class="validation-badge badge-pass">
                        <i class="fas fa-check-circle"></i> ${result.message}
                    </div>`;
                }
                toast("Data inserted successfully!", "success");
                dataInserted = true;
                return true;
            } else if (result.exists) {
                hideLoading();
                if (confirm(`${result.message}\n\nReplace the existing data?`)) {
                    return await doInsert(true);
                }
                toast("Insert cancelled — existing data left in place", "error");
                return false;
            } else {
                throw new Error(result.error || "Insert failed");
            }
        } catch (e) {
            const status = $("#autoInsertStatus");
            if (status) {
                status.style.display = "block";
                status.innerHTML = `<div class="validation-badge badge-fail">
                    <i class="fas fa-times-circle"></i> ${e.message}
                </div>`;
            }
            toast("Insert failed: " + e.message, "error");
            return false;
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
            await ensureVendorMatchesFresh();
            // vendorMatches makes this a true preview of the row set
            // /api/submit_cost_model would actually insert into
            // DFC_COST_MODEL_SUBMISSION (target_dc_count/dc_inclusions/
            // dc_exclusions included) rather than a looser approximation.
            const result = await api("/api/cost_model_preview", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName, vendor_matches: vendorMatches }),
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

            // Reconciliation stat + exceptions — surfaced instead of a
            // per-row expand/collapse, since an upload can run to 1000+ THD
            // keys and scanning every row isn't how anyone actually audits
            // a rollup. Only the SKUs that need a second look show up here:
            // ones built from more than one uploaded row, or resolved from
            // sister-SKU data rather than the THD SKU itself.
            const recon = result.reconciliation;
            const reconEl = $("#skuReconciliation");
            if (reconEl && recon) {
                reconEl.style.display = "block";
                const parts = [`${fmtNum(recon.uploaded_rows)} uploaded row${recon.uploaded_rows === 1 ? "" : "s"} → ${fmtNum(recon.resolved_skus)} SKU${recon.resolved_skus === 1 ? "" : "s"}`];
                if (recon.merged_count) parts.push(`${recon.merged_count} merged`);
                if (recon.sister_sourced_count) parts.push(`${recon.sister_sourced_count} sister-sourced`);
                reconEl.innerHTML = parts.join(" · ");
            }

            const mergedPanel = $("#mergedSkusPanel");
            const mergedSkus = result.merged_skus || [];
            if (mergedPanel) {
                mergedPanel.style.display = mergedSkus.length ? "block" : "none";
                if (mergedSkus.length) {
                    $("#mergedSkusSummary").textContent =
                        `${mergedSkus.length} SKU${mergedSkus.length === 1 ? "" : "s"} merged & units aggregated`;
                    // The extra field(s) beyond THD_SKU_NBR that _determine_thd_key (server side)
                    // needed to make every uploaded row distinct — dynamic because it depends on
                    // what this particular upload actually collides on (e.g. MVNDR_NBR when the
                    // same THD SKU is sourced from more than one vendor).
                    const extraFields = result.thd_key_extra_fields || [];
                    $("#mergedSkusBody").innerHTML = mergedSkus.map(m => {
                        const sourceRows = m.sources.map(s => {
                            const extraParts = extraFields.map(f =>
                                `${KEY_FIELD_LABELS[f] || f} ${s.key_fields?.[f] ?? "—"}`);
                            const detail = [
                                `THD ${s.thd_sku_nbr ?? "—"}`,
                                `Sister ${s.sister_sku_nbr ?? "—"}`,
                                s.sku_desc || "—",
                                ...extraParts,
                            ].join(" · ");
                            return `<div style="padding:4px 0;border-top:1px solid #ffe8a1">`
                                + `${detail} (${fmtNum(s.buy_units)} units${s.is_sister ? ", sister-sourced" : ""})`
                                + `</div>`;
                        }).join("");
                        return `<div style="margin-bottom:8px"><strong>SKU ${m.sku_nbr}</strong> — ${m.sources.length} uploaded rows${sourceRows}</div>`;
                    }).join("");
                }
            }

            const sisterPanel = $("#sisterSourcedPanel");
            const sisterSourcedSkus = result.sister_sourced_skus || [];
            if (sisterPanel) {
                sisterPanel.style.display = sisterSourcedSkus.length ? "block" : "none";
                if (sisterSourcedSkus.length) {
                    $("#sisterSourcedSummary").textContent = `${sisterSourcedSkus.length} SKU${sisterSourcedSkus.length === 1 ? "" : "s"}`;
                    const sisterBody = $("#sisterSourcedBody");
                    sisterBody.innerHTML = "";
                    for (const s of sisterSourcedSkus) {
                        const tr = document.createElement("tr");
                        tr.innerHTML = `<td>${s.sku_nbr}</td><td>${s.thd_sku_nbr ?? "—"}</td><td>${s.sister_sku_nbr ?? "—"}</td><td>${s.sku_desc || "—"}</td>`;
                        sisterBody.appendChild(tr);
                    }
                }
            }

            const tbody = $("#costModelBody");
            tbody.innerHTML = "";
            for (const r of result.rows) {
                const tr = document.createElement("tr");
                tr.innerHTML = `<td>${r.sku_nbr}</td>`
                    + `<td style="text-align:right">${Number(r.buy_qty).toLocaleString()}</td>`
                    + `<td>${r.target_dc_count ?? "—"}</td>`
                    + `<td>${r.dc_inclusions ?? "—"}</td>`
                    + `<td>${r.dc_exclusions ?? "—"}</td>`
                    + `<td>${r.IS_SISTER_SKU_FLAG ? "Sister" : "THD"}</td>`;
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
        $("#btnDeleteCostModel")?.addEventListener("click", () => deleteCostModelSubmission());
        $("#btnRunAsmtTool")?.addEventListener("click", startObcPipeline);
    }

    // ── OBC weekly pipeline (pre-processing → outbound cost → post-processing) ──
    // Replaces the old "open the dashboard and babysit it yourself" link with an
    // in-app trigger + poll loop — the pipeline itself runs server-side in a
    // background thread (it's documented to take "likely a few hours" once
    // outbound cost needs to run), so this just starts it and checks back
    // periodically rather than blocking on it.
    let obcPollTimer = null;

    function renderObcPipelineStatus(state) {
        const el = $("#asmtToolStatus");
        if (!el) return;
        $("#btnRunAsmtTool").disabled = state.status === "running";

        const runLine = state.run_id ? ` — Run ${state.run_id}` : "";
        if (state.status === "running") {
            el.style.display = "block";
            const stageLabel = {
                pre: "Running pre-processing / safety stock calc…",
                outbound_cost: `Calculating outbound costs${state.wave_progress ? ` (wave ${state.wave_progress})` : ""}…`,
                post: "Running post-processing — determining group/SKU recommendations…",
            }[state.stage] || "Running…";
            el.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-spinner fa-spin"></i> ${stageLabel}${runLine}
            </div>`;
        } else if (state.status === "done") {
            el.style.display = "block";
            el.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> Assortment tool complete${runLine}.
            </div>`;
        } else if (state.status === "error") {
            el.style.display = "block";
            el.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                <i class="fas fa-times-circle"></i> Assortment tool failed: ${state.error}
            </div>`;
        } else {
            el.style.display = "none"; // idle — nothing to show yet
        }
    }

    async function pollObcPipelineStatus() {
        try {
            const state = await api("/api/obc_pipeline/status");
            renderObcPipelineStatus(state);
            obcPollTimer = state.status === "running" ? setTimeout(pollObcPipelineStatus, 15000) : null;
        } catch (e) {
            // A transient network hiccup shouldn't kill hours of polling —
            // just try again on the same interval.
            obcPollTimer = setTimeout(pollObcPipelineStatus, 15000);
        }
    }

    async function startObcPipeline() {
        $("#btnRunAsmtTool").disabled = true;
        try {
            const result = await api("/api/obc_pipeline/start", { method: "POST" });
            if (result.error) throw new Error(result.error);
            toast("Assortment tool pipeline started", "success");
        } catch (e) {
            // Already running (409) is fine — just resume watching it instead
            // of treating it as a failure to start.
            if (!/already running/i.test(e.message)) {
                toast("Failed to start assortment tool: " + e.message, "error");
                $("#btnRunAsmtTool").disabled = false;
                return;
            }
        }
        if (obcPollTimer) clearTimeout(obcPollTimer);
        pollObcPipelineStatus();
    }

    async function submitCostModel() {
        showLoading("Submitting to DFC Cost Model…");
        try {
            // matchVendorStrategy() shows/hides its own loading state when it
            // actually has to run — restore ours afterward so the overlay
            // doesn't drop out from under the submit that's still pending.
            await ensureVendorMatchesFresh();
            showLoading("Submitting to DFC Cost Model…");
            const resp = await fetch("/api/submit_cost_model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                // vendor_matches carries Step 2's resolved DC assignments (and
                // any per-SKU overrides) so the submission can populate
                // target_dc_count/dc_inclusions/dc_exclusions instead of
                // leaving them null. Empty for a non-vendor-aligned strategy,
                // where the backend falls back to the old SKU_NBR-only insert.
                body: JSON.stringify({ event_name: eventName, vendor_matches: vendorMatches }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || "Submission failed");

            const passBadge = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> ${result.message}
            </div>`;
            $("#costModelStatus").innerHTML = passBadge;
            if ($("#vendorSubmitStatus")) $("#vendorSubmitStatus").innerHTML = passBadge;
            $("#btnSubmitCostModel").disabled = true;
            $("#btnDeleteVendorCostModel").style.display = "none";
            $("#btnRunAsmtTool").style.display = "inline-flex";
            $("#btnRunAsmtTool").disabled = false;
            toast("Cost model submission complete", "success");
            // The preview above was rendered before this row set actually
            // existed in DFC_COST_MODEL_SUBMISSION — reload it now so it
            // shows the real inserted rows instead of whatever null/estimated
            // state it had before submitting.
            loadCostModelPreview();
            return true;
        } catch (e) {
            const failBadge = `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
            $("#costModelStatus").innerHTML = failBadge;
            if ($("#vendorSubmitStatus")) $("#vendorSubmitStatus").innerHTML = failBadge;
            // Surface the delete option inline wherever this error happened,
            // so the user isn't forced to hunt for it in a different step.
            const alreadySubmitted = /already been submitted/i.test(e.message);
            $("#btnDeleteVendorCostModel").style.display = alreadySubmitted ? "inline-flex" : "none";
            toast("Submission failed: " + e.message, "error");
            return false;
        } finally {
            hideLoading();
        }
    }

    // `silent` skips this function's own confirm dialog and success toast —
    // used by replacePreviousUpload(), which already confirmed with the user
    // and reports its own toast once the resubmit that follows also succeeds.
    async function deleteCostModelSubmission(silent = false) {
        if (!eventName) { toast("No event loaded", "error"); return false; }
        if (!silent && !confirm(`Delete all previous cost model submissions for "${eventName}"?`)) return false;
        showLoading("Deleting previous submission…");
        try {
            const resp = await fetch("/api/delete_cost_model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName }),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) throw new Error(result.error || "Delete failed");
            const passBadge = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> ${result.message}
            </div>`;
            $("#costModelStatus").innerHTML = passBadge;
            if ($("#vendorSubmitStatus")) $("#vendorSubmitStatus").innerHTML = passBadge;
            $("#btnSubmitCostModel").disabled = false;
            $("#btnDeleteVendorCostModel").style.display = "none";
            // Let the user resubmit through the vendor-aligned confirm flow too.
            vendorStrategyConfirmed = false;
            if ($("#btnConfirmVendorStrategy")) {
                $("#btnConfirmVendorStrategy").disabled = false;
                $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check"></i> Confirm Vendor Strategies';
            }
            if (!silent) toast("Previous submission deleted", "success");
            return true;
        } catch (e) {
            const failBadge = `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
            $("#costModelStatus").innerHTML = failBadge;
            if ($("#vendorSubmitStatus")) $("#vendorSubmitStatus").innerHTML = failBadge;
            toast("Delete failed: " + e.message, "error");
            return false;
        } finally {
            hideLoading();
        }
    }

    // Full "Replace Previous Upload" action for the vendor-aligned flow:
    // deletes the prior DFC_COST_MODEL_SUBMISSION rows for this event and
    // immediately resubmits the current upload in their place, so the
    // replacement is complete in one click rather than deferring the
    // resubmit to whenever the user next hits Confirm/Next.
    async function replacePreviousUpload() {
        if (!eventName) { toast("No event loaded", "error"); return; }
        if (!confirm(`Delete the previous cost model submission for "${eventName}" and upload the current data in its place?`)) return;
        const deleted = await deleteCostModelSubmission(true);
        if (!deleted) return;
        const submitted = await submitCostModel();
        if (submitted) {
            vendorStrategyConfirmed = true;
            $("#btnConfirmVendorStrategy").disabled = true;
            $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check-circle"></i> Confirmed';
            toast("Previous submission replaced with current upload", "success");
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
                    // No manual "Match Suppliers" button anymore — if a file's
                    // already been uploaded (whether Vendor-Aligned was just
                    // selected after that upload, or this fires again from
                    // re-selecting it), match right away. But if matches are
                    // already populated (e.g. the user toggled to DC Selection
                    // and back without changing anything), leave them alone —
                    // rematching would needlessly reset the Confirm state.
                    if (eventName) {
                        noteVendorAlignedApplied();
                        if (!vendorMatches.length) matchVendorStrategy();
                    }
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

        // Confirm vendor strategies button — this is the commit point for
        // Vendor-Aligned: it writes this upload to EVENTS_SKU_LIST (deferred
        // until now, not automatic at upload time) and then submits SKU-level
        // rows into DFC_COST_MODEL_SUBMISSION, so a strategy isn't
        // "confirmed" unless both of those actually went through. Shared with
        // Step 2's Next button, which runs this same commit automatically if
        // the user proceeds without clicking Confirm themselves.
        $("#btnConfirmVendorStrategy")?.addEventListener("click", confirmVendorStrategy);
        $("#btnDeleteVendorCostModel")?.addEventListener("click", replacePreviousUpload);

        // Add Vendor Strategy — writes a new row straight into
        // VENDOR_ALIGNED_STRATEGY (ASMT_ID left null; it's only known once
        // the assortment tool has run for this vendor's DC group), then
        // re-runs matching so this event's suppliers pick it up immediately.
        $("#btnShowAddVendorStrategy")?.addEventListener("click", () => {
            pickedVendorStrategyDcs = new Set();
            renderVendorStrategyDcPicker();
            renderAddVendorStrategyNameOptions();
            $("#addVendorStrategyForm").style.display = "block";
        });
        $("#btnCancelAddVendorStrategy")?.addEventListener("click", () => {
            $("#addVendorStrategyForm").style.display = "none";
        });
        $("#newVendorStrategyName")?.addEventListener("change", () => {
            const isOther = $("#newVendorStrategyName").value === "__other__";
            const custom = $("#newVendorStrategyNameCustom");
            if (custom) {
                custom.style.display = isOther ? "block" : "none";
                if (isOther) custom.focus();
            }
        });
        $("#btnSaveVendorStrategy")?.addEventListener("click", saveVendorStrategy);

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

            // Default to "yes" the first time this particular lookup surfaces —
            // but once the user has seen it, don't fight a manual uncheck by
            // re-checking it every time Step 2 is revisited.
            if (followLastYearAppliedFor !== lastPriorYearStrategy) {
                followLastYearAppliedFor = lastPriorYearStrategy;
                const toggle = $("#followLastYearToggle");
                if (toggle) {
                    toggle.checked = true;
                    applyLastYearStrategy(true);
                }
            }
        } else {
            box.style.display = "none";
            const toggle = $("#followLastYearToggle");
            if (toggle && toggle.checked) { toggle.checked = false; applyLastYearStrategy(false); }
            followLastYearAppliedFor = null;
        }
    }

    // Only meaningful once there's an uploaded file to actually match against
    // — called from the upload flow and from re-selecting Vendor-Aligned
    // after an upload already happened, never at Step 2 load time itself.
    function noteVendorAlignedApplied() {
        const pys = lastPriorYearStrategy;
        if ((pys?.overall?.strategy_type || "").toUpperCase() !== "VENDOR-ALIGNED") return;
        const note = $("#followLastYearNote");
        if (!note) return;
        note.innerHTML = `<i class="fas fa-info-circle"></i> Applied ${pys.event_name} ${pys.event_year}: `
            + `Vendor-Aligned Strategy — supplier-to-DC assignments matched below.`;
        note.style.display = "block";
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

        // Vendor-aligned events don't replay historical DC assignments — the
        // strategy is driven by matching this event's current suppliers to
        // VENDOR_ALIGNED_STRATEGY, so following last year just means selecting
        // Vendor-Aligned and letting the Match Vendors step do its own lookup.
        const isVendorAligned = (pys.overall?.strategy_type || "").toUpperCase() === "VENDOR-ALIGNED";
        if (isVendorAligned) {
            const vendorRadio = document.querySelector('input[name="strategy"][value="VENDOR_ALIGNED"]');
            if (vendorRadio) {
                vendorRadio.checked = true;
                vendorRadio.dispatchEvent(new Event("change"));
            }
            // The note itself only appears once there's an uploaded file to
            // actually match against — see noteVendorAlignedApplied(), called
            // from the upload flow and from re-selecting this radio.
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

    let ALL_DCS = [
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

    // One HD orange -> gray -> navy gradient. Every DC keeps the same fill
    // everywhere in the app; white text throughout, so the ramp is capped
    // dark enough (L <= ~0.50) that every step still reads clearly. Steps
    // were assigned (not just sorted by DC number) by spreading the DCs that
    // actually co-occur on the same real vendor row as far apart on the line
    // as a single gradient allows — a couple of adjacent-step pairs are still
    // close (12 of the 19 DCs co-occur with nearly all the others today, and
    // one line only has so much room), which is why the DC number itself
    // stays the real identifier, always printed on the pill.
    const DC_COLOR = {
        5523: { fill: "#7e4d35", step: 4 },
        5820: { fill: "#363d47", step: 13 },
        5823: { fill: "#9c4415", step: 0 },
        5829: { fill: "#854b2f", step: 3 },
        5831: { fill: "#2f3846", step: 14 },
        5832: { fill: "#12233f", step: 18 },
        5841: { fill: "#3d4249", step: 12 },
        5854: { fill: "#5d5148", step: 8 },
        5855: { fill: "#202e43", step: 16 },
        5857: { fill: "#764e3a", step: 5 },
        5860: { fill: "#54524c", step: 9 },
        5882: { fill: "#655144", step: 7 },
        5938: { fill: "#954720", step: 1 },
        6006: { fill: "#192841", step: 17 },
        6007: { fill: "#45484a", step: 11 },
        6705: { fill: "#6e503f", step: 6 },
        6707: { fill: "#273344", step: 15 },
        6760: { fill: "#8d4928", step: 2 },
        6777: { fill: "#4c4d4b", step: 10 },
    };
    const DC_COLOR_FALLBACK = "#8a8a86"; // mid-gray placeholder for a DC added this session, before the ramp is re-optimized to include it
    function dcFill(dcNbr) { return (DC_COLOR[dcNbr] || {}).fill || DC_COLOR_FALLBACK; }

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

    let pickedVendorStrategyDcs = new Set();

    function renderVendorStrategyDcPicker() {
        const el = $("#newVendorStrategyDcPicker");
        if (!el) return;
        el.innerHTML = ALL_DCS.map(dc => {
            const active = pickedVendorStrategyDcs.has(dc.nbr);
            return `<button type="button" class="dc-toggle-btn vendor-dc-btn${active ? " active" : ""}"
                data-dc-nbr="${dc.nbr}" title="${dc.name}">${dc.nbr}</button>`;
        }).join("");
        el.querySelectorAll("button").forEach(b => b.addEventListener("click", () => {
            const dc = Number(b.dataset.dcNbr);
            pickedVendorStrategyDcs.has(dc) ? pickedVendorStrategyDcs.delete(dc) : pickedVendorStrategyDcs.add(dc);
            renderVendorStrategyDcPicker();
        }));
    }

    // Populates the "Add Vendor Strategy" name field from this upload's
    // distinct suppliers (vendorMatches) instead of free text, so a new
    // strategy always attaches to a real supplier on the current event.
    // Each option is labeled with the VENDOR_ALIGNED_STRATEGY name it
    // currently resolves to (often "OTHER") and flagged with ⚠ when it's
    // only getting the generic fallback — so a supplier like "ALLEY CAT"
    // that has no dedicated strategy yet is easy to pick out and fix.
    function renderAddVendorStrategyNameOptions() {
        const select = $("#newVendorStrategyName");
        const custom = $("#newVendorStrategyNameCustom");
        if (!select) return;
        const seen = new Set();
        const options = vendorMatches
            .map(m => ({ supplier: (m.SUPPLIER || "").trim(), current: (m.VENDOR || "OTHER").toUpperCase() }))
            .filter(o => o.supplier && !seen.has(o.supplier) && seen.add(o.supplier))
            .sort((a, b) => a.supplier.localeCompare(b.supplier));
        select.innerHTML = `<option value="">Select a supplier from this upload…</option>`
            + options.map(o => `<option value="${o.supplier}">${o.current === "OTHER" ? "⚠ " : ""}${o.supplier} — currently: ${o.current}</option>`).join("")
            + `<option value="__other__">+ Enter a different vendor name…</option>`;
        select.value = "";
        if (custom) { custom.style.display = "none"; custom.value = ""; }
    }

    async function saveVendorStrategy() {
        const select = $("#newVendorStrategyName");
        const isOther = select?.value === "__other__";
        const name = (isOther ? $("#newVendorStrategyNameCustom")?.value : select?.value || "").trim();
        if (!name) { toast("Select or enter a vendor name", "error"); return; }
        if (!pickedVendorStrategyDcs.size) { toast("Select at least one DC", "error"); return; }
        showLoading("Adding vendor strategy…");
        try {
            const result = await api("/api/vendor_strategy/add", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ vendor: name, dc_list: [...pickedVendorStrategyDcs] }),
            });
            toast(result.message || `Added ${name.toUpperCase()}`, "success");
            $("#addVendorStrategyForm").style.display = "none";
            pickedVendorStrategyDcs = new Set();
            // Re-run matching so this event's suppliers (including ones
            // currently falling back to OTHER) pick up the new vendor row.
            await matchVendorStrategy();
        } catch (e) {
            toast("Failed to add vendor strategy: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    // Guards submitCostModel()/loadCostModelPreview() against ever sending an
    // empty vendor_matches for a Vendor-Aligned event — that's exactly what
    // makes target_dc_count/dc_inclusions/dc_exclusions come back null, since
    // the backend can't tell "no vendor-aligned assignments exist" apart from
    // "this event isn't vendor-aligned." vendorMatches only ever gets
    // populated by matchVendorStrategy(), so if it's empty here re-run it
    // rather than submit/preview against stale or never-fetched matches.
    async function ensureVendorMatchesFresh() {
        if (selectedStrategy === "VENDOR_ALIGNED" && !vendorMatches.length) {
            await matchVendorStrategy();
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

            // The supplier/strategy counts are now covered by the YoY Vendor
            // Comparison card and the assignments table below — only surface
            // this badge when there's an actual problem to flag.
            $("#vendorMatchSummary").innerHTML = result.unmatched?.length
                ? `<div class="validation-badge badge-fail" style="font-size:0.95rem">
                    <i class="fas fa-triangle-exclamation"></i> ${result.unmatched.length} unmatched: ${result.unmatched.join(", ")}
                </div>`
                : "";
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
        // VENDOR_ALIGNED_STRATEGY.DC_NM_LIST is always "-"-joined (e.g.
        // "DALLAS-LACEY-PERRIS MAIN"), matching DC_LIST's own convention —
        // splitting on comma/pipe left the whole string as one "name".
        return String(value || "").replace(/^\[|\]$/g, "").split("-").map(value => value.replace(/^['\"]|['\"]$/g, "").trim()).filter(Boolean);
    }

    function vendorDcName(dcNbr, names, index) {
        if (names[index]) return names[index];
        const known = ALL_DCS.find(dc => dc.nbr === dcNbr);
        return known ? known.name : `DC ${dcNbr}`;
    }

    // Renders every DC in the network as a button, not just the ones eligible
    // for this row — the ineligible ones are disabled/greyed so it's visible
    // at a glance which of the full network this assortment does NOT use.
    function renderDcButtonGrid(matchIndex, eligibleDcs, names, selectedDcs, opts = {}) {
        const { extraClass = "", dataAttrs = "" } = opts;
        return eligibleDcs.map((dcNbr, index) => {
            const name = vendorDcName(dcNbr, names, index);
            const isActive = selectedDcs.includes(dcNbr);
            // Every DC keeps one fixed color everywhere (see DC_COLOR) so the
            // same DC number reads the same regardless of which supplier's
            // row it appears in — inline style, since `.active`'s CSS color
            // is shared with unrelated DC-COUNT toggle buttons elsewhere.
            const style = isActive ? ` style="background:${dcFill(dcNbr)};color:#fff;border-color:${dcFill(dcNbr)}"` : "";
            return `<button type="button" class="dc-toggle-btn vendor-dc-btn${extraClass}${isActive ? " active" : ""}"${style}
                title="${name}" aria-label="DC ${dcNbr}: ${name}" data-match-index="${matchIndex}" data-dc-nbr="${dcNbr}"${dataAttrs}>${dcNbr}</button>`;
        }).join("");
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

    let vendorSkuExpanded = new Set();

    function vendorSkuDcs(match, row) {
        const overrides = match.SKU_OVERRIDES || {};
        // Keyed by THD_SKU_NBR (not THD_KEY) so the override survives a round
        // trip through /api/submit_cost_model, which resolves it against
        // EVENTS_SKU_LIST.THD_SKU_NBR directly — a composite client-side key
        // can't be reconstructed on the BigQuery side.
        return parseVendorDcs(overrides[row.THD_SKU_NBR] || match.DC_LIST);
    }

    async function toggleVendorSkuRows(matchIndex) {
        if (vendorSkuExpanded.has(matchIndex)) {
            vendorSkuExpanded.delete(matchIndex);
        } else {
            vendorSkuExpanded.add(matchIndex);
        }
        renderVendorSupplierSummary(vendorMatches);
    }

    async function loadVendorSkuRows(matchIndex, page) {
        const match = vendorMatches[matchIndex];
        const container = $(`#vendor-skus-${matchIndex}`);
        if (!match || !container) return;
        container.innerHTML = '<div class="vendor-sku-loading">Loading SKU details...</div>';
        try {
            // A vendor merged into this one (via "Move to...") still owns its
            // SKUs under its own SUPPLIER name in EVENTS_SKU_LIST — pull
            // those in too so the group's SKU list actually shows every SKU
            // it's now responsible for. Each row keeps its real owner so a
            // per-SKU override lands on that vendor's own SKU_OVERRIDES
            // (which is what /api/submit_cost_model reads per vendor), not
            // on the group's.
            const owners = [{ index: matchIndex, match }];
            vendorMatches.forEach((v, i) => { if (v._movedTo === matchIndex) owners.push({ index: i, match: v }); });
            owners.forEach(o => { o.match.SKU_OVERRIDES = o.match.SKU_OVERRIDES || {}; });

            const FETCH_PAGE_SIZE = 100;
            const fetches = await Promise.all(owners.map(o =>
                api(`/api/vendor_skus?supplier=${encodeURIComponent(o.match.SUPPLIER)}&page=1&page_size=${FETCH_PAGE_SIZE}`)
            ));
            fetches.forEach(r => { if (r.error) throw new Error(r.error); });
            const truncated = fetches.some(r => (r.pages || 1) > 1);
            const allRows = [];
            fetches.forEach((r, oi) => (r.rows || []).forEach(row => allRows.push({ row, owner: owners[oi] })));

            const DISPLAY_PAGE_SIZE = 50;
            const totalPages = Math.max(1, Math.ceil(allRows.length / DISPLAY_PAGE_SIZE));
            const clampedPage = Math.min(Math.max(page, 1), totalPages);
            const pageRows = allRows.slice((clampedPage - 1) * DISPLAY_PAGE_SIZE, clampedPage * DISPLAY_PAGE_SIZE);

            const defaultDcs = parseVendorDcs(match.DC_LIST);
            let html = `<table class="detail-table vendor-sku-table"><thead><tr>
                <th>DC NBR List</th><th>DC Count</th><th>Supplier</th><th>THD SKU NBR</th><th>SKU Description</th><th>Total Units</th><th>Total Cube</th></tr></thead><tbody>`;
            pageRows.forEach(({ row, owner }) => {
                const selectedDcs = vendorSkuDcs(owner.match, row);
                html += `<tr data-sku-key="${row.THD_SKU_NBR}"><td><div class="vendor-dc-buttons">
                    ${renderDcButtonGrid(matchIndex, defaultDcs, parseVendorNames(match._initialDcNames), selectedDcs, {
                        extraClass: " vendor-sku-dc-btn",
                        dataAttrs: ` data-sku-key="${row.THD_SKU_NBR}" data-owner-index="${owner.index}"`,
                    })}
                    </div>${owner.match.SKU_OVERRIDES[row.THD_SKU_NBR] ? '<span class="vendor-sku-override">Override</span>' : ""}</td>
                    <td class="vendor-sku-count">${selectedDcs.length}</td>
                    <td>${(owner.match.VENDOR || owner.match.SUPPLIER || "").toUpperCase()}</td>
                    <td>${row.THD_SKU_NBR || "—"}</td><td>${row.SKU_DESC || "—"}</td><td>${row.TOTAL_UNITS || "—"}</td><td>${row.TOTAL_CUBE || "—"}</td>
                    <td><div class="move-wrap">
                        <button type="button" class="btn btn-sm btn-secondary vendor-sku-move-btn" data-match-index="${matchIndex}" data-owner-index="${owner.index}" data-sku-key="${row.THD_SKU_NBR}" title="Move this SKU to another vendor's DC group">⋯</button>
                    </div></td></tr>`;
            });
            html += `</tbody></table><div class="vendor-sku-footer"><button type="button" class="btn btn-sm btn-secondary vendor-sku-hide"><i class="fas fa-chevron-up"></i> Hide SKUs</button> Page ${clampedPage} of ${totalPages} · ${allRows.length} SKU(s)${truncated ? " — one or more suppliers truncated at 100 rows" : ""}`;
            if (totalPages > 1) {
                html += `<button type="button" class="btn btn-sm btn-secondary vendor-sku-next" data-match-index="${matchIndex}" data-page="${clampedPage + 1}" ${clampedPage >= totalPages ? "disabled" : ""}>Next</button>`;
            }
            html += `</div>`;
            container.innerHTML = html;
            container.querySelectorAll(".vendor-sku-dc-btn").forEach(button => {
                button.addEventListener("click", () => toggleVendorSkuDc(
                    Number(button.dataset.matchIndex), Number(button.dataset.ownerIndex), button.dataset.skuKey, Number(button.dataset.dcNbr)
                ));
            });
            container.querySelectorAll(".vendor-sku-move-btn").forEach(button => {
                button.addEventListener("click", e => {
                    e.stopPropagation();
                    const groupIndex = Number(button.dataset.matchIndex);
                    const ownerIndex = Number(button.dataset.ownerIndex);
                    const skuKey = button.dataset.skuKey;
                    openMovePopover(button, ownerIndex, "Move this SKU to another vendor's DC group",
                        targetIndex => applySkuMove(groupIndex, ownerIndex, skuKey, targetIndex));
                });
            });
            container.querySelector(".vendor-sku-next")?.addEventListener("click", event => {
                loadVendorSkuRows(matchIndex, Number(event.currentTarget.dataset.page));
            });
            container.querySelector(".vendor-sku-hide")?.addEventListener("click", () => toggleVendorSkuRows(matchIndex));
        } catch (error) {
            container.innerHTML = `<div class="vendor-sku-loading">Unable to load SKU details: ${error.message}</div>`;
        }
    }

    function closeMovePopover() {
        document.querySelectorAll(".move-pop").forEach(p => p.remove());
    }
    document.addEventListener("click", e => { if (!e.target.closest(".move-wrap")) closeMovePopover(); });

    function moveTargetOptions(excludeIndex) {
        // A vendor that's itself been moved away is just borrowing its
        // target's DCs — not a real group to move a third vendor into.
        return vendorMatches
            .map((v, i) => ({ i, v }))
            .filter(({ i, v }) => i !== excludeIndex && v._movedTo == null);
    }

    function openMovePopover(anchorButton, excludeIndex, label, onPick) {
        closeMovePopover();
        const options = moveTargetOptions(excludeIndex);
        if (!options.length) { toast("No other vendor to move to yet", "error"); return; }
        const pop = document.createElement("div");
        pop.className = "move-pop";
        pop.innerHTML = `<div class="move-pop-label">${label}</div>` + options.map(({ i, v }) =>
            `<button type="button" data-target-index="${i}">${(v.VENDOR || v.SUPPLIER || "").toUpperCase()}
                <span>${parseVendorDcs(v.DC_LIST).length} DCs</span></button>`).join("");
        pop.querySelectorAll("button[data-target-index]").forEach(b => b.addEventListener("click", e => {
            e.stopPropagation();
            onPick(Number(b.dataset.targetIndex));
            closeMovePopover();
        }));
        anchorButton.parentElement.appendChild(pop);
    }

    function applyVendorMove(matchIndex, targetIndex) {
        const src = vendorMatches[matchIndex], tgt = vendorMatches[targetIndex];
        if (!src || !tgt) return;
        // The DC/SKU data actually moves (needed for /api/submit_cost_model
        // to assign these SKUs to the target's DCs) — _movedTo is purely a
        // display flag so the source collapses into the target's row instead
        // of sitting there as its own row with borrowed DCs.
        const targetDcs = parseVendorDcs(tgt.DC_LIST);
        const rehome = m => {
            m.DC_LIST = targetDcs.join(", ");
            m.DC_COUNT = targetDcs.length;
            m.DC_NM_LIST = tgt.DC_NM_LIST;
            m._movedTo = targetIndex;
        };
        rehome(src);
        // Cascade: anyone already merged into src follows it to its new
        // target — moving "DEWALT (+ BOSCH)" into MAKITA becomes
        // "MAKITA (+ DEWALT, + BOSCH)" instead of leaving BOSCH pointing at
        // a DEWALT row that's now itself just a pointer to MAKITA.
        vendorMatches.forEach(m => { if (m._movedTo === matchIndex) rehome(m); });
        toast(`${(src.VENDOR || src.SUPPLIER || "").toUpperCase()} moved under ${(tgt.VENDOR || tgt.SUPPLIER || "").toUpperCase()}`, "success");
        renderVendorSupplierSummary(vendorMatches);
    }

    function undoVendorMove(matchIndex) {
        const src = vendorMatches[matchIndex];
        if (!src) return;
        const initialDcs = parseVendorDcs(src._initialDcList);
        src.DC_LIST = initialDcs.join(", ");
        src.DC_COUNT = initialDcs.length;
        src.DC_NM_LIST = src._initialDcNames;
        delete src._movedTo;
        toast(`${(src.VENDOR || src.SUPPLIER || "").toUpperCase()} restored to its own DC group`, "success");
        renderVendorSupplierSummary(vendorMatches);
    }

    // Repaints one already-rendered SKU row's DC buttons/count/override badge
    // in place, without a network round trip. THD_SKU_NBR/SKU_DESC/units/cube
    // don't change when a DC override is toggled or a SKU is moved — only the
    // client-side SKU_OVERRIDES state does — so there's nothing here that
    // /api/vendor_skus needs to be asked about again, unlike the initial page
    // load or paging to a different set of SKUs.
    // groupIndex is whichever vendor's "View SKUs" panel is open (the
    // #vendor-skus-N container to find/patch); ownerIndex is whichever
    // vendor's SUPPLIER this particular SKU row actually belongs to — the
    // same vendor for a normal row, but a merged-in vendor (see "Move
    // to...") for a row pulled in from its group. SKU_OVERRIDES always
    // lives on the owner, since that's what /api/submit_cost_model reads.
    function rerenderVendorSkuRow(groupIndex, ownerIndex, skuKey) {
        const group = vendorMatches[groupIndex];
        const owner = vendorMatches[ownerIndex];
        const container = $(`#vendor-skus-${groupIndex}`);
        if (!group || !owner || !container) return;
        const row = container.querySelector(`tr[data-sku-key="${CSS.escape(String(skuKey))}"]`);
        if (!row) return;

        const defaultDcs = parseVendorDcs(group.DC_LIST);
        const names = parseVendorNames(group._initialDcNames);
        const selectedDcs = parseVendorDcs(owner.SKU_OVERRIDES[skuKey] || owner.DC_LIST);

        const btnCell = row.querySelector(".vendor-dc-buttons");
        if (btnCell) {
            btnCell.innerHTML = renderDcButtonGrid(groupIndex, defaultDcs, names, selectedDcs, {
                extraClass: " vendor-sku-dc-btn",
                dataAttrs: ` data-sku-key="${skuKey}" data-owner-index="${ownerIndex}"`,
            });
            btnCell.querySelectorAll(".vendor-sku-dc-btn").forEach(button => {
                button.addEventListener("click", () => toggleVendorSkuDc(
                    Number(button.dataset.matchIndex), Number(button.dataset.ownerIndex), button.dataset.skuKey, Number(button.dataset.dcNbr)
                ));
            });
        }

        const overrideHolder = btnCell?.parentElement;
        const existingBadge = overrideHolder?.querySelector(".vendor-sku-override");
        const hasOverride = !!owner.SKU_OVERRIDES[skuKey];
        if (hasOverride && !existingBadge) {
            overrideHolder.insertAdjacentHTML("beforeend", '<span class="vendor-sku-override">Override</span>');
        } else if (!hasOverride && existingBadge) {
            existingBadge.remove();
        }

        const countCell = row.querySelector(".vendor-sku-count");
        if (countCell) countCell.textContent = selectedDcs.length;
    }

    function applySkuMove(groupIndex, ownerIndex, skuKey, targetIndex) {
        const owner = vendorMatches[ownerIndex], target = vendorMatches[targetIndex];
        if (!owner || !target) return;
        owner.SKU_OVERRIDES = owner.SKU_OVERRIDES || {};
        const targetDcs = parseVendorDcs(target.DC_LIST);
        const defaults = parseVendorDcs(owner.DC_LIST);
        if (targetDcs.join(",") === defaults.join(",")) delete owner.SKU_OVERRIDES[skuKey];
        else owner.SKU_OVERRIDES[skuKey] = targetDcs;
        toast(`SKU moved to ${(target.VENDOR || target.SUPPLIER || "").toUpperCase()}'s DC group`, "success");
        rerenderVendorSkuRow(groupIndex, ownerIndex, skuKey);
    }

    function toggleVendorSkuDc(groupIndex, ownerIndex, skuKey, dcNbr) {
        const owner = vendorMatches[ownerIndex];
        if (!owner) return;
        owner.SKU_OVERRIDES = owner.SKU_OVERRIDES || {};
        const selected = parseVendorDcs(owner.SKU_OVERRIDES[skuKey] || owner.DC_LIST);
        if (selected.length === 1 && selected[0] === dcNbr) {
            toast("Each SKU must have at least one DC selected", "error");
            return;
        }
        const next = selected.includes(dcNbr) ? selected.filter(dc => dc !== dcNbr) : [...selected, dcNbr];
        next.sort((a, b) => a - b);
        const defaults = parseVendorDcs(owner.DC_LIST);
        if (next.join(",") === defaults.join(",")) delete owner.SKU_OVERRIDES[skuKey];
        else owner.SKU_OVERRIDES[skuKey] = next;
        rerenderVendorSkuRow(groupIndex, ownerIndex, skuKey);
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

        // Reconcile against last year's recorded strategy (Step 1's lookup) —
        // read the same DC-list-grouped, canonical-vendor rows Step 1 itself
        // shows, so the two views can't disagree about vendor identity. Only
        // meaningful when last year was itself vendor-aligned; a DC-selection
        // or not-recorded year has no vendor list to compare against.
        const priorRows = (lastPriorYearStrategy?.overall?.strategy_type || "").toUpperCase() === "VENDOR-ALIGNED"
            ? (lastPriorYearStrategy.strategy_summary || [])
            : [];
        const norm = s => (s || "").toUpperCase().trim();
        const thisYearNames = new Set(matches.map(m => norm(m.VENDOR || m.SUPPLIER)));
        const priorYearNames = new Set(priorRows.flatMap(r => (r.vendor || "").split(", ").map(norm)));
        const newSuppliers = new Set([...thisYearNames].filter(n => n && !priorYearNames.has(n)));

        // A prior-year row can merge several vendors under one DC list; only
        // the subset absent from this year's matches is "missing" — and its
        // THD key count is only trustworthy to show when the WHOLE row is
        // missing (a partial split doesn't tell us each vendor's own share).
        const missingRows = priorRows
            .map(r => {
                const vendorNames = (r.vendor || "").split(", ").map(v => v.trim()).filter(Boolean);
                const missingNames = vendorNames.filter(v => !thisYearNames.has(norm(v)));
                if (!missingNames.length) return null;
                return {
                    dc_list: r.dc_list, dc_name_list: r.dc_name_list, dc_count: r.dc_count,
                    vendor: missingNames.join(", "),
                    thd_key_count: missingNames.length === vendorNames.length ? r.thd_key_count : null,
                };
            })
            .filter(Boolean);

        let html = `<h4 style="margin:0 0 6px 0;font-size:.9rem">
            <i class="fas fa-boxes-stacked"></i> Supplier DC Assignments</h4>`;
        if (priorRows.length) {
            // A standalone high-level comparison, separate from the table
            // below — this year's vendor roster against last year's, not just
            // the per-row new/missing markers.
            const unchangedCount = [...priorYearNames].filter(n => thisYearNames.has(n)).length;
            const newNames = [...newSuppliers].sort();
            const missingNames = missingRows.flatMap(r => (r.vendor || "").split(", ").map(v => v.trim())).filter(Boolean).sort();
            const priorEventTypeLabel = lastPriorYearStrategy._isImportVal === "true" ? "Import"
                : lastPriorYearStrategy._isImportVal === "false" ? "Domestic" : "";
            html += `<div class="prior-strategy-card vendor-reconcile-card">
                <div class="prior-strategy-heading">
                    <div><span class="prior-strategy-kicker">Vs ${lastPriorYearStrategy.event_name} ${lastPriorYearStrategy.event_year}${priorEventTypeLabel ? " " + priorEventTypeLabel : ""}</span>
                        <h4><i class="fas fa-code-compare"></i> YoY Vendor Comparison</h4></div>
                </div>
                <div class="prior-strategy-metrics">
                    <div><span>This Year</span><strong>${thisYearNames.size}</strong></div>
                    <div><span>Last Year</span><strong>${priorYearNames.size}</strong></div>
                    <div><span>Unchanged</span><strong>${unchangedCount}</strong></div>
                    <div><span>New</span><strong>${newNames.length}</strong></div>
                    <div><span>Missing</span><strong>${missingNames.length}</strong></div>
                </div>
                ${newNames.length ? `<div class="vendor-reconcile-namelist"><strong>New:</strong> ${newNames.join(", ")}</div>` : ""}
                ${missingNames.length ? `<div class="vendor-reconcile-namelist"><strong>Missing:</strong> ${missingNames.join(", ")}</div>` : ""}
            </div>`;
        }
        // Vendors merged into another vendor's group (via "Move to...") are
        // grouped under their target's row rather than kept as their own —
        // this is who's merged into which target index.
        const mergedInto = {};
        matches.forEach((m, i) => {
            if (m._movedTo == null) return;
            (mergedInto[m._movedTo] ||= []).push(i);
        });

        html += `<div class="table-container vendor-dc-table-wrap"><table class="detail-table vendor-dc-table">
            <thead><tr><th>DC NBR List</th><th>DC Count</th><th>Supplier</th><th>Matched THD Key</th><th></th></tr></thead><tbody>`;
        matches.forEach((m, matchIndex) => {
            const isOther = (m.VENDOR || "").toUpperCase() === "OTHER";
            const isNew = newSuppliers.has(norm(m.VENDOR || m.SUPPLIER));
            if (!m._initialDcList) m._initialDcList = parseVendorDcs(m.DC_LIST).join(", ");
            if (!m._initialDcNames) m._initialDcNames = Array.isArray(m.DC_NM_LIST) ? m.DC_NM_LIST.join(", ") : (m.DC_NM_LIST || "");
            const matchedVendor = (m.VENDOR || m.SUPPLIER || "").toUpperCase();

            // A vendor that's been moved collapses to a single greyed-out
            // line — its DCs/SKUs now live under the target's row, and
            // "Undo" is the only way back (no DC pills to hand-edit here).
            if (m._movedTo != null) {
                const target = vendorMatches[m._movedTo];
                html += `<tr class="vendor-row-moved">
                    <td colspan="4"><em>${matchedVendor}</em> moved under <strong>${(target?.VENDOR || target?.SUPPLIER || "").toUpperCase()}</strong></td>
                    <td class="vendor-row-actions">
                        <button type="button" class="btn btn-sm btn-secondary vendor-undo-move-btn" data-match-index="${matchIndex}">
                            <i class="fas fa-rotate-left"></i> Undo
                        </button>
                    </td></tr>`;
                return;
            }
            if (vendorSkuExpanded.has(matchIndex)) {
                html += `<tr class="vendor-sku-detail-row"><td colspan="5"><div id="vendor-skus-${matchIndex}" class="vendor-sku-details"></div></td></tr>`;
                return;
            }

            const selectedDcs = parseVendorDcs(m.DC_LIST);
            const initialDcs = parseVendorDcs(m._initialDcList);
            const names = parseVendorNames(m._initialDcNames);

            // Vendors merged INTO this one — shown as a badge line under the
            // name, and folded into the THD-key count so the total reads as
            // "everything this DC group is now responsible for."
            const mergedHere = (mergedInto[matchIndex] || []).map(i => matches[i]);
            const mergedBadges = mergedHere.length
                ? `<div class="vendor-merged-badges">${mergedHere.map(mv =>
                    `<span class="vendor-merged-badge">+ ${(mv.VENDOR || mv.SUPPLIER || "").toUpperCase()}</span>`).join("")}</div>`
                : "";
            const combinedSkuCount = Number(m.SKU_COUNT || 0) + mergedHere.reduce((sum, mv) => sum + Number(mv.SKU_COUNT || 0), 0);

            // A per-SKU override (this group's own, or one carried by a
            // merged-in supplier) can put a SKU on a smaller DC count than
            // the group's default — show the collapsed row as a range
            // instead of silently reporting only the default count.
            const overrideDcCounts = [m, ...mergedHere].flatMap(owner =>
                Object.values(owner.SKU_OVERRIDES || {}).map(dcs => parseVendorDcs(dcs).length));
            const dcCountRange = [selectedDcs.length, ...overrideDcCounts];
            const minDcCount = Math.min(...dcCountRange);
            const maxDcCount = Math.max(...dcCountRange);
            const dcCountLabel = minDcCount === maxDcCount ? String(maxDcCount) : `${minDcCount}-${maxDcCount}`;

            html += `<tr${isNew ? ' class="vendor-supplier-new"' : ""}><td><div class="vendor-dc-buttons">
                ${renderDcButtonGrid(matchIndex, initialDcs, names, selectedDcs)}
                </div></td><td class="vendor-dc-count"${minDcCount !== maxDcCount ? ` title="One or more SKUs in this group have a per-SKU DC override"` : ""}>${dcCountLabel}</td>
                <td><strong>${isNew ? '<i class="fas fa-plus vendor-new-icon" title="Not in a comparable last-year row"></i> ' : ""}${matchedVendor}</strong>${isOther
                    ? ' <span title="No vendor-specific strategy matched — using the OTHER default" style="color:#b8860b"><i class="fas fa-circle-info"></i></span>'
                    : ""}${mergedBadges}</td>
                <td style="text-align:right">${fmtNum(combinedSkuCount)}</td>
                <td class="vendor-row-actions">
                    <button type="button" class="btn btn-sm btn-secondary vendor-sku-toggle" data-match-index="${matchIndex}">
                        <i class="fas fa-chevron-${vendorSkuExpanded.has(matchIndex) ? "up" : "down"}"></i> ${vendorSkuExpanded.has(matchIndex) ? "Hide" : "View"} SKUs
                    </button>
                    <div class="move-wrap">
                        <button type="button" class="btn btn-sm btn-secondary vendor-move-btn" data-match-index="${matchIndex}" title="Move this supplier to another vendor's DC group">⋯</button>
                    </div>
                </td></tr>`;
        });
        html += `</tbody><tfoot><tr><td colspan="5" class="vendor-dc-total">Total matched THD Keys: ${fmtNum(totalSkus ?? matches.reduce((sum, m) => sum + Number(m.SKU_COUNT || 0), 0))}</td></tr></tfoot></table></div>`;
        box.innerHTML = html;
        box.querySelectorAll(".vendor-dc-btn").forEach(button => {
            button.addEventListener("click", () => toggleVendorDc(
                Number(button.dataset.matchIndex), Number(button.dataset.dcNbr)
            ));
        });
        box.querySelectorAll(".vendor-sku-toggle").forEach(button => {
            button.addEventListener("click", () => toggleVendorSkuRows(Number(button.dataset.matchIndex)));
        });
        box.querySelectorAll(".vendor-move-btn").forEach(button => {
            button.addEventListener("click", e => {
                e.stopPropagation();
                const matchIndex = Number(button.dataset.matchIndex);
                openMovePopover(button, matchIndex, "Move to this vendor's DC group",
                    targetIndex => applyVendorMove(matchIndex, targetIndex));
            });
        });
        box.querySelectorAll(".vendor-undo-move-btn").forEach(button => {
            button.addEventListener("click", () => undoVendorMove(Number(button.dataset.matchIndex)));
        });
        vendorSkuExpanded.forEach(matchIndex => loadVendorSkuRows(matchIndex, 1));
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
        $("#btnRerunAllocation")?.addEventListener("click", () => {
            forceRerunAllocation = true;
            runAllocation();
        });
    }

    // Same config-snapshot cache pattern as _executeAssortment()/
    // lastAssortmentConfig: Back → Step 4 → Confirm again shouldn't re-run
    // the (real, expensive) BigQuery allocation procedure just to look at
    // the same results — only an actual change to the strategy/DC/vendor
    // config built into `body` should trigger a fresh run.
    let lastAllocationConfig = null;
    let forceRerunAllocation = false;

    async function runAllocation() {
        const body = {
            strategy: selectedStrategy,
            event_name: eventName,
            wave_count: waveCount,
            run_id: $("#stratRunId")?.value?.trim() || "",
            email: $("#stratEmail")?.value?.trim() || "",
        };

        if (selectedStrategy === "VENDOR_ALIGNED") {
            body.sku_grp = $("#stratSkuGrp")?.value?.trim() || "";
            body.vendor_matches = vendorMatches;
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

        const snapshot = JSON.stringify(body);
        const useCache = !forceRerunAllocation && lastAllocationConfig && snapshot === lastAllocationConfig;
        forceRerunAllocation = false; // consumed once, regardless of path taken below

        if (useCache) {
            goStep(8); // just redisplay the existing results — no reason to re-run
            if ($("#allocCachedBanner")) $("#allocCachedBanner").style.display = "flex";
            return;
        }

        if ($("#allocCachedBanner")) $("#allocCachedBanner").style.display = "none";
        showLoading("Executing allocation procedure…");
        try {
            const result = await api("/api/run_allocation", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (result.success) {
                toast("Allocation completed!", "success");
                lastAllocationConfig = snapshot;
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
            // Factory concept doesn't exist for a domestic event — show the
            // KPI card only for imports rather than a confusing "0".
            const factoriesCard = $("#rKpiFactoriesCard");
            if (factoriesCard) factoriesCard.style.display = includesImports ? "" : "none";
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

    // FACTORY_ID, and the FACTORY_CUBE/FACTORY_CONTAINERS totals derived from it,
    // don't exist for a domestic event (factories are an import-only concept) —
    // includesImports is set back in Step 1 and carried through as the one
    // source of truth for that, rather than inferring it from whatever happens
    // to come back in a given page of results.
    const FACTORY_ONLY_COLUMNS = ["FACTORY_ID", "FACTORY_CUBE", "FACTORY_CONTAINERS"];
    function getVisibleResultColumns() {
        return includesImports ? RESULT_COLUMNS : RESULT_COLUMNS.filter(c => !FACTORY_ONLY_COLUMNS.includes(c.key));
    }

    function renderResultsTable(data) {
        const visibleColumns = getVisibleResultColumns();
        const headRow = $("#resultsHead");
        headRow.innerHTML = "";
        for (const col of visibleColumns) {
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
            tbody.innerHTML = `<tr><td colspan="${visibleColumns.length}" style="text-align:center;color:#666;padding:30px">No results</td></tr>`;
            return;
        }
        for (const row of data) {
            const tr = document.createElement("tr");
            for (const col of visibleColumns) {
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

        // Pick up any DC someone added via "Add DC to network" earlier this
        // server session (ALL_DCS otherwise starts from the hardcoded list
        // above, same as config.py's DC_NAMES).
        try {
            const cfg = await api("/api/config");
            for (const [nbrStr, name] of Object.entries(cfg.dc_names || {})) {
                const nbr = Number(nbrStr);
                if (!ALL_DCS.some(dc => dc.nbr === nbr)) ALL_DCS.push({ nbr, name });
            }
            ALL_DCS.sort((a, b) => a.nbr - b.nbr);
        } catch { /* ok — falls back to the hardcoded ALL_DCS above */ }

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
