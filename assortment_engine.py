"""Assortment ID determination logic per strategy."""

import logging
from google.cloud import bigquery
from config import (
    CATALOG_RUN_ANALYTICS, VENDOR_STRATEGY, EVENTS_SKU_LIST,
    DEFAULT_FALLBACK_ASMT_ID, CONTAINER_DIVISOR, CAMPUS_PAIRS,
    PROJECT_ID, DATASET, TEMP_DATASET, DC_NAMES,
)

logger = logging.getLogger(__name__)

CAMPUS_INFO = {
    "perris": {"bulk": 6006, "main": 6007},
    "locust_grove": {"bulk": 6705, "main": 6777},
}


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

    # Count SKUs per vendor and deduplicate
    vendor_counts = {}
    for m in vendor_matches:
        vendor = m["VENDOR"]
        if vendor not in vendor_counts:
            vendor_counts[vendor] = {"count": 0, "data": m}
        vendor_counts[vendor]["count"] += 1

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
    """Per THD Key: lowest TOTAL_EXPENSE across defined DC counts; validate cascade."""
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
        catalog AS (
            SELECT CAMP_ASMT_ID, THD_SKU_NBR, DC_COUNT,
                   ARRAY_AGG(DISTINCT CAST(DFC_NBR AS INT64)) AS DC_LIST,
                   SUM(TOTAL_EXPENSE) AS TOTAL_EXPENSE
            FROM {CATALOG_RUN_ANALYTICS}
            WHERE RUN_ID = @run_id AND SKU_GRP = @sku_grp
              AND DC_COUNT IN UNNEST(@dc_counts)
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
