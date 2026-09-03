"""Allocation procedure calls and results retrieval."""

import logging
import time
from google.cloud import bigquery
from config import (VENDOR_ALIGNED_PROC, SINGLE_DC_PROC, MULTI_DC_PROC,
                    FINAL_ALLOCATIONS, CATALOG_RUN_ALT, EVENTS_SKU_LIST)

logger = logging.getLogger(__name__)


def fmtk(n):
    return f"{n:,}"

MAX_RETRIES = 3


def run_allocation(client: bigquery.Client, params: dict) -> dict:
    """Call the appropriate allocation stored procedure based on strategy."""
    strategy = params["strategy"]
    event_name = params["event_name"]
    wave_count = int(params.get("wave_count", 0))

    if strategy == "VENDOR_ALIGNED":
        run_id = params.get("run_id", "")
        sku_grp = params.get("sku_grp", "")
        query = f"""
            CALL {VENDOR_ALIGNED_PROC}(
                @in_run_id, @in_sku_grp, @in_event_name, @in_wave_count
            )
        """
        job_config = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
            bigquery.ScalarQueryParameter("in_sku_grp", "STRING", sku_grp),
            bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
            bigquery.ScalarQueryParameter("in_wave_count", "INT64", wave_count),
        ])

    elif strategy == "SINGLE_DC":
        run_id = params.get("run_id", "")
        dc_counts = [int(x) for x in params.get("dc_counts", [])]
        dc_count = dc_counts[0] if dc_counts else 0
        query = f"""
            CALL {SINGLE_DC_PROC}(
                @in_run_id, @in_dc_count, @in_event_name, @in_wave_count
            )
        """
        job_config = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
            bigquery.ScalarQueryParameter("in_dc_count", "INT64", dc_count),
            bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
            bigquery.ScalarQueryParameter("in_wave_count", "INT64", wave_count),
        ])

    elif strategy == "MULTI_DC":
        run_id = params.get("run_id", "")
        dc_counts = [int(x) for x in params.get("dc_counts", [])]
        is_import = bool(params.get("is_import", False))
        # Empty dc_counts + is_import means the assortment step ran in dynamic mode
        # (determine_multi_dc_assortment picked a DC count per factory); allocation
        # must then pull each factory's own winner instead of one shared assortment.
        is_dynamic_import = is_import and not dc_counts
        query = f"""
            CALL {MULTI_DC_PROC}(
                @in_run_id, @in_dc_counts, @in_event_name, @in_wave_count, @in_dynamic_import
            )
        """
        job_config = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
            bigquery.ArrayQueryParameter("in_dc_counts", "INT64", dc_counts),
            bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
            bigquery.ScalarQueryParameter("in_wave_count", "INT64", wave_count),
            bigquery.ScalarQueryParameter("in_dynamic_import", "BOOL", is_dynamic_import),
        ])
    else:
        return {"success": False, "error": f"Unknown strategy: {strategy}"}

    last_error = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            logger.info(f"Allocation attempt {attempt}/{MAX_RETRIES} strategy={strategy}")
            job = client.query(query, job_config=job_config)
            job.result()
            return {"success": True, "message": "Allocation procedure completed successfully."}
        except Exception as e:
            last_error = str(e)
            logger.warning(f"Allocation attempt {attempt} failed: {last_error}")
            if attempt < MAX_RETRIES:
                time.sleep(2 ** attempt)

    return {"success": False, "error": f"Allocation failed after {MAX_RETRIES} attempts: {last_error}"}


def fetch_available_dc_counts(client: bigquery.Client, run_id: str, sku_grp: str) -> dict:
    """Query OBC_V_CTLG_RUN_BY_SKU_ALT for available DC_COUNTs and their CAMP_ASMT_IDs."""
    query = f"""
        SELECT DISTINCT DC_COUNT, CAMP_ASMT_ID
        FROM {CATALOG_RUN_ALT}
        WHERE RUN_ID = @run_id
          AND SKU_GRP = @sku_grp
        ORDER BY DC_COUNT
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("sku_grp", "STRING", sku_grp),
    ])
    try:
        rows = list(client.query(query, job_config=job_config).result())
        options = [{"dc_count": row["DC_COUNT"], "camp_asmt_id": row["CAMP_ASMT_ID"]} for row in rows]
        return {"success": True, "options": options}
    except Exception as e:
        return {"success": False, "error": str(e)}


def fetch_results(client: bigquery.Client, page: int = 1, page_size: int = 50,
                  sort: str = "SKU_NBR", direction: str = "ASC") -> dict:
    """Fetch allocation results from FINAL_ALLOCATIONS_WIDE."""
    # Matches the actual FINAL_ALLOCATIONS_WIDE schema (run_multi_dc_allocation.sql's
    # final SELECT) — THD_SKU_NBR is published as SKU_NBR, and there is no
    # SISTER_SKU_NBR/MVNDR_NBR/OG_W*_UNITS/DFC_W5_UNITS in that table at all.
    ALLOWED_SORT_COLS = {
        "SKU_NBR", "SKU_DESC", "SUPPLIER", "FACTORY_ID", "DC_NBR",
        "DFC_PCT", "DFC_UNITS", "DFC_W1_UNITS", "DFC_W2_UNITS",
        "DFC_W3_UNITS", "DFC_W4_UNITS",
        "BP", "ITEM_CUBE", "RACK_TYPE", "BUY_UNITS", "FACTORY_CUBE", "FACTORY_CONTAINERS",
    }
    if sort not in ALLOWED_SORT_COLS:
        sort = "SKU_NBR"
    if direction not in ("ASC", "DESC"):
        direction = "ASC"

    offset = (page - 1) * page_size

    count_q = f"SELECT COUNT(*) AS cnt FROM {FINAL_ALLOCATIONS}"
    total = list(client.query(count_q).result())[0]["cnt"]

    query = f"""
        SELECT SKU_NBR, SKU_DESC,
               SUPPLIER, FACTORY_ID,
               BP, BUY_UNITS,
               DC_NBR,
               DFC_PCT, DFC_UNITS, DFC_W1_UNITS, DFC_W2_UNITS,
               DFC_W3_UNITS, DFC_W4_UNITS,
               ITEM_CUBE, RACK_TYPE, FACTORY_CUBE, FACTORY_CONTAINERS
        FROM {FINAL_ALLOCATIONS}
        ORDER BY {sort} {direction}
        LIMIT @limit OFFSET @offset
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("limit", "INT64", page_size + 1),
        bigquery.ScalarQueryParameter("offset", "INT64", offset),
    ])
    rows = [dict(r) for r in client.query(query, job_config=job_config).result()]
    has_more = len(rows) > page_size
    if has_more:
        rows = rows[:page_size]

    return {"data": rows, "page": page, "has_more": has_more, "total": total}


def fetch_summary(client: bigquery.Client) -> dict:
    """Fetch KPI summary from allocation results."""
    # SKU_NBR is the THD key here (no separate MVNDR_NBR column on this table —
    # see the note in fetch_results).
    query = f"""
        SELECT
            COUNT(DISTINCT SKU_NBR) AS total_skus,
            COALESCE(SUM(DFC_UNITS), 0) AS total_buy_units,
            COUNT(DISTINCT DC_NBR) AS total_dcs,
            COUNT(DISTINCT FACTORY_ID) AS unique_factories
        FROM {FINAL_ALLOCATIONS}
    """
    rows = list(client.query(query).result())
    if rows:
        return dict(rows[0])
    return {"total_skus": 0, "total_buy_units": 0, "total_dcs": 0, "unique_factories": 0}


def validate_results(client: bigquery.Client) -> list[dict]:
    """Run post-allocation validation checks."""
    checks = []

    # 1. SUM(DFC_UNITS) per SKU = BUY_UNITS
    q1 = f"""
        SELECT SKU_NBR, SUM(DFC_UNITS) AS alloc_total, MAX(BP) AS BP
        FROM {FINAL_ALLOCATIONS}
        GROUP BY SKU_NBR
    """
    # We'd need BUY_UNITS from the SKU list — for now check non-negative and BP divisibility
    # Simplified checks against the results table itself

    # 2. All DFC_UNITS divisible by BP
    q2 = f"""
        SELECT COUNT(*) AS cnt
        FROM {FINAL_ALLOCATIONS}
        WHERE MOD(CAST(DFC_UNITS AS INT64), CAST(BP AS INT64)) != 0
    """
    try:
        r2 = list(client.query(q2).result())[0]["cnt"]
        checks.append({
            "name": "All DFC_UNITS divisible by BP",
            "passed": r2 == 0,
            "detail": f"{r2} row(s) fail" if r2 > 0 else "Pass",
        })
    except Exception as e:
        checks.append({"name": "DFC_UNITS divisible by BP", "passed": False, "detail": str(e)})

    # 3. No negative allocations
    q3 = f"SELECT COUNT(*) AS cnt FROM {FINAL_ALLOCATIONS} WHERE DFC_UNITS < 0"
    try:
        r3 = list(client.query(q3).result())[0]["cnt"]
        checks.append({
            "name": "No negative allocations",
            "passed": r3 == 0,
            "detail": f"{r3} negative row(s)" if r3 > 0 else "Pass",
        })
    except Exception as e:
        checks.append({"name": "No negative allocations", "passed": False, "detail": str(e)})

    # 4. DFC_PCT sums to ~1.0 per SKU
    q4 = f"""
        SELECT SKU_NBR, ABS(SUM(DFC_PCT) - 1.0) AS pct_diff
        FROM {FINAL_ALLOCATIONS}
        GROUP BY SKU_NBR
        HAVING ABS(SUM(DFC_PCT) - 1.0) > 0.01
    """
    try:
        r4 = len(list(client.query(q4).result()))
        checks.append({
            "name": "DFC_PCT sums to 1.0 per SKU",
            "passed": r4 == 0,
            "detail": f"{r4} SKU(s) outside tolerance" if r4 > 0 else "Pass",
        })
    except Exception as e:
        checks.append({"name": "DFC_PCT sums to 1.0", "passed": False, "detail": str(e)})

    # 5. Allocated units vs uploaded BUY_UNITS
    q5 = f"""
        SELECT
          (SELECT COALESCE(SUM(DFC_UNITS), 0) FROM {FINAL_ALLOCATIONS}) AS allocated,
          (SELECT COALESCE(SUM(BUY_UNITS), 0) FROM {EVENTS_SKU_LIST}
           WHERE EVENT_NAME = (SELECT ANY_VALUE(EVENT_NAME) FROM {FINAL_ALLOCATIONS})) AS uploaded
    """
    try:
        r5 = list(client.query(q5).result())[0]
        alloc = r5["allocated"]
        upload = r5["uploaded"]
        diff = alloc - upload
        passed = diff == 0
        if passed:
            detail = f"Pass ({fmtk(alloc)} units)"
        else:
            detail = f"Allocated {fmtk(alloc)} vs uploaded {fmtk(upload)} (diff: {fmtk(diff)})"
        checks.append({"name": "Allocated units match upload", "passed": passed, "detail": detail})
    except Exception as e:
        checks.append({"name": "Allocated units match upload", "passed": False, "detail": str(e)})

    return checks


def fetch_factory_summary(client: bigquery.Client, divisor: float = 2390.0) -> list:
    """Factory-level container summary with LCL and utilization metrics."""
    query = f"""
    WITH dc_level AS (
        SELECT
            FACTORY_ID,
            DC_NBR,
            MAX(FACTORY_CUBE) AS factory_cube,
            SUM(SAFE_DIVIDE(ITEM_CUBE * DFC_UNITS, @divisor)) AS dc_raw
        FROM {FINAL_ALLOCATIONS}
        WHERE FACTORY_ID IS NOT NULL
        GROUP BY FACTORY_ID, DC_NBR
    ),
    factory_level AS (
        SELECT
            FACTORY_ID,
            MAX(factory_cube) AS po_cube,
            COUNT(*) AS lane_count,
            SUM(dc_raw) AS raw_container,
            CAST(SUM(CEIL(dc_raw)) AS INT64) AS rounded_container,
            -- MOD() doesn't accept FLOAT64 in BigQuery (only INT64/NUMERIC/
            -- BIGNUMERIC) — dc_raw - FLOOR(dc_raw) is the FLOAT64-safe
            -- equivalent of MOD(dc_raw, 1), the fractional (partial-container)
            -- part of a DC lane's raw container count.
            COUNTIF((dc_raw - FLOOR(dc_raw)) > 0 AND (dc_raw - FLOOR(dc_raw)) < 0.70) AS lcl_containers
        FROM dc_level
        GROUP BY FACTORY_ID
    )
    SELECT
        FACTORY_ID AS factory,
        po_cube,
        lane_count,
        ROUND(raw_container, 1) AS raw_container,
        rounded_container,
        lcl_containers,
        ROUND(SAFE_DIVIDE(lcl_containers, rounded_container), 2) AS lcl_pct,
        ROUND(SAFE_DIVIDE(raw_container, rounded_container), 3) AS util_pct,
        ROUND(SUM(rounded_container) OVER (
            ORDER BY po_cube DESC
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
        ) / SUM(rounded_container) OVER (), 2) AS cumulative_pct
    FROM factory_level
    ORDER BY po_cube DESC
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("divisor", "FLOAT64", float(divisor)),
    ])
    return [dict(r) for r in client.query(query, job_config=job_config).result()]
