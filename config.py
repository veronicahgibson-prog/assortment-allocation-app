"""BigQuery project/dataset/table constants and app configuration."""

PROJECT_ID = "analytics-df-thd"
DATASET = "CM_STAGE"
TEMP_DATASET = "CM_TEMP"

EVENTS_SKU_LIST = f"`{PROJECT_ID}.{DATASET}.EVENTS_SKU_LIST`"
CATALOG_RUN_ALT = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_RUN_BY_SKU_ALT`"
CATALOG_RUN_GROUP = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_RUN_BY_GROUP`"
CATALOG_RUN_ANALYTICS = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_RUN_BY_SKU_ANALYTICS`"
WEEKLY_RUNS_LOG = f"`{PROJECT_ID}.{DATASET}.OBC_CTLG_WEEKLY_RUNS_SKU_LOG`"
DC_MODEL_PARAMS = f"`{PROJECT_ID}.{DATASET}.OBC_LOG_SKU_DC_MODEL_PARAMS`"
VENDOR_STRATEGY = f"`{PROJECT_ID}.{DATASET}.VENDOR_ALIGNED_STRATEGY`"
DFC_COST_MODEL_SUBMISSION = f"`{PROJECT_ID}.{DATASET}.DFC_COST_MODEL_SUBMISSION`"
ALLOCATION_PROC = f"`{PROJECT_ID}.{DATASET}.run_dynamic_allocation`"
# Retired in favor of UNIFIED_ALLOCATION_PROC below — each resolved CAMP_ASMT_ID
# live at allocation time from a stored/stale column or param instead of the
# assortment tool's own output tables, so an edited DC selection (Move-to,
# deselecting a DC) had no effect on the actual allocation. Left defined,
# unreferenced, rather than dropped from BigQuery (shared warehouse).
VENDOR_ALIGNED_PROC = f"`{PROJECT_ID}.{DATASET}.run_vendor_aligned_allocation`"
SINGLE_DC_PROC = f"`{PROJECT_ID}.{DATASET}.run_single_dc_allocation`"
MULTI_DC_PROC = f"`{PROJECT_ID}.{DATASET}.run_multi_dc_allocation`"
UNIFIED_ALLOCATION_PROC = f"`{PROJECT_ID}.{DATASET}.run_allocation_unified`"
SKU_DC_ELIGIBILITY = f"`{PROJECT_ID}.{DATASET}.OBC_CTLG_SKU_DC`"

# OBC weekly cost-model pipeline (formerly three manual notebook/dashboard
# steps — see _run_obc_pipeline in app.py): pre-processing/safety-stock,
# per-wave/batch outbound cost computation, then post-processing.
OBC_RUN_KEYS_VIEW = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_LATEST_WEEKLY_RUN_KEYS`"
OBC_PRE_PROC = f"`{PROJECT_ID}.{DATASET}.OBC_P_CTLG_WEEKLY_RUN_PRE`"
OBC_POST_PROC = f"`{PROJECT_ID}.{DATASET}.OBC_P_CTLG_WEEKLY_RUN_POST`"
OBC_COST_BATCH_PROC = f"`{PROJECT_ID}.{DATASET}.OBC_P_COST_OB_BATCH`"
FINAL_ALLOCATIONS = f"`{PROJECT_ID}.{TEMP_DATASET}.FINAL_ALLOCATIONS_WIDE`"
UNALLOCATED_RECORDS = f"`{PROJECT_ID}.{TEMP_DATASET}.UNALLOCATED_RECORDS`"
FACTORY_UTILIZATION = f"`{PROJECT_ID}.{TEMP_DATASET}.FACTORY_UTILIZATION`"
SCHN_SKU_ATTR = "`pr-edw-views-thd.SCHN_CURATED.SCHN_SKU_ATTR`"
# Combo-type lookup (e.g. "VAS - Blind") used only to force a BULK stocking
# type classification for certain vendor value-add setups — see
# api_classify_stock_type in app.py.
DF_SKU_COMBO_CLT = "`analytics-supplychain-thd.DF_IPR_BI.DF_SKU_COMBO_CLT`"

# MULTI_DC ladder flow: SKUs the winning (or campus-merged) assortment at a
# factory's chosen tier still didn't price, and the lightweight procedure that
# reroutes one to its own independent assortment without rerunning the ladder.
ASSORTMENT_DC_COVERAGE_GAPS = f"`{PROJECT_ID}.{TEMP_DATASET}.ASSORTMENT_DC_COVERAGE_GAPS`"
RESOLVE_PROBLEM_SKU_PROC = f"`{PROJECT_ID}.{DATASET}.resolve_problem_sku_override`"

CONTAINER_DIVISOR = 2390
DEFAULT_FALLBACK_ASMT_ID = 216050
MAX_UPLOAD_MB = 10

# Domestic template — no FACTORY_ID
# SUPPLIER and MVNDR_NBR are both optional at upload time: SUPPLIER is only
# actually required if the user follows a Vendor-Aligned strategy in Step 2
# (enforced there by /api/match_vendor_strategy, not here — the strategy
# isn't even chosen yet when the file is uploaded), and MVNDR_NBR was only
# ever required to help make an ambiguous SKU list (e.g. Patio) distinct —
# _determine_thd_key in validators.py already falls back to SKU_DESC/BP/
# BUY_UNITS/WAVE_* to disambiguate rows when MVNDR_NBR isn't provided.
TEMPLATE_COLUMNS_DOMESTIC = [
    {"name": "EVENT_NAME",      "type": "STRING",  "required": True},
    {"name": "EVENT_YEAR",      "type": "INT64",   "required": True},
    {"name": "THD_SKU_NBR",     "type": "INT64",   "required": True},
    {"name": "SISTER_SKU_NBR",  "type": "INT64",   "required": False, "note": "Required if net new SKU"},
    {"name": "SKU_DESC",        "type": "STRING",  "required": True},
    {"name": "SUPPLIER",        "type": "STRING",  "required": False, "note": "Required for Vendor-Aligned strategy"},
    {"name": "MVNDR_NBR",       "type": "INT64",   "required": False},
    {"name": "BP",              "type": "INT64",   "required": True},
    {"name": "BUY_UNITS",       "type": "INT64",   "required": True},
    {"name": "WAVE_1",          "type": "INT64",   "required": False},
    {"name": "WAVE_2",          "type": "INT64",   "required": False},
    {"name": "WAVE_3",          "type": "INT64",   "required": False},
    {"name": "WAVE_4",          "type": "INT64",   "required": False},
    {"name": "WAVE_5",          "type": "INT64",   "required": False},
]

# Import template — includes FACTORY_ID
TEMPLATE_COLUMNS_IMPORT = [
    {"name": "EVENT_NAME",      "type": "STRING",  "required": True},
    {"name": "EVENT_YEAR",      "type": "INT64",   "required": True},
    {"name": "THD_SKU_NBR",     "type": "INT64",   "required": True},
    {"name": "SISTER_SKU_NBR",  "type": "INT64",   "required": False, "note": "Required if net new SKU"},
    {"name": "SKU_DESC",        "type": "STRING",  "required": True},
    {"name": "SUPPLIER",        "type": "STRING",  "required": False, "note": "Required for Vendor-Aligned strategy"},
    {"name": "MVNDR_NBR",       "type": "INT64",   "required": False},
    {"name": "FACTORY_ID",      "type": "INT64",   "required": True},
    {"name": "BP",              "type": "INT64",   "required": True},
    {"name": "BUY_UNITS",       "type": "INT64",   "required": True},
    {"name": "WAVE_1",          "type": "INT64",   "required": False},
    {"name": "WAVE_2",          "type": "INT64",   "required": False},
    {"name": "WAVE_3",          "type": "INT64",   "required": False},
    {"name": "WAVE_4",          "type": "INT64",   "required": False},
    {"name": "WAVE_5",          "type": "INT64",   "required": False},
]


# THD_SKU_NBR is deliberately excluded here: it may be null for a net-new SKU
# as long as SISTER_SKU_NBR is populated (see the paired THD_SKU_NBR/
# SISTER_SKU_NBR check in validators.py and the SKU-age check in app.py,
# which is what actually decides whether the populated side has >= 365 days
# of history). SUPPLIER is excluded too — it's optional at upload time and
# only enforced when the user actually picks Vendor-Aligned in Step 2 (see
# /api/match_vendor_strategy, which errors if no SUPPLIER data is present).
# MVNDR_NBR is excluded for a different reason: validators.py fills a blank
# MVNDR_NBR with a proxy value (distinct from every real MVNDR_NBR in the
# file) before this list is ever checked, so it can never be null by the time
# it matters — see the proxy-fill step there.
NOT_NULL_DOMESTIC = ["EVENT_NAME", "EVENT_YEAR", "SKU_DESC", "BP", "BUY_UNITS"]
NOT_NULL_IMPORT = ["EVENT_NAME", "EVENT_YEAR", "SKU_DESC", "FACTORY_ID", "BP", "BUY_UNITS"]

# Allowed DFCs per event
ALLOWED_DFCS = {
    "GIFT CENTER": [5820, 5823, 5829, 5832, 5854, 5855, 5857, 5882, 6007, 6707, 6760, 6777],
    "PATIO":       [5523, 5823, 5832, 5841, 5857, 5882, 6006, 6007, 6705, 6707, 6760, 6777],
}

DC_NAMES = {
    5523: "Columbus",
    5820: "Chicago",
    5823: "Dallas",
    5829: "Baltimore",
    5831: "Houston",
    5832: "Lacey",
    5841: "Miami",
    5854: "Newark",
    5855: "Tampa",
    5857: "Tracy",
    5860: "Atlanta",
    5882: "Boston",
    6006: "Perris Bulk",
    6007: "Perris",
    6705: "Locust Grove Bulk",
    6707: "Troy",
    6760: "Hagerstown",
    6777: "Locust Grove",
}

# Campus pairs (interchangeable for cascade normalization)
CAMPUS_PAIRS = {
    6705: 6777,  # Locust Grove Bulk → Main
    6006: 6007,  # Perris Bulk → Main
}

STRATEGY_KEYS = [
    "VENDOR_ALIGNED",
    "SINGLE_DC",
    "MULTI_DC",
    "DC_SELECTION",
]
