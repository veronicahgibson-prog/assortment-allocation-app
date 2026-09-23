"""Assortment ID determination logic per strategy."""

import logging
import os
from google.cloud import bigquery
from config import (
    CATALOG_RUN_ANALYTICS, VENDOR_STRATEGY, EVENTS_SKU_LIST,
    DEFAULT_FALLBACK_ASMT_ID, CONTAINER_DIVISOR, CAMPUS_PAIRS,
    PROJECT_ID, DATASET, TEMP_DATASET, DC_NAMES,
    ASSORTMENT_DC_COVERAGE_GAPS, RESOLVE_PROBLEM_SKU_PROC, SKU_DC_ELIGIBILITY,
)

logger = logging.getLogger(__name__)

CAMPUS_INFO = {
    "perris": {"bulk": 6006, "main": 6007},
    "locust_grove": {"bulk": 6705, "main": 6777},
}

# check_dc_selection_eligibility's query body — a standalone .sql file (not a
# BigQuery stored procedure) since it's run as an ad-hoc multi-statement
# script directly from this app, the same way check_vendor_dc_eligibility's
# own DECLARE/IF preamble already is.
_DC_SELECTION_PREVIEW_SQL_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "dc_selection_eligibility_preview.sql"
)


def _normalize_dc(dc: int) -> int:
    """Normalize campus-paired DCs to their main facility."""
    return CAMPUS_PAIRS.get(dc, dc)


def _normalize_dc_list(dc_list: list[int]) -> set[int]:
    return {_normalize_dc(d) for d in dc_list}


def determine_assortment_ids(client: bigquery.Client, strategy: str, params: dict) -> dict:
    """Dispatch to the correct strategy handler. Returns {results: [...], error: str|None}."""
    handlers = {
        "VENDOR_ALIGNED": _vendor_aligned,
        "SINGLE_DC": _dc_count_single,
        "MULTI_DC": _multi_dc,
        "DC_COUNT_SINGLE": _dc_count_single,
        "DC_COUNT_MULTI_DOMESTIC": _dc_count_multi_domestic,
        "DC_COUNT_MULTI_IMPORT": _dc_count_multi_import,
        "DC_COUNT_MULTI_DOMESTIC_UNDEF": _dc_count_multi_domestic_undef,
        "DC_COUNT_MULTI_IMPORT_UNDEF": _dc_count_multi_import_undef,
    }
    handler = handlers.get(strategy)
    if not handler:
        return {"results": [], "error": f"Unknown strategy: {strategy}"}
    try:
        return handler(client, params)
    except Exception as e:
        logger.exception("Assortment determination error")
        return {"results": [], "error": str(e)}


def _vendor_aligned(client: bigquery.Client, params: dict) -> dict:
    vendor_matches = params.get("vendor_matches", [])

    if not vendor_matches:
        return {"results": [], "error": "No vendor matches provided. Run Match first."}

    # Sum each matched supplier's own distinct-THD-key SKU_COUNT per vendor —
    # multiple suppliers can map to the same vendor bucket, so counting match
    # rows (1 per supplier) instead of summing SKU_COUNT undercounts whenever
    # a supplier has more than one THD key.
    vendor_counts = {}
    for m in vendor_matches:
        vendor = m["VENDOR"]
        if vendor not in vendor_counts:
            vendor_counts[vendor] = {"count": 0, "data": m}
        vendor_counts[vendor]["count"] += int(m.get("SKU_COUNT", 0) or 0)

    results = []
    for vendor, info in vendor_counts.items():
        m = info["data"]
        results.append({
            "VENDOR": vendor,
            "ASMT_ID": m["ASMT_ID"],
            "DC_COUNT": m["DC_COUNT"],
            "DC_LIST": m.get("DC_LIST", ""),
            "DC_NM_LIST": m.get("DC_NM_LIST", ""),
            "SKU_COUNT": info["count"],
        })

    return {"results": results, "strategy_type": "VENDOR_ALIGNED", "error": None}


def _dc_count_single(client: bigquery.Client, params: dict) -> dict:
    camp_asmt_id = int(params["camp_asmt_id"])
    event_name = params["event_name"]
    run_id = params.get("dc_count_run_id", "")
    sku_grp = params.get("dc_count_sku_grp", "")

    query = f"""
        WITH skus AS (
            SELECT SKU_NBR, SUPPLIER, FACTORY_ID
            FROM {EVENTS_SKU_LIST}
            WHERE EVENT_NAME = @event_name
        ),
        catalog AS (
            SELECT CAMP_ASMT_ID,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp AND CAMP_ASMT_ID = @asmt_id
            GROUP BY CAMP_ASMT_ID
        )
        SELECT
            s.SKU_NBR, s.SUPPLIER, s.FACTORY_ID,
            CAST(NULL AS INT64) AS ASSIGNED_DC_COUNT,
            @asmt_id AS CAMP_ASMT_ID,
            c.DC_LIST,
            c.TOTAL_EXPENSE
        FROM skus s
        CROSS JOIN catalog c
        ORDER BY s.SKU_NBR
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("asmt_id", "INT64", camp_asmt_id),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    for r in rows:
        if r.get("DC_LIST"):
            r["DC_LIST"] = ", ".join(str(d) for d in sorted(r["DC_LIST"]))
    return {"results": rows, "error": None}


def _dc_count_multi_domestic(client: bigquery.Client, params: dict) -> dict:
    """Per THD Key: lowest TOTAL_EXPENSE across defined DC counts; validate cascade.

    Coverage fallback: a SKU with no priced option at all among the requested
    dc_counts previously resolved to a silent NULL row (unmapped, with no
    visibility). Now it automatically falls back to its own absolute-cheapest
    option across ANY DC count -- the same coverage-gate-then-fallback pattern
    used on the import side, adapted to domestic's per-SKU-independent model
    (there's no single shared list per tier here to gate on; the equivalent
    gap is a SKU with zero priced rows in the requested range at all).
    USED_FALLBACK flags which rows needed it, for visibility.
    """
    run_id = params["dc_count_run_id"]
    sku_grp = params["dc_count_sku_grp"]
    event_name = params["event_name"]
    dc_counts = params.get("dc_counts", [])
    dc_counts_str = ",".join(str(d) for d in dc_counts)

    query = f"""
        WITH skus AS (
            SELECT SKU_NBR, SUPPLIER, FACTORY_ID, THD_SKU_NBR
            FROM {EVENTS_SKU_LIST}
            WHERE EVENT_NAME = @event_name
        ),
        catalog_in_range AS (
            SELECT CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
              AND DC_COUNT IN UNNEST(@dc_counts)
            GROUP BY CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT
        ),
        primary_choice AS (
            SELECT * EXCEPT(rn) FROM (
                SELECT c.*,
                       ROW_NUMBER() OVER (PARTITION BY c.THD_SKU_NBR ORDER BY c.TOTAL_EXPENSE ASC) AS rn
                FROM catalog_in_range c
            ) WHERE rn = 1
        ),
        catalog_any AS (
            SELECT CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
              AND THD_SKU_NBR NOT IN (SELECT THD_SKU_NBR FROM primary_choice)
            GROUP BY CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT
        ),
        fallback_choice AS (
            SELECT * EXCEPT(rn) FROM (
                SELECT c.*,
                       ROW_NUMBER() OVER (PARTITION BY c.THD_SKU_NBR ORDER BY c.TOTAL_EXPENSE ASC) AS rn
                FROM catalog_any c
            ) WHERE rn = 1
        ),
        resolved AS (
            SELECT *, FALSE AS USED_FALLBACK FROM primary_choice
            UNION ALL
            SELECT *, TRUE AS USED_FALLBACK FROM fallback_choice
        )
        SELECT
            s.SKU_NBR, s.SUPPLIER, s.FACTORY_ID,
            r.DC_COUNT AS ASSIGNED_DC_COUNT,
            r.CAMP_ASMT_ID,
            r.DC_LIST,
            r.TOTAL_EXPENSE,
            COALESCE(r.USED_FALLBACK, FALSE) AS USED_FALLBACK
        FROM skus s
        LEFT JOIN resolved r ON s.THD_SKU_NBR = r.THD_SKU_NBR
        ORDER BY s.SUPPLIER, s.SKU_NBR
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
        bigquery.ArrayQueryParameter("dc_counts", "INT64", [int(d) for d in dc_counts]),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    for r in rows:
        if r.get("DC_LIST"):
            r["DC_LIST"] = ", ".join(str(d) for d in sorted(r["DC_LIST"]))
    return {"results": rows, "error": None}


def _dc_count_multi_import(client: bigquery.Client, params: dict) -> dict:
    """Per factory: assign DC count by container thresholds; lowest expense; cascade."""
    run_id = params["dc_count_run_id"]
    sku_grp = params["dc_count_sku_grp"]
    event_name = params["event_name"]
    dc_counts = params.get("dc_counts", [])

    query = f"""
        WITH skus AS (
            SELECT SKU_NBR, SUPPLIER, FACTORY_ID, THD_SKU_NBR, ITEM_CUBE, BUY_UNITS
            FROM {EVENTS_SKU_LIST}
            WHERE EVENT_NAME = @event_name
        ),
        factory_containers AS (
            SELECT FACTORY_ID,
                   SUM(ITEM_CUBE * BUY_UNITS) / {CONTAINER_DIVISOR} AS FACTORY_CONTAINERS
            FROM skus
            GROUP BY FACTORY_ID
        ),
        factory_dc AS (
            SELECT FACTORY_ID, FACTORY_CONTAINERS,
                   CASE
                       WHEN CEIL(FACTORY_CONTAINERS) >= 10 THEN 10
                       WHEN CEIL(FACTORY_CONTAINERS) >= 9  THEN 9
                       WHEN CEIL(FACTORY_CONTAINERS) >= 8  THEN 8
                       WHEN CEIL(FACTORY_CONTAINERS) >= 5  THEN 5
                       ELSE 2
                   END AS ASSIGNED_DC_COUNT
            FROM factory_containers
        ),
        catalog AS (
            SELECT CAMP_ASMT_ID, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
              AND DC_COUNT IN UNNEST(@dc_counts)
            GROUP BY CAMP_ASMT_ID, DC_COUNT
        ),
        best_asmt AS (
            SELECT c.*, fd.FACTORY_ID,
                   ROW_NUMBER() OVER (PARTITION BY fd.FACTORY_ID ORDER BY c.TOTAL_EXPENSE ASC) AS rn
            FROM factory_dc fd
            JOIN catalog c ON c.DC_COUNT = fd.ASSIGNED_DC_COUNT
        )
        SELECT
            s.SKU_NBR, s.SUPPLIER, s.FACTORY_ID,
            fd.ASSIGNED_DC_COUNT,
            ba.CAMP_ASMT_ID,
            ba.DC_LIST,
            ba.TOTAL_EXPENSE
        FROM skus s
        JOIN factory_dc fd ON s.FACTORY_ID = fd.FACTORY_ID
        LEFT JOIN best_asmt ba ON ba.FACTORY_ID = s.FACTORY_ID AND ba.rn = 1
        ORDER BY s.FACTORY_ID, s.SKU_NBR
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
        bigquery.ArrayQueryParameter("dc_counts", "INT64", [int(d) for d in dc_counts]),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    for r in rows:
        if r.get("DC_LIST"):
            r["DC_LIST"] = ", ".join(str(d) for d in sorted(r["DC_LIST"]))
    return {"results": rows, "error": None}


def _dc_count_multi_domestic_undef(client: bigquery.Client, params: dict) -> dict:
    """Per SKU: absolute lowest TOTAL_EXPENSE regardless of DC count."""
    run_id = params["dc_count_run_id"]
    sku_grp = params["dc_count_sku_grp"]
    event_name = params["event_name"]

    query = f"""
        WITH skus AS (
            SELECT SKU_NBR, SUPPLIER, FACTORY_ID, THD_SKU_NBR
            FROM {EVENTS_SKU_LIST}
            WHERE EVENT_NAME = @event_name
        ),
        catalog AS (
            SELECT CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
            GROUP BY CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT
        ),
        ranked AS (
            SELECT c.*,
                   ROW_NUMBER() OVER (PARTITION BY c.THD_SKU_NBR ORDER BY c.TOTAL_EXPENSE ASC) AS rn
            FROM catalog c
        )
        SELECT
            s.SKU_NBR, s.SUPPLIER, s.FACTORY_ID,
            r.DC_COUNT AS ASSIGNED_DC_COUNT,
            r.CAMP_ASMT_ID,
            r.DC_LIST,
            r.TOTAL_EXPENSE
        FROM skus s
        LEFT JOIN ranked r ON s.THD_SKU_NBR = r.THD_SKU_NBR AND r.rn = 1
        ORDER BY s.SUPPLIER, s.SKU_NBR
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    for r in rows:
        if r.get("DC_LIST"):
            r["DC_LIST"] = ", ".join(str(d) for d in sorted(r["DC_LIST"]))
    return {"results": rows, "error": None}


def _dc_count_multi_import_undef(client: bigquery.Client, params: dict) -> dict:
    """Per factory: lowest cost assortment per SKU → aggregate → choose lowest; cascade."""
    run_id = params["dc_count_run_id"]
    sku_grp = params["dc_count_sku_grp"]
    event_name = params["event_name"]

    query = f"""
        WITH skus AS (
            SELECT SKU_NBR, SUPPLIER, FACTORY_ID, THD_SKU_NBR, ITEM_CUBE, BUY_UNITS
            FROM {EVENTS_SKU_LIST}
            WHERE EVENT_NAME = @event_name
        ),
        catalog AS (
            SELECT CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
            GROUP BY CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT
        ),
        sku_best AS (
            SELECT c.*,
                   ROW_NUMBER() OVER (PARTITION BY c.THD_SKU_NBR ORDER BY c.TOTAL_EXPENSE ASC) AS rn
            FROM catalog c
        ),
        factory_agg AS (
            SELECT s.FACTORY_ID, sb.CAMP_ASMT_ID,
                   SUM(sb.TOTAL_EXPENSE) AS FACTORY_TOTAL_EXPENSE
            FROM skus s
            JOIN sku_best sb ON s.THD_SKU_NBR = sb.THD_SKU_NBR AND sb.rn = 1
            GROUP BY s.FACTORY_ID, sb.CAMP_ASMT_ID
        ),
        factory_best AS (
            SELECT fa.*,
                   ROW_NUMBER() OVER (PARTITION BY fa.FACTORY_ID ORDER BY fa.FACTORY_TOTAL_EXPENSE ASC) AS rn
            FROM factory_agg fa
        )
        SELECT
            s.SKU_NBR, s.SUPPLIER, s.FACTORY_ID,
            sb.DC_COUNT AS ASSIGNED_DC_COUNT,
            fb.CAMP_ASMT_ID,
            sb.DC_LIST,
            sb.TOTAL_EXPENSE
        FROM skus s
        LEFT JOIN sku_best sb ON s.THD_SKU_NBR = sb.THD_SKU_NBR AND sb.rn = 1
        LEFT JOIN factory_best fb ON s.FACTORY_ID = fb.FACTORY_ID AND fb.rn = 1
        ORDER BY s.FACTORY_ID, s.SKU_NBR
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    for r in rows:
        if r.get("DC_LIST"):
            r["DC_LIST"] = ", ".join(str(d) for d in sorted(r["DC_LIST"]))
    return {"results": rows, "error": None}


def _prepare_multi_dc_call(params: dict):
    """Validate params and build the CALL statement + query parameters for
    determine_multi_dc_assortment. Returns (proc_call, job_config, run_id, error) —
    proc_call/job_config are None when error is set. run_id empty (with no error)
    means "reuse existing results," not a failure — the caller should skip
    submitting a job and just fetch current output tables.
    """
    run_id = params.get("run_id", "")
    sku_grp = params.get("sku_grp", "")
    event_name = params.get("event_name", "")
    dc_counts = [int(d) for d in params.get("dc_counts", [])]
    is_import = bool(params.get("is_import", False))
    min_containers = float(params.get("min_containers", 0.66))
    low_vol_fallback_dc = int(params.get("low_vol_fallback_dc", 2))
    campus_pairs_raw = params.get("campus_pairs", [])
    dc_exclusions = [int(d) for d in params.get("dc_exclusions", [])]
    dc_inclusions = [int(d) for d in params.get("dc_inclusions", [])]
    cascading = bool(params.get("cascading", True))
    min_utilization = float(params.get("min_utilization", 0.80))
    expense_tolerance = float(params.get("expense_tolerance", 0.02))

    if not run_id or not sku_grp:
        return None, None, run_id, "Run ID and SKU Group are required"
    if not dc_counts and not is_import:
        return None, None, run_id, "At least one DC count is required"
    # Empty dc_counts + is_import triggers dynamic mode: the procedure sweeps every
    # DC count itself and assigns each factory the widest one that clears
    # min_utilization while staying within expense_tolerance of its cheapest option.

    campus_bulk = []
    campus_main = []
    for cp in campus_pairs_raw:
        info = CAMPUS_INFO.get(cp)
        if info:
            campus_bulk.append(info["bulk"])
            campus_main.append(info["main"])

    proc_call = f"CALL `{PROJECT_ID}.{DATASET}.determine_multi_dc_assortment`(" \
                f"@run_id, @sku_grp, @event_name, @dc_counts, @is_import, " \
                f"@min_containers, @low_vol_fallback_dc, @campus_bulk, @campus_main, @dc_exclusions, @dc_inclusions, @cascading, " \
                f"@min_utilization, @expense_tolerance)"

    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ArrayQueryParameter("dc_counts", "INT64", dc_counts),
        bigquery.ScalarQueryParameter("is_import", "BOOL", is_import),
        bigquery.ScalarQueryParameter("min_containers", "FLOAT64", min_containers),
        bigquery.ScalarQueryParameter("low_vol_fallback_dc", "INT64", low_vol_fallback_dc),
        bigquery.ArrayQueryParameter("campus_bulk", "INT64", campus_bulk),
        bigquery.ArrayQueryParameter("campus_main", "INT64", campus_main),
        bigquery.ArrayQueryParameter("dc_exclusions", "INT64", dc_exclusions),
        bigquery.ArrayQueryParameter("dc_inclusions", "INT64", dc_inclusions),
        bigquery.ScalarQueryParameter("cascading", "BOOL", cascading),
        bigquery.ScalarQueryParameter("min_utilization", "FLOAT64", min_utilization),
        bigquery.ScalarQueryParameter("expense_tolerance", "FLOAT64", expense_tolerance),
    ])

    logger.info(f"Preparing determine_multi_dc_assortment: run_id={run_id}, dc_counts={dc_counts}, "
                f"is_import={is_import}, min_containers={min_containers}, low_vol_fallback_dc={low_vol_fallback_dc}, event_name={event_name}, "
                f"campus_bulk={campus_bulk}, campus_main={campus_main}, "
                f"dc_exclusions={dc_exclusions}, dc_inclusions={dc_inclusions}, cascading={cascading}, "
                f"min_utilization={min_utilization}, expense_tolerance={expense_tolerance}")

    return proc_call, job_config, run_id, None


def start_multi_dc(client: bigquery.Client, params: dict) -> dict:
    """Submit the determine_multi_dc_assortment CALL asynchronously (no .result()) —
    the long-running dynamic sweep can take anywhere from ~40 seconds to several
    minutes, which a single synchronous HTTP request doesn't reliably survive
    (browser/proxy connection drops before the response, and Failed to fetch
    made a retry look necessary even though the original call was still running
    server-side — worse, running the retry concurrently raced both calls against
    the same shared CM_TEMP scratch tables, corrupting one of them). The caller
    should poll the returned job_id instead of holding a connection open.
    Returns {"job_id": str|None, "error": str|None}; job_id is None (no error)
    when run_id is empty — nothing to submit, just re-fetch existing results.
    """
    proc_call, job_config, run_id, error = _prepare_multi_dc_call(params)
    if error:
        return {"job_id": None, "error": error}
    if not run_id:
        logger.info("No run_id provided — loading existing results from output tables")
        return {"job_id": None, "error": None}
    job = client.query(proc_call, job_config=job_config)
    return {"job_id": job.job_id, "error": None}


def fetch_multi_dc_results(client: bigquery.Client) -> dict:
    """Fetch the results + summary tables written by a completed
    determine_multi_dc_assortment call (or by a prior call, when reusing
    existing results without submitting a new one)."""
    results_query = f"""
        SELECT SKU_NBR, FACTORY_ID,
               ASSIGNED_DC_COUNT, DC_LIST, CAMPUS_DC_LIST, TOTAL_EXP, TOTAL_SLA, ASMT_ID
        FROM `{PROJECT_ID}.{TEMP_DATASET}.SKU_WINNING_ASSORTMENT_DYNAMIC`
        ORDER BY FACTORY_ID, ASSIGNED_DC_COUNT DESC, SKU_NBR
    """
    rows = [dict(r) for r in client.query(results_query).result()]

    tier_summary = [dict(r) for r in client.query(f"""
        SELECT DC_TIER, CAMPUS_DC_LIST, DC_NAMES, THD_KEYS, BUY_UNITS,
               DELIVERY_EXPENSE, UNIT_DELIVERY_EXP, SLA, TOTAL_CUBE, CUBE_PER_UNIT
        FROM `{PROJECT_ID}.{TEMP_DATASET}.ASSORTMENT_COST_SUMMARY`
        ORDER BY DC_TIER DESC
    """).result()]

    dc_factory_detail = [dict(r) for r in client.query(f"""
        SELECT DC_TIER, CAMPUS_DC_LIST, DC_LIST, DC_NM_LIST, FACTORY_ID, CONTAINERS, THD_KEYS, BUY_UNITS,
               DELIVERY_EXPENSE, UNIT_DELIVERY_EXP, SLA, TOTAL_CUBE, CUBE_PER_UNIT
        FROM `{PROJECT_ID}.{TEMP_DATASET}.ASSORTMENT_DC_FACTORY_DETAIL`
        ORDER BY DC_TIER DESC, DC_LIST, CONTAINERS DESC
    """).result()]

    # Populated by BOTH branches now (dynamic mode's §6 decision, and the
    # explicit-tier branch's reporting-only pass) — always try to fetch it.
    utilization_choice = []
    try:
        utilization_choice = [dict(r) for r in client.query(f"""
            SELECT FACTORY_ID, ASSIGNED_DC_COUNT, ROUND(UTIL_DC * 100, 1) AS UTIL_DC_PCT,
                   ROUND(FACT_EXP, 0) AS FACT_EXP, ROUND(FLOOR_EXP, 0) AS FLOOR_EXP,
                   MEETS_TARGET, MEETS_UTIL, MEETS_EXP,
                   UNMAPPED
            FROM `{PROJECT_ID}.{TEMP_DATASET}.FACTORY_UTILIZATION_CHOICE`
            ORDER BY FACTORY_ID
        """).result()]
    except Exception:
        # Only populated by a fresh procedure call (e.g. not when run_id was left
        # blank to reuse prior results) — supplementary reporting data, so its
        # absence shouldn't fail the whole request.
        logger.warning("FACTORY_UTILIZATION_CHOICE not available for this call", exc_info=True)

    # Only exists (and only has rows) when a tier's coverage-gated candidate
    # pool came up empty in dynamic mode — the deliberate "no automatic
    # fallback" case (see determine_multi_dc_assortment.sql D7). Lists each
    # affected factory's own best assortment plus every other tier's
    # already-chosen list that happens to price for all of its SKUs, so the
    # app can let the user pick one directly instead of it being auto-resolved.
    unmapped_options = []
    try:
        unmapped_options = [dict(r) for r in client.query(f"""
            SELECT FACTORY_ID, ASSIGNED_DC_COUNT, OPTION_TYPE, SOURCE_DC_COUNT,
                   CAMPUS_DC_LIST, ROUND(TOTAL_EXP, 0) AS TOTAL_EXP
            FROM `{PROJECT_ID}.{TEMP_DATASET}.FACTORY_UNMAPPED_OPTIONS`
            ORDER BY FACTORY_ID, OPTION_TYPE, TOTAL_EXP ASC
        """).result()]
    except Exception:
        logger.warning("FACTORY_UNMAPPED_OPTIONS not available for this call", exc_info=True)

    return {
        "results": rows,
        "tier_summary": tier_summary,
        "dc_factory_detail": dc_factory_detail,
        "utilization_choice": utilization_choice,
        "unmapped_options": unmapped_options,
        "strategy_type": "MULTI_DC",
        "error": None,
    }


def check_ladder_problem_skus(client: bigquery.Client, run_id: str, event_name: str) -> list[dict]:
    """MULTI_DC: SKUs the winning (or campus-merged) assortment at a factory's
    own chosen tier still didn't price — ASSORTMENT_DC_COVERAGE_GAPS, written
    by determine_multi_dc_assortment's D7 step. Grouped by SKU_NBR (the grain
    resolve_problem_sku_override fixes at, matching DFC_COST_MODEL_SUBMISSION's
    own per-SKU_NBR dc_inclusions/dc_exclusions grain) with enough context —
    description, supplier, which factories/tiers are affected — for the user
    to decide a new DC selection for it. Same ineligible-DC-plus-reason shape
    as the VENDOR_ALIGNED DC Eligibility card (see check_vendor_dc_eligibility
    above) — OBC_CTLG_SKU_DC's VIABLE_POST/EXCL_REASON pins down which
    specific DC in the failed list is actually the problem, rather than just
    naming the whole failed DC_LIST — but the fix here is still a free DC
    pick rather than a curated eligible list, since a problem SKU's own
    assortment is independent of any tier's own candidate pool."""
    query = f"""
        SELECT g.SKU_NBR,
               ANY_VALUE(E.SKU_DESC) AS SKU_DESC, ANY_VALUE(E.SUPPLIER) AS SUPPLIER,
               ARRAY_AGG(DISTINCT E.THD_SKU_NBR IGNORE NULLS) AS THD_SKU_NBRS,
               ARRAY_AGG(DISTINCT g.FACTORY_ID) AS FACTORY_IDS,
               ARRAY_AGG(DISTINCT g.ASSIGNED_DC_COUNT) AS TIERS,
               ARRAY_AGG(DISTINCT g.CAMPUS_DC_LIST IGNORE NULLS) AS FAILED_DC_LISTS,
               COUNT(DISTINCT CONCAT(CAST(g.FACTORY_ID AS STRING), '|', CAST(g.THD_KEY_ID AS STRING))) AS RECORD_COUNT
        FROM {ASSORTMENT_DC_COVERAGE_GAPS} g
        LEFT JOIN {EVENTS_SKU_LIST} E
          ON E.THD_KEY_ID = g.THD_KEY_ID
        WHERE UPPER(E.EVENT_NAME) = UPPER(@event_name)
        GROUP BY g.SKU_NBR
        ORDER BY RECORD_COUNT DESC
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    if not rows or not run_id:
        for r in rows:
            r["ineligible"] = []
            r["eligible_alternatives"] = []
        return rows

    # Every DC that shows up in any of this SKU's failed lists, across all
    # rows — the candidate set to explain/rule in or out via OBC_CTLG_SKU_DC.
    sku_nbrs = [int(r["SKU_NBR"]) for r in rows]
    failed_dcs_by_sku = {}
    for r in rows:
        dcs = set()
        for dc_list in (r["FAILED_DC_LISTS"] or []):
            dcs.update(int(d) for d in str(dc_list).split("-") if d)
        failed_dcs_by_sku[int(r["SKU_NBR"])] = dcs

    elig_query = f"""
        SELECT SKU_NBR, CAST(DC_NBR AS INT64) AS DC_NBR, VIABLE_POST, EXCL_REASON
        FROM {SKU_DC_ELIGIBILITY}
        WHERE RUN_ID = @run_id AND SKU_NBR IN UNNEST(@sku_nbrs)
    """
    elig_jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ArrayQueryParameter("sku_nbrs", "INT64", sku_nbrs),
    ])
    elig_rows = list(client.query(elig_query, job_config=elig_jc).result())

    ineligible_by_sku = {}
    eligible_by_sku = {}
    for r in elig_rows:
        sku = r["SKU_NBR"]
        if r["VIABLE_POST"] is False:
            ineligible_by_sku.setdefault(sku, []).append({"dc_nbr": r["DC_NBR"], "reason": r["EXCL_REASON"]})
        elif r["VIABLE_POST"] is True:
            eligible_by_sku.setdefault(sku, []).append(r["DC_NBR"])

    for r in rows:
        sku = int(r["SKU_NBR"])
        failed_dcs = failed_dcs_by_sku.get(sku, set())
        r["ineligible"] = [i for i in ineligible_by_sku.get(sku, []) if i["dc_nbr"] in failed_dcs]
        r["eligible_alternatives"] = [dc for dc in eligible_by_sku.get(sku, []) if dc not in failed_dcs]
    return rows


def check_dc_selection_eligibility(client: bigquery.Client, run_id: str, sku_grp: str, event_name: str,
                                    dc_counts: list[int], dc_inclusions: list[int], dc_exclusions: list[int],
                                    campus_pairs: list[str]) -> list[dict]:
    """DC_SELECTION (i.e. MULTI_DC/SINGLE_DC driven by explicit dc_counts, not
    VENDOR_ALIGNED): a preview available on Step 3, BEFORE running the full
    assortment tool — given the caller's own dc_counts/dc_inclusions/
    dc_exclusions/campus-merge choice, which target SKUs would fail to price
    at every one of the requested DC counts. Reuses the same campus-merge
    combinatorial expansion determine_multi_dc_assortment's ladder uses (see
    dc_selection_eligibility_preview.sql), just without cascading nesting or
    the per-factory/utilization simulation — this is a coverage check, not a
    committed ladder. Enriched with OBC_CTLG_SKU_DC the same way
    check_ladder_problem_skus is, but the DCs explained are simply the
    caller's own dc_inclusions (the SKU's coverage is checked against
    exactly those, not a discovered failed DC_LIST after the fact)."""
    campus_bulk, campus_main = [], []
    for cp in (campus_pairs or []):
        info = CAMPUS_INFO.get(cp)
        if info:
            campus_bulk.append(info["bulk"])
            campus_main.append(info["main"])

    with open(_DC_SELECTION_PREVIEW_SQL_PATH, "r", encoding="utf-8") as f:
        preview_body = f.read()
    sql = f"""
        DECLARE in_run_id STRING DEFAULT @in_run_id;
        DECLARE in_sku_grp STRING DEFAULT @in_sku_grp;
        DECLARE in_event_name STRING DEFAULT @in_event_name;
        DECLARE in_dc_counts ARRAY<INT64> DEFAULT @in_dc_counts;
        DECLARE in_campus_bulk ARRAY<INT64> DEFAULT @in_campus_bulk;
        DECLARE in_campus_main ARRAY<INT64> DEFAULT @in_campus_main;
        DECLARE in_dc_inclusions ARRAY<INT64> DEFAULT @in_dc_inclusions;
        DECLARE in_dc_exclusions ARRAY<INT64> DEFAULT @in_dc_exclusions;

        {preview_body}
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("in_sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
        bigquery.ArrayQueryParameter("in_dc_counts", "INT64", dc_counts or []),
        bigquery.ArrayQueryParameter("in_campus_bulk", "INT64", campus_bulk),
        bigquery.ArrayQueryParameter("in_campus_main", "INT64", campus_main),
        bigquery.ArrayQueryParameter("in_dc_inclusions", "INT64", dc_inclusions or []),
        bigquery.ArrayQueryParameter("in_dc_exclusions", "INT64", dc_exclusions or []),
    ])
    rows = [dict(r) for r in client.query(sql, job_config=job_config).result()]
    if not rows or not run_id:
        for r in rows:
            r["ineligible"] = []
            r["eligible_alternatives"] = []
        return rows

    # The DCs actually being checked ARE the caller's own dc_inclusions —
    # unlike check_ladder_problem_skus, there's no discovered failed DC_LIST
    # to derive this from, since this preview runs before any ladder choice
    # is even made.
    candidate_dcs = set(dc_inclusions or [])
    sku_nbrs = [int(r["SKU_NBR"]) for r in rows]
    elig_query = f"""
        SELECT SKU_NBR, CAST(DC_NBR AS INT64) AS DC_NBR, VIABLE_POST, EXCL_REASON
        FROM {SKU_DC_ELIGIBILITY}
        WHERE RUN_ID = @run_id AND SKU_NBR IN UNNEST(@sku_nbrs)
    """
    elig_jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ArrayQueryParameter("sku_nbrs", "INT64", sku_nbrs),
    ])
    elig_rows = list(client.query(elig_query, job_config=elig_jc).result())

    ineligible_by_sku = {}
    eligible_by_sku = {}
    for r in elig_rows:
        sku = r["SKU_NBR"]
        if r["VIABLE_POST"] is False:
            ineligible_by_sku.setdefault(sku, []).append({"dc_nbr": r["DC_NBR"], "reason": r["EXCL_REASON"]})
        elif r["VIABLE_POST"] is True:
            eligible_by_sku.setdefault(sku, []).append(r["DC_NBR"])

    for r in rows:
        sku = int(r["SKU_NBR"])
        r["ineligible"] = [i for i in ineligible_by_sku.get(sku, []) if i["dc_nbr"] in candidate_dcs]
        r["eligible_alternatives"] = [dc for dc in eligible_by_sku.get(sku, []) if dc not in candidate_dcs]
    return rows


def apply_problem_sku_fix(client: bigquery.Client, run_id: str, sku_grp: str, event_name: str,
                           sku_nbr: int, dc_inclusions: list[int], dc_exclusions: list[int]) -> dict:
    """Reroute one flagged SKU_NBR to its own independent assortment —
    resolve_problem_sku_override finds the cheapest DC combination that
    satisfies the given inclusions/exclusions and actually prices it, updates
    SKU_WINNING_ASSORTMENT_DYNAMIC for every currently-flagged (factory, THD
    key) record sharing this SKU_NBR, rebuilds the cost-summary tables, and
    re-simulates utilization for just the affected factories — all without
    rerunning the shared ladder. Also persists the override onto
    DFC_COST_MODEL_SUBMISSION.dc_inclusions/dc_exclusions for this SKU_NBR,
    same bookkeeping VENDOR_ALIGNED already does (that write has no effect on
    the ladder itself — it never reads those two columns)."""
    call_sql = f"""
        CALL {RESOLVE_PROBLEM_SKU_PROC}(
            @run_id, @sku_grp, @event_name, @sku_nbr, @dc_inclusions, @dc_exclusions
        )
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("sku_nbr", "INT64", sku_nbr),
        bigquery.ArrayQueryParameter("dc_inclusions", "INT64", dc_inclusions or []),
        bigquery.ArrayQueryParameter("dc_exclusions", "INT64", dc_exclusions or []),
    ])
    try:
        client.query(call_sql, job_config=job_config).result()
        return {"success": True, "error": None}
    except Exception as e:
        logger.exception("apply_problem_sku_fix error")
        return {"success": False, "error": str(e)}


def persist_dynamic_multi_dc_selection(client: bigquery.Client) -> int:
    """Writes SKU_WINNING_ASSORTMENT_DYNAMIC's per-record decision onto its own
    EVENTS_SKU_LIST row, keyed by THD_KEY_ID (always unique, even across
    events — confirmed against live data).

    SKU_WINNING_ASSORTMENT_DYNAMIC is a shared scratch table: every dynamic-
    import "Determine Assortment IDs" call, for ANY event, replaces its
    entire contents. run_allocation_unified used to LEFT JOIN it live by
    THD_KEY_ID at allocation time — which meant a later determine call for a
    *different* event (or a redetermine of this same one) could silently
    overwrite the decision an allocation run was about to depend on, with no
    error, just a wrong result (confirmed: FINAL_ALLOCATIONS_WIDE showed a
    factory's record split across a 10-DC assortment it was never assigned
    to, because the scratch table had already moved on to a different
    factory/run's answer by the time allocation's join actually ran).

    Calling this right after every fetch_multi_dc_results() closes that
    window: once written here, this event's own decision (BATCH_ID/
    BATCH_INDEX — what actually drives the DC ship-% split — plus
    TARGET_DC_COUNT/TARGET_DC_INCLUSIONS for parity with VENDOR_ALIGNED's own
    write-back) lives on EVENTS_SKU_LIST itself, immune to whatever anyone
    else does to the shared scratch table afterward. Safe to call even when
    nothing changed (e.g. a bare re-fetch with no new run_id) — it's the same
    idempotent MERGE either way. Returns the number of EVENTS_SKU_LIST rows
    updated (0 when the scratch table is currently empty)."""
    merge_sql = f"""
        MERGE {EVENTS_SKU_LIST} T
        USING (
            SELECT
                THD_KEY_ID,
                ASSIGNED_DC_COUNT,
                ARRAY_TO_STRING(
                    ARRAY(SELECT CAST(d AS STRING) FROM UNNEST(SPLIT(DC_LIST, '-')) d ORDER BY d),
                    ', '
                ) AS DC_INCLUSIONS,
                BATCH_ID, BATCH_INDEX, RACK_TYPE
            FROM `{PROJECT_ID}.{TEMP_DATASET}.SKU_WINNING_ASSORTMENT_DYNAMIC`
        ) S
        ON T.THD_KEY_ID = S.THD_KEY_ID
        WHEN MATCHED THEN UPDATE SET
            T.TARGET_DC_COUNT = S.ASSIGNED_DC_COUNT,
            T.TARGET_DC_INCLUSIONS = S.DC_INCLUSIONS,
            T.DYNAMIC_BATCH_ID = S.BATCH_ID,
            T.DYNAMIC_BATCH_INDEX = S.BATCH_INDEX,
            T.DYNAMIC_RACK_TYPE = S.RACK_TYPE
    """
    job = client.query(merge_sql)
    job.result()
    updated = job.num_dml_affected_rows or 0
    logger.info(f"persist_dynamic_multi_dc_selection: updated {updated} EVENTS_SKU_LIST rows")
    return updated


def _multi_dc(client: bigquery.Client, params: dict) -> dict:
    """Synchronous submit-and-wait MULTI_DC path, kept for the generic strategy
    dispatcher (determine_assortment_ids). The app's own UI calls
    start_multi_dc()/fetch_multi_dc_results() directly instead, polling for
    completion rather than blocking one HTTP request for the full run."""
    proc_call, job_config, run_id, error = _prepare_multi_dc_call(params)
    if error:
        return {"results": [], "error": error}
    if run_id:
        client.query(proc_call, job_config=job_config).result()
    else:
        logger.info("No run_id provided — loading existing results from output tables")
    return fetch_multi_dc_results(client)
