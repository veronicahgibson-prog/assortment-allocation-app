"""Prior-year event strategy lookups from the enterprise historical allocation
table (not this app's own CM_TEMP scratch tables) — EVENTS_SKU_DFC_ALLOCATIONS.
Backfilled with EVENT_NAME/EVENT_YEAR/IS_IMPORT this session; see
alter_events_dfc_allocations.sql for the schema history.
"""
import logging
from typing import Optional
from google.cloud import bigquery
from config import DC_NAMES, CAMPUS_PAIRS, EVENTS_SKU_LIST, VENDOR_STRATEGY

logger = logging.getLogger(__name__)

HISTORY_TABLE = "`analytics-df-thd.CM_STAGE.EVENTS_SKU_DFC_ALLOCATIONS`"

# Bulk DC -> main DC, same normalization determine_multi_dc_assortment.sql uses
# — folding before counting gives the count that matches how the team talks
# about "how many buildings," since a factory's raw DC_NBR count can overcount
# by exactly the number of campus pairs it touches (e.g. both Perris Bulk and
# Main appearing for different SKUs) even when the strategy conceptually
# treats that campus as one building.
#
# That fold is now conditional on PERRIS_CAMPUS_MERGED / LG_CAMPUS_MERGED
# (added via alter_events_dfc_allocations.sql) rather than unconditional: a row
# only folds bulk into main when its flag says the event actually treated that
# campus as one, so an event that ran the two buildings as genuinely separate
# DCs counts them as 2, not 1. Existing rows predate the flag and read back as
# NULL — COALESCE to TRUE there so historical counts already on record don't
# change until someone sets the real value for that event.
_CAMPUS_NORMALIZE_CASE = """CASE
    WHEN DC_NBR = 6006 AND COALESCE(PERRIS_CAMPUS_MERGED, TRUE) THEN 6007
    WHEN DC_NBR = 6705 AND COALESCE(LG_CAMPUS_MERGED, TRUE) THEN 6777
    ELSE DC_NBR
END"""

# The set of normalized DC numbers that represent a merged campus (the main
# side of each pair in CAMPUS_PAIRS) — used only to label them "(campus)" in
# the tier breakdown, consistent with how the rest of the app names them.
_CAMPUS_MAIN_DCS = set(CAMPUS_PAIRS.values())


def _dc_name(dc_nbr: int) -> str:
    base = DC_NAMES.get(dc_nbr, str(dc_nbr))
    return f"{base} (campus)" if dc_nbr in _CAMPUS_MAIN_DCS else base


def _dc_list_names(dc_list_key: str) -> str:
    return ", ".join(_dc_name(int(d)) for d in dc_list_key.split("-"))


def _load_vendor_strategy_rows(client: bigquery.Client) -> tuple:
    """VENDOR_ALIGNED_STRATEGY rows plus its OTHER fallback row, shared by every
    substring-match lookup below so they can't drift apart."""
    vs_rows = [dict(r) for r in client.query(
        f"SELECT VENDOR, ASMT_ID, DC_COUNT, DC_LIST, DC_NM_LIST FROM {VENDOR_STRATEGY}"
    ).result()]
    other = next((v for v in vs_rows if (v["VENDOR"] or "").upper() == "OTHER"), None)
    return vs_rows, other


def _match_vendor(vs_rows: list, other: Optional[dict], supplier: str) -> Optional[dict]:
    """The canonical VENDOR_ALIGNED_STRATEGY row for a raw supplier name, using
    the same substring rule as /api/match_vendor_strategy so every view of
    vendor identity in this app agrees. Falls back to the OTHER row when no
    vendor-specific strategy matches."""
    sup_upper = (supplier or "").upper().strip()
    match = next(
        (v for v in vs_rows if (v["VENDOR"] or "").upper().strip() in sup_upper),
        None,
    )
    return match or other


def _attach_vendor_strategy(client: bigquery.Client, supplier_rows) -> list:
    """Pair each supplier with its VENDOR_ALIGNED_STRATEGY row so the DC count
    and DC list shown are the vendor's aligned strategy, not whatever DCs the
    historical rows happened to touch."""
    vs_rows, other = _load_vendor_strategy_rows(client)

    out = []
    for r in supplier_rows:
        supplier = r.SUPPLIER
        # "Unknown" means the SKU never appeared in an uploaded list for this
        # event, so there's no supplier name to match on at all — distinct from
        # a real supplier that simply has no vendor-specific strategy.
        match = _match_vendor(vs_rows, other, supplier) if supplier != "Unknown" else None
        out.append({
            "supplier": supplier,
            "sku_count": r.SKU_COUNT,
            "vendor": match["VENDOR"] if match else None,
            "asmt_id": match["ASMT_ID"] if match else None,
            "dc_count": match["DC_COUNT"] if match else None,
            "dc_list": match["DC_LIST"] if match else None,
        })
    return out


def fetch_known_event_names(client: bigquery.Client) -> list:
    """The canonical event names already recorded in history — backs the Step 1
    dropdown so new entries stay consistent with existing ones (data
    governance) rather than fragmenting into near-duplicate free-text
    variants. Callers still allow a genuinely new name via an explicit
    'Other' option — this list is a governance aid, not a hard whitelist."""
    rows = list(client.query(f"""
        SELECT DISTINCT EVENT_NAME
        FROM {HISTORY_TABLE}
        WHERE EVENT_NAME IS NOT NULL
        ORDER BY EVENT_NAME
    """).result())
    return [r.EVENT_NAME for r in rows]


def fetch_prior_year_strategy(client: bigquery.Client, event_name: str, max_year: int, is_import: str = "") -> dict:
    """Look up the most recent recorded snapshot at or before max_year for
    this event. is_import: "true", "false", or "" (no filter). Returns
    {"found": False} if nothing matches, else {"found": True, "event_name",
    "event_year" (the actual year found, may be earlier than max_year if
    max_year itself has no data), "overall": {...}, "by_dc": [...]}.

    A "not found" result also carries "checked_year" (max_year) and
    "checked_type" ("domestic"/"import"/"") so the caller can name exactly
    what came up empty (e.g. "2027 Patio Domestic has no history") instead of
    a generic "Patio has no history." When the Domestic/Import toggle was
    actually applied (see is_import_filter below) and the *other* cohort has
    data at/before max_year, it also carries "fallback_available": True,
    "fallback_is_import", and "fallback_year" — enough for the caller to ask
    "did you mean Import?" and re-run this same lookup with that toggle
    flipped rather than reporting a false negative.
    """
    event_name = (event_name or "").strip().upper()
    checked_type = "import" if is_import == "true" else "domestic" if is_import == "false" else ""
    if not event_name:
        return {"found": False, "checked_year": max_year, "checked_type": checked_type}

    params = [
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("max_year", "INT64", max_year),
    ]
    # The caller's Domestic/Import toggle only disambiguates events that
    # actually carry both cohorts as populated rows (e.g. an event with real
    # import AND domestic records in the same year) — apply it in that case
    # so a Domestic request can't pick up import rows or vice versa. But for
    # an event where IS_IMPORT was never populated (every row NULL — true for
    # any event backfilled before this column existed, e.g. Halfway
    # Halloween/Halloween), filtering on TRUE/FALSE would match nothing and
    # silently report "no history" even though real history exists. So only
    # filter when the flag is actually in use for this event at/before the
    # requested year; otherwise ignore the toggle and return what's there.
    is_import_filter = ""
    flag_in_use = False
    if is_import in ("true", "false"):
        flag_populated_rows = list(client.query(f"""
            SELECT COUNT(*) AS n
            FROM {HISTORY_TABLE}
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR <= @max_year
              AND IS_IMPORT IS NOT NULL
        """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
        if flag_populated_rows[0].n > 0:
            flag_in_use = True
            is_import_filter = "AND IS_IMPORT = TRUE" if is_import == "true" else "AND IS_IMPORT = FALSE"

    year_rows = list(client.query(f"""
        SELECT MAX(EVENT_YEAR) AS latest_year
        FROM {HISTORY_TABLE}
        WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR <= @max_year {is_import_filter}
    """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    latest_year = year_rows[0].latest_year if year_rows else None
    if latest_year is None:
        result = {"found": False, "checked_year": max_year, "checked_type": checked_type, "event_name": event_name}
        if flag_in_use:
            opposite = "false" if is_import == "true" else "true"
            opposite_filter = "AND IS_IMPORT = TRUE" if opposite == "true" else "AND IS_IMPORT = FALSE"
            opposite_rows = list(client.query(f"""
                SELECT MAX(EVENT_YEAR) AS latest_year
                FROM {HISTORY_TABLE}
                WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR <= @max_year {opposite_filter}
            """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
            opposite_latest = opposite_rows[0].latest_year if opposite_rows else None
            if opposite_latest is not None:
                result["fallback_available"] = True
                result["fallback_is_import"] = opposite
                result["fallback_year"] = opposite_latest
        return result

    detail_params = params + [bigquery.ScalarQueryParameter("year", "INT64", latest_year)]
    detail_job_config = bigquery.QueryJobConfig(query_parameters=detail_params)

    # Self-heal PERRIS_CAMPUS_MERGED/LG_CAMPUS_MERGED the same way
    # STRATEGY_TYPE self-corrects further down, but sourced from EVENTS_SKU_LIST
    # instead of computed from the DC data itself — unlike STRATEGY_TYPE, the
    # campus-merge choice isn't derivable after the fact from what DCs a row
    # touched. This app has no write path of its own into HISTORY_TABLE at
    # submission time (an external process owns that table); the one place it
    # *does* capture the Step 2 "Treat Bulk Counterparts The Same" choice is
    # EVENTS_SKU_LIST, via _update_events_campus_pairs in app.py. So the choice
    # only reaches history once a later lookup like this one carries it over —
    # and only when history's own flags are still both NULL (never overwrites
    # a value someone already set directly on history).
    try:
        current_flags = list(client.query(f"""
            SELECT ANY_VALUE(PERRIS_CAMPUS_MERGED) AS perris, ANY_VALUE(LG_CAMPUS_MERGED) AS lg
            FROM {HISTORY_TABLE}
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        """, job_config=detail_job_config).result())
        if current_flags and current_flags[0].perris is None and current_flags[0].lg is None:
            list_flags = list(client.query(f"""
                SELECT ANY_VALUE(PERRIS_CAMPUS_MERGED) AS perris, ANY_VALUE(LG_CAMPUS_MERGED) AS lg
                FROM {EVENTS_SKU_LIST}
                WHERE EVENT_NAME = @event_name AND EVENT_YEAR = @year
            """, job_config=detail_job_config).result())
            if list_flags and (list_flags[0].perris is not None or list_flags[0].lg is not None):
                heal_jc = bigquery.QueryJobConfig(query_parameters=detail_params + [
                    bigquery.ScalarQueryParameter("perris", "BOOL", list_flags[0].perris),
                    bigquery.ScalarQueryParameter("lg", "BOOL", list_flags[0].lg),
                ])
                client.query(f"""
                    UPDATE {HISTORY_TABLE}
                    SET PERRIS_CAMPUS_MERGED = @perris, LG_CAMPUS_MERGED = @lg
                    WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
                """, job_config=heal_jc).result()
                logger.info(
                    "Backfilled PERRIS_CAMPUS_MERGED=%r / LG_CAMPUS_MERGED=%r for %s %s from EVENTS_SKU_LIST",
                    list_flags[0].perris, list_flags[0].lg, event_name, latest_year,
                )
    except Exception:
        logger.exception("Failed to backfill campus-merge flags for %s %s", event_name, latest_year)

    # SKU identity: prefer THD_SKU_NBR, but some historical years (confirmed:
    # all 810 Patio 2026 rows) never had it populated at all — only SKU_NBR
    # is reliably present there. COALESCE to SKU_NBR rather than let the whole
    # composite key go NULL (which COUNT(DISTINCT ...) then silently drops,
    # undercounting to 0 instead of falling back).
    _sku_key = "COALESCE(THD_SKU_NBR, SKU_NBR)"

    # THD key: the combination of fields that made the originally-uploaded SKU
    # list distinct, before it was fanned out by DC_NBR — mirrors
    # _determine_thd_key in validators.py, which starts from THD_SKU_NBR and
    # dynamically adds MVNDR_NBR/FACTORY_ID/SUPPLIER/SKU_DESC/BP/BUY_UNITS/
    # WAVE_1..5, one at a time, only as needed to make rows distinct. That
    # incremental search can't be replicated here: it runs against the
    # pre-fan-out upload rows, which history never preserved — only the
    # DC-fanned result. The best available approximation is to use every
    # candidate column the history table actually has (FACTORY_ID, SUPPLIER,
    # SKU_DESC, BP, LOAD_IN_UNITS — the closest analog history has to the
    # upload's BUY_UNITS) unconditionally; for a genuine single record these
    # are constant across its DC rows, so including them doesn't over-split
    # versus the true minimal key. What this can NOT recover is a record
    # whose only real-world disambiguator was MVNDR_NBR — that column was
    # never captured on this table, so two such records are permanently
    # indistinguishable in history and will still be undercounted as one.
    # Confirmed on real data: SKU 1013313665 in Halloween 2026 is actually two
    # separate records (different SKU_DESC) that followed a 6-DC and an 8-DC
    # strategy respectively — a SKU_NBR+FACTORY_ID-only key silently merged
    # them into one record with an inflated, meaningless DC count. SUPPLIER is
    # normalized (trim/upper) before joining in, since this table is known to
    # carry casing variants of the same real vendor (e.g. "DEWALT" vs
    # "Dewalt") that would otherwise cause spurious over-splitting. Validated
    # by checking DFC_PCT sums to ~1.0 per key across all of Halloween 2026
    # (82/83 keys exactly, the 83rd off by 0.01 — floating-point noise, not a
    # merge) and that LOAD_IN_UNITS never varies within a key for that event.
    _thd_key_expr = (
        f"CONCAT({_sku_key}, '|', COALESCE(CAST(FACTORY_ID AS STRING), 'NA'), "
        "'|', COALESCE(UPPER(TRIM(SUPPLIER)), 'NA'), "
        "'|', COALESCE(SKU_DESC, 'NA'), '|', COALESCE(BP, 'NA'), "
        "'|', COALESCE(CAST(LOAD_IN_UNITS AS STRING), 'NA'))"
    )

    overall_rows = list(client.query(f"""
        WITH factory_dc AS (
          SELECT THD_SKU_NBR, SKU_NBR, FACTORY_ID, SUPPLIER, SKU_DESC, BP, LOAD_IN_UNITS,
                 STRATEGY_TYPE, DFC_UNITS, DFC_CUBE, PERRIS_CAMPUS_MERGED, LG_CAMPUS_MERGED,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        )
        SELECT ANY_VALUE(STRATEGY_TYPE) AS strategy_type,
               SUM(DFC_UNITS) AS total_units, SUM(DFC_CUBE) AS total_cube,
               COUNT(DISTINCT {_thd_key_expr}) AS distinct_thd_keys,
               COUNT(DISTINCT NORMALIZED_DC_NBR) AS normalized_dc_count,
               ANY_VALUE(PERRIS_CAMPUS_MERGED) AS perris_campus_merged,
               ANY_VALUE(LG_CAMPUS_MERGED) AS locust_grove_campus_merged
        FROM factory_dc
    """, job_config=detail_job_config).result())

    # DC Counts: for a non-vendor-aligned strategy, "how many DCs" isn't one
    # number for the whole event — different THD keys (SKU/factory records)
    # can legitimately be assigned to different numbers of DCs (e.g. Halloween
    # 2026 mixes keys assigned to anywhere from 2 to 12 DCs). The single
    # overall.normalized_dc_count above is the total distinct DCs touched
    # across *every* key, which overcounts what any individual key actually
    # used (it wrongly read as 13 for Halloween 2026). This computes the
    # distinct set of per-key DC counts instead, so a single-count event
    # (e.g. Halfway Halloween, always 5 DCs per key) reports just [5], while
    # a mixed event reports every distinct count actually used.
    key_dc_count_rows = list(client.query(f"""
        WITH factory_dc AS (
          SELECT THD_SKU_NBR, SKU_NBR, FACTORY_ID, SUPPLIER, SKU_DESC, BP, LOAD_IN_UNITS,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        ),
        per_key AS (
          SELECT {_thd_key_expr} AS THD_KEY,
                 COUNT(DISTINCT NORMALIZED_DC_NBR) AS DC_COUNT
          FROM factory_dc
          GROUP BY THD_KEY
        )
        SELECT DISTINCT DC_COUNT FROM per_key ORDER BY DC_COUNT
    """, job_config=detail_job_config).result())
    dc_counts_by_key = [r.DC_COUNT for r in key_dc_count_rows]

    # Evidence for the campus-merge guess used when PERRIS_CAMPUS_MERGED/
    # LG_CAMPUS_MERGED is NULL (never recorded): whether any single
    # key's own RAW (pre-fold) DC list contains *both* the bulk and main DC of
    # a pair. That's the one scenario where merging actually matters — a
    # key's inventory legitimately spilling across both buildings inflates
    # its raw DC count by one unless they're folded together. Merely "the
    # main DC number appears somewhere in the event" (the old guess) proves
    # nothing on its own: different keys can just as easily have been routed
    # to the bulk building for some SKUs and the main building for others,
    # with no key ever touching both — confirmed on HALFWAY HALLOWEEN 2024,
    # where every key had exactly 3 distinct raw DCs and Perris Bulk/Main
    # never co-occurred within one key, only across different keys.
    cooccur_rows = list(client.query(f"""
        WITH factory_dc_raw AS (
          SELECT {_thd_key_expr} AS THD_KEY, DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        ),
        per_key_raw AS (
          SELECT THD_KEY,
                 LOGICAL_OR(DC_NBR = 6006) AND LOGICAL_OR(DC_NBR = 6007) AS PERRIS_COOCCURS,
                 LOGICAL_OR(DC_NBR = 6705) AND LOGICAL_OR(DC_NBR = 6777) AS LG_COOCCURS
          FROM factory_dc_raw
          GROUP BY THD_KEY
        )
        SELECT LOGICAL_OR(PERRIS_COOCCURS) AS perris_cooccurs, LOGICAL_OR(LG_COOCCURS) AS lg_cooccurs
        FROM per_key_raw
    """, job_config=detail_job_config).result())
    perris_cooccurs_evidence = bool(cooccur_rows[0].perris_cooccurs) if cooccur_rows else False
    lg_cooccurs_evidence = bool(cooccur_rows[0].lg_cooccurs) if cooccur_rows else False

    # Pull the stored value, then independently recompute it live from the
    # per-key DC counts (dc_counts_by_key, just computed above — already the
    # DISTINCT set of counts used across the whole event) and use that as the
    # confirmation check — for a non-vendor-aligned event, every key landing
    # on the same DC count (dc_counts_by_key has exactly one value, whatever
    # that number is — e.g. always 5) -> SINGLE-DC COUNT; two keys landing on
    # different counts from each other (dc_counts_by_key has more than one
    # value) -> MULTI-DC COUNT. "COUNT" is deliberate: "SINGLE-DC" alone reads
    # as "always the same one DC," when it actually means every key's *count*
    # of DCs happened to be the same — that shared count could just as easily
    # have been 5 as 1.
    strategy_type = overall_rows[0].strategy_type
    is_vendor_aligned = bool(strategy_type) and strategy_type.upper() == "VENDOR-ALIGNED"

    computed_strategy_type = None
    if not is_vendor_aligned and dc_counts_by_key:
        computed_strategy_type = "SINGLE-DC COUNT" if len(dc_counts_by_key) <= 1 else "MULTI-DC COUNT"

    if is_vendor_aligned:
        display_strategy_type = strategy_type
    elif computed_strategy_type:
        # The stored value should never disagree with what the DC data
        # actually shows — if it does (a stale/incorrect backfill, a future
        # write that got it wrong, or it was never set), correct
        # EVENTS_SKU_DFC_ALLOCATIONS right here rather than just displaying
        # the right answer this one time and leaving the table wrong for the
        # next reader (or a downstream consumer outside this app).
        stored = (strategy_type or "").upper()
        if stored != computed_strategy_type:
            if stored:
                logger.warning(
                    "STRATEGY_TYPE mismatch for %s %s: stored=%r, computed from DC counts=%r — correcting the historical table",
                    event_name, latest_year, strategy_type, computed_strategy_type,
                )
            else:
                logger.info(
                    "STRATEGY_TYPE was unset for %s %s — setting it to %r from DC counts",
                    event_name, latest_year, computed_strategy_type,
                )
            try:
                update_jc = bigquery.QueryJobConfig(query_parameters=[
                    bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
                    bigquery.ScalarQueryParameter("year", "INT64", latest_year),
                    bigquery.ScalarQueryParameter("computed", "STRING", computed_strategy_type),
                ])
                client.query(f"""
                    UPDATE {HISTORY_TABLE}
                    SET STRATEGY_TYPE = @computed
                    WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
                """, job_config=update_jc).result()
            except Exception:
                # Don't let a correction failure (e.g. a concurrent DML quota
                # hit) break the lookup the user is actually waiting on — the
                # computed value below is still correct for this response;
                # it just won't have been persisted this time.
                logger.exception(
                    "Failed to correct STRATEGY_TYPE for %s %s", event_name, latest_year,
                )
        display_strategy_type = computed_strategy_type
    else:
        display_strategy_type = strategy_type

    strategy_summary = []
    if strategy_type and strategy_type.upper() == "VENDOR-ALIGNED":
        # Raw SUPPLIER text in the history table has near-duplicate casing
        # variants for the same real vendor (e.g. "DEWALT" vs "Dewalt") — group
        # by DC_NBR/THD key per raw supplier first, then collapse onto the
        # canonical VENDOR_ALIGNED_STRATEGY name below so those variants merge
        # into one row instead of showing up as separate "vendors."
        vendor_rows = client.query(f"""
            SELECT SUPPLIER,
                   ARRAY_AGG(DISTINCT DC_NBR) AS dc_nbrs,
                   COUNT(DISTINCT {_thd_key_expr}) AS thd_key_count
            FROM {HISTORY_TABLE}
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
              AND SUPPLIER IS NOT NULL
            GROUP BY SUPPLIER
        """, job_config=detail_job_config).result()

        vs_rows, other = _load_vendor_strategy_rows(client)
        by_vendor = {}
        for r in vendor_rows:
            match = _match_vendor(vs_rows, other, r.SUPPLIER)
            vendor_name = (match["VENDOR"] if match else r.SUPPLIER).upper().strip()
            entry = by_vendor.setdefault(vendor_name, {"dc_nbrs": set(), "thd_key_count": 0})
            entry["dc_nbrs"].update(r.dc_nbrs or [])
            entry["thd_key_count"] += r.thd_key_count

        # A second collapse: distinct vendors whose aligned strategy happens to
        # land on the identical DC list are shown as one row, vendor names
        # comma-joined alphabetically — the DC list is the primary grouping key
        # the requester wants surfaced first, not the vendor name.
        by_dc_list = {}
        for vendor_name, entry in by_vendor.items():
            dc_list = ", ".join(str(d) for d in sorted(entry["dc_nbrs"]))
            row = by_dc_list.setdefault(dc_list, {"dc_count": len(entry["dc_nbrs"]), "vendors": [], "thd_key_count": 0})
            row["vendors"].append(vendor_name)
            row["thd_key_count"] += entry["thd_key_count"]

        strategy_summary = [{
            "dc_list": dc_list,
            "dc_name_list": ", ".join(_dc_name(int(d)) for d in dc_list.split(", ")) if dc_list else "",
            "dc_count": row["dc_count"],
            "vendor": ", ".join(sorted(row["vendors"])),
            "thd_key_count": row["thd_key_count"],
        } for dc_list, row in sorted(by_dc_list.items(), key=lambda kv: (-kv[1]["dc_count"], kv[1]["vendors"]))]
    elif strategy_type:
        asmt_rows = client.query(f"""
            SELECT ASMT_ID AS asmt_id,
                   COUNT(DISTINCT DC_NBR) AS dc_count,
                   ARRAY_TO_STRING(ARRAY_AGG(DISTINCT CAST(DC_NBR AS STRING) ORDER BY CAST(DC_NBR AS STRING)), ', ') AS dc_list
            FROM {HISTORY_TABLE}
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
              AND ASMT_ID IS NOT NULL
            GROUP BY ASMT_ID
            ORDER BY ASMT_ID
        """, job_config=detail_job_config).result()
        strategy_summary = [{
            "asmt_id": r.asmt_id,
            "dc_count": r.dc_count,
            "dc_list": r.dc_list,
        } for r in asmt_rows]

    by_dc_rows = list(client.query(f"""
        SELECT DC_NBR, ANY_VALUE(DC_NAME) AS DC_NAME,
               SUM(DFC_UNITS) AS DC_UNITS, SUM(DFC_CUBE) AS DC_CUBE,
               COUNT(DISTINCT {_thd_key_expr}) AS DC_DISTINCT_THD_KEYS
        FROM {HISTORY_TABLE}
        WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        GROUP BY DC_NBR
        ORDER BY DC_UNITS DESC
    """, job_config=detail_job_config).result())

    # Tier-level strategy — one row per (DC-count tier, individual DC), not a
    # flat DC rollup and not a tier row with names collapsed into one string.
    # Units/cube per row are summed only across factories following that
    # tier's canonical (most-common) DC combination, so a variant outlier
    # factory's volume doesn't contaminate another combination's totals.
    # Only meaningful where FACTORY_ID exists (import strategies); a domestic
    # event has no per-factory tier concept, so this comes back empty for
    # those, not an error.
    tier_dc_rows = list(client.query(f"""
        WITH factory_dc AS (
          SELECT FACTORY_ID, STRATEGY_TYPE, DFC_UNITS, DFC_CUBE,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
            AND FACTORY_ID IS NOT NULL
        ),
        factory_list AS (
          SELECT FACTORY_ID, ANY_VALUE(STRATEGY_TYPE) AS STRATEGY_TYPE,
                 COUNT(DISTINCT NORMALIZED_DC_NBR) AS DC_COUNT,
                 ARRAY_TO_STRING(
                   ARRAY_AGG(DISTINCT CAST(NORMALIZED_DC_NBR AS STRING) ORDER BY CAST(NORMALIZED_DC_NBR AS STRING)),
                   '-'
                 ) AS DC_LIST_KEY
          FROM factory_dc
          GROUP BY FACTORY_ID
        ),
        tier_lists AS (
             SELECT STRATEGY_TYPE, DC_COUNT, DC_LIST_KEY, COUNT(*) AS N_FACTORIES,
                      ROW_NUMBER() OVER (PARTITION BY STRATEGY_TYPE, DC_COUNT ORDER BY COUNT(*) DESC, DC_LIST_KEY) AS rn,
                      COUNT(*) OVER (PARTITION BY STRATEGY_TYPE, DC_COUNT) AS n_variants
          FROM factory_list
          GROUP BY STRATEGY_TYPE, DC_COUNT, DC_LIST_KEY
        ),
        canonical AS (
          SELECT STRATEGY_TYPE, DC_COUNT, DC_LIST_KEY, N_FACTORIES, n_variants
          FROM tier_lists WHERE rn = 1
        )
            SELECT c.STRATEGY_TYPE, c.DC_COUNT, c.N_FACTORIES, c.n_variants, fd.NORMALIZED_DC_NBR AS DC_NBR,
               SUM(fd.DFC_UNITS) AS UNITS, SUM(fd.DFC_CUBE) AS TOTAL_CUBE
                FROM canonical c
                JOIN factory_list fl ON fl.STRATEGY_TYPE IS NOT DISTINCT FROM c.STRATEGY_TYPE
                    AND fl.DC_COUNT = c.DC_COUNT AND fl.DC_LIST_KEY = c.DC_LIST_KEY
        JOIN factory_dc fd ON fd.FACTORY_ID = fl.FACTORY_ID
            GROUP BY c.STRATEGY_TYPE, c.DC_COUNT, c.N_FACTORIES, c.n_variants, fd.NORMALIZED_DC_NBR
        ORDER BY c.DC_COUNT DESC, UNITS DESC
    """, job_config=detail_job_config).result())

    tier_strategy = []
    for r in tier_dc_rows:
        tier_strategy.append({
            "dc_count": r.DC_COUNT,
            "strategy": r.STRATEGY_TYPE,
            # Y whenever this DC is the "main" side of a campus pair. NORMALIZED_DC_NBR
            # (and therefore whether this row even folds to the main DC at all)
            # now honors PERRIS_CAMPUS_MERGED/LG_CAMPUS_MERGED per
            # _CAMPUS_NORMALIZE_CASE above, but this label itself still just
            # reports which side of the pair the row landed on, not the
            # underlying flag value.
            "campus_pair": "Y" if r.DC_NBR in _CAMPUS_MAIN_DCS else "N/A",
            "dc_nbr": r.DC_NBR,
            "dc_name": _dc_name(r.DC_NBR),
            "units": r.UNITS,
            "cube": r.TOTAL_CUBE,
            "n_factories": r.N_FACTORIES,
            "has_variants": r.n_variants > 1,
        })

    # Supplier-level strategy. The history table carries no supplier of its own
    # and its ASMT_ID is NULL for every backfilled row, so there's no way to
    # reach VENDOR_ALIGNED_STRATEGY from history directly — the supplier name
    # has to come from this app's own uploaded SKU list for the same event and
    # year, and is then matched to a vendor strategy by name.
    # SAFE_CAST because the history SKU columns are STRING and genuinely
    # contain non-numeric junk (e.g. "Onboarding"); a plain CAST errors the
    # whole query out on those rows.
    supplier_sku_rows = list(client.query(f"""
        WITH hist AS (
          SELECT SAFE_CAST({_sku_key} AS INT64) AS SKU_INT,
                 {_thd_key_expr} AS THD_KEY
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        ),
        -- Keyed on THD_SKU_NBR only, never SKU_NBR: EVENTS_SKU_LIST sets
        -- SKU_NBR to the SISTER_SKU_NBR proxy for every net-new/sister row
        -- (see _build_insert_query), so the same SKU_NBR can be shared by
        -- dozens of genuinely distinct SKUs/suppliers borrowing that proxy's
        -- cube — joining on it as if it were an identity collapses all of
        -- them onto one arbitrary, non-deterministic ANY_VALUE(SUPPLIER).
        -- THD_SKU_NBR is a required upload field, so it's always populated
        -- here and needs no fallback (unlike the history table's SKU key).
        sku_supplier AS (
          SELECT THD_SKU_NBR AS sku, ANY_VALUE(SUPPLIER) AS SUPPLIER
          FROM {EVENTS_SKU_LIST}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year
            AND SUPPLIER IS NOT NULL AND THD_SKU_NBR IS NOT NULL
          GROUP BY THD_SKU_NBR
        )
        SELECT COALESCE(s.SUPPLIER, 'Unknown') AS SUPPLIER,
               COUNT(DISTINCT h.THD_KEY) AS SKU_COUNT
        FROM hist h
        LEFT JOIN sku_supplier s ON h.SKU_INT = s.sku
        GROUP BY SUPPLIER
        ORDER BY SKU_COUNT DESC, SUPPLIER
    """, job_config=detail_job_config).result())

    by_supplier = _attach_vendor_strategy(client, supplier_sku_rows)

    o = overall_rows[0]
    return {
        "found": True,
        "event_name": event_name,
        "event_year": latest_year,
        # Whether IS_IMPORT was actually populated (and therefore actually
        # applied as a filter) for this event at/before max_year — see
        # is_import_filter above. False means every row is IS_IMPORT NULL
        # (any event backfilled before that column existed, e.g. Halfway
        # Halloween), so the caller's Domestic/Import toggle was silently
        # ignored rather than filtering out real data. The frontend uses this
        # to decide whether "DOMESTIC"/"IMPORT" means anything for this
        # specific event/year, rather than just echoing back whichever toggle
        # position happened to be selected when the lookup ran.
        "is_import_known": flag_in_use,
        "overall": {
            "strategy_type": display_strategy_type,
            "total_units": o.total_units,
            "total_cube": o.total_cube,
            "distinct_thd_keys": o.distinct_thd_keys,
            "normalized_dc_count": o.normalized_dc_count,
            "dc_counts_by_key": dc_counts_by_key,
            # NULL means unknown (this event predates the flag, or it was
            # never set) — the frontend falls back to perris/lg_cooccurs_evidence
            # in that case. Only a real TRUE/FALSE here reflects an actual
            # recorded choice, from either a direct edit to history or the
            # self-heal above.
            "perris_campus_merged": o.perris_campus_merged,
            "locust_grove_campus_merged": o.locust_grove_campus_merged,
            # Only a real signal for the merge guess (see cooccur_rows above):
            # True means some key's raw DC list actually contained both the
            # bulk and main DC of that pair, so merging avoids inflating that
            # key's DC count. False means no key ever needed it — different
            # keys may still have used the bulk and main DCs separately, which
            # proves nothing either way about whether they were "meant" to be
            # one campus, just that nothing in the count depends on it.
            "perris_cooccurs_evidence": perris_cooccurs_evidence,
            "locust_grove_cooccurs_evidence": lg_cooccurs_evidence,
        },
        "tier_strategy": tier_strategy,
        "strategy_summary": strategy_summary,
        "by_supplier": by_supplier,
        "by_dc": [
            {
                "dc_nbr": r.DC_NBR,
                "dc_name": r.DC_NAME,
                "units": r.DC_UNITS,
                "cube": r.DC_CUBE,
                "distinct_thd_keys": r.DC_DISTINCT_THD_KEYS,
            }
            for r in by_dc_rows
        ],
    }
