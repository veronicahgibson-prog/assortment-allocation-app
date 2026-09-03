"""Prior-year event strategy lookups from the enterprise historical allocation
table (not this app's own CM_TEMP scratch tables) — EVENTS_SKU_DFC_ALLOCATIONS.
Backfilled with EVENT_NAME/EVENT_YEAR/IS_IMPORT this session; see
alter_events_dfc_allocations.sql for the schema history.
"""
from google.cloud import bigquery
from config import DC_NAMES, CAMPUS_PAIRS

HISTORY_TABLE = "`analytics-df-thd.CM_STAGE.EVENTS_SKU_DFC_ALLOCATIONS`"

# Bulk DC -> main DC, same normalization determine_multi_dc_assortment.sql uses.
# A factory's raw DC_NBR count can overcount by exactly the number of campus
# pairs it touches (e.g. both Perris Bulk and Main appearing for different
# SKUs) even when the strategy conceptually treats that campus as one
# building — folding before counting gives the count that actually matches
# how the team talks about "how many buildings."
_CAMPUS_NORMALIZE_CASE = "CASE DC_NBR WHEN 6006 THEN 6007 WHEN 6705 THEN 6777 ELSE DC_NBR END"

# The set of normalized DC numbers that represent a merged campus (the main
# side of each pair in CAMPUS_PAIRS) — used only to label them "(campus)" in
# the tier breakdown, consistent with how the rest of the app names them.
_CAMPUS_MAIN_DCS = set(CAMPUS_PAIRS.values())


def _dc_name(dc_nbr: int) -> str:
    base = DC_NAMES.get(dc_nbr, str(dc_nbr))
    return f"{base} (campus)" if dc_nbr in _CAMPUS_MAIN_DCS else base


def _dc_list_names(dc_list_key: str) -> str:
    return ", ".join(_dc_name(int(d)) for d in dc_list_key.split("-"))


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
    """
    event_name = (event_name or "").strip().upper()
    if not event_name:
        return {"found": False}

    params = [
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("max_year", "INT64", max_year),
    ]
    # IS_IMPORT is NULL ("unknown") for most pre-2026 rows, since it's only
    # derivable from FACTORY_ID being populated. Asymmetric handling on
    # purpose: a domestic ask treats "unknown" as still-eligible (those old
    # rows likely predate FACTORY_ID tracking entirely, not likely imports),
    # but an import ask requires the explicit TRUE — we shouldn't claim
    # something was an import just because we don't know it wasn't.
    if is_import == "true":
        is_import_filter = "AND IS_IMPORT = TRUE"
    elif is_import == "false":
        is_import_filter = "AND IS_IMPORT IS NOT TRUE"
    else:
        is_import_filter = ""

    year_rows = list(client.query(f"""
        SELECT MAX(EVENT_YEAR) AS latest_year
        FROM {HISTORY_TABLE}
        WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR <= @max_year {is_import_filter}
    """, job_config=bigquery.QueryJobConfig(query_parameters=params)).result())
    latest_year = year_rows[0].latest_year if year_rows else None
    if latest_year is None:
        return {"found": False}

    detail_params = params + [bigquery.ScalarQueryParameter("year", "INT64", latest_year)]
    detail_job_config = bigquery.QueryJobConfig(query_parameters=detail_params)

    # SKU identity: prefer THD_SKU_NBR, but some historical years (confirmed:
    # all 810 Patio 2026 rows) never had it populated at all — only SKU_NBR
    # is reliably present there. COALESCE to SKU_NBR rather than let the whole
    # composite key go NULL (which COUNT(DISTINCT ...) then silently drops,
    # undercounting to 0 instead of falling back).
    _sku_key = "COALESCE(THD_SKU_NBR, SKU_NBR)"

    overall_rows = list(client.query(f"""
        WITH factory_dc AS (
          SELECT THD_SKU_NBR, SKU_NBR, FACTORY_ID, DFC_UNITS, DFC_CUBE,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        )
        SELECT SUM(DFC_UNITS) AS total_units, SUM(DFC_CUBE) AS total_cube,
               -- The SKU key alone can undercount too: confirmed on real Patio
               -- 2027 data that the same SKU can legitimately appear under more
               -- than one FACTORY_ID (8 did, out of 361) — each factory's
               -- occurrence is its own planning record, matching how this app's
               -- own THD-key logic falls back to a composite key elsewhere.
               -- COALESCE the FACTORY_ID side too: CONCAT() returns NULL if ANY
               -- argument is NULL, and COUNT(DISTINCT ...) silently drops NULLs.
               COUNT(DISTINCT CONCAT({_sku_key}, '|', COALESCE(CAST(FACTORY_ID AS STRING), 'NA'))) AS distinct_thd_keys,
               COUNT(DISTINCT NORMALIZED_DC_NBR) AS normalized_dc_count
        FROM factory_dc
    """, job_config=detail_job_config).result())

    by_dc_rows = list(client.query(f"""
        SELECT DC_NBR, ANY_VALUE(DC_NAME) AS DC_NAME,
               SUM(DFC_UNITS) AS DC_UNITS, SUM(DFC_CUBE) AS DC_CUBE,
               COUNT(DISTINCT CONCAT({_sku_key}, '|', COALESCE(CAST(FACTORY_ID AS STRING), 'NA'))) AS DC_DISTINCT_THD_KEYS
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
          SELECT FACTORY_ID, DFC_UNITS, DFC_CUBE,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
            AND FACTORY_ID IS NOT NULL
        ),
        factory_list AS (
          SELECT FACTORY_ID,
                 COUNT(DISTINCT NORMALIZED_DC_NBR) AS DC_COUNT,
                 ARRAY_TO_STRING(
                   ARRAY_AGG(DISTINCT CAST(NORMALIZED_DC_NBR AS STRING) ORDER BY CAST(NORMALIZED_DC_NBR AS STRING)),
                   '-'
                 ) AS DC_LIST_KEY
          FROM factory_dc
          GROUP BY FACTORY_ID
        ),
        tier_lists AS (
          SELECT DC_COUNT, DC_LIST_KEY, COUNT(*) AS N_FACTORIES,
                 ROW_NUMBER() OVER (PARTITION BY DC_COUNT ORDER BY COUNT(*) DESC, DC_LIST_KEY) AS rn,
                 COUNT(*) OVER (PARTITION BY DC_COUNT) AS n_variants
          FROM factory_list
          GROUP BY DC_COUNT, DC_LIST_KEY
        ),
        canonical AS (
          SELECT DC_COUNT, DC_LIST_KEY, N_FACTORIES, n_variants
          FROM tier_lists WHERE rn = 1
        )
        SELECT c.DC_COUNT, c.N_FACTORIES, c.n_variants, fd.NORMALIZED_DC_NBR AS DC_NBR,
               SUM(fd.DFC_UNITS) AS UNITS, SUM(fd.DFC_CUBE) AS TOTAL_CUBE
        FROM canonical c
        JOIN factory_list fl ON fl.DC_COUNT = c.DC_COUNT AND fl.DC_LIST_KEY = c.DC_LIST_KEY
        JOIN factory_dc fd ON fd.FACTORY_ID = fl.FACTORY_ID
        GROUP BY c.DC_COUNT, c.N_FACTORIES, c.n_variants, fd.NORMALIZED_DC_NBR
        ORDER BY c.DC_COUNT DESC, UNITS DESC
    """, job_config=detail_job_config).result())

    tier_strategy = []
    for r in tier_dc_rows:
        tier_strategy.append({
            "dc_count": r.DC_COUNT,
            # Inferred, not recorded: DC_COUNT == 1 reads as a single-DC
            # strategy the same way this app's own strategy picker does.
            # STRATEGY_TYPE itself is only populated going forward.
            "strategy": "SINGLE - DC" if r.DC_COUNT == 1 else "MULTI - DC",
            # Y whenever this DC is the "main" side of a campus pair — the
            # only campus-pair signal available for backfilled history is
            # whether the data was folded at all, not a recorded user choice
            # (that's CAMPUS_PAIRS_USED, populated only for future runs).
            "campus_pair": "Y" if r.DC_NBR in _CAMPUS_MAIN_DCS else "N/A",
            "dc_nbr": r.DC_NBR,
            "dc_name": _dc_name(r.DC_NBR),
            "units": r.UNITS,
            "cube": r.TOTAL_CUBE,
            "n_factories": r.N_FACTORIES,
            "has_variants": r.n_variants > 1,
        })

    o = overall_rows[0]
    return {
        "found": True,
        "event_name": event_name,
        "event_year": latest_year,
        "overall": {
            "total_units": o.total_units,
            "total_cube": o.total_cube,
            "distinct_thd_keys": o.distinct_thd_keys,
            "normalized_dc_count": o.normalized_dc_count,
        },
        "tier_strategy": tier_strategy,
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
