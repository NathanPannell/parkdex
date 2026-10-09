#!/usr/bin/env python3
"""Plan and apply reviewed, reversible park hiding by category.

Hidden parks keep every row (park, boundary, drive, claims, visits, flags) but
leave the content snapshot, the change feed and the CDN catalogue, and take no
new flag game visits. See docs/park-visibility.md.

  plan   Read the target database and write a hash-pinned plan to hide (or
         unhide) every park in the given categories. Parks players proposed
         stay visible. Planning never writes.
  apply  Apply one reviewed plan in one transaction. A replay is a no-op; a
         catalogue that changed since planning needs a new plan.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from typing import Any

SCHEMA = "parkdex.park-visibility-plan.v1"
CATEGORIES = ("national", "provincial", "regional", "municipal", "community")
ENVIRONMENT_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
CONTROL_CHARS = re.compile(r"[\x00-\x1f\x7f]")


class VisibilityError(ValueError):
    """Safe, actionable plan or apply error."""


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def plan_digest(plan: dict[str, Any]) -> str:
    return hashlib.sha256(canonical({key: value for key, value in plan.items() if key != "planSha256"})).hexdigest()


def check_reason(reason: str) -> str:
    reason = reason.strip()
    if not 1 <= len(reason) <= 500 or CONTROL_CHARS.search(reason):
        raise VisibilityError("--reason must be 1 to 500 characters of plain text")
    return reason


def check_categories(values: list[str]) -> list[str]:
    categories = sorted(set(values))
    if not categories or any(category not in CATEGORIES for category in categories):
        raise VisibilityError("Give one or more --category values from: " + ", ".join(CATEGORIES))
    return categories


def _connect():
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise VisibilityError("Set DATABASE_URL to the intended target database")
    try:
        import psycopg
    except ImportError:
        raise VisibilityError("psycopg is required; install database/requirements.txt") from None
    try:
        return psycopg.connect(database_url)
    except psycopg.Error as exc:
        raise VisibilityError(f"Could not connect to target database ({type(exc).__name__})") from None


def _identity(conn, host: str, environment: str) -> dict[str, Any]:
    if not ENVIRONMENT_RE.fullmatch(environment):
        raise VisibilityError("Target environment must be a lowercase label such as staging or production")
    info = conn.info
    identity = {"host": info.host or "", "port": info.port, "database": info.dbname, "environment": environment}
    if identity["host"] != host:
        raise VisibilityError(f"Declared target host {host!r} does not match connected host {identity['host']!r}")
    return identity


def read_state(cursor, categories: list[str]) -> dict[str, Any]:
    """Every park in the categories, with its hidden state, player-proposal flag and reader floor."""
    cursor.execute("SELECT to_regclass('public.content_park_hidden') IS NOT NULL")
    if not cursor.fetchone()[0]:
        raise VisibilityError("The target lacks content_005_park_visibility.sql; deploy it first")
    cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
    revision = cursor.fetchone()[0]
    cursor.execute(
        "SELECT park.id, park.category, hidden.source, public.content_park_is_player_proposal(park.id), "
        "floor.minimum_reader "
        "FROM public.parks AS park "
        "LEFT JOIN public.content_park_hidden AS hidden ON hidden.park_id = park.id "
        "LEFT JOIN public.content_park_reader_floor AS floor ON floor.park_id = park.id "
        "WHERE park.category = ANY(%s) ORDER BY park.id",
        (categories,),
    )
    parks = [{"id": row[0], "category": row[1], "hiddenBy": row[2], "playerProposal": row[3], "minimumReader": row[4]}
             for row in cursor.fetchall()]
    cursor.execute("SELECT category, reason FROM public.content_hidden_categories WHERE category = ANY(%s) ORDER BY category", (categories,))
    rules = {row[0]: row[1] for row in cursor.fetchall()}
    return {"revision": revision, "parks": parks, "rules": rules}


def targets(action: str, parks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if action == "hide":
        return [park for park in parks if park["hiddenBy"] is None and not park["playerProposal"]]
    # Unhide only what the category rule hid; parks an operator hid stay hidden.
    return [park for park in parks if park["hiddenBy"] == "category"]


def build_plan(action: str, categories: list[str], reason: str | None, identity: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    changes = targets(action, state["parks"])
    counts: dict[str, dict[str, int]] = {}
    for category in categories:
        in_category = [park for park in state["parks"] if park["category"] == category]
        chosen = [park for park in changes if park["category"] == category]
        counts[category] = {
            "parks": len(in_category),
            "change": len(chosen),
            "changeServedToReaders1And2": sum(park["minimumReader"] is None for park in chosen),
            "keptVisibleAsPlayerProposals": sum(park["playerProposal"] for park in in_category) if action == "hide" else 0,
            "alreadyHidden": sum(park["hiddenBy"] is not None for park in in_category) if action == "hide" else 0,
        }
    plan: dict[str, Any] = {
        "schema": SCHEMA,
        "action": action,
        "target": {**identity, "revision": state["revision"]},
        "categories": categories,
        "reason": reason,
        "rulesBefore": state["rules"],
        "parkIds": [park["id"] for park in changes],
        "exemptPlayerProposals": [park["id"] for park in state["parks"] if park["playerProposal"]] if action == "hide" else [],
        "counts": counts,
        "total": len(changes),
    }
    plan["planSha256"] = plan_digest(plan)
    return plan


def load_plan(path: Path, expected_sha: str) -> dict[str, Any]:
    try:
        plan = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise VisibilityError(f"Could not read the plan ({type(exc).__name__})") from None
    if not isinstance(plan, dict) or plan.get("schema") != SCHEMA:
        raise VisibilityError("The plan has an unsupported schema")
    if plan.get("planSha256") != plan_digest(plan) or expected_sha != plan["planSha256"]:
        raise VisibilityError("Plan SHA does not match --reviewed-plan-sha")
    return plan


def apply_plan(conn, plan: dict[str, Any], host: str, environment: str) -> dict[str, Any]:
    identity = _identity(conn, host, environment)
    if {key: identity[key] for key in ("host", "port", "database", "environment")} != {key: plan["target"][key] for key in ("host", "port", "database", "environment")}:
        raise VisibilityError("Connected database does not match the reviewed plan")
    action, categories = plan["action"], plan["categories"]
    try:
        with conn.transaction():
            with conn.cursor() as cursor:
                # Every content write takes the clock row first, so holding it keeps a new or
                # recategorised park from slipping in between the check and the rule.
                cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true FOR UPDATE")
                state = read_state(cursor, categories)
                planned = set(plan["parkIds"])
                remaining = {park["id"] for park in targets(action, state["parks"])}
                rules_done = (set(state["rules"]) == set(categories)) if action == "hide" else not state["rules"]
                if not remaining and rules_done and all(
                    (park["hiddenBy"] is not None) == (action == "hide") for park in state["parks"] if park["id"] in planned
                ):
                    return {"result": "already-current", "revision": state["revision"], "changed": 0}
                if remaining != planned:
                    raise VisibilityError("The parks in these categories changed after planning; create a new plan")
                if action == "hide":
                    for category in categories:
                        cursor.execute(
                            "INSERT INTO public.content_hidden_categories (category, reason) VALUES (%s, %s) "
                            "ON CONFLICT (category) DO UPDATE SET reason = EXCLUDED.reason",
                            (category, plan["reason"]),
                        )
                    cursor.executemany(
                        "INSERT INTO public.content_park_hidden (park_id, reason, source) VALUES (%s, %s, 'category')",
                        [(park_id, plan["reason"]) for park_id in plan["parkIds"]],
                    )
                else:
                    cursor.execute("DELETE FROM public.content_hidden_categories WHERE category = ANY(%s)", (categories,))
                    cursor.execute(
                        "DELETE FROM public.content_park_hidden WHERE source = 'category' AND park_id = ANY(%s)",
                        (plan["parkIds"],),
                    )
                cursor.execute("SELECT revision FROM public.content_clock WHERE singleton = true")
                return {"result": "applied", "revision": cursor.fetchone()[0], "changed": len(plan["parkIds"])}
    except VisibilityError:
        raise
    except Exception as exc:
        # PostgreSQL errors can include connection details, so keep this safe.
        raise VisibilityError(f"Visibility transaction failed ({type(exc).__name__}); all changes were rolled back") from None


def run_plan(args: argparse.Namespace) -> dict[str, Any]:
    categories = check_categories(args.category)
    if args.action == "hide" and not args.reason:
        raise VisibilityError("hide needs --reason")
    reason = check_reason(args.reason) if args.action == "hide" else None
    with _connect() as conn:
        identity = _identity(conn, args.target_host, args.target_environment)
        with conn.cursor() as cursor:
            cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            state = read_state(cursor, categories)
        conn.rollback()
    plan = build_plan(args.action, categories, reason, identity, state)
    out = args.out.expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(plan, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return {key: plan[key] for key in ("planSha256", "action", "categories", "counts", "total", "target")} | {"planPath": str(out)}


def run_apply(args: argparse.Namespace) -> dict[str, Any]:
    plan = load_plan(args.plan, args.reviewed_plan_sha)
    with _connect() as conn:
        return {"planSha256": plan["planSha256"], "action": plan["action"], **apply_plan(conn, plan, args.expected_target_host, args.target_environment)}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    plan = commands.add_parser("plan", help="write a read-only, hash-pinned plan")
    plan.add_argument("action", choices=["hide", "unhide"])
    plan.add_argument("--category", action="append", default=[], help="park category; repeat as needed")
    plan.add_argument("--reason", help="why the parks are hidden; required for hide")
    plan.add_argument("--target-host", required=True)
    plan.add_argument("--target-environment", required=True)
    plan.add_argument("--out", type=Path, required=True)
    plan.set_defaults(run=run_plan)
    apply = commands.add_parser("apply", help="apply one reviewed plan in one transaction")
    apply.add_argument("--plan", type=Path, required=True)
    apply.add_argument("--reviewed-plan-sha", required=True)
    apply.add_argument("--expected-target-host", required=True)
    apply.add_argument("--target-environment", required=True)
    apply.set_defaults(run=run_apply)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = args.run(args)
    except VisibilityError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    except Exception as exc:
        print(f"Park visibility failed ({type(exc).__name__})", file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
