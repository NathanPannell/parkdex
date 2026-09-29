#!/usr/bin/env python3
"""Build fail-closed visual publication decisions from frozen boundary rights evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


BOUNDARY_SHA256 = "0eb64ae05370800570a29d4011fdb3455548b0d3f6cf38607cece968475da410"
REGIONAL_IMPORT_SHA256 = "4f15ab2f54739979ccbb35fda33f0d1494fcde5ccf7d5d1303b5efc3587a0b75"
AGGREGATE_SUFFIX = " via BC Local and Regional Greenspaces"
APPROVED_SOURCE_CLASSES = {
    "BC Parks / DataBC — TANTALIS protected areas": "BC Parks / DataBC TANTALIS",
    "Natural Resources Canada — Canada Lands Survey System": "Natural Resources Canada",
    "OpenStreetMap contributors": "OpenStreetMap contributors",
    "Regional District of Nanaimo — Regional Parks spatial data": "Regional District of Nanaimo",
    "Regional District of Fraser-Fort George Regional Parks GIS": "Regional District of Fraser-Fort George",
}


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _checked_records(records: list[dict], label: str) -> dict[str, dict]:
    by_id = {}
    for record in records:
        place_id = record.get("id")
        if not isinstance(place_id, str) or place_id in by_id:
            raise ValueError(f"{label} has an invalid or repeated place ID")
        by_id[place_id] = record
    return by_id


def _match_aggregate_record(properties: dict, imported: list[dict]) -> dict:
    matches = [
        record
        for imported_feature in imported
        if imported_feature["properties"]["name"].casefold() == properties["name"].casefold()
        and properties["sourceId"] in imported_feature["properties"]["sourceIds"]
        for record in imported_feature["properties"]["sourceRecords"]
        if str(record["sourceId"]) == properties["sourceId"]
    ]
    if len(matches) != 1:
        raise ValueError(f"{properties['id']}: frozen aggregate source record is not unique")
    return matches[0]


def make_manifest(boundaries_path: Path, regional_import_path: Path, audit_path: Path) -> dict:
    if file_sha256(boundaries_path) != BOUNDARY_SHA256:
        raise ValueError("Boundary snapshot differs from the frozen reviewed input")
    if file_sha256(regional_import_path) != REGIONAL_IMPORT_SHA256:
        raise ValueError("Regional import differs from the frozen reviewed input")

    boundaries = json.loads(boundaries_path.read_text(encoding="utf-8"))["features"]
    imported = json.loads(regional_import_path.read_text(encoding="utf-8"))["features"]
    audit = json.loads(audit_path.read_text(encoding="utf-8"))
    if len(boundaries) != 1030 or len(imported) != 263:
        raise ValueError("Frozen boundary or regional source feature count changed")
    if audit.get("schemaVersion") != 1 or audit.get("sourceSnapshot", {}).get("sha256") != BOUNDARY_SHA256:
        raise ValueError("Rights audit does not identify the frozen boundary snapshot")
    if audit.get("sourceEvidenceSnapshot", {}).get("sha256") != REGIONAL_IMPORT_SHA256:
        raise ValueError("Rights audit does not identify the frozen regional import")
    totals = audit.get("totals", {})
    if (totals.get("held"), totals.get("approvedAggregateOgl"), totals.get("currentPublicationEligible")) != (218, 46, 812):
        raise ValueError("Rights audit current eligibility differs from the reviewed 812/218 split")
    held = _checked_records(audit["held"], "rights audit holds")
    provisional = _checked_records(audit["provisionalApprovedAggregateOgl"], "provisional aggregate rows")
    if len(held) != 218 or len(provisional) != 46 or set(held) & set(provisional):
        raise ValueError("Rights audit held and provisional IDs conflict")
    credits = _checked_records(
        [{**record, "id": record["sourceName"]} for record in audit["approvedAttributionDefaults"]],
        "approved attribution defaults",
    )
    if set(credits) != set(APPROVED_SOURCE_CLASSES.values()):
        raise ValueError("Approved source attribution classes changed")
    family_reviews = _checked_records(
        [{**record, "id": record["provider"]} for record in audit["aggregateExplicitLicenseFamilyReview"]],
        "provider family reviews",
    )
    if len(family_reviews) != 6 or any(
        review.get("termsReview") != "verified" or review.get("status") != "approved"
        or not isinstance(review.get("rightsAttribution"), str) or not review["rightsAttribution"].strip()
        or not isinstance(review.get("licenseUrl"), str) or not review["licenseUrl"].strip()
        for review in family_reviews.values()
    ):
        raise ValueError("All six aggregate provider licence families must be verified")

    decisions = {}
    aggregate_blank = 0
    aggregate_provisional = 0
    direct_held = 0
    for feature in boundaries:
        properties = feature["properties"]
        place_id = properties["id"]
        if place_id in decisions:
            raise ValueError(f"Repeated boundary place ID: {place_id}")
        source_name = properties["sourceName"]
        source = {field: properties[field] for field in ("sourceName", "sourceUrl", "sourceId")}
        audit_row = held.get(place_id) or provisional.get(place_id)
        if audit_row is not None:
            if any(audit_row.get(field) != properties.get(field) for field in ("name", "category", *source)):
                raise ValueError(f"{place_id}: audit source identity differs from frozen boundary")

        if place_id in held:
            reason = held[place_id].get("holdReason")
            if not isinstance(reason, str) or not reason.strip():
                raise ValueError(f"{place_id}: audited hold has no reason")
            if source_name.endswith(AGGREGATE_SUFFIX):
                record = _match_aggregate_record(properties, imported)
                if isinstance(record.get("licenceComments"), str) and record["licenceComments"].strip():
                    raise ValueError(f"{place_id}: aggregate held row now has an explicit frozen licence comment")
                aggregate_blank += 1
            else:
                direct_held += 1
            decision = {**source, "decision": "hold", "reason": reason}
        elif place_id in provisional:
            if not source_name.endswith(AGGREGATE_SUFFIX):
                raise ValueError(f"{place_id}: provisional row is not an aggregate boundary")
            record = _match_aggregate_record(properties, imported)
            comment = record.get("licenceComments")
            if not isinstance(comment, str) or not comment.strip():
                raise ValueError(f"{place_id}: provisional row has no explicit frozen licence comment")
            if comment != provisional[place_id].get("sourceRecordLicenceCommentsExact"):
                raise ValueError(f"{place_id}: provisional licence comment differs from the audit")
            review_row = provisional[place_id]
            family = family_reviews.get(review_row.get("provider"))
            if family is None or review_row.get("rightsStatus") != "approved" or review_row.get("termsVerified") is not True:
                raise ValueError(f"{place_id}: provider licence terms are not verified")
            if review_row.get("rightsAttribution") != family["rightsAttribution"]:
                raise ValueError(f"{place_id}: current provider attribution differs from verified terms")
            if review_row.get("officialLicenseUrl") != family["licenseUrl"]:
                raise ValueError(f"{place_id}: provider licence URL differs from verified terms")
            decision = {
                **source,
                "decision": "approved",
                "rightsAttribution": [family["rightsAttribution"]],
                "providerLicenseUrl": family["licenseUrl"],
                "frozenSourceLicenceComment": comment,
            }
            aggregate_provisional += 1
        else:
            credit_class = APPROVED_SOURCE_CLASSES.get(source_name)
            if credit_class is None:
                raise ValueError(f"{place_id}: no reviewed publication decision")
            credit = credits[credit_class].get("rightsAttribution")
            if not isinstance(credit, str) or not credit.strip():
                raise ValueError(f"{place_id}: approved source has no provider attribution")
            decision = {**source, "decision": "approved", "rightsAttribution": [credit]}
        decisions[place_id] = decision

    if set(decisions) != {feature["properties"]["id"] for feature in boundaries}:
        raise ValueError("Rights decisions do not cover the frozen boundaries")
    if (aggregate_blank, direct_held, aggregate_provisional) != (127, 91, 46):
        raise ValueError("Rights class counts differ from the reviewed 127/91/46 split")
    if sum(row["decision"] == "approved" for row in decisions.values()) != 812:
        raise ValueError("Current publication eligibility differs from the audited 812 places")

    return {
        "version": 1,
        "boundarySnapshotSha256": BOUNDARY_SHA256,
        "regionalImportSha256": REGIONAL_IMPORT_SHA256,
        "rightsAuditSha256": file_sha256(audit_path),
        "approvedPlaceCount": 812,
        "heldPlaceCount": 218,
        "places": dict(sorted(decisions.items())),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--boundaries", required=True, type=Path)
    parser.add_argument("--regional-import", required=True, type=Path)
    parser.add_argument("--rights-audit", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    manifest = make_manifest(args.boundaries, args.regional_import, args.rights_audit)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"approved": 812, "held": 218, "output": str(args.output)}))


if __name__ == "__main__":
    main()
