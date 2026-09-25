"""Bounded, identity-aware catalogue queries used by the web application."""

from __future__ import annotations

from collections.abc import Iterable

from psycopg import Connection

from backend.app.staging_field_places import (
    place_visibility_clause,
    place_visibility_params,
)


PLACE_CATEGORIES = ("national", "provincial", "regional", "island")
MAP_PLACE_LIMIT = 50
ISLAND_PRIORITY_COUNT = 12


def normalize_categories(categories: Iterable[str] | None) -> list[str] | None:
    if categories is None:
        return None
    normalized = list(dict.fromkeys(categories))
    if not normalized:
        return None
    invalid = sorted(set(normalized) - set(PLACE_CATEGORIES))
    if invalid:
        raise ValueError("Invalid place type")
    return normalized


def normalize_visit_filter(value: str | bool | None) -> bool | None:
    """Return True for visited, False for unseen, and None for all."""

    if value is None or value is True:
        return True if value is True else None
    if value is False:
        return False
    normalized = str(value).strip().casefold()
    if normalized in {"", "all"}:
        return None
    if normalized in {"visited", "true"}:
        return True
    if normalized in {"unseen", "unvisited", "false"}:
        return False
    raise ValueError("visited must be all, visited, or unseen")


def normalize_authorities(authorities: Iterable[str] | None) -> list[str] | None:
    if authorities is None:
        return None
    values = list(dict.fromkeys(value.strip() for value in authorities if value.strip()))
    if not values:
        return None
    if any(len(value) > 200 for value in values):
        raise ValueError("Authority values must be 200 characters or fewer")
    if len(values) > 100:
        raise ValueError("Too many authority filters")
    return values


def authority_sql(alias: str = "p") -> str:
    """Match frontend authorityForPlace rules for server-side list filters."""

    if alias not in {"p", "ranked"}:
        raise ValueError("Unsupported places alias")
    greenspace_suffix = (
        "'\\s+(?:via|' || chr(8212) || ')\\s+BC Local and Regional Greenspaces.*$'"
    )
    return f"""CASE
        WHEN {alias}.category = 'national' THEN 'Parks Canada'
        WHEN {alias}.category = 'provincial' THEN 'BC Parks'
        WHEN {alias}.category = 'island' THEN 'Major islands'
        WHEN strpos({alias}.source_name, 'Capital Regional District') > 0 THEN 'Capital Regional District (CRD)'
        WHEN strpos({alias}.source_name, 'Nanaimo') > 0 THEN 'Regional District of Nanaimo (RDN)'
        WHEN strpos({alias}.source_name, 'Cowichan Valley') > 0 THEN 'Cowichan Valley Regional District (CVRD)'
        WHEN strpos({alias}.source_name, 'Mount Waddington') > 0 THEN 'Regional District of Mount Waddington (RDMW)'
        WHEN {alias}.source_name ~* ({greenspace_suffix})
            THEN regexp_replace({alias}.source_name, ({greenspace_suffix}), '', 'i')
        ELSE {alias}.source_name
    END"""


def list_region_sql(alias: str = "p") -> str:
    """Match collection region headings without changing source place regions."""

    if alias not in {"p", "ranked"}:
        raise ValueError("Unsupported places alias")
    southern = "Southern Vancouver Island"
    northern = "Northern Vancouver Island"
    island_regions = {
        "Capital Region": southern,
        "Cowichan Valley": southern,
        "South Island": southern,
        "Gulf Islands": southern,
        "West Coast": southern,
        "West Coast Islands": southern,
        "North Island": northern,
        "Discovery Islands": northern,
        "Northern Gulf Islands": northern,
        "Northern Islands": northern,
    }
    cases = " ".join(
        f"WHEN {alias}.region = '{region}' THEN '{heading}'"
        for region, heading in island_regions.items()
    )
    return (
        f"CASE WHEN {alias}.region = 'Central Island' THEN "
        f"CASE WHEN {alias}.latitude >= 49.5 THEN '{northern}' ELSE '{southern}' END "
        f"{cases} ELSE {alias}.region END"
    )


def _visit_expression(
    *, account_id: str | None, owner_hash: str | None, alias: str = "p"
) -> tuple[str, list[str]]:
    if alias not in {"p", "ranked"}:
        raise ValueError("Unsupported places alias")
    if account_id is not None:
        return (
            f"EXISTS (SELECT 1 FROM account_visits av WHERE av.account_id = %s AND av.place_id = {alias}.id)",
            [account_id],
        )
    if owner_hash is not None:
        return (
            f"EXISTS (SELECT 1 FROM visits gv WHERE gv.owner_hash = %s AND gv.place_id = {alias}.id)",
            [owner_hash],
        )
    return "FALSE", []


def _catalogue_cte(include_staging_field_places: bool) -> tuple[str, list]:
    cte = f"""WITH visible AS (
        SELECT p.id, p.name, p.category, p.latitude, p.longitude, p.region,
               p.description, p.source_url, p.source_name, p.source_id
        FROM places p
        WHERE {place_visibility_clause('p')}
    ), island_cohort AS (
        SELECT id FROM visible
        WHERE category = 'island'
        ORDER BY md5(id), id
        LIMIT {ISLAND_PRIORITY_COUNT}
    ), ranked AS (
        SELECT v.*, md5(v.id) AS priority_key,
               CASE WHEN v.category = 'national' THEN 0
                    WHEN ic.id IS NOT NULL THEN 1
                    ELSE 2 END AS priority_tier
        FROM visible v
        LEFT JOIN island_cohort ic ON ic.id = v.id
    )"""
    return cte, list(place_visibility_params(include_staging_field_places))


def _filter_parts(
    *,
    categories: list[str] | None,
    authorities: list[str] | None,
    query: str | None,
    visited: bool | None,
    account_id: str | None,
    owner_hash: str | None,
    group_id: str | None = None,
    bounds: tuple[float, float, float, float] | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    radius_km: float | None = None,
) -> tuple[list[str], list]:
    clauses: list[str] = []
    params: list = []
    if categories:
        clauses.append("p.category = ANY(%s::text[])")
        params.append(categories)
    if authorities:
        clauses.append(f"({authority_sql('p')}) = ANY(%s::text[])")
        params.append(authorities)
    if query:
        term = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{term}%"
        searchable = (
            f"concat_ws(' ', p.name, p.description, p.region, "
            f"{authority_sql('p')}, {list_region_sql('p')})"
        )
        clauses.append(f"{searchable} ILIKE %s ESCAPE E'\\\\'")
        params.append(pattern)
    if group_id is not None:
        if account_id is None:
            raise ValueError("group_id requires an authenticated account")
        clauses.append(
            "EXISTS (SELECT 1 FROM account_group_places agp "
            "JOIN account_groups ag ON ag.id = agp.group_id "
            "WHERE agp.place_id = p.id AND ag.id::text = %s AND ag.account_id = %s)"
        )
        params.extend([group_id, account_id])
    if bounds is not None:
        west, south, east, north = bounds
        if west <= east:
            clauses.append("p.longitude >= %s AND p.longitude <= %s")
            params.extend([west, east])
        else:
            clauses.append("(p.longitude >= %s OR p.longitude <= %s)")
            params.extend([west, east])
        clauses.append("p.latitude >= %s AND p.latitude <= %s")
        params.extend([south, north])
    if (latitude is None) != (longitude is None):
        raise ValueError("latitude and longitude must be provided together")
    if radius_km is not None and latitude is None:
        raise ValueError("radius_km requires latitude and longitude")
    if latitude is not None and longitude is not None and radius_km is not None:
        clauses.append(
            "6371.0088 * 2 * ASIN(SQRT(LEAST(1, GREATEST(0, "
            "SIN(RADIANS(p.latitude - %s) / 2)^2 + "
            "COS(RADIANS(%s)) * COS(RADIANS(p.latitude)) * "
            "SIN(RADIANS(p.longitude - %s) / 2)^2)))) <= %s"
        )
        params.extend([latitude, latitude, longitude, radius_km])
    if visited is not None:
        expression, expression_params = _visit_expression(
            account_id=account_id, owner_hash=owner_hash
        )
        clauses.append(f"({expression})" if visited else f"NOT ({expression})")
        params.extend(expression_params)
    return clauses, params


def _where(clauses: list[str]) -> str:
    return " AND ".join(clauses) if clauses else "TRUE"


def map_place_rows(
    conn: Connection,
    *,
    west: float,
    south: float,
    east: float,
    north: float,
    categories: list[str] | None,
    authorities: list[str] | None,
    query: str | None,
    visited: bool | None,
    selected_id: str | None,
    group_id: str | None,
    account_id: str | None,
    owner_hash: str | None,
    limit: int,
    include_staging_field_places: bool,
) -> tuple[list[dict], int]:
    cte, cte_params = _catalogue_cte(include_staging_field_places)
    clauses, filter_params = _filter_parts(
        categories=categories,
        authorities=authorities,
        query=query,
        visited=visited,
        account_id=account_id,
        owner_hash=owner_hash,
        group_id=group_id,
        bounds=(west, south, east, north),
    )
    where_sql = _where(clauses)
    count = conn.execute(
        f"{cte} SELECT COUNT(*) AS total FROM ranked p WHERE {where_sql}",
        cte_params + filter_params,
    ).fetchone()["total"]
    visit_sql, visit_params = _visit_expression(
        account_id=account_id, owner_hash=owner_hash
    )
    selected_order_sql = "(p.id = %s) DESC, " if selected_id else ""
    order_params = [selected_id] if selected_id else []
    rows = conn.execute(
        f"""{cte}
        SELECT p.id, p.name, p.category, p.latitude, p.longitude, p.region,
               p.source_url, p.source_name, p.source_id,
               {authority_sql('p')} AS authority,
               {list_region_sql('p')} AS list_region,
               {visit_sql} AS visited,
               p.priority_tier, p.priority_key
        FROM ranked p
        WHERE {where_sql}
        ORDER BY p.priority_tier, {selected_order_sql}p.priority_key, p.id
        LIMIT %s
        """,
        cte_params + visit_params + filter_params + order_params + [limit],
    ).fetchall()
    return rows, count


def catalogue_place_rows(
    conn: Connection,
    *,
    categories: list[str] | None,
    authorities: list[str] | None,
    query: str | None,
    visited: bool | None,
    account_id: str | None,
    owner_hash: str | None,
    latitude: float | None,
    longitude: float | None,
    radius_km: float | None,
    limit: int,
    offset: int,
    include_staging_field_places: bool,
    prioritize_claims: bool = False,
) -> tuple[list[dict], int]:
    cte, cte_params = _catalogue_cte(include_staging_field_places)
    clauses, filter_params = _filter_parts(
        categories=categories,
        authorities=authorities,
        query=query,
        visited=visited,
        account_id=account_id,
        owner_hash=owner_hash,
        latitude=latitude,
        longitude=longitude,
        radius_km=radius_km,
    )
    where_sql = _where(clauses)
    count = conn.execute(
        f"{cte} SELECT COUNT(*) AS total FROM ranked p WHERE {where_sql}",
        cte_params + filter_params,
    ).fetchone()["total"]
    visit_sql, visit_params = _visit_expression(
        account_id=account_id, owner_hash=owner_hash
    )
    distance_sql = "NULL::double precision AS distance_km"
    distance_params: list = []
    order_sql = "p.name, p.id"
    order_join_sql = ""
    order_join_params: list[str] = []
    if latitude is not None and longitude is not None:
        distance_sql = """6371.0088 * 2 * ASIN(SQRT(LEAST(1, GREATEST(0,
            SIN(RADIANS(p.latitude - %s) / 2)^2 +
            COS(RADIANS(%s)) * COS(RADIANS(p.latitude)) *
            SIN(RADIANS(p.longitude - %s) / 2)^2
        )))) AS distance_km"""
        distance_params = [latitude, latitude, longitude]
        order_sql = "distance_km, p.name, p.id"
    if prioritize_claims and account_id is not None:
        order_join_sql = """LEFT JOIN account_visits order_av
            ON order_av.account_id = %s AND order_av.place_id = p.id
            LEFT JOIN account_visit_claims order_claim
            ON order_claim.account_id = %s AND order_claim.place_id = p.id"""
        order_join_params = [account_id, account_id]
        order_sql = """(order_claim.claimed_at IS NOT NULL) DESC,
            (order_claim.photo_object_key IS NOT NULL) DESC,
            order_av.visited_at DESC, p.name, p.id"""
    elif prioritize_claims and owner_hash is not None:
        order_join_sql = "LEFT JOIN visits order_gv " \
            "ON order_gv.owner_hash = %s AND order_gv.place_id = p.id"
        order_join_params = [owner_hash]
        order_sql = "order_gv.visited_at DESC, p.name, p.id"
    search_order_sql = ""
    search_order_params: list[str] = []
    if query and query.strip():
        term = query.strip()
        escaped_term = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        search_order_sql = """CASE
            WHEN lower(p.name) = lower(%s) THEN 0
            WHEN p.name ILIKE %s ESCAPE E'\\\\' THEN 1
            WHEN p.name ILIKE %s ESCAPE E'\\\\' THEN 2
            ELSE 3
        END, """
        search_order_params = [term, f"{escaped_term}%", f"%{escaped_term}%"]
    rows = conn.execute(
        f"""{cte}
        SELECT p.id, p.name, p.category, p.latitude, p.longitude, p.region,
               ''::text AS description, p.source_url, p.source_name, p.source_id,
               {authority_sql('p')} AS authority,
               {list_region_sql('p')} AS list_region,
               {visit_sql} AS visited, {distance_sql},
               p.priority_tier, p.priority_key
        FROM ranked p
        {order_join_sql}
        WHERE {where_sql}
        ORDER BY {search_order_sql}{order_sql}
        LIMIT %s OFFSET %s
        """,
        cte_params + visit_params + distance_params + order_join_params + filter_params + search_order_params + [limit, offset],
    ).fetchall()
    return rows, count


def catalogue_counts(
    conn: Connection, *, include_staging_field_places: bool
) -> tuple[int, dict[str, int]]:
    rows = conn.execute(
        f"""SELECT p.category, COUNT(*) AS total
        FROM places p
        WHERE {place_visibility_clause('p')}
        GROUP BY p.category""",
        place_visibility_params(include_staging_field_places),
    ).fetchall()
    totals = {category: 0 for category in PLACE_CATEGORIES}
    for row in rows:
        totals[row["category"]] = row["total"]
    return sum(totals.values()), totals


def active_badge_places(
    conn: Connection, *, include_staging_field_places: bool
) -> list[dict]:
    return conn.execute(
        f"""SELECT p.id, p.name, p.category, p.region
        FROM places p
        WHERE {place_visibility_clause('p')}
        ORDER BY p.id""",
        place_visibility_params(include_staging_field_places),
    ).fetchall()


def visited_place_rows(
    conn: Connection,
    *,
    account_id: str | None,
    owner_hash: str | None,
    categories: list[str] | None,
    authorities: list[str] | None,
    query: str | None,
    limit: int,
    offset: int,
    include_staging_field_places: bool,
) -> tuple[list[dict], int]:
    return catalogue_place_rows(
        conn,
        categories=categories,
        authorities=authorities,
        query=query,
        visited=True,
        account_id=account_id,
        owner_hash=owner_hash,
        latitude=None,
        longitude=None,
        radius_km=None,
        limit=limit,
        offset=offset,
        include_staging_field_places=include_staging_field_places,
        prioritize_claims=True,
    )
