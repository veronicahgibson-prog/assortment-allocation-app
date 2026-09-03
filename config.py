"""BigQuery project/dataset/table constants and app configuration."""

PROJECT_ID = "analytics-df-thd"
DATASET = "CM_STAGE"
TEMP_DATASET = "CM_TEMP"

EVENTS_SKU_LIST = f"`{PROJECT_ID}.{DATASET}.EVENTS_SKU_LIST`"
CATALOG_RUN_ALT = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_RUN_BY_SKU_ALT`"
CATALOG_RUN_ANALYTICS = f"`{PROJECT_ID}.{DATASET}.OBC_V_CTLG_RUN_BY_SKU_ANALYTICS`"
WEEKLY_RUNS_LOG = f"`{PROJECT_ID}.{DATASET}.OBC_CTLG_WEEKLY_RUNS_SKU_LOG`"
DC_MODEL_PARAMS = f"`{PROJECT_ID}.{DATASET}.OBC_LOG_SKU_DC_MODEL_PARAMS`"
VENDOR_STRATEGY = f"`{PROJECT_ID}.{DATASET}.VENDOR_ALIGNED_STRATEGY`"
DFC_COST_MODEL_SUBMISSION = f"`{PROJECT_ID}.{DATASET}.DFC_COST_MODEL_SUBMISSION`"
ALLOCATION_PROC = f"`{PROJECT_ID}.{DATASET}.run_dynamic_allocation`"
VENDOR_ALIGNED_PROC = f"`{PROJECT_ID}.{DATASET}.run_vendor_aligned_allocation`"
SINGLE_DC_PROC = f"`{PROJECT_ID}.{DATASET}.run_single_dc_allocation`"
MULTI_DC_PROC = f"`{PROJECT_ID}.{DATASET}.run_multi_dc_allocation`"
FINAL_ALLOCATIONS = f"`{PROJECT_ID}.{TEMP_DATASET}.FINAL_ALLOCATIONS_WIDE`"
UNALLOCATED_RECORDS = f"`{PROJECT_ID}.{TEMP_DATASET}.UNALLOCATED_RECORDS`"
FACTORY_UTILIZATION = f"`{PROJECT_ID}.{TEMP_DATASET}.FACTORY_UTILIZATION`"
SCHN_SKU_ATTR = "`pr-edw-views-thd.SCHN_CURATED.SCHN_SKU_ATTR`"

CONTAINER_DIVISOR = 2390
DEFAULT_FALLBACK_ASMT_ID = 216050
MAX_UPLOAD_MB = 10

# Domestic template — no FACTORY_ID
TEMPLATE_COLUMNS_DOMESTIC = [
    {"name": "EVENT_NAME",      "type": "STRING",  "required": True},
    {"name": "EVENT_YEAR",      "type": "INT64",   "required": True},
    {"name": "THD_SKU_NBR",     "type": "INT64",   "required": True},
    {"name": "SISTER_SKU_NBR",  "type": "INT64",   "required": False, "note": "Required if net new SKU"},
    {"name": "SKU_DESC",        "type": "STRING",  "required": True},
    {"name": "SUPPLIER",        "type": "STRING",  "required": True},
    {"name": "MVNDR_NBR",       "type": "INT64",   "required": True},
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
    {"name": "SUPPLIER",        "type": "STRING",  "required": True},
    {"name": "MVNDR_NBR",       "type": "INT64",   "required": True},
    {"name": "FACTORY_ID",      "type": "INT64",   "required": True},
    {"name": "BP",              "type": "INT64",   "required": True},
    {"name": "BUY_UNITS",       "type": "INT64",   "required": True},
    {"name": "WAVE_1",          "type": "INT64",   "required": False},
    {"name": "WAVE_2",          "type": "INT64",   "required": False},
    {"name": "WAVE_3",          "type": "INT64",   "required": False},
    {"name": "WAVE_4",          "type": "INT64",   "required": False},
    {"name": "WAVE_5",          "type": "INT64",   "required": False},
]

NOT_NULL_DOMESTIC = ["EVENT_NAME", "EVENT_YEAR", "THD_SKU_NBR", "SKU_DESC", "SUPPLIER", "MVNDR_NBR", "BP", "BUY_UNITS"]
NOT_NULL_IMPORT = ["EVENT_NAME", "EVENT_YEAR", "THD_SKU_NBR", "SKU_DESC", "SUPPLIER", "MVNDR_NBR", "FACTORY_ID", "BP", "BUY_UNITS"]

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
    5938: "Mexico, MO",
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
