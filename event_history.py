"""Prior-year event strategy lookups from the enterprise historical allocation
table (not this app's own CM_TEMP scratch tables) — EVENTS_SKU_DFC_ALLOCATIONS.
Backfilled with EVENT_NAME/EVENT_YEAR/IS_IMPORT this session; see
alter_events_dfc_allocations.sql for the schema history.
"""
from google.cloud import bigquery
from config import DC_NAMES, CAMPUS_PAIRS, EVENTS_SKU_LIST, VENDOR_STRATEGY

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


def _attach_vendor_strategy(client: bigquery.Client, supplier_rows) -> list:
    """Pair each supplier with its VENDOR_ALIGNED_STRATEGY row so the DC count
    and DC list shown are the vendor's aligned strategy, not whatever DCs the
    historical rows happened to touch. Uses the same substring rule as
    /api/match_vendor_strategy so Step 1 and Step 2 can't disagree about which
    vendor a supplier belongs to."""
    vs_rows = [dict(r) for r in client.query(
        f"SELECT VENDOR, ASMT_ID, DC_COUNT, DC_LIST, DC_NM_LIST FROM {VENDOR_STRATEGY}"
    ).result()]
    other = next((v for v in vs_rows if (v["VENDOR"] or "").upper() == "OTHER"), None)

    out = []
    for r in supplier_rows:
        supplier = r.SUPPLIER
        sup_upper = supplier.upper().strip()
        match = next(
            (v for v in vs_rows if (v["VENDOR"] or "").upper().strip() in sup_upper),
            None,
        ) if supplier != "Unknown" else None
        # "Unknown" means the SKU never appeared in an uploaded list for this
        # event, so there's no supplier name to match on at all — distinct from
        # a real supplier that simply has no vendor-specific strategy.
        if match is None and supplier != "Unknown":
            match = other
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
    """
    event_name = (event_name or "").strip().upper()
    if not event_name:
        return {"found": False}

    params = [
        bigquery.ScalarQueryParameter("event_name", "STRING", event_name),
        bigquery.ScalarQueryParameter("max_year", "INT64", max_year),
    ]
    # Use the explicit flag for both event types. A Domestic request must not
    # include NULL/unknown rows, because an event can contain separate import
    # and domestic records in the same year.
    if is_import == "true":
        is_import_filter = "AND IS_IMPORT = TRUE"
    elif is_import == "false":
        is_import_filter = "AND IS_IMPORT = FALSE"
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
          SELECT THD_SKU_NBR, SKU_NBR, FACTORY_ID, STRATEGY_TYPE, DFC_UNITS, DFC_CUBE,
                 {_CAMPUS_NORMALIZE_CASE} AS NORMALIZED_DC_NBR
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        )
        SELECT ANY_VALUE(STRATEGY_TYPE) AS strategy_type,
               SUM(DFC_UNITS) AS total_units, SUM(DFC_CUBE) AS total_cube,
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

    strategy_type = overall_rows[0].strategy_type
    strategy_summary = []
    if strategy_type and strategy_type.upper() == "VENDOR-ALIGNED":
        vendor_rows = client.query(f"""
            SELECT SUPPLIER AS vendor,
                   COUNT(DISTINCT DC_NBR) AS dc_count,
                   ARRAY_TO_STRING(ARRAY_AGG(DISTINCT CAST(DC_NBR AS STRING) ORDER BY CAST(DC_NBR AS STRING)), ', ') AS dc_list
            FROM {HISTORY_TABLE}
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
              AND SUPPLIER IS NOT NULL
            GROUP BY SUPPLIER
            ORDER BY vendor
        """, job_config=detail_job_config).result()
        strategy_summary = [{
            "vendor": r.vendor,
            "dc_count": r.dc_count,
            "dc_list": r.dc_list,
        } for r in vendor_rows]
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
                 CONCAT({_sku_key}, '|', COALESCE(CAST(FACTORY_ID AS STRING), 'NA')) AS THD_KEY
          FROM {HISTORY_TABLE}
          WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year {is_import_filter}
        ),
        -- A SKU can be listed under either key, and ANY_VALUE collapses the
        -- rare SKU that appears under two suppliers so the join can't
        -- double-count it into both.
        sku_supplier AS (
          SELECT sku, ANY_VALUE(SUPPLIER) AS SUPPLIER
          FROM (
            SELECT SUPPLIER, sku
            FROM {EVENTS_SKU_LIST}, UNNEST([THD_SKU_NBR, SKU_NBR]) AS sku
            WHERE UPPER(EVENT_NAME) = @event_name AND EVENT_YEAR = @year
              AND SUPPLIER IS NOT NULL AND sku IS NOT NULL
          )
          GROUP BY sku
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
        "overall": {
            "strategy_type": strategy_type,
            "total_units": o.total_units,
            "total_cube": o.total_cube,
            "distinct_thd_keys": o.distinct_thd_keys,
            "normalized_dc_count": o.normalized_dc_count,
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
