"""Upload file validation logic with domestic vs import awareness."""

import math
import pandas as pd
from config import (
    TEMPLATE_COLUMNS_DOMESTIC, TEMPLATE_COLUMNS_IMPORT,
    NOT_NULL_DOMESTIC, NOT_NULL_IMPORT,
)

WAVE_COLS = ["WAVE_1", "WAVE_2", "WAVE_3", "WAVE_4", "WAVE_5"]


def _determine_thd_key(df, includes_imports):
    """Build the minimal composite key that makes all rows distinct."""
    key_cols = ["THD_SKU_NBR"]
    candidates = ["MVNDR_NBR"]
    if includes_imports:
        candidates.append("FACTORY_ID")
    candidates.extend(["SUPPLIER", "SKU_DESC", "BP", "BUY_UNITS",
                       "WAVE_1", "WAVE_2", "WAVE_3", "WAVE_4", "WAVE_5"])
    for col in candidates:
        if col not in df.columns:
            continue
        present = [c for c in key_cols if c in df.columns]
        if not df[present].duplicated().any():
            break
        key_cols.append(col)
    return key_cols


def validate_upload(df: pd.DataFrame, includes_imports: bool = False) -> dict:
    """Run validation checks. Returns {passed, checks, errors, summary}."""
    checks = []
    errors = []

    template_cols = TEMPLATE_COLUMNS_IMPORT if includes_imports else TEMPLATE_COLUMNS_DOMESTIC
    not_null_cols = NOT_NULL_IMPORT if includes_imports else NOT_NULL_DOMESTIC
    required_cols = [c["name"] for c in template_cols if c["required"]]

    # 1. Required columns present
    missing = [c for c in required_cols if c not in df.columns]
    missing_details = [{"row": "—", "column": m, "message": f"{m} missing from file", "row_data": {}} for m in missing]
    checks.append({
        "id": 1,
        "name": "Required columns present",
        "passed": len(missing) == 0,
        "detail": f"Missing: {', '.join(missing)}" if missing else "All required columns found",
        "details": missing_details,
    })
    if missing:
        for m in missing:
            errors.append({"row": "—", "column": m, "error": "Required column missing from file"})
        return {"passed": False, "checks": checks, "errors": errors, "summary": {}}

    # 2. No null required values
    null_errors = []
    for col in not_null_cols:
        if col in df.columns:
            nulls = df[df[col].isna() | (df[col].astype(str).str.strip() == "")]
            for idx in nulls.index:
                null_errors.append({
                    "row": int(idx) + 2,
                    "column": col,
                    "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                    "error": f"{col} cannot be null",
                })
    null_details = [{"row": e["row"], "column": e["column"], "message": e["error"], "row_data": e.get("row_data", {})} for e in null_errors]
    checks.append({
        "id": 2,
        "name": "No null required values",
        "passed": len(null_errors) == 0,
        "detail": f"{len(null_errors)} null value(s) found" if null_errors else "No nulls in required fields",
        "details": null_details,
    })
    errors.extend(null_errors)

    # 3. Numeric type checks (must be valid INT64)
    type_errors = []
    int_cols = ["THD_SKU_NBR", "MVNDR_NBR", "BP", "BUY_UNITS"]
    if includes_imports:
        int_cols.append("FACTORY_ID")
    if "SISTER_SKU_NBR" in df.columns:
        int_cols.append("SISTER_SKU_NBR")
    for col in int_cols:
        if col not in df.columns:
            continue
        for idx, val in df[col].items():
            if pd.isna(val) or str(val).strip() == "":
                continue
            try:
                v = int(float(str(val).strip()))
                if v < 0:
                    type_errors.append({
                        "row": int(idx) + 2, "column": col,
                        "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                        "error": f"{col} must be ≥ 0 (got {v})",
                    })
            except (ValueError, TypeError):
                type_errors.append({
                    "row": int(idx) + 2, "column": col,
                    "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                    "error": f"{col} must be an integer (got '{val}')",
                })
    # FACTORY_ID must be exactly 7 digits for imports
    if includes_imports and "FACTORY_ID" in df.columns:
        for idx, val in df["FACTORY_ID"].items():
            if pd.isna(val) or str(val).strip() == "":
                continue
            raw = str(val).strip()
            try:
                n = int(float(raw))
                s = str(n)
            except (ValueError, TypeError):
                s = raw
            if not s.isdigit() or len(s) != 7:
                type_errors.append({
                    "row": int(idx) + 2, "column": "FACTORY_ID",
                    "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                    "error": f"FACTORY_ID must be exactly 7 digits (got '{raw}')",
                })

    type_details = [{"row": e["row"], "column": e["column"], "message": e["error"], "row_data": e.get("row_data", {})} for e in type_errors]
    checks.append({
        "id": 3,
        "name": "Numeric type checks",
        "passed": len(type_errors) == 0,
        "detail": f"{len(type_errors)} type error(s)" if type_errors else "All numeric types valid",
        "details": type_details,
    })
    errors.extend(type_errors)

    # Snapshot the true raw BUY_UNITS sum BEFORE the BP-rounding step below
    # mutates df.at[idx, "BUY_UNITS"] in place — that mutation is real and
    # needed (downstream processing/inserts read the corrected df), but it
    # means summing df["BUY_UNITS"] afterward would already be summing the
    # rounded values, silently making "raw" and "optimal" identical below.
    raw_buy_units_snapshot = int(pd.to_numeric(df["BUY_UNITS"], errors="coerce").sum()) if "BUY_UNITS" in df.columns else 0

    # 4. BUY_UNITS divisible by BP + wave fix — warnings only (not blocking)
    bp_warnings = []
    wave_warnings = []
    present_waves = [w for w in WAVE_COLS if w in df.columns]
    if "BUY_UNITS" in df.columns and "BP" in df.columns:
        for idx in df.index:
            buy_raw = df.at[idx, "BUY_UNITS"]
            bp_raw = df.at[idx, "BP"]
            if pd.isna(buy_raw) or pd.isna(bp_raw):
                continue
            try:
                b = int(float(str(buy_raw).strip()))
                p = int(float(str(bp_raw).strip()))
            except (ValueError, TypeError):
                continue
            if p <= 0:
                continue

            optimal = b if b % p == 0 else math.ceil(b / p) * p

            # Fix waves to be BP-divisible and sum to optimal
            raw_waves = []
            for w in present_waves:
                v = df.at[idx, w]
                if pd.isna(v) or str(v).strip() == "":
                    raw_waves.append(0)
                else:
                    try:
                        raw_waves.append(int(float(str(v).strip())))
                    except (ValueError, TypeError):
                        raw_waves.append(0)

            has_waves = any(v > 0 for v in raw_waves)
            if has_waves:
                active_indices = [i for i, v in enumerate(raw_waves) if v > 0]
                floored = [(v // p) * p for v in raw_waves]
                remaining_packs = (optimal - sum(floored)) // p
                i = 0
                while remaining_packs > 0:
                    floored[active_indices[i % len(active_indices)]] += p
                    remaining_packs -= 1
                    i += 1
                while sum(floored) > optimal:
                    for j in range(len(active_indices) - 1, -1, -1):
                        if floored[active_indices[j]] >= p and sum(floored) > optimal:
                            floored[active_indices[j]] -= p
            else:
                floored = raw_waves[:]

            buy_changed = b != optimal
            waves_changed = has_waves and any(floored[wi] != raw_waves[wi] for wi in range(len(present_waves)))

            if buy_changed:
                df.at[idx, "BUY_UNITS"] = str(optimal)
                bp_warnings.append({
                    "row": int(idx) + 2, "column": "BUY_UNITS",
                    "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                    "message": f"BUY_UNITS rounded up from {b} to {optimal} (BP={p})",
                })
            if waves_changed:
                for wi, w in enumerate(present_waves):
                    df.at[idx, w] = str(floored[wi])
                old_waves = " | ".join(f"{present_waves[wi]}={raw_waves[wi]}" for wi in range(len(present_waves)) if raw_waves[wi] > 0)
                new_waves = " | ".join(f"{present_waves[wi]}={floored[wi]}" for wi in range(len(present_waves)) if floored[wi] > 0 or raw_waves[wi] > 0)
                wave_warnings.append({
                    "row": int(idx) + 2, "column": "WAVES",
                    "row_data": {c: str(df.at[idx, c]) if pd.notna(df.at[idx, c]) else "" for c in df.columns},
                    "message": f"Waves adjusted: [{old_waves}] → [{new_waves}]",
                })

    checks.append({
        "id": 4,
        "name": "BUY_UNITS divisible by BP",
        "passed": True,
        "detail": f"{len(bp_warnings)} row(s) rounded up to nearest BP multiple" if bp_warnings else "All rows pass",
        "warning": len(bp_warnings) > 0,
        "details": bp_warnings,
    })
    checks.append({
        "id": "4b",
        "name": "Waves divisible by BP",
        "passed": True,
        "detail": f"{len(wave_warnings)} row(s) had waves redistributed" if wave_warnings else "All waves pass",
        "warning": len(wave_warnings) > 0,
        "details": wave_warnings,
    })

    # 5. EVENT_NAME consistency
    event_error = []
    if "EVENT_NAME" in df.columns:
        unique_events = df["EVENT_NAME"].dropna().unique()
        if len(unique_events) > 1:
            event_error.append({
                "row": "—", "column": "EVENT_NAME",
                "error": f"Multiple EVENT_NAMEs found: {', '.join(str(e) for e in unique_events)}",
            })
    event_details = [{"row": e["row"], "column": e["column"], "message": e["error"], "row_data": e.get("row_data", {})} for e in event_error]
    checks.append({
        "id": 5,
        "name": "EVENT_NAME consistency",
        "passed": len(event_error) == 0,
        "detail": "Multiple events found" if event_error else "Single EVENT_NAME confirmed",
        "details": event_details,
    })
    errors.extend(event_error)

    # 6. THD_KEY uniqueness — composite key must be distinct
    thd_key_cols = _determine_thd_key(df, includes_imports)
    present_key_cols = [c for c in thd_key_cols if c in df.columns]
    key_errors = []
    key_label = " + ".join(thd_key_cols)
    if present_key_cols:
        check_df = df[present_key_cols].fillna("__NULL__")
        dupes = df[check_df.duplicated(keep=False)]
        seen = set()
        for idx, row in dupes.iterrows():
            key = tuple(str(row.get(c, "")) for c in present_key_cols)
            if key in seen:
                key_errors.append({
                    "row": int(idx) + 2,
                    "column": key_label,
                    "error": f"Duplicate THD_KEY ({key_label}): {' | '.join(str(row.get(c,'')) for c in present_key_cols)}",
                })
            else:
                seen.add(key)
    key_details = [{"row": e["row"], "column": e["column"], "message": e["error"], "row_data": e.get("row_data", {})} for e in key_errors]
    checks.append({
        "id": 6,
        "name": f"THD_KEY distinct ({key_label})",
        "passed": len(key_errors) == 0,
        "detail": f"{len(key_errors)} duplicate(s)" if key_errors else "All rows distinct",
        "details": key_details,
    })
    errors.extend(key_errors)

    passed = all(c["passed"] for c in checks)

    summary = {}
    if passed:
        # Optimal BUY_UNITS: round each row up to nearest BP multiple
        optimal_buy = 0
        if "BUY_UNITS" in df.columns and "BP" in df.columns:
            for _, row in df.iterrows():
                buy = row.get("BUY_UNITS")
                bp = row.get("BP")
                if pd.notna(buy) and pd.notna(bp) and int(float(bp)) > 0:
                    b, p = int(float(buy)), int(float(bp))
                    optimal_buy += b if b % p == 0 else math.ceil(b / p) * p
                elif pd.notna(buy):
                    optimal_buy += int(float(buy))

        # Total Buy Units: the raw quantity exactly as uploaded (the snapshot
        # taken above, before the BP-rounding step mutated df in place) —
        # NOT re-read from df here, which by this point holds the rounded
        # values. Optimal Buy Units: each row rounded up to its own BP
        # multiple (what will actually ship, since orders can only move in
        # whole buy packs) — shown alongside Total Buy Units with
        # buy_units_delta as the difference, not in place of the raw total.
        summary = {
            "row_count": len(df),
            "total_buy_units": raw_buy_units_snapshot,
            "buy_units_delta": optimal_buy - raw_buy_units_snapshot,
            "optimal_buy_units": optimal_buy,
            "unique_suppliers": int(df["SUPPLIER"].nunique()) if "SUPPLIER" in df.columns else 0,
            "event_name": str(df["EVENT_NAME"].iloc[0]) if "EVENT_NAME" in df.columns and len(df) > 0 else "",
            "thd_key_columns": thd_key_cols,
        }
        if includes_imports and "FACTORY_ID" in df.columns:
            summary["unique_factories"] = int(df["FACTORY_ID"].nunique())
            df_work = df[["FACTORY_ID", "THD_SKU_NBR", "MVNDR_NBR", "BUY_UNITS", "BP"]].copy()
            df_work["OPT_BUY"] = df_work.apply(
                lambda r: math.ceil(int(float(r["BUY_UNITS"])) / int(float(r["BP"]))) * int(float(r["BP"]))
                if pd.notna(r["BUY_UNITS"]) and pd.notna(r["BP"]) and int(float(r["BP"])) > 0
                else (int(float(r["BUY_UNITS"])) if pd.notna(r["BUY_UNITS"]) else 0),
                axis=1,
            )
            df_work["THD_KEY"] = df_work["THD_SKU_NBR"].astype(str) + "|" + df_work["MVNDR_NBR"].astype(str)
            dist = df_work.groupby("FACTORY_ID").agg(
                sku_count=("THD_KEY", "nunique"),
                optimal_buy_units=("OPT_BUY", "sum"),
            ).reset_index()
            summary["factory_distribution"] = [
                {"factory_id": int(r["FACTORY_ID"]), "sku_count": int(r["sku_count"]),
                 "optimal_buy_units": int(r["optimal_buy_units"]), "factory_cube": 0}
                for _, r in dist.iterrows()
            ]

    return {"passed": passed, "checks": checks, "errors": errors, "warnings": bp_warnings + wave_warnings, "summary": summary}
