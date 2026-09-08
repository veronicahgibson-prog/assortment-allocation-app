"""Allocation procedure calls and results retrieval."""

import logging
import time
from google.cloud import bigquery
from config import (UNIFIED_ALLOCATION_PROC, DFC_COST_MODEL_SUBMISSION,
                    CATALOG_RUN_ANALYTICS, SKU_DC_ELIGIBILITY,
                    FINAL_ALLOCATIONS, CATALOG_RUN_ALT, EVENTS_SKU_LIST)

logger = logging.getLogger(__name__)


def fmtk(n):
    return f"{n:,}"

MAX_RETRIES = 3


def run_allocation(client: bigquery.Client, params: dict) -> dict:
    """Call the single unified allocation stored procedure. It resolves each
    record's CAMP_ASMT_ID live (never from a stored/stale column) — see
    run_allocation_unified in BigQuery for the per-strategy resolution logic."""
    strategy = params["strategy"]
    event_name = params["event_name"]
    wave_count = int(params.get("wave_count", 0))
    run_id = params.get("run_id", "")
    sku_grp = params.get("sku_grp", "")

    if strategy not in ("VENDOR_ALIGNED", "SINGLE_DC", "MULTI_DC"):
        return {"success": False, "error": f"Unknown strategy: {strategy}"}

    dc_counts = [int(x) for x in params.get("dc_counts", [])]
    is_import = bool(params.get("is_import", False))
    # Empty dc_counts + is_import means the assortment step ran in dynamic mode
    # (determine_multi_dc_assortment picked a DC count per factory); allocation
    # must then pull each factory's own winner instead of one shared assortment.
    is_dynamic_import = strategy == "MULTI_DC" and is_import and not dc_counts

    query = f"""
        CALL {UNIFIED_ALLOCATION_PROC}(
            @in_run_id, @in_sku_grp, @in_event_name, @in_wave_count,
            @in_strategy, @in_dc_counts, @in_dynamic_import
        )
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("in_sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("in_wave_count", "INT64", wave_count),
        bigquery.ScalarQueryParameter("in_strategy", "STRING", strategy),
        bigquery.ArrayQueryParameter("in_dc_counts", "INT64", dc_counts),
        bigquery.ScalarQueryParameter("in_dynamic_import", "BOOL", is_dynamic_import),
    ])

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


def check_vendor_dc_eligibility(client: bigquery.Client, run_id: str, sku_grp: str, event_name: str) -> list[dict]:
    """For VENDOR_ALIGNED: find SKUs whose currently-submitted DC selection
    (DFC_COST_MODEL_SUBMISSION.dc_inclusions) has no matching CAMP_ASMT_ID in the
    catalog run — same DC-set match the allocation procedure itself uses — then
    explain why via OBC_CTLG_SKU_DC (VIABLE_POST=FALSE) and list eligible DCs
    (VIABLE_POST=TRUE) the user could swap in instead. Only surfaces SKUs where a
    match genuinely fails; not every VIABLE_POST=FALSE row blocks a match (e.g. a
    soft "no rack type" reason can still resolve fine), so flagging every such row
    would be a false alarm."""
    query = f"""
    DECLARE resolved_sku_grp STRING;
    IF @in_sku_grp IS NOT NULL AND @in_sku_grp != '' THEN
      SET resolved_sku_grp = @in_sku_grp;
    ELSE
      SET resolved_sku_grp = (
        SELECT SKU_GRP
        FROM {CATALOG_RUN_ANALYTICS}
        WHERE RUN_ID = @in_run_id
          AND REGEXP_REPLACE(UPPER(SKU_GRP), r'[^A-Z0-9]', '')
              LIKE CONCAT('%', REGEXP_REPLACE(UPPER(@in_event_name), r'[^A-Z0-9]', ''), '%')
        LIMIT 1
      );
    END IF;

    WITH SUBMISSION AS (
      SELECT
        sku_nbr,
        SAFE_CAST(target_dc_count AS INT64) AS TARGET_DC_COUNT,
        ARRAY(SELECT CAST(TRIM(d) AS INT64) FROM UNNEST(SPLIT(dc_inclusions, ',')) d) AS CHOSEN_DCS,
        ARRAY_TO_STRING(ARRAY(
          SELECT CAST(CAST(TRIM(d) AS INT64) AS STRING)
          FROM UNNEST(SPLIT(dc_inclusions, ',')) d ORDER BY 1
        ), ',') AS TARGET_DC_SET
      FROM {DFC_COST_MODEL_SUBMISSION}
      -- Matched on key = in_sku_grp directly: the real assortment-tool pipeline
      -- publishes SKU_GRP as exactly this submission's own key (LDAP-project-project),
      -- so no separate event_year lookup (ambiguous when EVENTS_SKU_LIST holds more
      -- than one year for the same EVENT_NAME) or project_name reconstruction is
      -- needed at all.
      WHERE key = resolved_sku_grp
        AND dc_inclusions IS NOT NULL
    ),
    CAMP_LOOKUP AS (
      SELECT SKU_NBR, DC_COUNT,
        ARRAY_TO_STRING(ARRAY(
          SELECT CAST(CAST(TRIM(d) AS INT64) AS STRING)
          FROM UNNEST(SPLIT(DC_LIST, '-')) d ORDER BY 1
        ), ',') AS DC_SET
      FROM {CATALOG_RUN_ANALYTICS}
      WHERE RUN_ID = @in_run_id AND SKU_GRP = resolved_sku_grp
    ),
    UNMATCHED AS (
      SELECT s.sku_nbr, ANY_VALUE(s.CHOSEN_DCS) AS CHOSEN_DCS
      FROM SUBMISSION s
      LEFT JOIN CAMP_LOOKUP c
        ON c.SKU_NBR = CAST(s.sku_nbr AS INT64)
       AND c.DC_COUNT = s.TARGET_DC_COUNT
       AND c.DC_SET   = s.TARGET_DC_SET
      GROUP BY s.sku_nbr
      HAVING COUNTIF(c.DC_SET IS NOT NULL) = 0
    )
    SELECT
      u.sku_nbr, ANY_VALUE(E.SKU_DESC) AS SKU_DESC, ANY_VALUE(E.SUPPLIER) AS SUPPLIER,
      ANY_VALUE(u.CHOSEN_DCS) AS CHOSEN_DCS,
      ARRAY_AGG(DISTINCT E.THD_SKU_NBR IGNORE NULLS) AS THD_SKU_NBRS
    FROM UNMATCHED u
    LEFT JOIN {EVENTS_SKU_LIST} E
      ON SAFE_CAST(E.SKU_NBR AS INT64) = CAST(u.sku_nbr AS INT64)
     AND UPPER(E.EVENT_NAME) = UPPER(@in_event_name)
    GROUP BY u.sku_nbr
    """
    job_config = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
        bigquery.ScalarQueryParameter("in_sku_grp", "STRING", sku_grp),
        bigquery.ScalarQueryParameter("in_event_name", "STRING", event_name),
    ])
    unmatched_rows = list(client.query(query, job_config=job_config).result())
    if not unmatched_rows:
        return []

    sku_nbrs = [int(r["sku_nbr"]) for r in unmatched_rows]
    chosen_by_sku = {int(r["sku_nbr"]): list(r["CHOSEN_DCS"]) for r in unmatched_rows}

    # A plain JOIN restricted to just these flagged SKUs (never a per-row correlated
    # subquery against OBC_CTLG_SKU_DC) — cheap since unmatched_rows is only the handful
    # of real exceptions, not every SKU in the event.
    elig_query = f"""
        SELECT SKU_NBR, CAST(DC_NBR AS INT64) AS DC_NBR, VIABLE_POST, EXCL_REASON
        FROM {SKU_DC_ELIGIBILITY}
        WHERE RUN_ID = @in_run_id AND SKU_NBR IN UNNEST(@sku_nbrs)
    """
    elig_jc = bigquery.QueryJobConfig(query_parameters=[
        bigquery.ScalarQueryParameter("in_run_id", "STRING", run_id),
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

    return [
        {
            "sku_nbr": r["sku_nbr"],
            "sku_desc": r["SKU_DESC"],
            "supplier": r["SUPPLIER"],
            # A proxy SKU_NBR can carry more than one THD_SKU_NBR (e.g. two vendor-aligned
            # sourcing paths sharing a proxy) — the override fix must apply to all of them.
            "thd_sku_nbrs": list(r["THD_SKU_NBRS"]),
            "chosen_dcs": chosen_by_sku[int(r["sku_nbr"])],
            "ineligible": [
                i for i in ineligible_by_sku.get(int(r["sku_nbr"]), [])
                if i["dc_nbr"] in chosen_by_sku[int(r["sku_nbr"])]
            ],
            "eligible_alternatives": [
                dc for dc in eligible_by_sku.get(int(r["sku_nbr"]), [])
                if dc not in chosen_by_sku[int(r["sku_nbr"])]
            ],
        }
        for r in unmatched_rows
    ]


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


def is_import_run(client: bigquery.Client) -> bool:
    """Whether the current FINAL_ALLOCATIONS_WIDE run has any real FACTORY_ID —
    a domestic run leaves it null/0 throughout, since factories are an
    import-only concept. FACTORY_CUBE/FACTORY_CONTAINERS are meaningless
    (a bogus sum across every domestic row treated as one factory group)
    whenever this is false, so callers should skip them in that case."""
    q = f"""
        SELECT COUNTIF(FACTORY_ID IS NOT NULL AND FACTORY_ID != 0) > 0 AS is_import
        FROM {FINAL_ALLOCATIONS}
    """
    rows = list(client.query(q).result())
    return bool(rows and rows[0]["is_import"])


def fetch_results(client: bigquery.Client, page: int = 1, page_size: int = 50,
                  sort: str = "SKU_NBR", direction: str = "ASC", extra_key_cols=None) -> dict:
    """Fetch allocation results from FINAL_ALLOCATIONS_WIDE.

    extra_key_cols: optional list of (alias, events_sku_list_column) pairs —
    whatever this upload's THD key needs beyond THD_SKU_NBR (typically
    MVNDR_NBR) to distinguish two records, joined in from EVENTS_SKU_LIST via
    the THD_KEY_ID both tables share. FINAL_ALLOCATIONS_WIDE has no
    SISTER_SKU_NBR/MVNDR_NBR itself (its SKU_NBR is THD_SKU_NBR published
    under a different name), so this is the only way to surface them here."""
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

    extra_key_cols = extra_key_cols or []
    extra_cols_sql = "".join(f", e.{sql_col} AS {alias}" for alias, sql_col in extra_key_cols)
    join_clause = (
        f"LEFT JOIN {EVENTS_SKU_LIST} e "
        f"ON e.THD_KEY_ID = f.THD_KEY_ID AND e.EVENT_NAME = f.EVENT_NAME AND e.EVENT_YEAR = f.EVENT_YEAR"
    ) if extra_key_cols else ""

    factory_totals = "f.FACTORY_CUBE, f.FACTORY_CONTAINERS" if is_import_run(client) else \
        "CAST(NULL AS FLOAT64) AS FACTORY_CUBE, CAST(NULL AS FLOAT64) AS FACTORY_CONTAINERS"
    query = f"""
        SELECT f.SKU_NBR, f.SKU_DESC{extra_cols_sql},
               f.SUPPLIER, f.FACTORY_ID,
               f.BP, f.BUY_UNITS,
               f.DC_NBR,
               f.DFC_PCT, f.DFC_UNITS, f.DFC_W1_UNITS, f.DFC_W2_UNITS,
               f.DFC_W3_UNITS, f.DFC_W4_UNITS,
               f.ITEM_CUBE, f.RACK_TYPE, {factory_totals}
        FROM {FINAL_ALLOCATIONS} f
        {join_clause}
        ORDER BY f.{sort} {direction}
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

    return {
        "data": rows, "page": page, "has_more": has_more, "total": total,
        "extra_key_cols": [alias for alias, _ in extra_key_cols],
    }


def fetch_summary(client: bigquery.Client) -> dict:
    """Fetch KPI summary from allocation results."""
    # A single SKU_NBR can carry multiple THD_KEY_ID rows (e.g. two vendor-aligned
    # sourcing paths for the same retail SKU), so THD_KEY_ID — not SKU_NBR — is
    # the true per-record partition key on this table.
    query = f"""
        SELECT
            COUNT(DISTINCT THD_KEY_ID) AS total_skus,
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

    # 4. DFC_PCT sums to ~1.0 per THD_KEY_ID (partition by THD_KEY_ID, not
    # SKU_NBR — a SKU_NBR can legitimately carry more than one THD_KEY_ID,
    # each independently allocated to 100%)
    q4 = f"""
        SELECT THD_KEY_ID, ANY_VALUE(SKU_NBR) AS SKU_NBR, ABS(SUM(DFC_PCT) - 1.0) AS pct_diff
        FROM {FINAL_ALLOCATIONS}
        GROUP BY THD_KEY_ID
        HAVING ABS(SUM(DFC_PCT) - 1.0) > 0.01
    """
    try:
        r4_rows = list(client.query(q4).result())
        r4 = len(r4_rows)
        bad_skus = ", ".join(str(row["SKU_NBR"]) for row in r4_rows[:10])
        if r4 > 10:
            bad_skus += f", +{r4 - 10} more"
        checks.append({
            "name": "DFC_PCT sums to 1.0 per SKU",
            "passed": r4 == 0,
            "detail": f"{r4} THD key(s) outside tolerance: {bad_skus}" if r4 > 0 else "Pass",
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
