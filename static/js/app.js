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
    // "No" -> "Single DC Count — determine for me": runs the group-run query
    // with no DC-count constraint (open search), for either strategy — unlike
    // multiDcDynamicSelected's cascading tiers, which stay import-only.
    let singleDcCountAutoSelected = false;
    let singleDcGroupChoice = null; // {dc_count, camp_asmt_id, camp_list, total_exp} once auto-picked
    let waveCount = 0;
    let selectedStrategy = "";
    // Whether the current upload's rows are already written to
    // EVENTS_SKU_LIST — the write happens on Confirm (Vendor-Aligned) or on
    // Step 2's own Next click (DC Selection, which has no separate confirm
    // step), never automatically at upload time. Reset on every new upload.
    let dataInserted = false;
    // Set by doInsert() when /api/check_upload_unchanged determined a
    // "replace" would be a genuine no-op (same row data AND same DC/vendor
    // selection already on file) — its callers (confirmVendorStrategy,
    // setupInsert's DC Selection branch) read and consume this to skip their
    // own submitCostModel() call too, instead of redoing that BigQuery work
    // for a resubmit that changes nothing. Always reset to false once read.
    let skipResubmitBecauseUnchanged = false;
    // Bulk vs. Parcel strategy split (opt-in, see stockTypeSplitToggle).
    // stockTypeRows: last /api/classify_stock_type response's per-row results.
    // stockTypeOverrides: thd_key -> "BULK"/"PARCEL", mirrors the server's
    // _upload_cache["stock_type_overrides"] so the UI never has to re-fetch
    // just to know what a user already flipped.
    let stockTypeSplitEnabled = false;
    let stockTypeConfirmed = false;
    let stockTypeRows = [];
    let stockTypeOverrides = {};
    // Per-segment strategy configuration, captured off the shared strategy
    // controls when the user switches segment tabs (see setupSegmentTabs).
    // null = that segment hasn't been configured yet this session. Shape:
    // {strategy: "VENDOR_ALIGNED", vendorMatches, vendorStrategyConfirmed}
    // or {strategy: "DC_SELECTION", dcCounts, dcInclusions, dcExclusions, campusPairs}.
    // NOTE: only the "manual DC count" path is supported per segment — the
    // "determine for me" single/multi-DC dynamic modes are not captured
    // per-segment and should be treated as out of scope for a split event.
    let segmentConfigs = { BULK: null, PARCEL: null };
    let currentSegment = "BULK";
    // Mirrors dcSelectionCostModelSubmitted, for the combined segmented
    // submission (see setupInsert's stockTypeSplitEnabled branch).
    let segmentedCostModelSubmitted = false;
    // Whether the currently-displayed upload actually passed validation —
    // tracked separately from #btnGoInsert's disabled attribute so the Next
    // button's enabled state can always be recomputed from real state instead
    // of snapshotting/restoring a raw disabled flag.
    let uploadValidated = false;
    // "event_name|event_year|includes_imports" (Step 1's fields, at the moment
    // a file last passed validation) — lets a later prior-year check for a
    // *different* combination detect that Step 2's upload is now stale for
    // whatever's selected in Step 1, so it can be cleared instead of lingering
    // as if it belonged to the newly selected event. Null once cleared or
    // before any file has been uploaded.
    let lastUploadEventKey = null;
    // The most recent successful /api/prior_year_strategy lookup from Step 1
    // (null if none found yet, or the last check came back empty) — Step 2
    // reads this to offer "Follow last year's strategy?".
    let lastPriorYearStrategy = null;
    // Background auto-check for a prior-year strategy match (see
    // scheduleAutoPriorYearCheck/autoCheckPriorYearIfReady in
    // setupPriorYearStrategy): the debounce timer handle, the last
    // "name|year|isImportVal" combo already checked (so switching back to
    // one already looked up doesn't re-fetch it), and whether a check is
    // currently in flight — read by goStep so arriving at Step 2 mid-check
    // doesn't just show an empty "Follow last year's strategy?" box forever.
    let autoPriorYearCheckTimer = null;
    let autoPriorYearCheckedFor = null;
    let priorYearCheckInFlight = false;
    // Which lastPriorYearStrategy object (by reference) has already had its
    // "Follow last year's strategy?" default applied — lets a fresh lookup
    // default to checked without re-checking a box the user just unchecked
    // for that same lookup.
    let followLastYearAppliedFor = null;
    // True only while applyLastYearStrategy() is itself programmatically
    // flipping radios/buttons to lay down last year's config — lets
    // noteManualStrategyEdit() tell that apart from a real user click on the
    // same controls, which it must not stay silent for.
    let applyingLastYearStrategy = false;
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
    function toTitleCase(s) {
        return (s || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
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

    // Fills in Run ID (and, in the same round trip, SKU Group) from just
    // Event Name/Year — both already known from Step 1 — instead of making
    // the user go find and paste in a Run ID by hand before Step 3 can do
    // anything. Only meaningful once some catalog run has actually priced
    // this event (e.g. it's been submitted to DFC Cost Model and the
    // pipeline has caught up); silently does nothing otherwise, same as
    // today's manual-entry path. Only overwrites Run ID when it's still
    // empty — never clobbers a Run ID the user typed in themselves or one
    // a just-finished pipeline run already filled in.
    async function syncRunIdFromServer() {
        const runIdInput = $("#stratRunId");
        if (!runIdInput || runIdInput.value.trim() || !eventName || !eventYear) return;
        try {
            const res = await api("/api/resolve_run_id?event_name=" + encodeURIComponent(eventName)
                + "&event_year=" + encodeURIComponent(eventYear));
            if (res.run_id) {
                runIdInput.value = res.run_id;
                if (res.sku_grp && $("#stratSkuGrp")) $("#stratSkuGrp").value = res.sku_grp;
            }
        } catch (e) {
            // Non-fatal — leave the fields as-is for manual entry.
        }
    }

    // ── Loading / Toast ────────────────────────────────────────────
    function showLoading(msg) {
        const el = $("#loadingText");
        if (el) el.textContent = msg || "Loading…";
        $("#loadingOverlay").classList.add("active");
    }
    function hideLoading() { $("#loadingOverlay").classList.remove("active"); }

    // Single source of truth for #btnGoInsert's disabled state.
    function refreshNextButtonState() {
        const btn = $("#btnGoInsert");
        if (btn) btn.disabled = !uploadValidated;
    }

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
            // Try Run ID first (it fills SKU Group itself when it finds a
            // match) — syncSkuGrpFromServer() is still the fallback for
            // whichever fills Run ID in some other way (typed by hand, or a
            // pipeline run finishing while already on this step).
            syncRunIdFromServer();
            syncSkuGrpFromServer();
        }

        // Refresh the "Follow last year's strategy?" offer when arriving at
        // Step 2, in case Step 1's lookup changed since last time. This only
        // ever has something to show if the user actually clicked "View
        // Last Year's Strategy" on Step 1 first — there's no silent
        // background lookup here, so a strategy is never pre-filled without
        // the user explicitly asking for it.
        if (n === 2) {
            refreshFollowLastYearUI();
            // The Bulk/Parcel split only ever applies to DC Selection — only
            // show the opt-in checkbox if that's already the active strategy
            // (e.g. returning to Step 2 after picking it earlier); the
            // strategy radios' own change handler shows/hides this the rest
            // of the time.
            const stockTypeBox = $("#stockTypeSplitBox");
            if (stockTypeBox) stockTypeBox.style.display = selectedStrategy === "DC_SELECTION" ? "block" : "none";
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
            const descText = $("#templateDescText");
            const btnText = $("#btnDownloadTemplate");

            if (csStep1) csStep1.style.display = includesImports ? "block" : "none";
            if (descText) {
                descText.innerHTML = includesImports ? "*requires Factory ID" : "";
            }
            if (btnText) {
                btnText.innerHTML = `<i class="fas fa-download"></i> Download ${includesImports ? "Import" : "Domestic"} Template`;
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

    // "47.9K" style — only for the by-DFC breakdown table below, where a full
    // comma-formatted number per row would be noisier than useful; fmtCube/
    // fmtNum stay full-precision everywhere else.
    function fmtCompact(v) {
        if (v == null) return "—";
        const n = Number(v);
        return Math.abs(n) >= 1000 ? (n / 1000).toFixed(1) + "K" : n.toLocaleString("en-US");
    }

    // Same "MAIN" suffix convention app.py's _dc_display_name uses for the
    // main side of a campus pair (see CAMPUS_PAIRS in config.py) — ALL_DCS
    // itself just says "Perris"/"Locust Grove" for those, which reads as
    // ambiguous next to their own "Perris Bulk"/"Locust Grove Bulk" rows in
    // the same table.
    const _CAMPUS_MAIN_SUFFIX_DCS = new Set([6007, 6777]);
    function dfcDisplayName(dcNbr) {
        const base = ALL_DCS.find(d => d.nbr === dcNbr)?.name || `DC ${dcNbr}`;
        return _CAMPUS_MAIN_SUFFIX_DCS.has(dcNbr) ? `${base} MAIN` : base;
    }

    // The prior-year card (and the lastPriorYearStrategy it's cached onto)
    // is looked up by Event Name — switching it on Step 1 (e.g. from GIFT
    // CENTER to PATIO) left "2026 GIFT CENTER DOMESTIC" showing under
    // "PATIO", a completely different event's card. Hide it and drop the
    // cache rather than leave it lying around; a fresh "View Last Year's
    // Strategy" click repopulates it for whatever event is selected now.
    function clearPriorYearStrategy() {
        lastPriorYearStrategy = null;
        const section = $("#priorStrategySection");
        if (section) { section.style.display = "none"; section.innerHTML = ""; }
        refreshFollowLastYearUI();
    }

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
                clearPriorYearStrategy();
                const isOther = select.value === "__other__";
                if (customInput) {
                    customInput.style.display = isOther ? "block" : "none";
                    if (isOther) customInput.focus();
                }
                updatePriorYearAvailability();
                scheduleAutoPriorYearCheck();
            });
            updatePriorYearAvailability();
            customInput?.addEventListener("input", () => {
                customInput.value = customInput.value.toUpperCase();
                scheduleAutoPriorYearCheck(600); // debounced — this one's free text
            });
        }

        // Changing the year or event type invalidates whatever prior-year
        // card is currently showing (it was looked up for a different
        // combination) — clear it, then silently re-check in the background
        // once name/year/type all resolve to a real combination (see
        // scheduleAutoPriorYearCheck/autoCheckPriorYearIfReady below). The
        // manual "View Last Year's Strategy" button still works the same
        // way too, e.g. to force a re-check or use the Import/Domestic
        // fallback prompt.
        yearInput?.addEventListener("input", () => {
            clearPriorYearStrategy();
            scheduleAutoPriorYearCheck(600);
        });
        document.addEventListener("change", (e) => {
            if (e.target?.name === "importToggle") {
                clearPriorYearStrategy();
                scheduleAutoPriorYearCheck();
            }
        });

        function currentEventName() {
            if (select?.value === "__other__") {
                // Uppercased for the same governance reason the dropdown exists —
                // keeps a newly-typed name consistent with the canonical
                // convention instead of introducing a stray-cased variant.
                return (customInput?.value || "").trim().toUpperCase();
            }
            return select?.value || "";
        }

        // Runs the prior-year lookup and records it onto lastPriorYearStrategy,
        // rendering the summary card into Step 1's section. Called both from
        // the manual "View Last Year's Strategy" click (and its "Did you
        // mean Import/Domestic?" fallback buttons) and from the silent
        // background auto-check (autoCheckPriorYearIfReady) that fires once
        // event name/year/type resolve to a real combination — either way,
        // Step 2's "Follow last year's strategy?" offer only ever shows if
        // this actually found a match, never a strategy pre-filled from thin air.
        async function performPriorYearCheck(name, year, isImportVal) {
            // A file already validated for a different event/year/type is now
            // stale — Step 2 must not carry it forward under whatever's just
            // been looked up here, so clear it before running the lookup.
            const checkKey = `${name}|${year}|${isImportVal}`;
            if (lastUploadEventKey && lastUploadEventKey !== checkKey) {
                await resetStep2Upload();
            }
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
                const checkedTypeLabel = result.checked_type
                    ? result.checked_type.charAt(0).toUpperCase() + result.checked_type.slice(1)
                    : "";
                const checkedLabel = result.checked_year
                    ? `${result.checked_year} ${toTitleCase(name)}${checkedTypeLabel ? " " + checkedTypeLabel : ""}`
                    : toTitleCase(name);
                const fallbackLabel = result.fallback_available
                    ? (result.fallback_is_import === "true" ? "Import" : "Domestic")
                    : "";
                // A single self-contained warning — no other content in this
                // section alongside it. When there's nothing to fall back to,
                // it's just the notice; when there is, Yes/No replace the old
                // plain-text link so the choice reads as a real decision, in
                // the same orange/gray (primary/secondary) THD button colors
                // used everywhere else in this app.
                section.innerHTML = `
                    <div style="padding:14px 16px;background:#fff3cd;border:1px solid #ffc107;border-radius:8px">
                        <i class="fas fa-exclamation-triangle" style="color:#856404;margin-right:6px"></i>
                        <strong style="color:#856404">${checkedLabel} has no history.</strong>
                        ${fallbackLabel ? `
                        <p style="margin:8px 0 10px;color:#856404;font-size:.85rem">Did you mean <strong>${fallbackLabel}</strong>?</p>
                        <div style="display:flex;gap:8px">
                            <button type="button" class="btn btn-primary" id="priorStrategyFallbackYes" style="font-size:.8rem;padding:6px 16px">Yes</button>
                            <button type="button" class="btn btn-secondary" id="priorStrategyFallbackNo" style="font-size:.8rem;padding:6px 16px">No</button>
                        </div>` : ""}
                    </div>`;
                if (fallbackLabel) {
                    $("#priorStrategyFallbackYes")?.addEventListener("click", async () => {
                        // Keep the Event Type toggle in sync with the results we're
                        // about to show — dispatching "change" (not just setting
                        // .checked) lets the existing document-level listener re-run
                        // syncImportToggle(), which also updates the container-size
                        // panel and template text for the new type.
                        const radio = document.querySelector(`input[name="importToggle"][value="${result.fallback_is_import}"]`);
                        if (radio) {
                            radio.checked = true;
                            radio.dispatchEvent(new Event("change", { bubbles: true }));
                        }
                        showLoading("Checking for a prior year's strategy…");
                        try {
                            await performPriorYearCheck(name, year, result.fallback_is_import);
                        } finally {
                            hideLoading();
                        }
                    });
                    $("#priorStrategyFallbackNo")?.addEventListener("click", () => {
                        section.style.display = "none";
                    });
                }
                return result;
            }
            const o = result.overall;
            const isVendorAligned = (o.strategy_type || "").toUpperCase() === "VENDOR-ALIGNED";
            const STRATEGY_TYPE_LABELS = { "SINGLE-DC COUNT": "Single-DC Count Strategy", "MULTI-DC COUNT": "Multi-DC Count Strategy" };
            const strategyLabel = isVendorAligned
                ? "Vendor-Aligned Strategy"
                : (STRATEGY_TYPE_LABELS[(o.strategy_type || "").toUpperCase()] || o.strategy_type || "Strategy Not Recorded");
            const countLabel = isVendorAligned ? "Suppliers" : "DC Counts";
            // Vendor-aligned rows can list more than one vendor per row (rows
            // sharing an identical DC list are merged) so the supplier count
            // is the number of vendor names across all rows, not the row count.
            // For a non-vendor-aligned strategy, "DC Counts" is the distinct
            // set of per-THD-key DC counts (how many DCs each individual
            // SKU/factory record was assigned to) — not a single overall
            // total, since different keys can use different DC counts.
            const dcCountsByKey = o.dc_counts_by_key || [];
            const countValueDisplay = isVendorAligned
                ? fmtNum((result.strategy_summary || []).reduce((sum, s) => sum + (s.vendor ? s.vendor.split(", ").length : 0), 0))
                : (dcCountsByKey.length ? dcCountsByKey.join(", ") : "—");
            // Only label Domestic/Import when the backend actually applied
            // that filter for this event/year (result.is_import_known) —
            // otherwise IS_IMPORT was never populated on these rows (e.g.
            // Halfway Halloween, backfilled before that column existed), so
            // the toggle position on screen is just whatever was last
            // selected, not a fact about this event. Showing "DOMESTIC" next
            // to the year would claim a distinction the data doesn't make.
            const eventTypeLabel = !result.is_import_known ? "" : (isImportVal === "true" ? "IMPORT" : isImportVal === "false" ? "DOMESTIC" : "");
            let html = `<div class="prior-strategy-card">
                <div class="prior-strategy-heading">
                    <div><span class="prior-strategy-kicker">${strategyLabel}</span>
                        <h4><i class="fas fa-calendar-days"></i> <span style="color:var(--hd-orange)">${result.event_year}</span> ${result.event_name}${eventTypeLabel ? " " + eventTypeLabel : ""}</h4></div>
                    <span class="prior-strategy-type">${eventTypeLabel || "—"}</span>
                </div>
                <div class="prior-strategy-metrics">
                    <div><span>${countLabel}</span><strong>${countValueDisplay}</strong></div>
                    <div><span>Total Units</span><strong>${fmtNum(o.total_units)}</strong></div>
                    <div><span>Total Cube (ft&sup3;)</span><strong>${fmtCube(o.total_cube)}</strong></div>
                    <div><span>Total SKUs</span><strong>${fmtNum(o.distinct_thd_keys)}</strong></div>
                    <div><span>Total DCs Used</span><strong>${fmtNum(o.normalized_dc_count)}</strong></div>
                </div>`;
            const hasDcDetails = result.strategy_summary?.length && !isVendorAligned;
            if (result.strategy_summary?.length && isVendorAligned) {
                html += `<div class="prior-strategy-details"><div class="prior-strategy-details-title">Vendor DC Details</div>`;
                // Highest DC count first, then (within the same DC count)
                // whichever row covers the most SKUs — e.g. among several
                // 9-DC rows, the one with 600 SKUs outranks one with 4.
                const sortedSummary = [...result.strategy_summary].sort((a, b) =>
                    (b.dc_count ?? 0) - (a.dc_count ?? 0) || (b.thd_key_count ?? 0) - (a.thd_key_count ?? 0));
                for (const s of sortedSummary) {
                    html += `<div class="prior-strategy-detail-row prior-strategy-detail-row-vendor"><strong>${s.vendor || "—"}</strong><small title="${s.dc_name_list || s.dc_list || ""}">${s.dc_list || "—"}</small><span>${s.dc_count ?? "—"} DC${s.dc_count === 1 ? "" : "s"}</span><span>${fmtNum(s.thd_key_count)} SKUs</span></div>`;
                }
                html += `</div>`;
            }
            // by_dc is raw (unfolded) — Perris Bulk/Main and Locust Grove
            // Bulk/Main show as separate rows even for a merged campus, since
            // this is meant to show exactly which physical buildings units/
            // cube actually landed in. Already sorted by units descending
            // from the backend.
            const hasByDc = !!result.by_dc?.length;
            if (hasByDc) {
                html += `<div class="prior-strategy-details"><div class="prior-strategy-details-title">By DFC — Units &amp; Cube</div>
                    <table class="prior-strategy-dc-table"><thead><tr><th>DFC</th><th>Units</th><th>Cube</th></tr></thead><tbody>`;
                for (const d of result.by_dc) {
                    html += `<tr><td>${dfcDisplayName(d.dc_nbr).toUpperCase()}</td><td>${fmtCompact(d.units)}</td><td>${fmtCompact(d.cube)}</td></tr>`;
                }
                html += `</tbody></table>`;
                // The DC Details breakdown below is hidden behind this toggle
                // — it's the same data as the metrics/By DFC table above, just
                // broken out per DC-count tier, so it's secondary detail most
                // people won't need to see by default.
                if (hasDcDetails) {
                    html += `<button type="button" class="btn btn-primary" id="btnTogglePriorDcDetails" style="margin-top:12px;font-size:.8rem">
                        <i class="fas fa-table"></i> View DC Details
                    </button>`;
                }
                html += `</div>`;
            }
            if (hasDcDetails) {
                // Non-vendor-aligned: ASMT_ID is null on every backfilled row,
                // so there's no meaningful per-assortment grouping to show —
                // group by each key's actual DC set instead (same breakdown
                // dc_counts_by_key/is_cascading are computed from), so this
                // always has something real to show.
                const sortedSummary = [...result.strategy_summary].sort((a, b) =>
                    (a.dc_count ?? 0) - (b.dc_count ?? 0) || (a.dc_list || "").localeCompare(b.dc_list || ""));
                // Only actually hidden-behind-the-toggle when the By DFC table
                // rendered above it to reveal it — otherwise (rare: no by_dc
                // data at all) it's shown directly so it's never stuck
                // permanently inaccessible.
                html += `<div class="prior-strategy-details" id="priorDcDetailsBox" style="${hasByDc ? "display:none;margin-top:16px" : ""}">
                    <div class="prior-strategy-details-title">DC Details</div>
                    <table class="prior-strategy-dc-table dc-details-table">
                    <thead><tr><th>DC Count</th><th>DC Names</th><th>DC List</th><th>Total SKUs</th></tr></thead><tbody>`;
                for (const s of sortedSummary) {
                    html += `<tr><td>${s.dc_count ?? "—"}</td><td title="${s.dc_list || ""}">${s.dc_name_list || s.dc_list || "—"}</td><td title="${s.dc_name_list || s.dc_list || ""}">${s.dc_list || "—"}</td><td>${fmtNum(s.num_keys)}</td></tr>`;
                }
                html += `</tbody></table></div>`;
            }
            html += `</div>`;
            section.innerHTML = html;
            $("#btnTogglePriorDcDetails")?.addEventListener("click", () => {
                const box = $("#priorDcDetailsBox");
                const btn = $("#btnTogglePriorDcDetails");
                if (!box || !btn) return;
                const show = box.style.display === "none";
                box.style.display = show ? "block" : "none";
                btn.innerHTML = show
                    ? '<i class="fas fa-table"></i> Hide DC Details'
                    : '<i class="fas fa-table"></i> View DC Details';
            });
            return result;
        }

        // Debounced background check: fires shortly after event name, year,
        // and Domestic/Import all resolve to a real combination, without
        // requiring the "View Last Year's Strategy" click. Skips a combo
        // it's already checked (autoPriorYearCheckedFor) so switching back
        // and forth between two events already looked up doesn't re-fetch
        // either one, and stays silent on failure — this is a convenience,
        // not a user-initiated action, so it shouldn't toast an error the
        // manual button would still be able to explain properly.
        function scheduleAutoPriorYearCheck(delay = 300) {
            clearTimeout(autoPriorYearCheckTimer);
            autoPriorYearCheckTimer = setTimeout(autoCheckPriorYearIfReady, delay);
        }

        async function autoCheckPriorYearIfReady() {
            if (select?.value === "__other__") return; // nothing on file yet for a brand-new event name
            const name = currentEventName();
            const year = yearInput?.value?.trim();
            if (!name || !year) return;
            const isImportVal = document.querySelector('input[name="importToggle"]:checked')?.value;
            const checkKey = `${name}|${year}|${isImportVal}`;
            if (autoPriorYearCheckedFor === checkKey) return;
            autoPriorYearCheckedFor = checkKey;
            priorYearCheckInFlight = true;
            try {
                await performPriorYearCheck(name, year, isImportVal);
                // The user may already be on Step 2 by the time this
                // resolves (its debounce + network round trip can outlast a
                // fast click to Next) — refresh its offer now rather than
                // leaving it showing nothing until some later, unrelated
                // event happens to call refreshFollowLastYearUI again.
                if (currentStep === 2) refreshFollowLastYearUI();
            } catch (e) {
                // Silent — see comment above.
            } finally {
                priorYearCheckInFlight = false;
            }
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
        $("#btnDownloadValidatedUpload")?.addEventListener("click", () => {
            window.location.href = "/api/download_validated_upload";
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
        // A fresh file also invalidates any bulk/parcel classification run
        // against the old one — force it to be re-run before it's trusted again.
        resetStockTypeSplit();
        dcSelectionCostModelSubmitted = false;

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
            if (result.passed) {
                lastUploadEventKey = `${(step1IsExistingEvent ? step1EventSelect.value : (step1EventCustom?.value || "")).trim()}|${$("#step1EventYear")?.value?.trim() || ""}|${includesImports.toString()}`;
            }
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
            uploadValidated = false;
            refreshNextButtonState();
            $("#importMismatchAlert").style.display = "block";
            toast(result.import_mismatch_msg, "error");
            return;
        }

        // Available whenever there's something worth reviewing row-by-row —
        // failed rows to fix, or rows the validator silently adjusted.
        const downloadValidatedBtn = $("#btnDownloadValidatedUpload");
        if (downloadValidatedBtn) {
            const hasIssues = (result.errors?.length || 0) > 0 || (result.warnings?.length || 0) > 0;
            downloadValidatedBtn.style.display = hasIssues ? "inline-flex" : "none";
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
            } else {
                // Clear out whatever a *previous* upload left behind — a
                // reupload with no factory data (e.g. it's now domestic, or
                // FACTORY_ID was dropped) must not keep the old file's stale
                // distribution around for the low-volume check below to use.
                window._factoryDist = null;
                if (distContainer) distContainer.style.display = "none";
            }
            // Re-upload/re-validation refreshes window._factoryDist above, but
            // the DC toggle grid's own selection doesn't change just because
            // of that — nothing re-clicks it, so nothing would otherwise
            // re-run the low-volume check against the new data until the
            // user happened to retoggle a DC count. Refresh it here too.
            renderLowVolumeAlert();
            eventName = result.summary.event_name || "";
            eventYear = result.summary.event_year || "";
            waveCount = result.summary.wave_count || 0;
            uploadValidated = true;
            refreshNextButtonState();
            toast("File validation passed!", "success");
        } else {
            $("#successSection").style.display = "none";
            uploadValidated = false;
            refreshNextButtonState();
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

    // Wipes Step 2's uploaded-file state — client-side display and the
    // server's cached upload alike — so a file validated for one event/year/
    // type never lingers once Step 1 looks up a *different* combination's
    // prior-year strategy. Called from performPriorYearCheck when it detects
    // that mismatch; a no-op in effect (server clear aside) if nothing was
    // ever uploaded.
    async function resetStep2Upload() {
        // eventName/eventYear are only ever (re-)set from a successful file-
        // validation response (see handleFile) — clearing them here too, not
        // just lastUploadEventKey, means any action still gated on eventName
        // (matchVendorStrategy, doInsert, submitCostModel, "Use last year's
        // strategy") fails closed until the new event is actually uploaded,
        // rather than silently running against the previous event's stale name.
        eventName = "";
        eventYear = "";
        waveCount = 0;
        dataInserted = false;
        dcSelectionCostModelSubmitted = false;
        lastUploadEventKey = null;
        resetStockTypeSplit();
        const fileInput = $("#fileInput");
        if (fileInput) fileInput.value = "";
        const fileNameEl = $("#fileName");
        if (fileNameEl) fileNameEl.textContent = "";
        const validationResults = $("#validationResults");
        if (validationResults) validationResults.style.display = "none";
        $("#checksList")?.replaceChildren();
        const successSection = $("#successSection");
        if (successSection) successSection.style.display = "none";
        const errorSection = $("#errorSection");
        if (errorSection) errorSection.style.display = "none";
        const importMismatchEl = $("#importMismatchAlert");
        if (importMismatchEl) importMismatchEl.style.display = "none";
        uploadValidated = false;
        refreshNextButtonState();
        const distContainer = $("#factoryDistribution");
        if (distContainer) distContainer.style.display = "none";
        window._factoryDist = null;
        const followLastYearNote = $("#followLastYearNote");
        if (followLastYearNote) followLastYearNote.style.display = "none";
        resetStep2VendorAndSubmissionState();
        try {
            await api("/api/clear_upload_cache", { method: "POST" });
        } catch (e) {
            // Best-effort — the next real upload overwrites the server cache
            // anyway, so a failed clear here isn't worth surfacing.
        }
    }

    // Wipes everything Step 2 shows about a *submission* — the Vendor-Aligned
    // supplier/DC match table, the "Confirm Vendor Strategies" button state,
    // and any "already submitted"/delete-previous-submission banner — none of
    // which resetStep2Upload above touches on its own even though all of it
    // is just as tied to one specific event as the uploaded file is. Without
    // this, switching events in Step 1 left the *previous* event's Supplier DC
    // Assignments table and submission banners on screen in Step 2, since
    // those are only ever populated by matchVendorStrategy()/loadCostModelPreview()
    // and nothing previously cleared them when the event changed underneath.
    function resetStep2VendorAndSubmissionState() {
        vendorMatches = [];
        vendorStrategyConfirmed = false;
        skipResubmitBecauseUnchanged = false;

        const vendorMatchResult = $("#vendorMatchResult");
        if (vendorMatchResult) vendorMatchResult.style.display = "none";
        const vendorMatchSummary = $("#vendorMatchSummary");
        if (vendorMatchSummary) vendorMatchSummary.innerHTML = "";
        const vendorSupplierSummary = $("#vendorSupplierSummary");
        if (vendorSupplierSummary) vendorSupplierSummary.innerHTML = "";

        const btnConfirmVendorStrategy = $("#btnConfirmVendorStrategy");
        if (btnConfirmVendorStrategy) {
            btnConfirmVendorStrategy.disabled = false;
            btnConfirmVendorStrategy.innerHTML = '<i class="fas fa-check"></i> Confirm Vendor Strategies';
        }
        const vendorSubmitStatus = $("#vendorSubmitStatus");
        if (vendorSubmitStatus) vendorSubmitStatus.innerHTML = "";
        const btnDeleteVendorCostModel = $("#btnDeleteVendorCostModel");
        if (btnDeleteVendorCostModel) btnDeleteVendorCostModel.style.display = "none";

        const dcSelectionSubmitStatus = $("#dcSelectionSubmitStatus");
        if (dcSelectionSubmitStatus) dcSelectionSubmitStatus.innerHTML = "";
        const btnDeleteDcCostModel = $("#btnDeleteDcCostModel");
        if (btnDeleteDcCostModel) btnDeleteDcCostModel.style.display = "none";

        const costModelPreview = $("#costModelPreview");
        if (costModelPreview) costModelPreview.style.display = "none";
        const costModelStatus = $("#costModelStatus");
        if (costModelStatus) costModelStatus.innerHTML = "";
        const btnDeleteCostModel = $("#btnDeleteCostModel");
        if (btnDeleteCostModel) btnDeleteCostModel.style.display = "none";

        const vendorChartContainer = $("#vendorChartContainer");
        if (vendorChartContainer) vendorChartContainer.style.display = "none";
        if (vendorPieChart) { vendorPieChart.destroy(); vendorPieChart = null; }
        if (skuUnitsPieChart) { skuUnitsPieChart.destroy(); skuUnitsPieChart = null; }
        if (skuCountPieChart) { skuCountPieChart.destroy(); skuCountPieChart = null; }
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
        let totalSkus = 0, totalContainers = 0;
        for (const f of sorted) {
            const c = (f.factory_cube || 0) / divisor;
            const containers = hasCube ? c.toFixed(2) : "—";
            totalSkus += f.sku_count || 0;
            totalContainers += c;
            const tr = document.createElement("tr");
            tr.innerHTML = `<td>${f.factory_id}</td><td style="text-align:right">${containers}</td><td style="text-align:right">${fmtNum(f.sku_count)}</td>`;
            tbody.appendChild(tr);
        }
        const tfoot = document.createElement("tr");
        tfoot.style.fontWeight = "700";
        tfoot.style.borderTop = "2px solid #333";
        tfoot.innerHTML = `<td>Total</td><td style="text-align:right">${hasCube ? totalContainers.toFixed(2) : "—"}</td><td style="text-align:right">${fmtNum(totalSkus)}</td>`;
        tbody.appendChild(tfoot);

        renderFactoryDistChart(sorted, hasCube, divisor);
        // The chart above was just rebuilt from scratch, wiping any prior
        // low-volume highlight — re-derive it (a no-op if DC counts haven't
        // been picked yet) instead of leaving it stale until the next DC
        // toggle click.
        renderLowVolumeAlert();
    }

    // ── Factory distribution bar chart ──────────────────────────────
    // Bar height is the same metric ranked in the table above (Containers once
    // real factory cube is known, Optimal Buy Units as a fallback before that).
    // The number above each bar is a second metric (distinct THD Keys) riding
    // as an annotation, not a repeat of the bar's own encoded value.
    function roundedTopRectPath(x, y, w, h, r) {
        r = Math.max(0, Math.min(r, h, w / 2));
        return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} `
            + `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
    }

    function niceAxisMax(rawMax) {
        if (!(rawMax > 0)) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(rawMax)));
        const norm = rawMax / mag;
        const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
        return step * mag;
    }

    function positionChartTooltip(evt, tooltip) {
        const pad = 14;
        const rectW = tooltip.offsetWidth || 180;
        const rectH = tooltip.offsetHeight || 60;
        let left = evt.clientX + pad;
        let top = evt.clientY + pad;
        if (left + rectW > window.innerWidth) left = evt.clientX - rectW - pad;
        if (top + rectH > window.innerHeight) top = evt.clientY - rectH - pad;
        tooltip.style.left = Math.max(4, left) + "px";
        tooltip.style.top = Math.max(4, top) + "px";
    }

    function renderFactoryDistChart(sorted, hasCube, divisor) {
        const metricLabel = $("#factoryDistChartMetricLabel");
        if (metricLabel) metricLabel.textContent = hasCube ? "Containers" : "Optimal Buy Units";
        // Containers have a real physical unit worth drawing one dot per —
        // Optimal Buy Units (the fallback before real factory cube is known)
        // doesn't, so that case stays a plain bar rather than a fake dot plot.
        if (hasCube) {
            renderFactoryDistDots(sorted, divisor);
        } else {
            renderFactoryDistBars(sorted, divisor);
        }
    }

    function renderFactoryDistBars(sorted, divisor) {
        const svg = $("#factoryDistChart");
        const tooltip = $("#factoryDistTooltip");
        if (!svg) return;
        svg.innerHTML = "";
        if (!sorted || !sorted.length) {
            svg.setAttribute("width", "0");
            svg.setAttribute("height", "0");
            return;
        }

        const svgNS = "http://www.w3.org/2000/svg";
        const values = sorted.map(f => f.optimal_buy_units || 0);
        const niceMax = niceAxisMax(Math.max(...values, 0));

        const barW = 22, barGap = 10;
        const plotLeft = 44, plotRight = 12, plotTop = 20, plotHeight = 140, plotBottom = 58;
        const chartWidth = plotLeft + sorted.length * (barW + barGap) - barGap + plotRight;
        const chartHeight = plotTop + plotHeight + plotBottom;
        const baselineY = plotTop + plotHeight;

        svg.setAttribute("width", chartWidth);
        svg.setAttribute("height", chartHeight);
        svg.setAttribute("viewBox", `0 0 ${chartWidth} ${chartHeight}`);

        // Y gridlines + ticks, rounded to clean numbers
        const tickCount = 4;
        for (let i = 0; i <= tickCount; i++) {
            const val = (niceMax / tickCount) * i;
            const y = baselineY - (val / niceMax) * plotHeight;

            const grid = document.createElementNS(svgNS, "line");
            grid.setAttribute("x1", plotLeft);
            grid.setAttribute("x2", chartWidth - plotRight);
            grid.setAttribute("y1", y);
            grid.setAttribute("y2", y);
            grid.setAttribute("class", i === 0 ? "chart-baseline" : "chart-grid-line");
            svg.appendChild(grid);

            const tickLabel = document.createElementNS(svgNS, "text");
            tickLabel.setAttribute("x", plotLeft - 6);
            tickLabel.setAttribute("y", y + 3);
            tickLabel.setAttribute("class", "chart-y-tick-label");
            tickLabel.textContent = fmtNum(Math.round(val));
            svg.appendChild(tickLabel);
        }

        sorted.forEach((f, i) => {
            const val = values[i];
            const barH = niceMax > 0 ? Math.max((val / niceMax) * plotHeight, val > 0 ? 1 : 0) : 0;
            const x = plotLeft + i * (barW + barGap);
            const y = baselineY - barH;

            const bar = document.createElementNS(svgNS, "path");
            bar.setAttribute("d", roundedTopRectPath(x, y, barW, barH, 4));
            bar.setAttribute("class", "chart-bar");
            bar.setAttribute("data-factory-id", f.factory_id);
            bar.setAttribute("tabindex", "0");
            bar.setAttribute("role", "img");
            const valueText = `${fmtNum(Math.round(val))} optimal buy units`;
            bar.setAttribute("aria-label", `Factory ${f.factory_id}: ${valueText}, ${f.sku_count} distinct records`);
            svg.appendChild(bar);

            // Distinct THD Key count, direct-labeled above every bar (the one
            // number this chart deliberately puts on every mark — see comment above).
            const countLabel = document.createElementNS(svgNS, "text");
            countLabel.setAttribute("x", x + barW / 2);
            countLabel.setAttribute("y", Math.max(y - 6, plotTop - 6));
            countLabel.setAttribute("class", "chart-bar-count-label");
            countLabel.textContent = fmtNum(f.sku_count);
            svg.appendChild(countLabel);

            // Factory ID axis label, rotated to fit under a 22px-wide bar
            const xLabel = document.createElementNS(svgNS, "text");
            xLabel.setAttribute("class", "chart-axis-tick-label");
            xLabel.setAttribute("text-anchor", "end");
            xLabel.setAttribute("transform", `translate(${x + barW / 2},${baselineY + 8}) rotate(-55)`);
            xLabel.textContent = f.factory_id;
            svg.appendChild(xLabel);

            if (tooltip) {
                const showTip = (evt) => {
                    bar.classList.add("is-active");
                    tooltip.innerHTML = `<div>Factory <strong>${f.factory_id}</strong></div>`
                        + `<div>Optimal Buy Units: <strong>${fmtNum(f.optimal_buy_units)}</strong></div>`
                        + `<div>Distinct Records: <strong>${fmtNum(f.sku_count)}</strong></div>`;
                    tooltip.style.display = "block";
                    if (evt.clientX != null) positionChartTooltip(evt, tooltip);
                };
                const hideTip = () => {
                    bar.classList.remove("is-active");
                    tooltip.style.display = "none";
                };
                bar.addEventListener("pointerenter", showTip);
                bar.addEventListener("pointermove", showTip);
                bar.addEventListener("pointerleave", hideTip);
                bar.addEventListener("focus", () => {
                    const box = bar.getBoundingClientRect();
                    showTip({ clientX: box.right, clientY: box.top });
                });
                bar.addEventListener("blur", hideTip);
            }
        });
    }

    // ── Factory distribution dot plot (waffle grid) ─────────────────
    // One square dot = one shipping container. Dots wrap into a fixed-width
    // grid (GRID_COLS wide) per factory instead of one tall column, so a
    // 50-container factory stays as readable as a 2-container one — the
    // chart's height grows with the tallest *grid* (rows), not with the raw
    // container count. A fractional container (e.g. 45.3) gets one extra
    // dot whose fill only covers that fraction, anchored to the dot's own
    // bottom edge, so it visually reads as "partially filled."
    const DOT_GRID_COLS = 5;
    const DOT_SIZE = 7;
    const DOT_GAP = 2;
    const DOT_ROW_H = DOT_SIZE + DOT_GAP;

    // How many dots (whole + one partial) a container value needs, and the
    // fraction (0 when the value lands on a whole number) the last dot
    // should show as filled. Rounds to hundredths first so float noise from
    // cube/divisor division (e.g. 44.999999999) never manufactures a
    // spurious near-zero partial dot.
    function dotsForContainerValue(v) {
        const rounded = Math.round(Math.max(v, 0) * 100) / 100;
        const whole = Math.floor(rounded + 1e-9);
        const frac = Math.round((rounded - whole) * 100) / 100;
        const hasPartial = frac > 0.004;
        return { whole, frac: hasPartial ? frac : 0, total: whole + (hasPartial ? 1 : 0) };
    }

    function roundedRectPath(x, y, w, h, r) {
        r = Math.max(0, Math.min(r, h / 2, w / 2));
        if (h <= 0 || w <= 0) return "";
        return `M${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} `
            + `L${x + w},${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} `
            + `L${x + r},${y + h} Q${x},${y + h} ${x},${y + h - r} `
            + `L${x},${y + r} Q${x},${y} ${x + r},${y} Z`;
    }

    function renderFactoryDistDots(sorted, divisor) {
        const svg = $("#factoryDistChart");
        const tooltip = $("#factoryDistTooltip");
        if (!svg) return;
        svg.innerHTML = "";
        if (!sorted || !sorted.length) {
            svg.setAttribute("width", "0");
            svg.setAttribute("height", "0");
            return;
        }

        const svgNS = "http://www.w3.org/2000/svg";
        const values = sorted.map(f => (f.factory_cube || 0) / divisor);
        const niceMax = niceAxisMax(Math.max(...values, 0));
        const dotCounts = values.map(dotsForContainerValue);

        const slotW = DOT_GRID_COLS * DOT_SIZE + (DOT_GRID_COLS - 1) * DOT_GAP;
        const slotGap = 16;
        // Rows needed to reach niceMax (always >= every real value — see
        // niceAxisMax), so every factory's own grid always fits within it.
        const rowsForNiceMax = Math.max(1, Math.ceil(niceMax / DOT_GRID_COLS));
        const plotHeight = rowsForNiceMax * DOT_SIZE + (rowsForNiceMax - 1) * DOT_GAP;

        const plotLeft = 44, plotRight = 12, plotTop = 20, plotBottom = 58;
        const chartWidth = plotLeft + sorted.length * (slotW + slotGap) - slotGap + plotRight;
        const chartHeight = plotTop + plotHeight + plotBottom;
        const baselineY = plotTop + plotHeight;

        svg.setAttribute("width", chartWidth);
        svg.setAttribute("height", chartHeight);
        svg.setAttribute("viewBox", `0 0 ${chartWidth} ${chartHeight}`);

        // Y gridlines + ticks, in units of containers — a continuous
        // reference scale over the discrete dot grid underneath it.
        const tickCount = 4;
        for (let i = 0; i <= tickCount; i++) {
            const val = (niceMax / tickCount) * i;
            const y = baselineY - (val / DOT_GRID_COLS) * DOT_ROW_H;

            const grid = document.createElementNS(svgNS, "line");
            grid.setAttribute("x1", plotLeft);
            grid.setAttribute("x2", chartWidth - plotRight);
            grid.setAttribute("y1", y);
            grid.setAttribute("y2", y);
            grid.setAttribute("class", i === 0 ? "chart-baseline" : "chart-grid-line");
            svg.appendChild(grid);

            const tickLabel = document.createElementNS(svgNS, "text");
            tickLabel.setAttribute("x", plotLeft - 6);
            tickLabel.setAttribute("y", y + 3);
            tickLabel.setAttribute("class", "chart-y-tick-label");
            tickLabel.textContent = val.toFixed(1);
            svg.appendChild(tickLabel);
        }

        sorted.forEach((f, i) => {
            const val = values[i];
            const { frac, total } = dotCounts[i];
            const rows = total > 0 ? Math.ceil(total / DOT_GRID_COLS) : 0;
            const slotX = plotLeft + i * (slotW + slotGap);

            const group = document.createElementNS(svgNS, "g");
            group.setAttribute("class", "chart-dot-group");
            group.setAttribute("data-factory-id", f.factory_id);
            group.setAttribute("tabindex", "0");
            group.setAttribute("role", "img");
            group.setAttribute("aria-label",
                `Factory ${f.factory_id}: ${val.toFixed(2)} containers, ${f.sku_count} distinct records`);

            for (let d = 0; d < total; d++) {
                const row = Math.floor(d / DOT_GRID_COLS);
                const col = d % DOT_GRID_COLS;
                const dotX = slotX + col * (DOT_SIZE + DOT_GAP);
                const dotY = baselineY - (row + 1) * DOT_SIZE - row * DOT_GAP;
                const isPartial = frac > 0 && d === total - 1;

                if (!isPartial) {
                    const dot = document.createElementNS(svgNS, "rect");
                    dot.setAttribute("x", dotX);
                    dot.setAttribute("y", dotY);
                    dot.setAttribute("width", DOT_SIZE);
                    dot.setAttribute("height", DOT_SIZE);
                    dot.setAttribute("rx", 2);
                    dot.setAttribute("class", "chart-dot");
                    group.appendChild(dot);
                } else {
                    // Partial container: a light, outlined full-size cell
                    // underneath, and a fill clipped to that same rounded
                    // shape but only as tall as the fraction, anchored to
                    // the dot's bottom edge — reads as "part-full."
                    const clipId = `dotPartialClip-${i}-${d}`;
                    const clip = document.createElementNS(svgNS, "clipPath");
                    clip.setAttribute("id", clipId);
                    const clipShape = document.createElementNS(svgNS, "path");
                    clipShape.setAttribute("d", roundedRectPath(dotX, dotY, DOT_SIZE, DOT_SIZE, 2));
                    clip.appendChild(clipShape);
                    group.appendChild(clip);

                    const bg = document.createElementNS(svgNS, "rect");
                    bg.setAttribute("x", dotX);
                    bg.setAttribute("y", dotY);
                    bg.setAttribute("width", DOT_SIZE);
                    bg.setAttribute("height", DOT_SIZE);
                    bg.setAttribute("rx", 2);
                    bg.setAttribute("class", "chart-dot-partial-bg");
                    group.appendChild(bg);

                    const fillH = DOT_SIZE * frac;
                    const fill = document.createElementNS(svgNS, "rect");
                    fill.setAttribute("x", dotX);
                    fill.setAttribute("y", dotY + DOT_SIZE - fillH);
                    fill.setAttribute("width", DOT_SIZE);
                    fill.setAttribute("height", fillH);
                    fill.setAttribute("clip-path", `url(#${clipId})`);
                    fill.setAttribute("class", "chart-dot-partial-fill");
                    group.appendChild(fill);
                }
            }

            // Distinct THD Key count, direct-labeled above every factory's
            // grid (the one number this chart deliberately puts on every
            // mark — see comment above).
            const topY = baselineY - (rows * DOT_SIZE + Math.max(rows - 1, 0) * DOT_GAP);
            const countLabel = document.createElementNS(svgNS, "text");
            countLabel.setAttribute("x", slotX + slotW / 2);
            countLabel.setAttribute("y", Math.max(topY - 6, plotTop - 6));
            countLabel.setAttribute("class", "chart-bar-count-label");
            countLabel.textContent = fmtNum(f.sku_count);
            group.appendChild(countLabel);

            // Factory ID axis label, rotated to fit under a narrow slot
            const xLabel = document.createElementNS(svgNS, "text");
            xLabel.setAttribute("class", "chart-axis-tick-label");
            xLabel.setAttribute("text-anchor", "end");
            xLabel.setAttribute("transform", `translate(${slotX + slotW / 2},${baselineY + 8}) rotate(-55)`);
            xLabel.textContent = f.factory_id;
            group.appendChild(xLabel);

            // One hit target for the whole slot (dots are too small to
            // reliably hover individually) — drawn last so it sits on top.
            const hit = document.createElementNS(svgNS, "rect");
            hit.setAttribute("x", slotX - slotGap / 2);
            hit.setAttribute("y", plotTop);
            hit.setAttribute("width", slotW + slotGap);
            hit.setAttribute("height", baselineY - plotTop);
            hit.setAttribute("class", "chart-dot-hit");
            group.appendChild(hit);

            svg.appendChild(group);

            if (tooltip) {
                const showTip = (evt) => {
                    group.classList.add("is-active");
                    tooltip.innerHTML = `<div>Factory <strong>${f.factory_id}</strong></div>`
                        + `<div>Containers: <strong>${val.toFixed(2)}</strong></div>`
                        + `<div>Distinct Records: <strong>${fmtNum(f.sku_count)}</strong></div>`;
                    tooltip.style.display = "block";
                    if (evt.clientX != null) positionChartTooltip(evt, tooltip);
                };
                const hideTip = () => {
                    group.classList.remove("is-active");
                    tooltip.style.display = "none";
                };
                hit.addEventListener("pointerenter", showTip);
                hit.addEventListener("pointermove", showTip);
                hit.addEventListener("pointerleave", hideTip);
                group.addEventListener("focus", () => {
                    const box = hit.getBoundingClientRect();
                    showTip({ clientX: box.right, clientY: box.top });
                });
                group.addEventListener("blur", hideTip);
            }
        });
    }

    function downloadFactoryDist() {
        const dist = window._factoryDist;
        if (!dist) return;
        const divisor = getContainerDivisor();
        const hasCube = dist.some(f => (f.factory_cube || 0) > 0);
        const sorted = [...dist].sort((a, b) => hasCube
            ? ((b.factory_cube || 0) / divisor) - ((a.factory_cube || 0) / divisor)
            : (b.optimal_buy_units || 0) - (a.optimal_buy_units || 0));
        const header = "Factory,Containers,Distinct Records\n";
        const rows = sorted.map(f => `${f.factory_id},${hasCube ? ((f.factory_cube || 0) / divisor).toFixed(2) : ""},${f.sku_count}`).join("\n");
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
            // eventName is only ever set from a successful file-validation
            // response this page load (see handleFile) — without it,
            // doInsert()/submitCostModel() would either fail outright
            // ("event_name is required") or, worse, silently succeed against
            // whatever _upload_cache still holds server-side from a previous
            // upload/session (a bare process-global, not tied to this page).
            // Block before either insert runs rather than let that happen.
            if (!eventName) {
                toast("Please upload and validate a SKU list before continuing", "error");
                return;
            }
            if (stockTypeSplitEnabled && stockTypeConfirmed) {
                segmentConfigs[currentSegment] = captureCurrentSegmentConfig();
                const missing = ["BULK", "PARCEL"].filter(seg => !segmentConfigs[seg]);
                if (missing.length) {
                    toast(`Select a strategy for ${missing.map(s => s === "BULK" ? "Bulk" : "Parcel").join(" and ")} SKUs before continuing`, "error");
                    return;
                }
                if (!dataInserted) {
                    const inserted = await doInsert(false);
                    if (!inserted) return;
                }
                if (!segmentedCostModelSubmitted) {
                    const submitted = await submitCostModel();
                    if (!submitted) return;
                    segmentedCostModelSubmitted = true;
                }
                goStep(6);
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
            } else if (selectedStrategy === "DC_SELECTION") {
                // submit_cost_model reads BUY_UNITS back out of EVENTS_SKU_LIST,
                // so the insert has to land first.
                if (!dataInserted) {
                    const inserted = await doInsert(false);
                    if (!inserted) return;
                }
                // doInsert() already confirmed the row data AND this DC
                // selection match what's on file — resubmitting would write
                // back the exact same values, so skip it.
                if (skipResubmitBecauseUnchanged) {
                    skipResubmitBecauseUnchanged = false;
                    dcSelectionCostModelSubmitted = true;
                } else if (!dcSelectionCostModelSubmitted) {
                    // No separate "Confirm DC Selection" button — submit to DFC
                    // Cost Model right here the first time, same automatic-on-Next
                    // treatment Vendor-Aligned gets above. dc_inclusions/
                    // dc_exclusions (Step 2's DC filter) ride along inside
                    // submitCostModel() itself.
                    const submitted = await submitCostModel();
                    if (!submitted) return;
                    dcSelectionCostModelSubmitted = true;
                }
            } else if (!dataInserted) {
                const inserted = await doInsert(false);
                if (!inserted) return;
            }
            goStep(6);
        });
    }

    // ── Bulk vs. Parcel strategy split (opt-in) ────────────────────
    // Classifies the current upload via /api/classify_stock_type — reads
    // _upload_cache["df"] server-side (the validated Step 1 upload), so it
    // works before a strategy is chosen and before /api/insert has ever run
    // for this event. Never runs on its own; only when the user checks the
    // box, since it's an extra BigQuery round trip most events don't need.

    function resetStockTypeSplit() {
        stockTypeSplitEnabled = false;
        stockTypeConfirmed = false;
        stockTypeRows = [];
        stockTypeOverrides = {};
        segmentedCostModelSubmitted = false;
        hideSegmentTabs();
        const toggle = $("#stockTypeSplitToggle");
        if (toggle) toggle.checked = false;
        const confirmBox = $("#stockTypeConfirmBox");
        if (confirmBox) confirmBox.style.display = "none";
        const status = $("#stockTypeSplitStatus");
        if (status) status.innerHTML = "";
        const actions = $("#stockTypeConfirmActions");
        if (actions) actions.style.display = "flex";
        const confirmedBadge = $("#stockTypeConfirmedBadge");
        if (confirmedBadge) confirmedBadge.style.display = "none";
    }

    function effectiveStockType(row) {
        return stockTypeOverrides[row.thd_key] || row.stock_type;
    }

    function renderStockTypeSummary() {
        const counts = { BULK: 0, PARCEL: 0, MISSING_DATA: 0 };
        for (const row of stockTypeRows) counts[effectiveStockType(row)] = (counts[effectiveStockType(row)] || 0) + 1;

        const pill = (label, count, color) =>
            `<div style="padding:6px 14px;border-radius:20px;background:${color}22;color:${color};font-size:.82rem;font-weight:700">
                ${label}: ${count.toLocaleString()}
            </div>`;
        const summary = $("#stockTypeSummary");
        if (summary) {
            summary.innerHTML =
                pill("Bulk", counts.BULK, "#c8102e") +
                pill("Parcel", counts.PARCEL, "#0f7b3f") +
                (counts.MISSING_DATA ? pill("Needs Input", counts.MISSING_DATA, "#856404") : "");
        }

        const missingSection = $("#stockTypeMissingSection");
        // Everything the classifier ITSELF couldn't confidently handle — not
        // just what's still unresolved right now — so a row the user already
        // picked Bulk/Parcel for stays visible with an Undo option instead of
        // vanishing the instant it's resolved.
        const needsReviewRows = stockTypeRows.filter(row => row.stock_type === "MISSING_DATA");
        if (missingSection) missingSection.style.display = needsReviewRows.length ? "block" : "none";
        renderStockTypeMissingTable(needsReviewRows);

        updateStockTypeSegmentVisibility();
    }

    function renderStockTypeMissingTable(rows) {
        const container = $("#stockTypeMissingTable");
        if (!container) return;
        if (!rows.length) { container.innerHTML = ""; return; }

        container.innerHTML = rows.map(row => {
            const current = effectiveStockType(row);
            const hasOverride = current !== "MISSING_DATA";
            const btnClass = (choice) => `btn btn-sm ${current === choice ? "btn-primary" : "btn-secondary"} stock-type-override-btn`;
            return `
            <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #eee;font-size:.82rem">
                <div style="flex:1">
                    <strong>${row.thd_sku_nbr ?? row.sister_sku_nbr ?? "—"}</strong>
                    ${row.sku_desc ? `— ${row.sku_desc}` : ""}
                    ${row.buy_units ? `<span style="color:#888"> (${row.buy_units.toLocaleString()} units)</span>` : ""}
                    ${row.group_size ? `<div style="color:#856404;font-size:.75rem">
                        Shares a SKU_NBR (own or sister) with ${row.group_size - 1} other row(s) —
                        choosing here sets all ${row.group_size} the same, to keep the upload consistent.
                    </div>` : ""}
                </div>
                <button type="button" class="${btnClass("BULK")}"
                    data-thd-key="${row.thd_key}" data-stock-type="BULK">Bulk</button>
                <button type="button" class="${btnClass("PARCEL")}"
                    data-thd-key="${row.thd_key}" data-stock-type="PARCEL">Parcel</button>
                <button type="button" class="btn btn-sm btn-secondary stock-type-undo-btn"
                    data-thd-key="${row.thd_key}" ${hasOverride ? "" : "disabled"} title="Undo — back to Needs Input">
                    <i class="fas fa-rotate-left"></i> Undo
                </button>
            </div>`;
        }).join("");

        container.querySelectorAll(".stock-type-override-btn").forEach(btn => {
            btn.addEventListener("click", () => setStockTypeOverride(btn.dataset.thdKey, btn.dataset.stockType));
        });
        container.querySelectorAll(".stock-type-undo-btn").forEach(btn => {
            btn.addEventListener("click", () => undoStockTypeOverride(btn.dataset.thdKey));
        });
    }

    async function setStockTypeOverride(thdKey, stockType) {
        try {
            const result = await api("/api/override_stock_type", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ thd_key: thdKey, stock_type: stockType }),
            });
            // The server may have propagated this to every other row sharing
            // a SISTER_SKU_NBR (see the grouping note in app.py) — apply the
            // same set here so the UI reflects exactly what was persisted.
            for (const key of result.thd_keys || [thdKey]) stockTypeOverrides[key] = stockType;
            renderStockTypeSummary();
        } catch (e) {
            toast(`Failed to set classification: ${e.message || e}`, "error");
        }
    }

    // Clears a manual override, reverting the row (and any consistency-group
    // siblings) back to the classification /api/classify_stock_type computed.
    async function undoStockTypeOverride(thdKey) {
        try {
            const result = await api("/api/undo_stock_type_override", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ thd_key: thdKey }),
            });
            for (const key of result.thd_keys || [thdKey]) delete stockTypeOverrides[key];
            renderStockTypeSummary();
        } catch (e) {
            toast(`Failed to undo classification: ${e.message || e}`, "error");
        }
    }

    async function runStockTypeClassification() {
        if (!eventName) {
            toast("Please upload and validate a SKU list before splitting by bulk/parcel", "error");
            return false;
        }
        const confirmBox = $("#stockTypeConfirmBox");
        const status = $("#stockTypeSplitStatus");
        try {
            if (status) status.innerHTML = `<i class="fas fa-spinner fa-spin"></i> Classifying SKUs…`;
            if (confirmBox) confirmBox.style.display = "block";
            const result = await api("/api/classify_stock_type", { method: "POST" });
            stockTypeRows = result.rows || [];
            stockTypeOverrides = {};
            // A fresh classification run means any earlier "confirmed" state
            // is stale — forces updateStockTypeSegmentVisibility (called via
            // renderStockTypeSummary below) to treat this as a brand-new
            // pass instead of assuming segmentConfigs from a previous
            // upload/event still applies.
            stockTypeConfirmed = false;
            if (status) status.innerHTML = "";
            renderStockTypeSummary();
            return true;
        } catch (e) {
            if (confirmBox) confirmBox.style.display = "none";
            toast(`Bulk/Parcel classification failed: ${e.message || e}`, "error");
            return false;
        }
    }

    // Re-shows exactly what was on screen before an in-page uncheck —
    // classification rows, overrides, confirmed state and each segment's
    // saved strategy — without re-hitting /api/classify_stock_type. Only
    // called when stockTypeRows is already populated (see the toggle's
    // change listener below).
    function restoreStockTypeSplitUI() {
        stockTypeSplitEnabled = stockTypeConfirmed;
        const confirmBox = $("#stockTypeConfirmBox");
        if (confirmBox) confirmBox.style.display = "block";
        renderStockTypeSummary();
        // renderStockTypeSummary -> updateStockTypeSegmentVisibility only
        // acts on a CHANGE in confirmed state — nothing changed here (an
        // in-page uncheck→recheck), so it left stockTypeConfirmed exactly as
        // it was and never called showSegmentTabs(). Restore the tabs
        // ourselves, with preserveState so segmentConfigs survives.
        if (stockTypeConfirmed) showSegmentTabs(true);
    }

    function setupStockTypeSplit() {
        $("#stockTypeSplitToggle")?.addEventListener("change", async e => {
            if (e.target.checked) {
                // Re-checking after an in-page uncheck restores whatever was
                // already classified/confirmed instead of re-running
                // classification and losing overrides/segment configs —
                // only classify fresh when nothing is cached yet.
                if (stockTypeRows.length) {
                    restoreStockTypeSplitUI();
                } else {
                    const ok = await runStockTypeClassification();
                    if (!ok) e.target.checked = false;
                }
            } else {
                // Hides the panel only — stockTypeRows/overrides/
                // segmentConfigs/stockTypeConfirmed are deliberately left
                // intact so re-checking this box, still on this page,
                // restores rather than re-classifies.
                stockTypeSplitEnabled = false;
                hideSegmentTabs(true);
                const confirmBox = $("#stockTypeConfirmBox");
                if (confirmBox) confirmBox.style.display = "none";
            }
        });
        $("#btnCancelStockTypeSplit")?.addEventListener("click", () => {
            resetStockTypeSplit();
        });
        $("#btnDownloadStockTypeSplit")?.addEventListener("click", () => {
            window.location.href = "/api/download_stock_type_classification";
        });
        setupSegmentTabs();
    }

    // Auto-advances Step 2's Bulk/Parcel split — no manual "Confirm" click.
    // Called from renderStockTypeSummary() after every classification load,
    // override, or undo: once every row has a Bulk/Parcel answer, shows the
    // segment tabs on its own; if an Undo puts any row back to Needs Input,
    // hides them again (segmentConfigs preserved — see hideSegmentTabs).
    function updateStockTypeSegmentVisibility() {
        if (!stockTypeRows.length) return;
        const stillMissing = stockTypeRows.some(row => effectiveStockType(row) === "MISSING_DATA");
        const confirmedBadge = $("#stockTypeConfirmedBadge");
        if (!stillMissing) {
            if (confirmedBadge) confirmedBadge.style.display = "block";
            if (!stockTypeConfirmed) {
                stockTypeSplitEnabled = true;
                stockTypeConfirmed = true;
                showSegmentTabs();
            }
        } else {
            if (confirmedBadge) confirmedBadge.style.display = "none";
            if (stockTypeConfirmed) {
                stockTypeConfirmed = false;
                hideSegmentTabs(true);
            }
        }
    }

    // ── Bulk/Parcel segment tabs ────────────────────────────────────
    // The strategy grid/params below are shared DOM — switching tabs saves
    // the outgoing segment's live configuration into segmentConfigs and
    // loads the incoming segment's saved configuration (or a blank slate)
    // onto those same controls, rather than duplicating that whole card.

    // preserveState: true re-shows the tabs with whatever's already saved in
    // segmentConfigs/currentSegment (an in-page uncheck→recheck of the split
    // toggle — see restoreStockTypeSplitUI) instead of starting both segments
    // over blank, which is what a genuinely fresh confirm still does.
    function showSegmentTabs(preserveState = false) {
        if (!preserveState) {
            segmentConfigs = { BULK: null, PARCEL: null };
            currentSegment = "BULK";
        }
        const tabs = $("#stockTypeSegmentTabs");
        if (tabs) tabs.style.display = "block";
        // The split only ever applies to DC Selection — hide the Vendor-
        // Aligned/DC Selection choice entirely so there's nothing to pick
        // per segment; applySegmentConfig forces DC_SELECTION directly.
        const grid = $("#strategyGrid");
        if (grid) grid.style.display = "none";
        applySegmentConfig(preserveState ? segmentConfigs[currentSegment] : null);
        renderSegmentTabs();
    }

    // preserveState: true just hides the DOM without wiping segmentConfigs —
    // used when the split toggle is unchecked but the user might still flip
    // it back on this same page, so their per-segment strategy work isn't
    // lost. A real reset (new upload, Cancel, Follow Last Year) always calls
    // this with no argument.
    function hideSegmentTabs(preserveState = false) {
        if (!preserveState) segmentConfigs = { BULK: null, PARCEL: null };
        const tabs = $("#stockTypeSegmentTabs");
        if (tabs) tabs.style.display = "none";
        const grid = $("#strategyGrid");
        if (grid) grid.style.display = "grid";
    }

    function renderSegmentTabs() {
        const counts = { BULK: 0, PARCEL: 0 };
        for (const row of stockTypeRows) {
            const t = effectiveStockType(row);
            if (counts[t] !== undefined) counts[t]++;
        }

        $$(".segment-tab").forEach(btn => {
            btn.classList.toggle("active", btn.dataset.segment === currentSegment);
        });

        const countEl = { BULK: $("#segmentTabCountBulk"), PARCEL: $("#segmentTabCountParcel") };
        const statusEl = { BULK: $("#segmentTabStatusBulk"), PARCEL: $("#segmentTabStatusParcel") };
        for (const seg of ["BULK", "PARCEL"]) {
            if (countEl[seg]) countEl[seg].textContent = `${counts[seg].toLocaleString()} SKU(s)`;
            if (statusEl[seg]) {
                const configured = !!segmentConfigs[seg];
                statusEl[seg].textContent = configured ? "Configured" : "Not configured";
                statusEl[seg].classList.toggle("done", configured);
            }
        }

        const banner = $("#segmentActiveBanner");
        if (banner) {
            const label = currentSegment === "BULK" ? "📦 Bulk" : "📮 Parcel";
            banner.innerHTML = `<i class="fas fa-arrow-down"></i> Now configuring: <u>${label} SKUs</u> `
                + `(${counts[currentSegment].toLocaleString()} items) — the strategy below applies only to this segment`;
        }
    }

    // Reads the shared DC Selection controls into a plain config object.
    // The Bulk/Parcel split only ever applies to DC Selection — a vendor's
    // DC assignment is driven by who the supplier is, not by whether their
    // SKUs ship bulk or parcel, so Vendor-Aligned is never segmented and
    // isn't handled here. Only the "manual DC count" path is captured — see
    // segmentConfigs' declaration for why.
    function captureCurrentSegmentConfig() {
        if (selectedStrategy !== "DC_SELECTION") return null;
        return {
            strategy: "DC_SELECTION",
            dcCounts: getSelectedDcCounts("#dcToggleGrid"),
            dcInclusions: [...dcInclusions],
            dcExclusions: [...dcExclusions],
            campusPairs: [...campusPairs],
        };
    }

    // Writes a saved (or null/blank) DC Selection config back onto the
    // shared controls — the mirror image of captureCurrentSegmentConfig,
    // using the same click-driven DOM manipulation _applyLastYearStrategyBody
    // already established for restoring DC Selection's controls
    // programmatically. Always forces DC_SELECTION (clicking its radio
    // itself) since that's the only strategy a segment can use — see
    // showSegmentTabs, which hides the Vendor-Aligned/DC Selection choice
    // entirely while segment tabs are active.
    function applySegmentConfig(config) {
        applyingLastYearStrategy = true; // reuse the same "don't uncheck Follow Last Year" guard
        try {
            $("#paramsVendor").style.display = "none";
            dcInclusions = [];
            dcExclusions = [];
            campusPairs = [];
            $$("#dcToggleGrid .dc-toggle-btn").forEach(b => b.classList.remove("active"));
            updateDcSelectionCountBadge();
            $("#btnCampusNo")?.click();
            $("#btnDcFilterNo")?.click();

            const radio = document.querySelector('input[name="strategy"][value="DC_SELECTION"]');
            if (radio && !radio.checked) { radio.checked = true; radio.dispatchEvent(new Event("change")); }
            $("#strategyParams").style.display = "block";

            if (!config) return;

            $("#btnDcKnow")?.click();
            $$("#dcToggleGrid .dc-toggle-btn").forEach(b => {
                b.classList.toggle("active", (config.dcCounts || []).includes(parseInt(b.dataset.dcCount)));
            });
            updateDcSelectionCountBadge();
            campusPairs = [...(config.campusPairs || [])];
            if (campusPairs.length) {
                if ($("#campusSelection")?.style.display === "none") $("#btnCampusYes")?.click();
                if (campusPairs.includes("perris") !== !!$("#btnCampusPerris")?.classList.contains("active")) $("#btnCampusPerris")?.click();
                if (campusPairs.includes("locust_grove") !== !!$("#btnCampusLG")?.classList.contains("active")) $("#btnCampusLG")?.click();
            }
            const inclusions = config.dcInclusions || [];
            const exclusions = config.dcExclusions || [];
            if (inclusions.length || exclusions.length) {
                if ($("#dcFilterSelection")?.style.display === "none") $("#btnDcFilterYes")?.click();
                buildDcFilterLists();
                $$(".dc-filter-toggle-btn").forEach(btn => {
                    const dc = parseInt(btn.dataset.dc);
                    btn.dataset.state = inclusions.includes(dc) ? "include" : exclusions.includes(dc) ? "exclude" : "none";
                });
                updateDcFilters();
            }
        } finally {
            applyingLastYearStrategy = false;
        }
    }

    function switchSegment(nextSegment) {
        if (nextSegment === currentSegment) return;
        segmentConfigs[currentSegment] = captureCurrentSegmentConfig();
        currentSegment = nextSegment;
        applySegmentConfig(segmentConfigs[currentSegment]);
        renderSegmentTabs();
    }

    function setupSegmentTabs() {
        $$(".segment-tab").forEach(btn => {
            btn.addEventListener("click", () => switchSegment(btn.dataset.segment));
        });
    }

    // Shared commit path for Vendor-Aligned: writes the upload to
    // EVENTS_SKU_LIST (if not already done) and submits SKU-level rows into
    // DFC_COST_MODEL_SUBMISSION. Used by the explicit "Confirm Vendor
    // Strategies" button and by Step 2's Next button when the user proceeds
    // without clicking Confirm themselves. Returns whether it succeeded.
    async function confirmVendorStrategy() {
        // Same guard as the Next button (setupInsert) — this is also
        // reachable directly via "Confirm Vendor Strategies," a separate
        // entry point that would otherwise skip the check entirely.
        if (!eventName) {
            toast("Please upload and validate a SKU list before continuing", "error");
            return false;
        }
        if (!dataInserted) {
            const inserted = await doInsert(false);
            if (!inserted) return false;
        }
        // doInsert() already confirmed the row data AND this vendor
        // selection match what's on file — resubmitting would write back
        // the exact same DFC_COST_MODEL_SUBMISSION/EVENTS_SKU_LIST values,
        // so skip it instead of redoing that BigQuery work for nothing.
        if (skipResubmitBecauseUnchanged) {
            skipResubmitBecauseUnchanged = false;
        } else {
            const submitted = await submitCostModel();
            if (!submitted) return false;
        }
        vendorStrategyConfirmed = true;
        $("#btnConfirmVendorStrategy").disabled = true;
        $("#btnConfirmVendorStrategy").innerHTML = '<i class="fas fa-check-circle"></i> Confirmed';
        toast("Vendor strategies confirmed", "success");
        renderVendorPieChart(vendorMatches);
        return true;
    }

    // Asks the backend whether replacing the existing EVENTS_SKU_LIST data
    // for this event would actually change anything — same row data AND same
    // DC/vendor selection already on file — so doInsert can skip the whole
    // replace/resubmit cycle instead of redoing real BigQuery work for
    // something that changes nothing. Any error/uncertainty resolves to
    // false (caller falls back to its normal replace flow), never a hard
    // failure of its own.
    async function checkUploadUnchanged() {
        try {
            const result = await api("/api/check_upload_unchanged", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    container_divisor: getContainerDivisor(),
                    vendor_matches: vendorMatches,
                    dc_inclusions: dcInclusions,
                    dc_exclusions: dcExclusions,
                    campus_pairs: campusPairs,
                }),
            });
            return !!result.unchanged;
        } catch (e) {
            return false;
        }
    }

    // recomputeMaturity only matters when overwrite is true: false (default)
    // tells the backend to pin every SKU's THD-vs-sister maturity decision to
    // whatever was already on file for this event, so a plain resubmit of the
    // same list stays aligned with anything already priced under an existing
    // RUN_ID. Pass true instead when the upload is a genuinely new baseline
    // and today's SKU maturity should be recomputed fresh (see the prompt in
    // the "exists" branch below).
    async function doInsert(overwrite, recomputeMaturity = false) {
        // Reset here, not just where it's set true below — so a stale true
        // from an earlier, unrelated doInsert() call can never leak into
        // this one's result if this call doesn't hit the "unchanged" path.
        skipResubmitBecauseUnchanged = false;
        showLoading("Inserting into BigQuery…");
        try {
            const result = await api("/api/insert", {
                method: "POST",
                headers: {"Content-Type": "application/json"},
                body: JSON.stringify({ container_divisor: getContainerDivisor(), overwrite, recompute_maturity: recomputeMaturity }),
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
                showLoading("Checking for changes…");
                const unchanged = await checkUploadUnchanged();
                hideLoading();
                if (unchanged) {
                    dataInserted = true;
                    skipResubmitBecauseUnchanged = true;
                    toast("No changes detected — nothing to update", "info");
                    return true;
                }
                if (confirm(`${result.message}\n\nReplace the existing data?`)) {
                    // A second, separate choice: whether the replacement should
                    // stay aligned with anything already run for this event (the
                    // safe default — OK here) or recompute each SKU's THD-vs-
                    // sister maturity fresh against today's date because this
                    // upload is intentionally a new baseline (Cancel here).
                    const recompute = !confirm(
                        `Keep this replacement aligned with any existing catalog run for this event?\n\n` +
                        `OK (recommended) reuses each SKU's already-decided THD-vs-sister maturity, so it still ` +
                        `matches whatever a prior RUN_ID already priced.\n\n` +
                        `Cancel recomputes maturity fresh against today's date instead — only do this if the SKU ` +
                        `list has genuinely changed and you want a new baseline / a brand-new RUN_ID to reflect it.`
                    );
                    return await doInsert(true, recompute);
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

            // Offer the delete/resubmit option any time an existing submission is
            // found — not just right after a failed resubmit — so revisiting Step 2
            // after already running allocation (e.g. to fix a DC eligibility
            // conflict) always has a way back in.
            if (result.already_submitted) {
                $("#btnSubmitCostModel").disabled = true;
                $("#btnDeleteVendorCostModel").style.display = "inline-flex";
                $("#btnDeleteCostModel").style.display = "inline-flex";
                $("#btnDeleteDcCostModel").style.display = "inline-flex";
            }

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
                    const extraHeaders = extraFields.map(f => `<th>${KEY_FIELD_LABELS[f] || f}</th>`).join("");
                    $("#mergedSkusBody").innerHTML = mergedSkus.map(m => {
                        const total = m.sources.reduce((sum, s) => sum + (Number(s.buy_units) || 0), 0);
                        const rows = m.sources.map(s => {
                            const extraCells = extraFields.map(f => `<td>${s.key_fields?.[f] ?? "—"}</td>`).join("");
                            return `<tr>
                                <td>${s.thd_sku_nbr ?? "—"}</td>
                                <td>${s.sister_sku_nbr ?? "—"}</td>
                                <td>${s.sku_desc || "—"}</td>
                                ${extraCells}
                                <td style="text-align:right">${fmtNum(s.buy_units)}${s.is_sister ? " <em>(sister)</em>" : ""}</td>
                            </tr>`;
                        }).join("");
                        return `<div style="margin-bottom:14px">
                            <div style="margin-bottom:4px"><strong>SKU ${m.sku_nbr}</strong> — ${m.sources.length} uploaded rows</div>
                            <table class="mini-table" style="width:100%">
                                <thead><tr><th>THD SKU</th><th>Sister SKU</th><th>SKU Description</th>${extraHeaders}<th style="text-align:right">Buy Units</th></tr></thead>
                                <tbody>${rows}</tbody>
                                <tfoot><tr style="font-weight:700;border-top:2px solid #856404">
                                    <td colspan="${3 + extraFields.length}" style="text-align:right">Aggregated buy (this SKU's total):</td>
                                    <td style="text-align:right">${fmtNum(total)}</td>
                                </tr></tfoot>
                            </table>
                        </div>`;
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
        $("#btnDeleteCostModel")?.addEventListener("click", replacePreviousUpload);
        $("#btnRunAsmtTool")?.addEventListener("click", startObcPipeline);
    }

    // ── OBC weekly pipeline (pre-processing → outbound cost → post-processing) ──
    // Replaces the old "open the dashboard and babysit it yourself" link with an
    // in-app trigger + poll loop — the pipeline itself runs server-side in a
    // background thread (it's documented to take "likely a few hours" once
    // outbound cost needs to run), so this just starts it and checks back
    // periodically rather than blocking on it.
    let obcPollTimer = null;
    let autoEligibilityCheckedForRun = null;

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
            // Auto-populate Run ID as soon as it's known — regardless of strategy,
            // since DC Selection's "Single DC Count — determine for me"
            // (singleDcCountAutoSelected) needs Run ID/SKU Group at Step 6's
            // "Determine Assortment IDs" just as much as anything vendor-aligned
            // does. Only the
            // DC-eligibility check below stays VENDOR_ALIGNED-only (see
            // check_vendor_dc_eligibility's own docstring) — that's a check against
            // DFC_COST_MODEL_SUBMISSION's per-vendor dc_inclusions, meaningless for
            // DC Selection. Guarded so the eligibility check only fires once per new
            // run_id.
            const runIdInput = $("#stratRunId");
            if (state.run_id && runIdInput && !runIdInput.value.trim()) {
                runIdInput.value = state.run_id;
                syncSkuGrpFromServer();
            }
            const isVendorAligned = document.querySelector('input[name="strategy"][value="VENDOR_ALIGNED"]')?.checked;
            if (state.run_id && state.run_id !== autoEligibilityCheckedForRun && isVendorAligned) {
                autoEligibilityCheckedForRun = state.run_id;
                loadDcEligibility();
            }
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
            let body;
            if (stockTypeSplitEnabled && stockTypeConfirmed) {
                // The Bulk/Parcel split only ever applies to DC Selection (a
                // vendor's DC assignment is driven by who the supplier is,
                // not by whether their SKUs ship bulk or parcel) — every
                // segment here is a DC Selection config, never Vendor-Aligned.
                const segments = ["BULK", "PARCEL"]
                    .filter(segKey => segmentConfigs[segKey])
                    .map(segKey => ({
                        stock_type: segKey,
                        dc_counts: segmentConfigs[segKey].dcCounts,
                        dc_inclusions: segmentConfigs[segKey].dcInclusions,
                        dc_exclusions: segmentConfigs[segKey].dcExclusions,
                        campus_pairs: segmentConfigs[segKey].campusPairs,
                    }));
                if (!segments.length) throw new Error("Configure a strategy for at least one segment (Bulk or Parcel) before submitting");
                showLoading("Submitting to DFC Cost Model…");
                body = { event_name: eventName, segments };
            } else {
                // matchVendorStrategy() shows/hides its own loading state when it
                // actually has to run — restore ours afterward so the overlay
                // doesn't drop out from under the submit that's still pending.
                await ensureVendorMatchesFresh();
                showLoading("Submitting to DFC Cost Model…");
                // DC Selection's chosen DC count(s) — same manual-vs-"determine for
                // me" resolution used elsewhere (getSingleDcCountCap,
                // determineAssortment). Left empty for a mode that hasn't resolved
                // to a concrete count yet (single-count lookup, or an import's
                // dynamic per-factory cascading), same as before this existed.
                const dcCountsForSubmit = (singleDcCountAutoSelected || (multiDcDynamicSelected && includesImports))
                    ? []
                    : ($("#dcManual")?.style.display !== "none"
                        ? getSelectedDcCounts("#dcToggleGrid")
                        : [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount)));
                // vendor_matches carries Step 2's resolved DC assignments (and
                // any per-SKU overrides) so the submission can populate
                // target_dc_count/dc_inclusions/dc_exclusions instead of
                // leaving them null. Empty for a non-vendor-aligned strategy.
                // For DC Selection (Single-DC/Multi-DC Count), there's no
                // per-vendor resolution to send instead — dc_inclusions/
                // dc_exclusions/dc_counts are just Step 2's event-wide DC
                // filter/count choices, applied identically to every SKU row.
                body = {
                    event_name: eventName,
                    vendor_matches: vendorMatches,
                    dc_counts: dcCountsForSubmit,
                    dc_inclusions: dcInclusions,
                    dc_exclusions: dcExclusions,
                    // DC Selection's "Treat Bulk Counterparts The Same" choice
                    // (campusPairs: subset of ["perris","locust_grove"] that
                    // are toggled on) — only meaningful for that strategy;
                    // the backend ignores it for a vendor-aligned submission.
                    campus_pairs: campusPairs,
                };
            }
            const resp = await fetch("/api/submit_cost_model", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const result = await resp.json();
            if (!resp.ok || result.error) {
                const err = new Error(result.error || "Submission failed");
                err.conflicts = result.conflicts;
                throw err;
            }

            renderSubmissionConflicts([]); // clear any earlier conflict panel now that this succeeded
            const passBadge = `<div class="validation-badge badge-pass" style="font-size:0.95rem">
                <i class="fas fa-check-circle"></i> ${result.message}
            </div>`;
            $("#costModelStatus").innerHTML = passBadge;
            if ($("#vendorSubmitStatus")) $("#vendorSubmitStatus").innerHTML = passBadge;
            if ($("#dcSelectionSubmitStatus")) $("#dcSelectionSubmitStatus").innerHTML = passBadge;
            $("#btnSubmitCostModel").disabled = true;
            $("#btnDeleteVendorCostModel").style.display = "none";
            $("#btnDeleteCostModel").style.display = "none";
            $("#btnDeleteDcCostModel").style.display = "none";
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
            if ($("#dcSelectionSubmitStatus")) $("#dcSelectionSubmitStatus").innerHTML = failBadge;
            // Surface the replace option inline wherever this error happened
            // (Step 2's vendor-aligned or DC Selection confirm box, or Step
            // 6's generic Submit button), so the user isn't forced to hunt
            // for it in a different step.
            const alreadySubmitted = /already been submitted/i.test(e.message);
            $("#btnDeleteVendorCostModel").style.display = alreadySubmitted ? "inline-flex" : "none";
            $("#btnDeleteCostModel").style.display = alreadySubmitted ? "inline-flex" : "none";
            $("#btnDeleteDcCostModel").style.display = alreadySubmitted ? "inline-flex" : "none";
            // Cross-segment SKU_NBR conflicts (see _find_cross_segment_sku_
            // conflicts) come with the exact rows responsible — give the user
            // something to click instead of just naming the error.
            renderSubmissionConflicts(e.conflicts || []);
            toast("Submission failed: " + e.message, "error");
            return false;
        } finally {
            hideLoading();
        }
    }

    // Renders the rows behind a cross-segment SKU_NBR conflict (see
    // /api/submit_cost_model's 409 "conflicts" payload) with the same
    // Bulk/Parcel override buttons as the classification panel's own
    // MISSING_DATA table — reuses /api/override_stock_type directly, since
    // these are ordinary rows the user just needs to nudge into agreement.
    function renderSubmissionConflicts(rows) {
        const box = $("#submissionConflictBox");
        if (!box) return;
        if (!rows.length) { box.style.display = "none"; box.innerHTML = ""; return; }
        box.style.display = "block";
        box.innerHTML = `
            <div style="padding:14px 16px;border:1.5px solid #dc3545;border-radius:8px;background:#fff5f5">
                <strong style="color:#dc3545"><i class="fas fa-triangle-exclamation"></i> Submission conflict</strong>
                <p style="margin:6px 0 10px;font-size:.85rem;color:#555">
                    These rows resolved to the same SKU_NBR in both Bulk and Parcel after BigQuery's own
                    maturity check. Pick one category for each, then click Retry Submission below.
                </p>
                <div id="submissionConflictTable"></div>
                <button type="button" class="btn btn-sm btn-primary" id="btnRetrySubmission" style="margin-top:10px">
                    <i class="fas fa-rotate"></i> Retry Submission
                </button>
            </div>
        `;
        const table = $("#submissionConflictTable");
        table.innerHTML = rows.map(row => `
            <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #eee;font-size:.82rem">
                <div style="flex:1">
                    <strong>${row.thd_sku_nbr ?? row.sister_sku_nbr ?? "—"}</strong>
                    ${row.sku_desc ? `— ${row.sku_desc}` : ""}
                    <div style="color:#856404;font-size:.75rem">Currently ${row.stock_type} — resolves to SKU_NBR ${row.conflict_sku_nbr}</div>
                </div>
                <button type="button" class="btn btn-sm btn-secondary submission-conflict-override-btn" data-thd-key="${row.thd_key}" data-stock-type="BULK">Bulk</button>
                <button type="button" class="btn btn-sm btn-secondary submission-conflict-override-btn" data-thd-key="${row.thd_key}" data-stock-type="PARCEL">Parcel</button>
                <button type="button" class="btn btn-sm btn-secondary submission-conflict-undo-btn" data-thd-key="${row.thd_key}">
                    <i class="fas fa-rotate-left"></i> Undo
                </button>
            </div>
        `).join("");
        table.querySelectorAll(".submission-conflict-override-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                await setStockTypeOverride(btn.dataset.thdKey, btn.dataset.stockType);
                btn.closest("div").style.opacity = "0.5";
            });
        });
        table.querySelectorAll(".submission-conflict-undo-btn").forEach(btn => {
            btn.addEventListener("click", async () => {
                await undoStockTypeOverride(btn.dataset.thdKey);
                btn.closest("div").style.opacity = "1";
            });
        });
        $("#btnRetrySubmission")?.addEventListener("click", () => $("#btnGoInsert")?.click());
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
            if ($("#dcSelectionSubmitStatus")) $("#dcSelectionSubmitStatus").innerHTML = passBadge;
            $("#btnSubmitCostModel").disabled = false;
            $("#btnDeleteVendorCostModel").style.display = "none";
            $("#btnDeleteCostModel").style.display = "none";
            $("#btnDeleteDcCostModel").style.display = "none";
            // Let the user resubmit through the vendor-aligned confirm flow too.
            vendorStrategyConfirmed = false;
            dcSelectionCostModelSubmitted = false;
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
            if ($("#dcSelectionSubmitStatus")) $("#dcSelectionSubmitStatus").innerHTML = failBadge;
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
            dcSelectionCostModelSubmitted = true;
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

    // Same green banner style as #dcFilterNotice ("Include/Exclude") — a
    // full-width block, not the small inline-block .badge-pass pill this
    // used before, so the two confirmations in Step 2 read consistently.
    const _DC_COUNT_NOTICE_STYLE = "display:block;padding:10px 14px;border-radius:6px;background:#d4edda;border:1px solid #28a745;font-size:0.85rem";

    function updateDcSelectionCountBadge() {
        const selected = getSelectedDcCounts("#dcToggleGrid");
        const badge = $("#dcSelectionCountBadge");
        const cascadingGroup = $("#paramsCascading");
        if (selected.length === 0) {
            if (badge) badge.innerHTML = "";
            if (cascadingGroup) cascadingGroup.style.display = "none";
        } else if (selected.length === 1) {
            // Hidden for now, per request — commented out rather than removed.
            // if (badge) badge.innerHTML = `<div style="${_DC_COUNT_NOTICE_STYLE}"><i class="fas fa-info-circle" style="color:#155724"></i> <strong>1 DC Count (${selected[0]}) selected</strong> — Single DC Strategy</div>`;
            if (badge) badge.innerHTML = "";
            if (cascadingGroup) cascadingGroup.style.display = "none";
        } else {
            // Hidden for now, per request — commented out rather than removed.
            // if (badge) badge.innerHTML = `<div style="${_DC_COUNT_NOTICE_STYLE}"><i class="fas fa-info-circle" style="color:#155724"></i> <strong>${selected.length} DC Counts (${selected.join(", ")}) selected</strong> — Multi DC Strategy</div>`;
            if (badge) badge.innerHTML = "";
            if (cascadingGroup) cascadingGroup.style.display = "block";
        }
        renderLowVolumeAlert();
    }

    function getSelectedDcCounts(containerId) {
        return [...$(containerId).querySelectorAll(".dc-toggle-btn.active")].map(b => parseInt(b.dataset.dcCount));
    }

    // Live counterpart to the old click-time-only check: re-evaluates every
    // time the DC count toggles change (via updateDcSelectionCountBadge above)
    // instead of waiting for "Determine Assortment IDs" on Step 3 to reveal
    // it — this only ever applies to import events (window._factoryDist is
    // only populated when the upload had FACTORY_ID/cube data; see
    // validate_upload in validators.py), so a domestic event never shows it,
    // which is correct, not a bug. No Proceed/Cancel gate anymore: this is
    // just a live, adjustable status panel now that it lives on Step 2
    // alongside the rest of the DC config — determineAssortment() reads
    // whatever #minContainersInput/#lowVolFallbackDc currently hold (or the
    // prior hardcoded defaults, 5 and 2, if the panel was never shown).
    // Marks (or clears) the low-volume factories' own bars/dots in the
    // Factory Distribution chart above, in the same yellow used by the
    // alert box below it — so a factory flagged as "too low for the min DC
    // count" is visible right on the chart, not just named in a count.
    // Matches by data-factory-id, set on each bar/dot-group when the chart
    // is built, so this works for either renderer without re-drawing it.
    function applyLowVolumeChartHighlight(factoryIds) {
        const svg = $("#factoryDistChart");
        if (!svg) return;
        const idSet = new Set((factoryIds || []).map(String));
        svg.querySelectorAll("[data-factory-id]").forEach(el => {
            el.classList.toggle("chart-mark-low-vol", idSet.has(el.getAttribute("data-factory-id")));
        });
    }

    function renderLowVolumeAlert() {
        const alertEl = $("#lowVolumeAlert");
        if (!alertEl) return;
        const dynamicMode = multiDcDynamicSelected && includesImports;
        const dist = dynamicMode ? null : window._factoryDist;
        const dcCounts = getSelectedDcCounts("#dcToggleGrid");
        if (!dist || !dist.length || !dcCounts.length) {
            alertEl.style.display = "none";
            alertEl.innerHTML = "";
            applyLowVolumeChartHighlight([]);
            return;
        }
        const divisor = getContainerDivisor();
        const minDc = Math.min(...dcCounts);
        // 2 is only a sensible fallback when 1 isn't itself on the table —
        // if 1 IS one of the selected DC counts, it's already the narrowest
        // possible strategy, so a factory too low-volume even for it has
        // nowhere lower to fall back to than 1 itself.
        const fallbackDefault = dcCounts.includes(1) ? 1 : 2;
        const lowVol = dist.filter(f => (f.factory_cube || 0) / divisor < minDc);
        if (!lowVol.length) {
            alertEl.style.display = "none";
            alertEl.innerHTML = "";
            applyLowVolumeChartHighlight([]);
            return;
        }
        applyLowVolumeChartHighlight(lowVol.map(f => f.factory_id));
        // Default the adjustable threshold to the highest container volume
        // actually found among the flagged factories (not the bare min DC
        // count) — accepting the default then captures exactly this set,
        // no more and no fewer, instead of an arbitrary round number that
        // could sweep in extra factories or miss ones just under it.
        const threshold = Math.round(Math.max(...lowVol.map(f => (f.factory_cube || 0) / divisor)) * 100) / 100;
        alertEl.innerHTML = `
            <div class="validation-badge" style="display:block;background:#fff3cd;color:#856404;border:1px solid #ffc107;border-radius:8px;padding:10px 14px;font-size:0.8rem">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                    <i class="fas fa-exclamation-triangle"></i>
                    <strong style="text-transform:uppercase">${lowVol.length} of ${dist.length} factories produce fewer than the minimum selected DC count (${minDc}).</strong>
                </div>
                <div style="margin-bottom:8px">
                    Factories with fewer containers than the threshold will default to a
                    <input type="number" id="lowVolFallbackDc" value="${fallbackDefault}" min="1" max="13" step="1" style="width:50px;padding:3px 6px;border:1px solid #ccc;border-radius:4px;font-weight:700;text-align:center">
                    <strong>DC strategy</strong>.
                </div>
                <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px">
                    <label style="font-weight:600;font-size:0.76rem">Adjust container threshold:</label>
                    <input type="number" id="minContainersInput" value="${threshold}" min="0" step="0.01" style="width:60px;padding:3px 6px;border:1px solid #ccc;border-radius:4px">
                </div>
                <div id="lowVolSummary" style="padding:6px 10px;background:#fef9e7;border-radius:6px;font-size:0.76rem;font-style:italic">
                    Factories that produce less than or equal to <strong>${threshold}</strong> containers will be assorted to a <strong>${fallbackDefault}</strong> DC count strategy.
                </div>
            </div>`;
        alertEl.style.display = "block";
        // Typing in either input only refreshes the summary line in place —
        // never re-render the whole block from an "input" event, or the
        // input being typed into would lose focus/cursor position on every
        // keystroke. A full re-render only happens above, from a DC toggle
        // click via updateDcSelectionCountBadge.
        const updateSummary = () => {
            const t = $("#minContainersInput")?.value || threshold;
            const d = $("#lowVolFallbackDc")?.value || fallbackDefault;
            $("#lowVolSummary").innerHTML = `Factories that produce less than or equal to <strong>${t}</strong> containers will be assorted to a <strong>${d}</strong> DC count strategy.`;
        };
        $("#minContainersInput").addEventListener("input", updateSummary);
        $("#lowVolFallbackDc").addEventListener("input", updateSummary);
    }

    // A single DC count picked manually or via lookup caps how many DCs can be
    // marked "include" in the DC Filter below — including more than the chosen
    // count would ask the group-run query for something impossible (e.g. count
    // 5 with 6 required DCs). Neither "determine for me" mode (single-auto's
    // open search, or import's per-factory cascading tiers) has a fixed count
    // to cap against yet, so both return null (no cap).
    function getSingleDcCountCap() {
        if (singleDcCountAutoSelected) return null;
        if (multiDcDynamicSelected && includesImports) return null;
        const counts = $("#dcManual")?.style.display !== "none"
            ? getSelectedDcCounts("#dcToggleGrid")
            : [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount));
        return counts.length === 1 ? counts[0] : null;
    }

    function setupStrategy() {
        const radios = $$('input[name="strategy"]');

        // Once a determination has run, flag any change anywhere on Step 6 as
        // "config may have changed" and relabel the button to "Redetermine" —
        // if nothing actually changed, the button just stays "Determine."
        const markConfigDirty = e => {
            // The toggle's own "change" bubbles here too, but only after its
            // dedicated listener below has already fully run
            // applyLastYearStrategy() (including resetting
            // applyingLastYearStrategy back to false) — by the time it
            // reaches here the guard inside noteManualStrategyEdit() can no
            // longer tell that apart from a real edit, so skip it by target
            // instead.
            if (e?.target?.id !== "followLastYearToggle") noteManualStrategyEdit();
            if (!lastAssortmentConfig) return; // nothing determined yet — no need
            const btn = $("#btnDetermineAsmt");
            if (btn) btn.innerHTML = '<i class="fas fa-search"></i> Redetermine Assortment IDs <i class="fas fa-arrow-right"></i>';
        };
        $("#panel-2")?.addEventListener("change", markConfigDirty);
        $("#panel-2")?.addEventListener("input", markConfigDirty);
        // The controls above (DC count grid, campus toggles, DC filter
        // include/exclude pills, per-supplier vendor DC buttons) are all
        // plain <button>s toggled via classList, not real form controls — a
        // click on one never fires "change"/"input" for markConfigDirty to
        // catch, so it needs its own delegated listener to notice the edit.
        $("#panel-2")?.addEventListener("click", e => {
            if (e.target.closest(".dc-toggle-btn, .dc-filter-toggle-btn, #btnDcKnow, #btnDcNo, #btnDcSingleAuto, #btnDcMultiAuto, #btnCampusYes, #btnCampusNo, #btnDcFilterYes, #btnDcFilterNo")) {
                noteManualStrategyEdit();
            }
        });

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

                // The Bulk/Parcel split only ever applies to DC Selection (see
                // resetStockTypeSplit/showSegmentTabs) — hide the opt-in
                // checkbox entirely for Vendor-Aligned, and turn the whole
                // feature off if it was already active, since it no longer
                // means anything for this strategy.
                const stockTypeBox = $("#stockTypeSplitBox");

                if (stratVal === "VENDOR_ALIGNED") {
                    if (stockTypeBox) stockTypeBox.style.display = "none";
                    if (stockTypeSplitEnabled || $("#stockTypeSplitToggle")?.checked) resetStockTypeSplit();
                    $("#paramsVendor").style.display = "block";
                    if ($("#paramsCascading")) $("#paramsCascading").style.display = "none";
                    $("#paramsCampus").style.display = "none";
                    $("#paramsDcFilter").style.display = "none";
                    campusPairs = [];
                    $$(".dc-filter-toggle-btn").forEach(btn => { btn.dataset.state = "none"; });
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
                    if (stockTypeBox) stockTypeBox.style.display = "block";
                    $("#paramsDcSelection").style.display = "block";
                    syncIncludesImportsFromServer();
                    $("#btnDcKnow")?.click();
                    $("#paramsCampus").style.display = "block";
                    $("#paramsDcFilter").style.display = "block";
                }
            });
        });

        // DC Selection: know vs don't know. "No" doesn't commit to anything by
        // itself — it just reveals the Single/Multi-DC Count fork below, since
        // those two "determine for me" paths need genuinely different handling
        // (single: one open group-run query; multi: each strategy's own
        // existing "determine for me" behavior).
        function resetDcSelectionMode() {
            multiDcDynamicSelected = false;
            singleDcCountAutoSelected = false;
            singleDcGroupChoice = null;
            $("#dcNoKnowChoice").style.display = "none";
            $("#dcManual").style.display = "none";
            $("#dcSingleAuto").style.display = "none";
            $("#dcMultiAuto").style.display = "none";
            $("#dcMultiAutoImport").style.display = "none";
            $("#dcMultiAutoDomestic").style.display = "none";
            if ($("#paramsCascading")) $("#paramsCascading").style.display = "none";
            // Tied to the manual toggle grid's own selection — irrelevant
            // (and, once hidden, stale) in every other DC-count mode.
            const lowVolEl = $("#lowVolumeAlert");
            if (lowVolEl) { lowVolEl.style.display = "none"; lowVolEl.innerHTML = ""; }
        }

        $("#btnDcKnow")?.addEventListener("click", () => {
            resetDcSelectionMode();
            $("#btnDcKnow")?.classList.add("active");
            $("#btnDcNo")?.classList.remove("active");
            $("#dcManual").style.display = "block";
            updateDcSelectionCountBadge();
        });

        $("#btnDcNo")?.addEventListener("click", () => {
            resetDcSelectionMode();
            $("#btnDcNo")?.classList.add("active");
            $("#btnDcKnow")?.classList.remove("active");
            $$("#dcToggleGrid .dc-toggle-btn").forEach(b => b.classList.remove("active"));
            updateDcSelectionCountBadge();
            $("#dcNoKnowChoice").style.display = "block";
        });

        $("#btnDcSingleAuto")?.addEventListener("click", () => {
            resetDcSelectionMode();
            singleDcCountAutoSelected = true;
            $("#btnDcSingleAuto")?.classList.add("active");
            $("#btnDcMultiAuto")?.classList.remove("active");
            $("#dcNoKnowChoice").style.display = "block";
            $("#dcSingleAuto").style.display = "block";
        });

        $("#btnDcMultiAuto")?.addEventListener("click", () => {
            resetDcSelectionMode();
            multiDcDynamicSelected = true;
            $("#btnDcMultiAuto")?.classList.add("active");
            $("#btnDcSingleAuto")?.classList.remove("active");
            $("#dcNoKnowChoice").style.display = "block";
            $("#dcMultiAuto").style.display = "block";
            $("#dcMultiAutoImport").style.display = includesImports ? "block" : "none";
            $("#dcMultiAutoDomestic").style.display = includesImports ? "none" : "block";
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
        $("#btnDeleteDcCostModel")?.addEventListener("click", replacePreviousUpload);

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

        // DC eligibility check (VENDOR_ALIGNED) — needs RUN_ID, which only exists
        // once the user's entered it here in Step 3, not back on Step 2.
        $("#btnCheckDcEligibility")?.addEventListener("click", loadDcEligibility);

        // Problem SKU check (MULTI_DC) — Step 7/Assortment ID Results.
        $("#btnCheckProblemSkus")?.addEventListener("click", loadProblemSkus);

        // Campus pairing
        $("#btnCampusYes")?.addEventListener("click", () => {
            $("#btnCampusYes")?.classList.add("active");
            $("#btnCampusNo")?.classList.remove("active");
            $("#campusSelection").style.display = "block";
        });
        $("#btnCampusNo")?.addEventListener("click", () => {
            $("#btnCampusNo")?.classList.add("active");
            $("#btnCampusYes")?.classList.remove("active");
            $("#campusSelection").style.display = "none";
            // Deactivate both buttons
            $("#btnCampusPerris")?.classList.remove("active");
            $("#btnCampusLG")?.classList.remove("active");
            // Also clears campusPairs (both buttons are now inactive) — without
            // this, a Yes->select->No sequence left campusPairs holding the
            // stale selection even though the UI now shows "No", and that
            // stale value would get submitted as this event's merge choice.
            updateCampusNotice();
        });
        $("#btnCampusPerris")?.addEventListener("click", () => toggleCampusBtn("btnCampusPerris"));
        $("#btnCampusLG")?.addEventListener("click", () => toggleCampusBtn("btnCampusLG"));

        // DC Inclusions / Exclusions
        $("#btnDcFilterYes")?.addEventListener("click", () => {
            $("#btnDcFilterYes")?.classList.add("active");
            $("#btnDcFilterNo")?.classList.remove("active");
            $("#dcFilterSelection").style.display = "block";
            buildDcFilterLists();
        });
        $("#btnDcFilterNo")?.addEventListener("click", () => {
            $("#btnDcFilterNo")?.classList.add("active");
            $("#btnDcFilterYes")?.classList.remove("active");
            $("#dcFilterSelection").style.display = "none";
            $$(".dc-filter-toggle-btn").forEach(btn => { btn.dataset.state = "none"; });
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

    // The moment the user changes anything about the current strategy — a
    // DC count, a campus toggle, an include/exclude pill, switching strategy
    // type entirely, a per-supplier vendor DC edit — "Follow last year's
    // strategy?" is no longer an accurate description of what's on screen,
    // even though whatever they just set should obviously stay. Just
    // uncheck the box (no undo) rather than silently keep claiming a match
    // to last year that no longer holds. A no-op while
    // applyLastYearStrategy() is itself the one making the change.
    function noteManualStrategyEdit() {
        if (applyingLastYearStrategy) return;
        const toggle = $("#followLastYearToggle");
        if (toggle?.checked) {
            toggle.checked = false;
            const noteEl = $("#followLastYearNote");
            if (noteEl) noteEl.style.display = "none";
        }
    }

    // Applies (or clears) last year's recorded strategy onto Step 2's controls.
    // Uses tier_strategy (per-factory building counts) when available — the
    // real import case this was built for — and falls back to the flat by_dc
    // rollup for domestic events, which have no per-factory tier concept.
    // Wrapped in applyingLastYearStrategy so its own programmatic button
    // clicks/radio flips don't trip noteManualStrategyEdit() into
    // immediately unchecking the very toggle that's invoking it.
    function applyLastYearStrategy(enable) {
        applyingLastYearStrategy = true;
        try {
            _applyLastYearStrategyBody(enable);
        } finally {
            applyingLastYearStrategy = false;
        }
    }

    function _applyLastYearStrategyBody(enable) {
        const note = $("#followLastYearNote");
        const pys = lastPriorYearStrategy;
        // Bulk/Parcel is a manual, this-event-only opt-in (see
        // captureCurrentSegmentConfig) — last year's recorded strategy never
        // carries a split decision, so any split left checked from before
        // this toggle was flipped is stale and must be cleared rather than
        // silently surviving underneath whatever this applies.
        resetStockTypeSplit();
        if (!enable || !pys) {
            if (note) note.style.display = "none";
            // Unchecking is a real undo, not just hiding the note — otherwise
            // whatever this pre-fill put onto DC Count(s), Treat Bulk
            // Counterparts, and the Include/Exclude DC filter stays behind as
            // stale selections, and re-checking later would compound onto
            // them instead of starting clean. Scoped to DC Selection's own
            // controls only — a Vendor-Aligned pre-fill (matched suppliers,
            // Step 2's own work) is left alone.
            $$("#dcToggleGrid .dc-toggle-btn").forEach(b => b.classList.remove("active"));
            updateDcSelectionCountBadge();
            $("#btnCampusNo")?.click();
            $("#btnDcFilterNo")?.click();
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

        // Domestic events (no per-factory tier_strategy) don't have one DC
        // count for the whole event — different THD keys can be assigned to
        // different numbers of DCs (e.g. Halloween 2026 mixed keys using
        // anywhere from 2 to 12 DCs). Use the distinct set of per-key DC
        // counts computed on the backend rather than
        // overall.normalized_dc_count, which is the total distinct DCs
        // touched across the whole event and wrongly auto-selected a single
        // "13" for Halloween 2026 instead of highlighting the actual counts
        // in use.
        const hasTiers = !!(pys.tier_strategy && pys.tier_strategy.length);
        const dcCounts = hasTiers
            ? [...new Set(pys.tier_strategy.map(t => t.dc_count))]
            : (pys.overall?.dc_counts_by_key?.length ? pys.overall.dc_counts_by_key : [1]);
        const dcNbrs = hasTiers
            ? [...new Set(pys.tier_strategy.map(t => t.dc_nbr))]
            : (pys.by_dc || []).map(d => d.dc_nbr);
        // For domestic events, prefer the actual recorded PERRIS_CAMPUS_MERGED/
        // LOCUST_GROVE_CAMPUS_MERGED flag (set at a prior Step 2 submission,
        // possibly self-healed from EVENTS_SKU_LIST) when it's known. NULL
        // means "never recorded" (every event predating this flag, or one
        // whose Step 2 submission ran before it existed) — only then fall
        // back to *_cooccurs_evidence: whether any single key's own raw DC
        // list actually contained both the bulk and main DC of a pair, the
        // one scenario where merging changes anything (a key's units legitimately
        // spilling across both buildings). The old guess — "the main DC number
        // showed up somewhere in the event" — proved nothing on its own:
        // confirmed on HALFWAY HALLOWEEN 2024, where Perris Bulk and Main
        // never co-occurred within one key, only across different keys (some
        // keys' SKUs landed in Bulk, others' in Main), yet the old guess still
        // auto-toggled "merged" just because Main appeared somewhere.
        const perrisMerged = pys.overall?.perris_campus_merged;
        const lgMerged = pys.overall?.locust_grove_campus_merged;
        const perrisOn = hasTiers
            ? pys.tier_strategy.some(t => t.dc_nbr === 6007 && t.campus_pair === "Y")
            : (perrisMerged !== null && perrisMerged !== undefined ? perrisMerged : !!pys.overall?.perris_cooccurs_evidence);
        const lgOn = hasTiers
            ? pys.tier_strategy.some(t => t.dc_nbr === 6777 && t.campus_pair === "Y")
            : (lgMerged !== null && lgMerged !== undefined ? lgMerged : !!pys.overall?.locust_grove_cooccurs_evidence);
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

        // "Cascading Assortments" (only shown when multiple DC counts are
        // selected — see updateDcSelectionCountBadge) defaults to checked in
        // the HTML, which was never actually verified against last year's
        // real per-key DC sets. is_cascading is a real check: every smaller
        // tier's DC set is a subset of the largest tier's — only override
        // the checkbox when the backend actually computed a real answer
        // (null for a single-count event, where this control is hidden
        // anyway and there's nothing to test it against).
        const cascadingToggle = $("#cascadingToggle");
        const isCascading = pys.overall?.is_cascading;
        if (cascadingToggle && isCascading !== null && isCascading !== undefined) {
            cascadingToggle.checked = isCascading;
        }

        if (perrisOn || lgOn) {
            if ($("#campusSelection")?.style.display === "none") $("#btnCampusYes")?.click();
            if (perrisOn !== !!$("#btnCampusPerris")?.classList.contains("active")) $("#btnCampusPerris")?.click();
            if (lgOn !== !!$("#btnCampusLG")?.classList.contains("active")) $("#btnCampusLG")?.click();
        } else {
            $("#btnCampusNo")?.click();
        }

        // Deliberately does NOT pre-fill the Include/Exclude DC filter from
        // last year's DC list — that filter is a hard constraint on this
        // year's determination, and prior-year DCs (e.g. from a since-closed
        // or reassigned building) auto-populating it silently narrowed this
        // year's options. Leave it on "No" and let the user opt in manually.
        $("#btnDcFilterNo")?.click();

        if (note) {
            const names = dcNbrs.map(n => ALL_DCS.find(d => d.nbr === n)?.name || n).join(", ");
            note.innerHTML = `<i class="fas fa-info-circle"></i> Applied ${pys.event_name} ${pys.event_year}: `
                + `${isSingle ? "Single DC" : "Multi DC"} — ${names}`
                + `${(perrisOn || lgOn) ? " (campus pairing on)" : ""}.`;
            note.style.display = "block";
        }
    }

    let vendorStrategyConfirmed = false;
    // Mirrors vendorStrategyConfirmed for DC Selection (Single-DC/Multi-DC
    // Count), which has no separate "Confirm" button of its own — Step 2's
    // Next submits to DFC Cost Model automatically the first time, same as
    // Vendor-Aligned falls back to doing when its Confirm click was skipped.
    let dcSelectionCostModelSubmitted = false;
    let vendorMatches = [];
    let campusPairs = [];

    const CAMPUS_INFO = {
        perris: { main: 6007, bulk: 6006, name: "Perris" },
        locust_grove: { main: 6777, bulk: 6705, name: "Locust Grove" },
    };

    function toggleCampusBtn(btnId) {
        const btn = $(`#${btnId}`);
        const activating = !btn.classList.contains("active");
        if (activating) {
            // Turning a campus merge ON when its two DCs are already split
            // across include/exclude would create the same contradiction
            // the DC-filter click guard prevents going forward — catch it
            // here too, since this is the other order the split can happen.
            const cp = btnId === "btnCampusPerris" ? "perris" : btnId === "btnCampusLG" ? "locust_grove" : null;
            const info = cp && CAMPUS_INFO[cp];
            if (info) {
                const bulkBtn = document.querySelector(`#dcFilterList .dc-filter-toggle-btn[data-dc="${info.bulk}"]`);
                const mainBtn = document.querySelector(`#dcFilterList .dc-filter-toggle-btn[data-dc="${info.main}"]`);
                const bulkState = bulkBtn?.dataset.state;
                const mainState = mainBtn?.dataset.state;
                const splitAcross = (bulkState === "include" && mainState === "exclude")
                    || (bulkState === "exclude" && mainState === "include");
                if (splitAcross) {
                    toast(`${info.name} Bulk and Main are currently split between include/exclude — clear one before merging them as a campus`, "error");
                    return;
                }
            }
        }
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
            // An inline separator, not a block-level divider — this reads as
            // one wrapping line of text instead of forcing Perris and Locust
            // Grove onto their own separate lines.
            const divider = '&nbsp;&nbsp;|&nbsp;&nbsp;';
            notice.innerHTML = '<i class="fas fa-info-circle" style="color:#856404"></i> ' + lines.join(divider);
            notice.style.display = "block";
        } else {
            notice.style.display = "none";
        }
    }

    // DC filter variables — each DC is its own toggle, cycling none -> include
    // -> exclude -> none, so a DC can never end up in both lists at once.
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
        5823: { fill: "#f96302", step: 0 }, // matches --hd-orange (the "Confirm Vendor Strategies" button)
        5829: { fill: "#854b2f", step: 3 },
        5831: { fill: "#2f3846", step: 14 },
        5832: { fill: "#12233f", step: 18 },
        5841: { fill: "#3d4249", step: 12 },
        5854: { fill: "#5d5148", step: 8 },
        5855: { fill: "#202e43", step: 16 },
        5857: { fill: "#764e3a", step: 5 },
        5860: { fill: "#54524c", step: 9 },
        5882: { fill: "#655144", step: 7 },
        6006: { fill: "#192841", step: 17 },
        6007: { fill: "#45484a", step: 11 },
        6705: { fill: "#6e503f", step: 6 },
        6707: { fill: "#273344", step: 15 },
        6760: { fill: "#8d4928", step: 2 },
        6777: { fill: "#4c4d4b", step: 10 },
    };
    const DC_COLOR_FALLBACK = "#8a8a86"; // mid-gray placeholder for a DC added this session, before the ramp is re-optimized to include it
    function dcFill(dcNbr) { return (DC_COLOR[dcNbr] || {}).fill || DC_COLOR_FALLBACK; }

    const DC_FILTER_NEXT_STATE = { none: "include", include: "exclude", exclude: "none" };

    // Only when campusPairs actually has that pair toggled on (Step 2's
    // "Treat Bulk Counterparts The Same") — with no merge active, bulk and
    // main are just two ordinary, independent DCs and can freely be split
    // across include/exclude.
    function getCampusSibling(dc) {
        for (const cp of campusPairs) {
            const info = CAMPUS_INFO[cp];
            if (!info) continue;
            if (info.bulk === dc) return info.main;
            if (info.main === dc) return info.bulk;
        }
        return null;
    }

    function buildDcFilterLists() {
        const container = $("#dcFilterList");
        if (container.children.length > 0) return; // already built
        for (const dc of ALL_DCS) {
            container.innerHTML += `<button type="button" class="dc-toggle-btn dc-filter-toggle-btn" data-dc="${dc.nbr}" data-state="none" `
                + `title="${dc.name.toUpperCase()}">${dc.nbr}</button>`;
        }
        container.addEventListener("click", (e) => {
            const btn = e.target.closest(".dc-filter-toggle-btn");
            if (!btn) return;
            const nextState = DC_FILTER_NEXT_STATE[btn.dataset.state];
            if (nextState === "include") {
                const cap = getSingleDcCountCap();
                if (cap != null && dcInclusions.length >= cap) {
                    toast(`Only ${cap} DC(s) can be included — that's the selected DC count`, "error");
                    return;
                }
            }
            // With that campus merged, one half in "include" and the other
            // in "exclude" is a real contradiction, not just confusing UX —
            // confirmed live: the assortment tool hard-fails with "no
            // priced assortment at all" for exactly this combination, since
            // the two states expand into the identical equivalence group.
            // Rather than block the click and make the user clear the
            // sibling themselves first, clear it for them and apply the
            // click they actually made.
            if (nextState === "include" || nextState === "exclude") {
                const siblingDc = getCampusSibling(parseInt(btn.dataset.dc));
                if (siblingDc != null) {
                    const siblingBtn = container.querySelector(`.dc-filter-toggle-btn[data-dc="${siblingDc}"]`);
                    const siblingState = siblingBtn?.dataset.state;
                    const opposite = nextState === "include" ? "exclude" : "include";
                    if (siblingBtn && siblingState === opposite) {
                        siblingBtn.dataset.state = "none";
                        toast(`DC ${siblingDc} was ${opposite}d and campus-merged with this one — cleared it so DC ${btn.dataset.dc} could be ${nextState}d`, "success");
                    }
                }
            }
            btn.dataset.state = nextState;
            updateDcFilters();
        });
    }

    function updateDcFilters() {
        dcInclusions = [];
        dcExclusions = [];
        $$(".dc-filter-toggle-btn").forEach(btn => {
            const dc = parseInt(btn.dataset.dc);
            const state = btn.dataset.state;
            if (state === "include") dcInclusions.push(dc);
            else if (state === "exclude") dcExclusions.push(dc);
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
        // The OTHER bucket is one row in the table (matchVendorStrategy()
        // collapses every fallback supplier into it), but every individual
        // supplier folded into it still needs to show up here — that's the
        // whole point of this picker, promoting one of them out of OTHER.
        const options = vendorMatches
            .flatMap(m => (m._otherSuppliers?.length ? m._otherSuppliers : [m.SUPPLIER])
                .map(s => ({ supplier: (s || "").trim(), current: (m.VENDOR || "OTHER").toUpperCase() })))
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

            // Every supplier that didn't match a named VENDOR_STRATEGY row
            // falls back to the same generic OTHER default (same ASMT_ID/
            // DC_LIST) — the backend still returns one match entry per such
            // supplier (so each keeps its own SUPPLIER for its own SKU
            // lookups), but they belong in ONE bucket, mapped to OTHER, full
            // stop — not N rows, and not even a "moved under" row tying them
            // together (that still named each supplier individually).
            // Collapse them into a single entry up front, before anything
            // renders, remembering the underlying supplier names only so
            // "View SKUs" can still fetch every one of them.
            const otherEntries = vendorMatches.filter(m => (m.VENDOR || "").toUpperCase() === "OTHER");
            if (otherEntries.length > 1) {
                const canonical = otherEntries[0];
                canonical._otherSuppliers = otherEntries.map(m => m.SUPPLIER);
                canonical.SKU_COUNT = otherEntries.reduce((sum, m) => sum + Number(m.SKU_COUNT || 0), 0);
                vendorMatches = vendorMatches.filter(m => m === canonical || (m.VENDOR || "").toUpperCase() !== "OTHER");
            }

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

    function dcNetworkName(dcNbr) {
        const known = ALL_DCS.find(dc => dc.nbr === dcNbr);
        return known ? known.name : `DC ${dcNbr}`;
    }

    function vendorDcName(dcNbr, names, index) {
        if (names[index]) return names[index];
        return dcNetworkName(dcNbr);
    }

    // Union of a row's default/override DC set with whatever's currently
    // selected — lets a DC added at the SKU level (beyond the vendor's own
    // default list) still get a pill rendered for it, without disturbing the
    // positional alignment `eligibleDcs`/`names` normally rely on: any DC
    // beyond `defaultDcs`'s own entries falls back to dcNetworkName() in
    // vendorDcName() above instead of a (mis-)indexed name lookup.
    function unionDcs(defaultDcs, selectedDcs) {
        return [...new Set([...defaultDcs, ...selectedDcs])];
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

    // A small "+ Add DC" dropdown listing every network DC not already in
    // `currentDcs`, appended next to a row's pills — the only way to bring a
    // DC into a vendor's (or one SKU's) list that wasn't already part of it,
    // since renderDcButtonGrid only ever draws buttons for `eligibleDcs`.
    function renderAddDcOptions(currentDcs, dataAttrs, selectClass) {
        const available = ALL_DCS.filter(dc => !currentDcs.includes(dc.nbr)).sort((a, b) => a.nbr - b.nbr);
        if (!available.length) return "";
        const options = available.map(dc => `<option value="${dc.nbr}">${dc.nbr} — ${dc.name}</option>`).join("");
        return `<select class="${selectClass}" title="Add a DC to this list"${dataAttrs}>
            <option value="">+ Add DC</option>${options}</select>`;
    }

    function toggleVendorDc(matchIndex, dcNbr) {
        const match = vendorMatches[matchIndex];
        const selected = parseVendorDcs(match?.DC_LIST);
        if (!match || (selected.length === 1 && selected[0] === dcNbr)) {
            toast("Each supplier must have at least one DC selected", "error");
            return;
        }
        const isDeselecting = selected.includes(dcNbr);
        const next = isDeselecting
            ? selected.filter(dc => dc !== dcNbr)
            : [...selected, dcNbr];
        next.sort((a, b) => a - b);
        match.DC_LIST = next.join(", ");
        match.DC_COUNT = next.length;

        // A DC the user brought in via "+ Add DC" (not part of the original
        // VENDOR_ALIGNED_STRATEGY match) has no reason to linger as a
        // greyed-out pill once deselected — drop it from the eligible set
        // entirely so it disappears, instead of just turning inactive the
        // way an originally-matched DC does.
        const addedDcs = new Set(parseVendorDcs(match._addedDcs));
        if (isDeselecting && addedDcs.has(dcNbr)) {
            addedDcs.delete(dcNbr);
            match._addedDcs = [...addedDcs].join(", ");
            const removeIndex = parseVendorDcs(match._initialDcList).indexOf(dcNbr);
            match._initialDcList = parseVendorDcs(match._initialDcList).filter(dc => dc !== dcNbr).join(", ");
            match._initialDcNames = parseVendorNames(match._initialDcNames).filter((_, i) => i !== removeIndex).join(", ");
        }

        const initialDcs = parseVendorDcs(match._initialDcList);
        const initialNames = parseVendorNames(match._initialDcNames);
        match.DC_NM_LIST = next.map(dc => vendorDcName(dc, initialNames, initialDcs.indexOf(dc))).join(", ");
        // A vendor merged into this one (via "Move to...") got a one-time
        // copy of this DC list at move time, not a live reference — without
        // this cascade, toggling a DC here afterward would leave the merged
        // vendor's own SKUs still showing/using the pre-toggle list.
        vendorMatches.forEach(v => {
            if (v._movedTo === matchIndex) {
                v.DC_LIST = match.DC_LIST;
                v.DC_COUNT = match.DC_COUNT;
                v.DC_NM_LIST = match.DC_NM_LIST;
            }
        });
        renderVendorSupplierSummary(vendorMatches);
    }

    // Brings a DC that wasn't part of this vendor's VENDOR_ALIGNED_STRATEGY
    // match into its selectable (and immediately selected) set — appended to
    // `_initialDcList`/`_initialDcNames` so it keeps rendering as a pill on
    // every future re-render, not just this one. Cascades to any vendor
    // merged into this one the same way toggleVendorDc does.
    function addVendorDc(matchIndex, dcNbr) {
        const match = vendorMatches[matchIndex];
        if (!match || !Number.isFinite(dcNbr)) return;
        const initialDcs = parseVendorDcs(match._initialDcList);
        const initialNames = parseVendorNames(match._initialDcNames);
        if (!initialDcs.includes(dcNbr)) {
            initialDcs.push(dcNbr);
            initialNames.push(dcNetworkName(dcNbr));
            match._initialDcList = initialDcs.join(", ");
            match._initialDcNames = initialNames.join(", ");
        }
        // Remembered so a later deselect (toggleVendorDc) can drop this DC
        // from the eligible set entirely instead of leaving it as an
        // inactive pill — only a DC that was already part of the vendor's
        // real VENDOR_ALIGNED_STRATEGY match gets to keep that greyed-out
        // placeholder behavior.
        const addedDcs = new Set(parseVendorDcs(match._addedDcs));
        addedDcs.add(dcNbr);
        match._addedDcs = [...addedDcs].join(", ");
        const selected = parseVendorDcs(match.DC_LIST);
        if (!selected.includes(dcNbr)) selected.push(dcNbr);
        selected.sort((a, b) => a - b);
        match.DC_LIST = selected.join(", ");
        match.DC_COUNT = selected.length;
        match.DC_NM_LIST = selected.map(dc => vendorDcName(dc, initialNames, initialDcs.indexOf(dc))).join(", ");
        vendorMatches.forEach(v => {
            if (v._movedTo === matchIndex) {
                v.DC_LIST = match.DC_LIST;
                v.DC_COUNT = match.DC_COUNT;
                v.DC_NM_LIST = match.DC_NM_LIST;
            }
        });
        toast(`Added DC ${dcNbr} to ${(match.VENDOR || match.SUPPLIER || "").toUpperCase()}`, "success");
        renderVendorSupplierSummary(vendorMatches);
    }

    let vendorSkuExpanded = new Set();

    function vendorSkuDcs(match, row) {
        const overrides = match.SKU_OVERRIDES || {};
        // Keyed by THD_KEY (THD_SKU_NBR plus whatever else — usually
        // MVNDR_NBR — actually makes this upload's rows distinct), not bare
        // THD_SKU_NBR: the same THD SKU can appear more than once (e.g. two
        // different MVNDR NBRs), and keying by THD_SKU_NBR alone made an
        // override on one of those rows silently apply to all of them. The
        // backend reconstructs the identical composite key from a fresh
        // EVENTS_SKU_LIST query — see _compute_vendor_aligned_submission_rows.
        return parseVendorDcs(overrides[row.THD_KEY] || match.DC_LIST);
    }

    async function toggleVendorSkuRows(matchIndex) {
        if (vendorSkuExpanded.has(matchIndex)) {
            vendorSkuExpanded.delete(matchIndex);
        } else {
            vendorSkuExpanded.add(matchIndex);
        }
        renderVendorSupplierSummary(vendorMatches);
    }

    // Guards against an older, slower-to-resolve reload overwriting a newer
    // one's correct render with stale content — e.g. a supplier-level DC
    // toggle re-triggers this for an already-expanded panel while a prior
    // call (from opening it, or an earlier toggle) is still in flight; if
    // that older call's fetch happens to resolve later, it must not clobber
    // the fresher render with the DC list as it stood before the toggle.
    let vendorSkuLoadToken = {};

    async function loadVendorSkuRows(matchIndex, page) {
        const match = vendorMatches[matchIndex];
        const container = $(`#vendor-skus-${matchIndex}`);
        if (!match || !container) return;
        const myToken = (vendorSkuLoadToken[matchIndex] = (vendorSkuLoadToken[matchIndex] || 0) + 1);
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

            // The OTHER bucket collapses every fallback supplier into ONE
            // owner (matchVendorStrategy()) but still has to fetch each
            // one's own SKUs under its own real SUPPLIER name in
            // EVENTS_SKU_LIST — _otherSuppliers is exactly that list.
            // Attributed to the same owner throughout, so its overrides all
            // land in one SKU_OVERRIDES dict and its row displays as OTHER
            // (owner.match.VENDOR), the same as every other row it owns.
            const supplierSources = owners.flatMap(o =>
                (o.match._otherSuppliers?.length ? o.match._otherSuppliers : [o.match.SUPPLIER]).map(s => ({ owner: o, supplier: s })));

            const FETCH_PAGE_SIZE = 100;
            const fetches = await Promise.all(supplierSources.map(s =>
                api(`/api/vendor_skus?supplier=${encodeURIComponent(s.supplier)}&page=1&page_size=${FETCH_PAGE_SIZE}`)
            ));
            if (vendorSkuLoadToken[matchIndex] !== myToken) return; // superseded by a newer reload
            fetches.forEach(r => { if (r.error) throw new Error(r.error); });
            const truncated = fetches.some(r => (r.pages || 1) > 1);
            const allRows = [];
            fetches.forEach((r, oi) => (r.rows || []).forEach(row => allRows.push({ row, owner: supplierSources[oi].owner })));

            // Whatever beyond THD_SKU_NBR actually distinguishes two rows for
            // the same THD SKU (e.g. MVNDR_NBR when it's sourced from more
            // than one vendor) — without this, two rows for THD 1011513312
            // are visually identical and there's no way to tell which one a
            // DC toggle is about to change.
            const extraKeyCols = [...new Set(fetches.flatMap(r => r.extra_key_cols || []))];
            const extraHeaders = extraKeyCols.map(f => `<th>${KEY_FIELD_LABELS[f] || f}</th>`).join("");

            const DISPLAY_PAGE_SIZE = 50;
            const totalPages = Math.max(1, Math.ceil(allRows.length / DISPLAY_PAGE_SIZE));
            const clampedPage = Math.min(Math.max(page, 1), totalPages);
            const pageRows = allRows.slice((clampedPage - 1) * DISPLAY_PAGE_SIZE, clampedPage * DISPLAY_PAGE_SIZE);

            let html = `<table class="detail-table vendor-sku-table"><thead><tr>
                <th>DC NBR List</th><th>DC Count</th><th>Supplier</th><th>THD SKU NBR</th><th>SKU Description</th>${extraHeaders}<th>Total Units</th><th>Total Cube</th></tr></thead><tbody>`;
            pageRows.forEach(({ row, owner }) => {
                // Eligible (which pills render at all) and selected (which
                // are active) must come from the SAME DC list — the row's
                // actual owner, not always the top-level group. A vendor
                // merged in via "Move to" keeps its own DC_LIST distinct
                // from the group's, so using the group's here for a merged-
                // in owner's row would show pills that don't match what's
                // actually selectable/selected for it.
                const defaultDcs = parseVendorDcs(owner.match.DC_LIST);
                const selectedDcs = vendorSkuDcs(owner.match, row);
                const eligibleDcs = unionDcs(defaultDcs, selectedDcs);
                const extraCells = extraKeyCols.map(f => `<td>${row[f] || "—"}</td>`).join("");
                html += `<tr data-sku-key="${row.THD_KEY}"><td><div class="vendor-dc-buttons">
                    ${renderDcButtonGrid(matchIndex, eligibleDcs, parseVendorNames(owner.match._initialDcNames), selectedDcs, {
                        extraClass: " vendor-sku-dc-btn",
                        dataAttrs: ` data-sku-key="${row.THD_KEY}" data-owner-index="${owner.index}"`,
                    })}
                    ${renderAddDcOptions(eligibleDcs, ` data-match-index="${matchIndex}" data-owner-index="${owner.index}" data-sku-key="${row.THD_KEY}"`, "vendor-sku-add-dc-select")}
                    </div>${owner.match.SKU_OVERRIDES[row.THD_KEY] ? '<span class="vendor-sku-override">Override</span>' : ""}</td>
                    <td class="vendor-sku-count">${selectedDcs.length}</td>
                    <td>${(owner.match.VENDOR || owner.match.SUPPLIER || "").toUpperCase()}</td>
                    <td>${row.THD_SKU_NBR || "—"}</td><td>${row.SKU_DESC || "—"}</td>${extraCells}<td>${row.TOTAL_UNITS || "—"}</td><td>${row.TOTAL_CUBE || "—"}</td>
                    <td><div class="move-wrap">
                        <button type="button" class="btn btn-sm btn-secondary vendor-sku-move-btn" data-match-index="${matchIndex}" data-owner-index="${owner.index}" data-sku-key="${row.THD_KEY}" title="Move this SKU to another vendor's DC group">⋯</button>
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
            container.querySelectorAll(".vendor-sku-add-dc-select").forEach(select => {
                select.addEventListener("change", () => {
                    const dc = Number(select.value);
                    if (dc) addVendorSkuDc(Number(select.dataset.matchIndex), Number(select.dataset.ownerIndex), select.dataset.skuKey, dc);
                });
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

        // Eligible and selected must come from the same DC list — the row's
        // actual owner, not the top-level group (a vendor merged in via
        // "Move to" keeps its own DC_LIST distinct from the group's).
        const defaultDcs = parseVendorDcs(owner.DC_LIST);
        const names = parseVendorNames(owner._initialDcNames);
        const selectedDcs = parseVendorDcs(owner.SKU_OVERRIDES[skuKey] || owner.DC_LIST);
        const eligibleDcs = unionDcs(defaultDcs, selectedDcs);

        const btnCell = row.querySelector(".vendor-dc-buttons");
        if (btnCell) {
            btnCell.innerHTML = renderDcButtonGrid(groupIndex, eligibleDcs, names, selectedDcs, {
                extraClass: " vendor-sku-dc-btn",
                dataAttrs: ` data-sku-key="${skuKey}" data-owner-index="${ownerIndex}"`,
            }) + renderAddDcOptions(eligibleDcs, ` data-match-index="${groupIndex}" data-owner-index="${ownerIndex}" data-sku-key="${skuKey}"`, "vendor-sku-add-dc-select");
            btnCell.querySelectorAll(".vendor-sku-dc-btn").forEach(button => {
                button.addEventListener("click", () => toggleVendorSkuDc(
                    Number(button.dataset.matchIndex), Number(button.dataset.ownerIndex), button.dataset.skuKey, Number(button.dataset.dcNbr)
                ));
            });
            btnCell.querySelectorAll(".vendor-sku-add-dc-select").forEach(select => {
                select.addEventListener("change", () => {
                    const dc = Number(select.value);
                    if (dc) addVendorSkuDc(Number(select.dataset.matchIndex), Number(select.dataset.ownerIndex), select.dataset.skuKey, dc);
                });
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

    // Adds a DC to one SKU's own override, independent of its vendor's
    // supplier-level DC_LIST — the SKU-level counterpart to addVendorDc.
    // Only creates/touches SKU_OVERRIDES for this one THD_KEY; the vendor's
    // default list (and every other SKU under it) is untouched.
    function addVendorSkuDc(groupIndex, ownerIndex, skuKey, dcNbr) {
        const owner = vendorMatches[ownerIndex];
        if (!owner || !Number.isFinite(dcNbr)) return;
        owner.SKU_OVERRIDES = owner.SKU_OVERRIDES || {};
        const current = parseVendorDcs(owner.SKU_OVERRIDES[skuKey] || owner.DC_LIST);
        if (current.includes(dcNbr)) return;
        const next = [...current, dcNbr].sort((a, b) => a - b);
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
        // "OTHER" is the generic no-match fallback, not a real vendor identity
        // — comparing it year over year is meaningless (it's expected to
        // reappear every year regardless of which actual suppliers land in
        // it), so it's excluded here rather than flagged as a "new supplier"
        // (light-green row highlight) any time nobody happens to match it.
        const thisYearNames = new Set(matches.map(m => norm(m.VENDOR || m.SUPPLIER)).filter(n => n !== "OTHER"));
        const priorYearNames = new Set(priorRows.flatMap(r => (r.vendor || "").split(", ").map(norm)).filter(n => n !== "OTHER"));
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

        let html = `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
            <h4 style="margin:0;font-size:.9rem"><i class="fas fa-boxes-stacked"></i> Supplier DC Assignments</h4>
            <button type="button" class="btn btn-sm btn-secondary vendor-table-download-btn"><i class="fas fa-file-arrow-down"></i> Download</button>
        </div>`;
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
            <thead><tr><th>DC NBR List</th><th>DC Count</th><th>Supplier</th><th>SKUs</th><th></th></tr></thead><tbody>`;
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
                // matchedVendor is just "OTHER" for a supplier that fell
                // back to the generic default (that's the whole reason it's
                // being merged), which reads as a meaningless "OTHER moved
                // under OTHER" — show its actual SUPPLIER instead. The
                // target keeps showing "OTHER" since that IS the bucket's
                // real name.
                const movedLabel = isOther ? (m.SUPPLIER || matchedVendor).toUpperCase() : matchedVendor;
                html += `<tr class="vendor-row-moved">
                    <td colspan="4"><em>${movedLabel}</em> moved under <strong>${(target?.VENDOR || target?.SUPPLIER || "").toUpperCase()}</strong></td>
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
                ? `<div class="vendor-merged-badges">${mergedHere.map(mv => {
                    // An OTHER-bucket member's own VENDOR is just "OTHER" too
                    // (that's the whole point — it never matched a named
                    // strategy), so the badge would read "+ OTHER" for every
                    // one of them; show its actual SUPPLIER there instead.
                    const label = (mv.VENDOR || "").toUpperCase() === "OTHER" ? mv.SUPPLIER : (mv.VENDOR || mv.SUPPLIER);
                    return `<span class="vendor-merged-badge">+ ${(label || "").toUpperCase()}</span>`;
                }).join("")}</div>`
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
                ${renderAddDcOptions(initialDcs, ` data-match-index="${matchIndex}"`, "vendor-add-dc-select")}
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
        box.querySelectorAll(".vendor-add-dc-select").forEach(select => {
            select.addEventListener("change", () => {
                const dc = Number(select.value);
                if (dc) addVendorDc(Number(select.dataset.matchIndex), dc);
            });
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
        box.querySelector(".vendor-table-download-btn")?.addEventListener("click", downloadVendorAlignedTable);
        vendorSkuExpanded.forEach(matchIndex => loadVendorSkuRows(matchIndex, 1));
    }

    // Exports every SKU record across all matched suppliers with its
    // effective DC assignment — the same override resolution
    // /api/submit_cost_model uses (per-SKU overrides, "Move to" merges),
    // kept at THD-record granularity rather than rolled up by SKU_NBR, so
    // SISTER_SKU_NBR/SKU_DESC and whatever else distinguishes two records
    // sharing a THD_SKU_NBR (e.g. MVNDR_NBR) stay visible.
    async function downloadVendorAlignedTable() {
        showLoading("Preparing vendor-aligned SKU export…");
        try {
            const resp = await fetch("/api/download_vendor_aligned_table", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName, vendor_matches: vendorMatches }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error || `Server returned status ${resp.status}`);
            }
            const blob = await resp.blob();
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `vendor_aligned_skus_${(eventName || "export").replace(/\s+/g, "_")}.xlsx`;
            a.click();
            URL.revokeObjectURL(a.href);
        } catch (e) {
            toast("Failed to download vendor-aligned table: " + e.message, "error");
        } finally {
            hideLoading();
        }
    }

    let availableDcOptions = [];

    // Strategy-aware: VENDOR_ALIGNED reads DFC_COST_MODEL_SUBMISSION's own
    // per-SKU dc_inclusions and has no notion of dc_counts or campus merging
    // at all — running that check under DC_SELECTION instead was exactly
    // what produced the wrong wholesale "109 SKUs ineligible" result (it
    // can't see campus pairing, and it isn't scoped to the DC counts/
    // inclusions actually chosen here). DC_SELECTION gets its own preview
    // that reuses the same campus-merge logic the real ladder will use.
    async function loadDcEligibility() {
        const runId = $("#stratRunId")?.value?.trim() || "";
        if (!runId) {
            toast("Run ID is required", "error");
            return;
        }
        if (selectedStrategy === "DC_SELECTION" || selectedStrategy === "SINGLE_DC" || selectedStrategy === "MULTI_DC") {
            return loadDcSelectionEligibility(runId);
        }
        const container = $("#dcEligibilityResults");
        container.style.display = "block";
        container.innerHTML = `<div style="color:var(--hd-medium-gray);font-size:0.85rem"><i class="fas fa-spinner fa-spin"></i> Checking DC eligibility…</div>`;
        try {
            const result = await api("/api/check_dc_eligibility", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    run_id: runId,
                    event_name: eventName,
                    sku_grp: $("#stratSkuGrp")?.value?.trim() || "",
                }),
            });
            if (result.error) throw new Error(result.error);
            renderDcEligibility(result.conflicts || []);
        } catch (e) {
            container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
        }
    }

    async function loadDcSelectionEligibility(runId) {
        const container = $("#dcEligibilityResults");
        container.style.display = "block";
        container.innerHTML = `<div style="color:var(--hd-medium-gray);font-size:0.85rem"><i class="fas fa-spinner fa-spin"></i> Checking DC selection eligibility…</div>`;
        const dcCounts = $("#dcManual")?.style.display !== "none"
            ? getSelectedDcCounts("#dcToggleGrid")
            : [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount));
        if (!dcCounts.length) {
            container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem">
                <i class="fas fa-times-circle"></i> Select at least one DC count first
            </div>`;
            return;
        }
        try {
            const result = await api("/api/check_dc_selection_eligibility", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    run_id: runId,
                    event_name: eventName,
                    sku_grp: $("#stratSkuGrp")?.value?.trim() || "",
                    dc_counts: dcCounts,
                    dc_inclusions: dcInclusions,
                    dc_exclusions: dcExclusions,
                    campus_pairs: campusPairs,
                }),
            });
            if (result.error) throw new Error(result.error);
            renderDcSelectionEligibility(result.problem_skus || [], dcCounts);
        } catch (e) {
            container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
        }
    }

    function renderDcSelectionEligibility(problemSkus, dcCounts) {
        const container = $("#dcEligibilityResults");
        if (!problemSkus.length) {
            container.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.9rem">
                <i class="fas fa-check-circle"></i> Every target SKU would price at DC count(s) ${dcCounts.join(", ")} with this selection.
            </div>`;
            return;
        }
        const totalRecords = problemSkus.reduce((sum, p) => sum + (p.RECORD_COUNT || 0), 0);
        container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem;margin-bottom:8px">
                <i class="fas fa-triangle-exclamation"></i> ${problemSkus.length} SKU(s), ${totalRecords} record(s) would NOT price at any of DC count(s) ${dcCounts.join(", ")}
            </div>` + problemSkus.map(p => {
            const ineligible = p.ineligible || [];
            const ineligibleText = ineligible.length
                ? ineligible.map(x => `${x.dc_nbr} (${x.reason})`).join("; ")
                : "no specific reason found in OBC_CTLG_SKU_DC for this run";
            const altText = (p.eligible_alternatives || []).slice(0, 8).join(", ");
            return `<div style="border:1px solid var(--hd-light-gray);border-radius:6px;padding:10px 12px;margin-bottom:8px">
                <strong>SKU ${p.SKU_NBR}</strong> — ${p.SUPPLIER || "—"} — ${p.SKU_DESC || "—"}
                <div style="font-size:0.82rem;color:var(--hd-medium-gray);margin:4px 0">
                    Affects ${p.RECORD_COUNT} record(s) across ${(p.FACTORY_IDS || []).length} factory(ies)
                </div>
                <div style="font-size:0.82rem;color:#a94442;margin:4px 0"><strong>Ineligible DC(s):</strong> ${ineligibleText}</div>
                ${altText ? `<div style="font-size:0.8rem;color:var(--hd-medium-gray)">Known-eligible alternative(s): ${altText}</div>` : ""}
            </div>`;
        }).join("");
    }

    function renderDcEligibility(conflicts) {
        const container = $("#dcEligibilityResults");
        if (!conflicts.length) {
            container.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.9rem">
                <i class="fas fa-check-circle"></i> No DC eligibility conflicts found for the current selections.
            </div>`;
            return;
        }
        container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem;margin-bottom:8px">
                <i class="fas fa-triangle-exclamation"></i> ${conflicts.length} SKU(s) have no eligible catalog assortment for their chosen DCs
            </div>` + conflicts.map((c, i) => {
            const ineligibleList = c.ineligible.length
                ? c.ineligible.map(x => `${x.dc_nbr} (${x.reason})`).join("; ")
                : "no specific reason found in OBC_CTLG_SKU_DC for this run";
            const altButtons = c.eligible_alternatives.slice(0, 8).map(dc =>
                `<button type="button" class="btn btn-sm btn-secondary dc-elig-add" data-idx="${i}" data-dc="${dc}" style="margin:2px">+ ${dc}</button>`
            ).join("");
            return `<div style="border:1px solid var(--hd-light-gray);border-radius:6px;padding:10px 12px;margin-bottom:8px">
                <strong>SKU ${c.sku_nbr}</strong> — ${c.supplier || "—"} — ${c.sku_desc || "—"}
                <div style="font-size:0.82rem;color:var(--hd-medium-gray);margin:4px 0">Ineligible: ${ineligibleList}</div>
                <div style="font-size:0.8rem;color:var(--hd-medium-gray)">Chosen DCs: ${c.chosen_dcs.join(", ")}</div>
                <div style="margin-top:6px">
                    <button type="button" class="btn btn-sm btn-secondary dc-elig-remove" data-idx="${i}" style="margin-right:8px">Remove ineligible DC(s)</button>
                    ${altButtons ? `<span style="font-size:0.8rem;color:var(--hd-medium-gray)">Add eligible alternative:</span> ${altButtons}` : ""}
                </div>
            </div>`;
        }).join("");

        container.querySelectorAll(".dc-elig-remove").forEach(btn => {
            btn.addEventListener("click", () => {
                const c = conflicts[Number(btn.dataset.idx)];
                const ineligibleSet = new Set(c.ineligible.map(x => x.dc_nbr));
                applyEligibilityFix(c, c.chosen_dcs.filter(dc => !ineligibleSet.has(dc)));
            });
        });
        container.querySelectorAll(".dc-elig-add").forEach(btn => {
            btn.addEventListener("click", () => {
                const c = conflicts[Number(btn.dataset.idx)];
                const dc = Number(btn.dataset.dc);
                applyEligibilityFix(c, [...new Set([...c.chosen_dcs, dc])]);
            });
        });
    }

    // Applies a corrected DC list for every THD_SKU_NBR under this conflict's proxy
    // SKU_NBR (a proxy can carry more than one THD key) via the same per-SKU
    // SKU_OVERRIDES mechanism Step 2's drill-down uses — the fix must be resubmitted
    // via "Submit to Cost Model" (Step 2) to actually take effect on the next
    // allocation run, since that's what writes DFC_COST_MODEL_SUBMISSION.dc_inclusions.
    // Then sends the user back to Step 2 so they actually see the corrected
    // selection land on the SKU, rather than a toast telling them to go check.
    async function applyEligibilityFix(conflict, newDcs) {
        if (!conflict.thd_sku_nbrs || !conflict.thd_sku_nbrs.length) {
            toast("Could not determine which uploaded record(s) to update", "error");
            return;
        }
        const owner = vendorMatches.find(m =>
            (m.VENDOR || m.SUPPLIER || "").toUpperCase() === (conflict.supplier || "").toUpperCase());
        if (!owner) {
            toast("Run vendor matching first (Step 2) before fixing eligibility here", "error");
            return;
        }
        owner.SKU_OVERRIDES = owner.SKU_OVERRIDES || {};

        // conflict.thd_sku_nbrs are bare THD_SKU_NBR values, but Step 2 keys
        // SKU_OVERRIDES by the composite THD_KEY it builds per row (THD_SKU_NBR
        // plus whatever else disambiguates rows, e.g. MVNDR_NBR — see
        // vendorSkuDcs()). Writing the override under the bare number would
        // silently never match a Step 2 row whenever that owner needed the
        // extra key columns, so look up each row's real THD_KEY first.
        const wantedSkus = new Set(conflict.thd_sku_nbrs.map(String));
        let targetKeys = conflict.thd_sku_nbrs.map(String);
        try {
            // owner.SUPPLIER is just whichever supplier this owner's row
            // happens to carry — for the collapsed OTHER bucket that's only
            // ONE of potentially many underlying suppliers, not necessarily
            // this conflict's own. conflict.supplier (the SKU's real,
            // uploaded supplier) is always the right one to fetch here.
            const result = await api(`/api/vendor_skus?supplier=${encodeURIComponent(conflict.supplier || owner.SUPPLIER)}&page=1&page_size=100`);
            if (!result.error && result.rows?.length) {
                const resolved = result.rows
                    .filter(r => wantedSkus.has(String(r.THD_SKU_NBR)))
                    .map(r => r.THD_KEY);
                if (resolved.length) targetKeys = resolved;
            }
        } catch (e) {
            // Fall back to the bare THD_SKU_NBR keys above — still correct
            // whenever this owner has no extra key columns.
        }

        for (const key of targetKeys) {
            owner.SKU_OVERRIDES[key] = newDcs;
        }
        toast(`Updated SKU ${conflict.sku_nbr} to ${newDcs.length} DC(s) — review it on Step 2`, "success");
        loadDcEligibility();

        // Jump back to Step 2 and open (or refresh, if already open) this
        // owner's SKU panel so the corrected pills are immediately visible,
        // instead of leaving the user on Step 3 to discover it on their own.
        const ownerIndex = vendorMatches.indexOf(owner);
        const groupIndex = owner._movedTo != null ? owner._movedTo : ownerIndex;
        goStep(2);
        vendorSkuExpanded.add(groupIndex);
        renderVendorSupplierSummary(vendorMatches);

        // The panel's rows load via an async fetch (loadVendorSkuRows,
        // triggered from inside renderVendorSupplierSummary above) — poll
        // briefly for them to land rather than guessing a fixed delay that
        // might be too short on a slow connection.
        let attempts = 0;
        const tryHighlight = () => {
            attempts++;
            let found = false;
            for (const key of targetKeys) {
                const row = document.querySelector(`tr[data-sku-key="${CSS.escape(key)}"]`);
                if (row) {
                    found = true;
                    row.scrollIntoView({ behavior: "smooth", block: "center" });
                    row.classList.add("vendor-sku-row-flash");
                    setTimeout(() => row.classList.remove("vendor-sku-row-flash"), 2000);
                }
            }
            if (!found && attempts < 15) setTimeout(tryHighlight, 300);
        };
        setTimeout(tryHighlight, 300);
    }

    // ── Problem SKUs (MULTI_DC, Step 7) ────────────────────────────
    // Same flag-then-fix shape as the VENDOR_ALIGNED DC Eligibility card
    // above, but the fix here reroutes the SKU to its own independent
    // assortment immediately (resolve_problem_sku_override) rather than
    // requiring a trip back to Step 2 and a cost-model resubmission — the
    // ladder never reads a per-SKU DC selection, so there's nothing to
    // resubmit for it to pick up.
    let problemSkus = [];
    let problemSkuDcState = {}; // sku_nbr -> Map(dc_nbr -> "include"|"exclude")

    async function loadProblemSkus() {
        const runId = $("#stratRunId")?.value?.trim() || "";
        if (!runId) {
            toast("Run ID is required", "error");
            return;
        }
        const container = $("#problemSkuResults");
        container.style.display = "block";
        container.innerHTML = `<div style="color:var(--hd-medium-gray);font-size:0.85rem"><i class="fas fa-spinner fa-spin"></i> Checking problem SKUs…</div>`;
        try {
            const result = await api("/api/check_problem_skus", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ event_name: eventName, run_id: runId }),
            });
            if (result.error) throw new Error(result.error);
            problemSkus = result.problem_skus || [];
            renderProblemSkus();
        } catch (e) {
            container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem">
                <i class="fas fa-times-circle"></i> ${e.message}
            </div>`;
        }
    }

    function renderProblemSkus() {
        const container = $("#problemSkuResults");
        if (!problemSkus.length) {
            container.innerHTML = `<div class="validation-badge badge-pass" style="font-size:0.9rem">
                <i class="fas fa-check-circle"></i> No problem SKUs — every record priced under its factory's chosen assortment.
            </div>`;
            return;
        }
        container.innerHTML = `<div class="validation-badge badge-fail" style="font-size:0.9rem;margin-bottom:8px">
                <i class="fas fa-triangle-exclamation"></i> ${problemSkus.length} SKU(s) didn't price under their factory's chosen assortment
            </div>` + problemSkus.map(p => {
            if (!problemSkuDcState[p.SKU_NBR]) problemSkuDcState[p.SKU_NBR] = new Map();
            const failedLists = (p.FAILED_DC_LISTS || []).join(" | ") || "—";
            const ineligible = p.ineligible || [];
            const ineligibleText = ineligible.length
                ? ineligible.map(x => `${x.dc_nbr} (${x.reason})`).join("; ")
                : "no specific reason found in OBC_CTLG_SKU_DC for this run";
            const altButtons = (p.eligible_alternatives || []).slice(0, 8).map(dc =>
                `<button type="button" class="btn btn-sm btn-secondary problem-sku-add-alt" data-sku="${p.SKU_NBR}" data-dc="${dc}" style="margin:2px">+ ${dc}</button>`
            ).join("");
            const dcGridId = `problemSkuDcGrid-${p.SKU_NBR}`;
            return `<div style="border:1px solid var(--hd-light-gray);border-radius:6px;padding:10px 12px;margin-bottom:8px">
                <strong>SKU ${p.SKU_NBR}</strong> — ${p.SUPPLIER || "—"} — ${p.SKU_DESC || "—"}
                <div style="font-size:0.82rem;color:var(--hd-medium-gray);margin:4px 0">
                    Affects ${p.RECORD_COUNT} record(s) across ${(p.FACTORY_IDS || []).length} factory(ies), tier(s) ${(p.TIERS || []).join(", ")}
                </div>
                <div style="font-size:0.8rem;color:var(--hd-medium-gray)">Didn't price at: ${failedLists}</div>
                <div style="font-size:0.82rem;color:#a94442;margin:4px 0"><strong>Ineligible DC(s):</strong> ${ineligibleText}</div>
                ${altButtons ? `<div style="font-size:0.8rem;color:var(--hd-medium-gray);margin-bottom:4px">Known-eligible alternative(s) — click to include: ${altButtons}</div>` : ""}
                <div style="font-size:0.8rem;color:var(--hd-medium-gray);margin-top:6px">Pick a new DC selection for this SKU (click to include → exclude → clear):</div>
                <div id="${dcGridId}" style="margin:6px 0"></div>
                <button type="button" class="btn btn-sm btn-primary problem-sku-apply" data-sku="${p.SKU_NBR}">Apply</button>
            </div>`;
        }).join("");

        problemSkus.forEach(p => {
            const grid = $(`#problemSkuDcGrid-${p.SKU_NBR}`);
            if (!grid) return;
            const state = problemSkuDcState[p.SKU_NBR];
            grid.innerHTML = ALL_DCS.map(dc =>
                `<button type="button" class="dc-toggle-btn problem-sku-dc-btn" data-sku="${p.SKU_NBR}" data-dc="${dc.nbr}" data-state="${state.get(dc.nbr) || "none"}" title="${dc.name.toUpperCase()}">${dc.nbr}</button>`
            ).join("");
        });

        container.querySelectorAll(".problem-sku-dc-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const sku = btn.dataset.sku;
                const dc = Number(btn.dataset.dc);
                const nextState = DC_FILTER_NEXT_STATE[btn.dataset.state];
                btn.dataset.state = nextState;
                const state = problemSkuDcState[sku];
                if (nextState === "none") state.delete(dc);
                else state.set(dc, nextState);
            });
        });

        // Quick-add a known-eligible alternative straight into that SKU's
        // include state, keeping the toggle grid's own button in sync so the
        // two controls never disagree about what's selected.
        container.querySelectorAll(".problem-sku-add-alt").forEach(btn => {
            btn.addEventListener("click", () => {
                const sku = btn.dataset.sku;
                const dc = Number(btn.dataset.dc);
                problemSkuDcState[sku].set(dc, "include");
                const gridBtn = container.querySelector(`.problem-sku-dc-btn[data-sku="${sku}"][data-dc="${dc}"]`);
                if (gridBtn) gridBtn.dataset.state = "include";
            });
        });

        container.querySelectorAll(".problem-sku-apply").forEach(btn => {
            btn.addEventListener("click", () => applyProblemSkuFix(btn.dataset.sku));
        });
    }

    async function applyProblemSkuFix(skuNbr) {
        const state = problemSkuDcState[skuNbr];
        const dcInclusions = [...state.entries()].filter(([, s]) => s === "include").map(([dc]) => dc);
        const dcExclusions = [...state.entries()].filter(([, s]) => s === "exclude").map(([dc]) => dc);
        if (!dcInclusions.length && !dcExclusions.length) {
            toast("Pick at least one DC to include or exclude first", "error");
            return;
        }
        try {
            const result = await api("/api/resolve_problem_sku", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    run_id: $("#stratRunId")?.value?.trim() || "",
                    event_name: eventName,
                    sku_nbr: Number(skuNbr),
                    dc_inclusions: dcInclusions,
                    dc_exclusions: dcExclusions,
                }),
            });
            if (result.error) throw new Error(result.error);
            toast(`SKU ${skuNbr} rerouted to its own assortment`, "success");
            delete problemSkuDcState[skuNbr];
            await loadProblemSkus();
            await refreshAssortmentResultsOnly();
        } catch (e) {
            toast(e.message || "Failed to apply fix", "error");
        }
    }

    // Re-fetches Step 7's own table + confirm-gate from the output tables the
    // fix above just corrected, WITHOUT resubmitting the ladder procedure —
    // deliberately calls with run_id blank (the "no run_id, just re-fetch"
    // path in /api/determine_assortment_start) rather than reusing
    // determineAssortment()/forceRedetermine, which would submit a fresh
    // ladder run and silently undo this SKU's independent reroute.
    async function refreshAssortmentResultsOnly() {
        try {
            const started = await api("/api/determine_assortment_start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ strategy: selectedStrategy, event_name: eventName, run_id: "" }),
            });
            if (started.error) throw new Error(started.error);
            const result = started.sync_result;
            if (!result) return;
            assortmentResults = result.results || [];
            renderAssortmentTable(assortmentResults, result.strategy_type || selectedStrategy, result);
            lastAssortmentResults = result;
            applyConfirmGate(result);
        } catch (e) {
            // Non-fatal — the fix itself already succeeded; the user can
            // still see it by clicking "Check Problem SKUs" again or
            // navigating away and back.
            console.warn("refreshAssortmentResultsOnly failed", e);
        }
    }

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

            // Manual/lookup DC counts, computed up front (neither "determine
            // for me" path has any yet — that's the whole point). Whether this
            // ends up length 1 decides, below, whether the group-run query
            // runs for THIS path too, same as "Single DC Count — determine for
            // me" and (for imports) the cascading toggle.
            let dcCounts = null;
            if (!dynamicMode && !singleDcCountAutoSelected) {
                dcCounts = $("#dcManual")?.style.display !== "none"
                    ? getSelectedDcCounts("#dcToggleGrid")
                    : [...$$('#dcCountChecks input:checked')].map(c => parseInt(c.dataset.dcCount));
                if (!dcCounts.length) {
                    toast("Select at least one DC count", "error");
                    return;
                }
            }

            // A single DC count — however it was arrived at (manually checking
            // just one box, checking just one lookup option, or "Single DC
            // Count — determine for me") — always resolves through the same
            // group-run query (fetch_lowest_expense_dc_count /
            // OBC_V_CTLG_RUN_BY_GROUP): the Best-Expense, lowest-TOTAL_EXP
            // assortment for the whole group, optionally constrained to specific
            // DC numbers the user has marked "include" in the DC Filter below.
            const singleCountWanted = singleDcCountAutoSelected || (dcCounts && dcCounts.length === 1);

            if (singleCountWanted) {
                const runId = $("#stratRunId")?.value?.trim() || "";
                const skuGrp = $("#stratSkuGrp")?.value?.trim() || "";
                if (!runId || !skuGrp) {
                    toast("Run ID and SKU Group are required to pick a single DC count", "error");
                    return;
                }
                const resultEl = $("#singleDcGroupResult");
                if (resultEl) {
                    resultEl.style.display = "block";
                    resultEl.innerHTML = `<div class="validation-badge" style="display:block"><i class="fas fa-spinner fa-spin"></i> Finding the lowest-expense DC count for this group…</div>`;
                }
                try {
                    const result = await api("/api/lowest_expense_dc_count", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            run_id: runId, sku_grp: skuGrp,
                            dc_counts: dcCounts && dcCounts.length ? dcCounts : undefined,
                            dc_inclusions: dcInclusions && dcInclusions.length ? dcInclusions : undefined,
                        }),
                    });
                    if (result.error) throw new Error(result.error);
                    singleDcGroupChoice = result;
                    if (resultEl) {
                        const dcListLine = result.dc_list ? ` (DCs ${result.dc_list.join(", ")})` : "";
                        resultEl.innerHTML = `<div class="validation-badge badge-pass" style="display:block">
                            <i class="fas fa-check-circle"></i> Selected <strong>${result.dc_count} DCs</strong>${dcListLine}
                            (assortment ID ${result.camp_asmt_id}) — lowest total expense at
                            <strong>$${Number(result.total_exp).toLocaleString()}</strong> for the whole group.
                        </div>`;
                    }
                } catch (err) {
                    toast("Could not determine lowest-expense DC count: " + err.message, "error");
                    if (resultEl) resultEl.style.display = "none";
                    return;
                }
                body.strategy = "SINGLE_DC";
                body.camp_asmt_id = singleDcGroupChoice.camp_asmt_id;
                body.dc_count_run_id = runId;
                body.dc_count_sku_grp = skuGrp;
                body.run_id = runId;
                body.sku_grp = skuGrp;
                body.is_import = includesImports;
                _executeAssortment(body);
                return;
            } else if (dynamicMode) {
                body.strategy = "MULTI_DC";
                body.dc_counts = [];
            } else {
                body.strategy = "MULTI_DC";
                body.dc_counts = dcCounts;
            }
            // Low-volume factory settings: read straight off Step 2's own
            // panel (kept live by renderLowVolumeAlert(), triggered on every
            // DC-count toggle there) rather than re-deriving anything here —
            // defaults to the same 5/2 this used to hardcode when that panel
            // was never shown (a domestic event, or no factory below the
            // threshold at any point).
            body.min_containers = parseFloat($("#minContainersInput")?.value) || 5;
            body.low_vol_fallback_dc = parseInt($("#lowVolFallbackDc")?.value) || 2;
            body.is_import = includesImports;
            body.cascading = !!$("#cascadingToggle")?.checked;
            body.campus_pairs = campusPairs;
            body.dc_inclusions = dcInclusions;
            body.dc_exclusions = dcExclusions;
            body.run_id = $("#stratRunId")?.value?.trim() || "";
            body.sku_grp = $("#stratSkuGrp")?.value?.trim() || "";
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

            // Campus DCs only means something when the user actually opted into
            // treating a campus's bulk/main DCs as one ("Treat Bulk Counterparts
            // The Same") AND that campus's DCs actually turn up in some tier's
            // winning assortment. Can't tell that from CAMPUS_DC_LIST vs DC_LIST
            // — the backend's CAMPUS_DC_LIST is a display-name string (e.g.
            // "Columbus Bulk, Chicago"), built from a static per-DC name lookup
            // applied to every row regardless of campus pairing, so it never
            // equals the numeric DC_LIST even when Perris/Locust Grove never
            // appear at all. Check DC_LIST itself (numeric, dash-joined) for the
            // actual DC codes of whichever campus(es) were selected instead.
            // Computed once here since both the High-Level Summary and the
            // Factory & DC List Detail tables key their DC List column on it.
            const activeCampusCodes = campusPairs.flatMap(cp => {
                const info = CAMPUS_INFO[cp];
                return info ? [info.main, info.bulk] : [];
            });
            const showCampusCol = activeCampusCodes.length > 0
                && dcFactoryDetail.some(d => (d.DC_LIST || "").split("-")
                    .some(code => activeCampusCodes.includes(parseInt(code, 10))));
            // Per-tier DC_NM_LIST (actual DC facility names) for the High-Level
            // Summary's DC List hover — ASSORTMENT_COST_SUMMARY only carries
            // CAMPUS_DC_LIST (numeric) and DC_NAMES (campus names), not the raw
            // DC_NM_LIST, so pull it from dc_factory_detail instead. Same "read
            // off the first row" convention as CAMPUS_DC_LIST below: one winning
            // list per tier, enforced by the coverage-gated selection.
            const dcNmByTier = {};
            for (const d of dcFactoryDetail) {
                if (!(d.DC_TIER in dcNmByTier)) dcNmByTier[d.DC_TIER] = d.DC_NM_LIST || "—";
            }
            // Priced (matched) THD Keys per tier — dc_factory_detail is already
            // matched-only (built from _combo_detail, same source ASSORTMENT_COST_
            // SUMMARY's own matched-only expense/SLA figures come from), so summing
            // its THD_KEYS per tier gives the truly-priced record count without any
            // backend change. tier_summary's own THD_KEYS counts every SKU assigned
            // to the tier regardless of whether it priced, so the two can now be
            // compared directly to surface the gap this table used to hide.
            const pricedKeysByTier = {};
            for (const d of dcFactoryDetail) {
                pricedKeysByTier[d.DC_TIER] = (pricedKeysByTier[d.DC_TIER] || 0) + (d.THD_KEYS || 0);
            }

            let html = "";

            // ── Table 1: High-Level Summary ──
            html += `<tr><td colspan="${C}" style="background:var(--hd-orange);color:#fff;font-weight:700;padding:10px;font-size:1rem">High-Level Summary</td></tr>`;
            html += `<tr style="background:var(--hd-bg);font-weight:600">
                <td>DC Tier</td><td>${showCampusCol ? "Campus DC List" : "DC List"}</td>
                <td style="text-align:right">THD Keys</td><td style="text-align:right">Priced THD Keys</td><td style="text-align:right">Buy Units</td>
                <td style="text-align:right">Delivery Expense</td><td style="text-align:right">Unit Del. Exp</td>
                <td style="text-align:right">SLA</td></tr>`;
            let tKeys=0,tPriced=0,tBuy=0,tExp=0,tSla=0;
            for (const r of tierSummary) {
                const priced = pricedKeysByTier[r.DC_TIER] || 0;
                tKeys+=r.THD_KEYS||0; tPriced+=priced; tBuy+=r.BUY_UNITS||0; tExp+=r.DELIVERY_EXPENSE||0; tSla+=(r.SLA||0)*(r.BUY_UNITS||0);
                const dcNmTitle = (dcNmByTier[r.DC_TIER] || "—").replace(/"/g, "&quot;");
                const gap = (r.THD_KEYS || 0) - priced;
                const pricedCell = gap > 0
                    ? `<span style="color:#c00" title="${gap} of ${fmtN(r.THD_KEYS)} record(s) in this tier didn't price — see Check Problem SKUs"><i class="fas fa-triangle-exclamation"></i> ${fmtN(priced)}</span>`
                    : fmtN(priced);
                html += `<tr>
                    <td style="text-align:center;font-weight:600">${r.DC_TIER}</td>
                    <td style="font-size:0.85rem" title="${dcNmTitle}">${r.CAMPUS_DC_LIST || "—"}</td>
                    <td style="text-align:right">${fmtN(r.THD_KEYS)}</td>
                    <td style="text-align:right">${pricedCell}</td>
                    <td style="text-align:right">${fmtN(r.BUY_UNITS)}</td>
                    <td style="text-align:right">${fmt$(r.DELIVERY_EXPENSE)}</td>
                    <td style="text-align:right">${fmt$(r.UNIT_DELIVERY_EXP)}</td>
                    <td style="text-align:right">${fmtD(r.SLA,2)}</td></tr>`;
            }
            const tGap = tKeys - tPriced;
            const tPricedCell = tGap > 0
                ? `<span style="color:#c00">${fmtN(tPriced)}</span>`
                : fmtN(tPriced);
            html += `<tr style="font-weight:700;border-top:2px solid #333">
                <td>Total</td><td></td><td style="text-align:right">${fmtN(tKeys)}</td><td style="text-align:right">${tPricedCell}</td><td style="text-align:right">${fmtN(tBuy)}</td>
                <td style="text-align:right">${fmt$(tExp)}</td><td style="text-align:right">${fmt$(tBuy?tExp/tBuy:0)}</td>
                <td style="text-align:right">${fmtD(tBuy?tSla/tBuy:0,2)}</td></tr>`;

            // ── Table 2: Factory & DC List Detail (expandable by tier) —
            // combines the former separate DC List Detail / Factory Detail
            // tables. Grain is (tier, DC list, factory): the D7 fallback can
            // now legitimately put a factory's SKUs on more than one DC_LIST
            // within its own tier, which neither table alone could show without
            // either splitting a factory's row or blending factories together.
            html += `<tr><td colspan="${C}">&nbsp;</td></tr>`;
            html += `<tr><td colspan="${C}" style="background:var(--hd-orange);color:#fff;font-weight:700;padding:10px;font-size:1rem">Factory & DC List Detail</td></tr>`;
            html += `<tr style="background:var(--hd-bg);font-weight:600">
                <td>DC Tier</td><td>${showCampusCol ? "Campus DC List" : "DC List"}</td><td>Factory</td>
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
                // and show once at the rollup level, not left blank. DC_NM_LIST
                // (the actual DC facility names) rides along as the hover title,
                // same convention as the High-Level Summary table above.
                const campusList = tRows[0]?.CAMPUS_DC_LIST || "—";
                const campusListTitle = (tRows[0]?.DC_NM_LIST || "—").replace(/"/g, "&quot;");
                // The expand/collapse control now lives on Factory (not DC List) —
                // clicking it reveals the per-factory rows this tier rolls up.
                html += `<tr style="font-weight:600;background:#f9f9f9;cursor:pointer" onclick="document.querySelectorAll('.${gid}').forEach(r=>r.style.display=r.style.display==='none'?'':'none');this.querySelector('.tog').textContent=this.querySelector('.tog').textContent==='▶'?'▼':'▶'">
                    <td style="text-align:center">${tier}</td>
                    <td style="font-size:0.85rem" title="${campusListTitle}">${campusList}</td>
                    <td><span class="tog">▶</span> ${tRows.length} row${tRows.length === 1 ? "" : "s"}</td>
                    <td style="text-align:right">${fmtD(sub.cont,2)}</td><td style="text-align:right">${fmtN(sub.keys)}</td>
                    <td style="text-align:right">${fmtN(sub.buy)}</td>
                    <td style="text-align:right">${fmt$(sub.exp)}</td><td style="text-align:right">${fmt$(sub.buy?sub.exp/sub.buy:0)}</td>
                    <td style="text-align:right">${fmtD(sub.buy?sub.sla/sub.buy:0,2)}</td><td style="text-align:right">${fmtD(cubeAvg,2)}</td></tr>`;
                for (const r of tRows) {
                    const rowListTitle = (r.DC_NM_LIST || "—").replace(/"/g, "&quot;");
                    html += `<tr class="${gid}" style="display:none">
                        <td></td>
                        <td style="font-size:0.85rem" title="${rowListTitle}">${r.CAMPUS_DC_LIST||'—'}</td>
                        <td>${r.FACTORY_ID||'—'}</td>
                        <td style="text-align:right">${fmtD(r.CONTAINERS,2)}</td><td style="text-align:right">${fmtN(r.THD_KEYS)}</td>
                        <td style="text-align:right">${fmtN(r.BUY_UNITS)}</td>
                        <td style="text-align:right">${fmt$(r.DELIVERY_EXPENSE)}</td><td style="text-align:right">${fmt$(r.UNIT_DELIVERY_EXP)}</td>
                        <td style="text-align:right">${fmtD(r.SLA,2)}</td><td style="text-align:right">${fmtD(r.CUBE_PER_UNIT,2)}</td></tr>`;
                }
            }
            html += `<tr style="font-weight:700;border-top:2px solid #333">
                <td>Grand Total</td><td></td><td></td>
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
            // Backs SINGLE_DC (both the manual/lookup one-count pick and the
            // "determine for me" group-run query) — assortment_engine.py's
            // _dc_count_single returns SKU_NBR/SUPPLIER/FACTORY_ID/
            // ASSIGNED_DC_COUNT/CAMP_ASMT_ID/DC_LIST/TOTAL_EXPENSE, not the
            // CAMPUS_DC_LIST/TOTAL_EXP/TOTAL_SLA/ASMT_ID shape MULTI_DC's
            // dynamic-sweep table uses (that one renders in the branch above).
            chartContainer.style.display = "none";
            const factoryTh = includesImports ? "<th>FACTORY_ID</th>" : "";
            thead.innerHTML = `<th>SKU_NBR</th><th>SUPPLIER</th>${factoryTh}<th>DC_COUNT</th><th>DC_LIST</th><th>ASMT_ID</th><th>TOTAL_EXPENSE</th>`;
            const colCount = includesImports ? 7 : 6;
            if (!rows.length) {
                tbody.innerHTML = `<tr><td colspan="${colCount}" style="text-align:center;color:#666;padding:20px">No results</td></tr>`;
                return;
            }
            for (const r of rows) {
                const tr = document.createElement("tr");
                const factoryTd = includesImports ? `<td>${r.FACTORY_ID || "—"}</td>` : "";
                tr.innerHTML = `
                    <td>${r.SKU_NBR || "—"}</td>
                    <td>${r.SUPPLIER || "—"}</td>
                    ${factoryTd}
                    <td>${r.ASSIGNED_DC_COUNT ?? "—"}</td>
                    <td>${r.DC_LIST || "—"}</td>
                    <td>${r.CAMP_ASMT_ID ?? "—"}</td>
                    <td style="text-align:right">${r.TOTAL_EXPENSE != null ? fmtNum(r.TOTAL_EXPENSE) : "—"}</td>
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
            } else if (singleDcCountAutoSelected) {
                // The actual count was already resolved back in
                // determineAssortment() (Step 6) via the group-run query —
                // reuse it rather than re-querying here.
                body.strategy = "SINGLE_DC";
                body.dc_counts = singleDcGroupChoice?.dc_count ? [singleDcGroupChoice.dc_count] : [];
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

    // Whatever this upload's THD key needs beyond THD_SKU_NBR (typically
    // MVNDR_NBR) — FINAL_ALLOCATIONS_WIDE has no such column itself, so
    // /api/results joins it in from EVENTS_SKU_LIST and reports which
    // column(s) it added here, since that's upload-specific and can't be a
    // fixed entry in RESULT_COLUMNS.
    let resultsExtraKeyCols = [];

    async function loadResultsTable() {
        try {
            const p = new URLSearchParams();
            p.set("page", resultsPage);
            p.set("page_size", PAGE_SIZE);
            p.set("sort", resultsSort);
            p.set("dir", resultsDir);
            const result = await api(`/api/results?${p}`);
            const total = result.total || 0;
            resultsExtraKeyCols = result.extra_key_cols || [];
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
        const base = includesImports ? RESULT_COLUMNS : RESULT_COLUMNS.filter(c => !FACTORY_ONLY_COLUMNS.includes(c.key));
        if (!resultsExtraKeyCols.length) return base;
        // Inserted right after SKU_DESC (not sortable — they come from a
        // joined table, not FINAL_ALLOCATIONS_WIDE itself).
        const descIdx = base.findIndex(c => c.key === "SKU_DESC");
        const extraCols = resultsExtraKeyCols.map(key => ({ key, label: KEY_FIELD_LABELS[key] || key, sortable: false }));
        return [...base.slice(0, descIdx + 1), ...extraCols, ...base.slice(descIdx + 1)];
    }

    function renderResultsTable(data) {
        const visibleColumns = getVisibleResultColumns();
        const headRow = $("#resultsHead");
        headRow.innerHTML = "";
        for (const col of visibleColumns) {
            const th = document.createElement("th");
            th.textContent = col.label;
            th.dataset.col = col.key;
            // Extra THD-key columns (e.g. MVNDR_NBR) come from a table
            // joined in for display only — FINAL_ALLOCATIONS_WIDE's own
            // ALLOWED_SORT_COLS has no entry for them, so sorting by one
            // would silently no-op server-side.
            if (col.sortable === false) {
                headRow.appendChild(th);
                continue;
            }
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
        setupStockTypeSplit();
        setupAsmtTool();
        setupStrategy();
        setupAllocation();
        setupExport();
    }

    document.addEventListener("DOMContentLoaded", init);
})();
