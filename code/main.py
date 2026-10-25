#!/usr/bin/env python3
import csv
import json
import re
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "dataset"

DELETE_KEYWORDS = [
    "delete", "deletion", "erase", "erasure", "remove account", "close my account",
    "delete my account", "permanently delete", "remove my profile", "delete profile",
    "account deletion", "close account permanently"
]

NON_DELETE_KEYWORDS = [
    "access my data", "download my data", "export my data", "correct my profile",
    "update my profile", "unsubscribe", "opt out", "marketing opt-out",
    "change my email", "change my phone", "access request", "data request",
    "rectify", "fix my account"
]

def parse_iso(ts):
    if ts is None:
        return None
    ts = ts.replace("Z", "+00:00")
    return datetime.fromisoformat(ts)

def load_identity_aliases():
    current = {}
    with open(DATASET / "user_identities.csv", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            user_id = row["user_id"]
            current[user_id] = {
                "name": row["name"],
                "email": row["email"],
                "phone": row["phone"],
                "email_hash": row["email_hash"],
            }
    audits = []
    with open(DATASET / "user_audit_log.csv", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            audits.append(row)

    alias_map = {}
    for user_id, info in current.items():
        alias_map.setdefault(user_id, set()).update({
            info["email"], info["phone"], info["email_hash"]
        })
    for row in audits:
        user_id = row["user_id"]
        alias_map.setdefault(user_id, set())
        if row["field_name"] in {"email", "phone"}:
            alias_map[user_id].add(row["old_value"])
            alias_map[user_id].add(row["new_value"])
        if row["field_name"] == "email_hash":
            alias_map[user_id].add(row["old_value"])
            alias_map[user_id].add(row["new_value"])

    email_to_user = {}
    for user_id, aliases in alias_map.items():
        for a in aliases:
            if a:
                email_to_user.setdefault(a.lower(), set()).add(user_id)

    return current, alias_map, email_to_user

def request_authorizes_deletion(text):
    t = (text or "").lower()
    if any(k in t for k in NON_DELETE_KEYWORDS):
        return False
    if any(k in t for k in DELETE_KEYWORDS):
        return True
    # Safe default for challenge-style deletion requests
    if "delete" in t or "remove" in t or "erase" in t or "close" in t:
        return True
    return False

def find_user_candidates(email, identities, alias_map, email_to_user):
    candidates = set()
    key = (email or "").strip().lower()
    if key:
        candidates |= email_to_user.get(key, set())
    for user_id, info in identities.items():
        if info["email"] and info["email"].lower() == key:
            candidates.add(user_id)
        if info["phone"] and info["phone"] == email:
            candidates.add(user_id)
    return candidates

def build_steps(status, findings=None, remediation=None, verification=None):
    steps = []
    findings = findings or []
    remediation = remediation or []
    verification = verification or []

    if status == "NOT_APPLICABLE":
        return []

    # Default ordering: findings, remediation, verification
    for i, step in enumerate(findings, start=1):
        step["step_no"] = i
        step["phase"] = "FINDING"
        steps.append(step)
    for i, step in enumerate(remediation, start=1):
        step["step_no"] = len(findings) + i
        step["phase"] = "REMEDIATION"
        steps.append(step)
    for i, step in enumerate(verification, start=1):
        step["step_no"] = len(findings) + len(remediation) + i
        step["phase"] = "VERIFICATION"
        steps.append(step)

    return steps

def main():
    identities, alias_map, email_to_user = load_identity_aliases()

    requests_path = DATASET / "deletion_requests.csv"
    out_path = ROOT / "output.csv"

    with open(requests_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        rows = list(reader)

    output_rows = []

    for row in sorted(rows, key=lambda r: r["case_id"]):
        case_id = row["case_id"]
        email = (row["email"] or "").strip()
        request_text = row["request_text"] or ""

        if not request_authorizes_deletion(request_text):
            output_rows.append({
                "case_id": case_id,
                "deletion_status": "NOT_APPLICABLE",
                "steps_json": "[]",
            })
            continue

        # In the real challenge you must match the actual user identity to the actual evidence and system activity.
        # This is a placeholder classifier to keep the pipeline deterministic and runnable.
        user_candidates = find_user_candidates(email, identities, alias_map, email_to_user)

        # Default incomplete status for requests that appear to be valid deletion requests.
        # Replace this with evidence-grounded reconstruction using system_activity + evidence_files + SQL/text evidence.
        status = "INCOMPLETE"

        findings = [
            {
                "system_id": "account_service",
                "resource_id": "account_unknown",
                "operation": "REPORT_REMAINING_RECORD",
                "state": "PRESENT",
                "evidence_id": ""
            }
        ]
        remediation = [
            {
                "system_id": "account_service",
                "resource_id": "account_unknown",
                "operation": "DELETE_RECORD",
                "state": "ABSENT",
                "evidence_id": ""
            }
        ]
        verification = [
            {
                "system_id": "account_service",
                "resource_id": "account_unknown",
                "operation": "VERIFY_RECORD_ABSENT",
                "state": "ABSENT",
                "evidence_id": ""
            }
        ]

        steps = build_steps(status, findings, remediation, verification)
        output_rows.append({
            "case_id": case_id,
            "deletion_status": status,
            "steps_json": json.dumps(steps, separators=(",", ":"))
        })

    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["case_id", "deletion_status", "steps_json"])
        for row in output_rows:
            writer.writerow([row["case_id"], row["deletion_status"], row["steps_json"]])

    print(f"Wrote {len(output_rows)} rows to {out_path}")

if __name__ == "__main__":
    main()
