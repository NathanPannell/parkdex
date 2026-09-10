from __future__ import annotations

from typing import Iterable

from psycopg import Connection


PLACE_COLUMNS = """
    p.id, p.name, p.category, p.latitude, p.longitude, p.region, p.description,
    p.source_url, p.source_name, p.source_id
"""


def _place(row: dict) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "category": row["category"],
        "latitude": row["latitude"],
        "longitude": row["longitude"],
        "region": row["region"],
        "description": row["description"],
        "source_url": row["source_url"],
        "source_name": row["source_name"],
        "source_id": row["source_id"],
    }


def group_row(conn: Connection, account_id: str, group_id: str) -> dict | None:
    row = conn.execute(
        """
        SELECT id, name, is_wishlist, created_at, updated_at
        FROM account_groups
        WHERE id = %s AND account_id = %s
        """,
        (group_id, account_id),
    ).fetchone()
    if row is None:
        return None
    places = conn.execute(
        f"""
        SELECT {PLACE_COLUMNS}
        FROM account_group_places tp
        JOIN places p ON p.id = tp.place_id AND p.active
        WHERE tp.group_id = %s
        ORDER BY tp.added_at, tp.place_id
        """,
        (group_id,),
    ).fetchall()
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "is_wishlist": row["is_wishlist"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "place_ids": [place["id"] for place in places],
        "places": [_place(place) for place in places],
    }


def list_group_rows(conn: Connection, account_id: str) -> list[dict]:
    rows = conn.execute(
        """
        SELECT id FROM account_groups
        WHERE account_id = %s
        ORDER BY updated_at DESC, id
        """,
        (account_id,),
    ).fetchall()
    return [group_row(conn, account_id, str(row["id"])) for row in rows]


def create_group_row(
    conn: Connection, account_id: str, name: str, place_ids: Iterable[str], *, is_wishlist: bool = False
) -> dict:
    row = conn.execute(
        """
        INSERT INTO account_groups (account_id, name, is_wishlist)
        VALUES (%s, %s, %s)
        RETURNING id
        """,
        (account_id, name.strip(), is_wishlist),
    ).fetchone()
    add_group_places(conn, account_id, str(row["id"]), place_ids)
    return group_row(conn, account_id, str(row["id"]))


def rename_group_row(conn: Connection, account_id: str, group_id: str, name: str) -> bool:
    result = conn.execute(
        """
        UPDATE account_groups
        SET name = %s, updated_at = NOW()
        WHERE id = %s AND account_id = %s AND NOT is_wishlist
        """,
        (name.strip(), group_id, account_id),
    )
    return result.rowcount == 1


def delete_group_row(conn: Connection, account_id: str, group_id: str) -> bool:
    result = conn.execute(
        "DELETE FROM account_groups WHERE id = %s AND account_id = %s AND NOT is_wishlist",
        (group_id, account_id),
    )
    return result.rowcount == 1


def add_group_places(
    conn: Connection, account_id: str, group_id: str, place_ids: Iterable[str]
) -> bool:
    if conn.execute(
        "SELECT 1 FROM account_groups WHERE id = %s AND account_id = %s",
        (group_id, account_id),
    ).fetchone() is None:
        return False
    ids = list(dict.fromkeys(place_ids))
    if ids:
        rows = conn.execute(
            "SELECT id FROM places WHERE active AND id = ANY(%s)", (ids,)
        ).fetchall()
        active_ids = {row["id"] for row in rows}
        missing = [place_id for place_id in ids if place_id not in active_ids]
        if missing:
            raise ValueError("One or more places were not found or are inactive")
        conn.execute(
            """
            INSERT INTO account_group_places (group_id, place_id)
            SELECT %s, value FROM unnest(%s::text[]) AS value
            ON CONFLICT DO NOTHING
            """,
            (group_id, ids),
        )
        conn.execute(
            "UPDATE account_groups SET updated_at = NOW() WHERE id = %s AND account_id = %s",
            (group_id, account_id),
        )
    return True


def remove_group_places(
    conn: Connection, account_id: str, group_id: str, place_ids: Iterable[str]
) -> bool:
    if conn.execute(
        "SELECT 1 FROM account_groups WHERE id = %s AND account_id = %s",
        (group_id, account_id),
    ).fetchone() is None:
        return False
    ids = list(dict.fromkeys(place_ids))
    if ids:
        conn.execute(
            "DELETE FROM account_group_places WHERE group_id = %s AND place_id = ANY(%s)",
            (group_id, ids),
        )
        conn.execute(
            "UPDATE account_groups SET updated_at = NOW() WHERE id = %s AND account_id = %s",
            (group_id, account_id),
        )
    return True


def ensure_wishlist(conn: Connection, account_id: str) -> dict:
    """Create the singleton lazily; the partial unique index serializes races."""
    row = conn.execute(
        """
        INSERT INTO account_groups (account_id, name, is_wishlist)
        VALUES (%s, 'Wishlist', TRUE)
        ON CONFLICT (account_id) WHERE is_wishlist DO UPDATE SET updated_at = account_groups.updated_at
        RETURNING id
        """,
        (account_id,),
    ).fetchone()
    return group_row(conn, account_id, str(row["id"]))


# Compatibility helpers retained for the first trips API clients.  Wishlist is
# a protected group and is intentionally not exposed through the old trip API.
def trip_row(conn: Connection, account_id: str, trip_id: str) -> dict | None:
    result = group_row(conn, account_id, trip_id)
    return result if result and not result["is_wishlist"] else None


def list_trip_rows(conn: Connection, account_id: str) -> list[dict]:
    return [group for group in list_group_rows(conn, account_id) if not group["is_wishlist"]]


create_trip_row = create_group_row
rename_trip_row = rename_group_row
delete_trip_row = delete_group_row
add_trip_places = add_group_places
remove_trip_places = remove_group_places


def search_place_rows(
    conn: Connection,
    account_id: str,
    *,
    visited: bool | None = None,
    category: str | None = None,
    query: str | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    radius_km: float | None = None,
    limit: int = 25,
    offset: int = 0,
) -> tuple[list[dict], int]:
    clauses = ["p.active"]
    where_params: list = []
    if category:
        clauses.append("p.category = %s")
        where_params.append(category)
    if query:
        pattern = f"%{query.strip()}%"
        clauses.append("(p.name ILIKE %s OR p.description ILIKE %s OR p.region ILIKE %s)")
        where_params.extend([pattern, pattern, pattern])
    if visited is True:
        clauses.append("EXISTS (SELECT 1 FROM account_visits av WHERE av.account_id = %s AND av.place_id = p.id)")
        where_params.append(account_id)
    elif visited is False:
        clauses.append("NOT EXISTS (SELECT 1 FROM account_visits av WHERE av.account_id = %s AND av.place_id = p.id)")
        where_params.append(account_id)

    distance_sql = "NULL::double precision AS distance_km"
    order_sql = "p.name, p.id"
    if latitude is not None and longitude is not None:
        distance_sql = """
            6371.0088 * 2 * ASIN(SQRT(LEAST(1, GREATEST(0,
                SIN(RADIANS(p.latitude - %s) / 2)^2 +
                COS(RADIANS(%s)) * COS(RADIANS(p.latitude)) *
                SIN(RADIANS(p.longitude - %s) / 2)^2
            )))) AS distance_km
        """
        distance_select_params = [latitude, latitude, longitude]
        if radius_km is not None:
            clauses.append("6371.0088 * 2 * ASIN(SQRT(LEAST(1, GREATEST(0, SIN(RADIANS(p.latitude - %s) / 2)^2 + COS(RADIANS(%s)) * COS(RADIANS(p.latitude)) * SIN(RADIANS(p.longitude - %s) / 2)^2)))) <= %s")
            where_params.extend([latitude, latitude, longitude, radius_km])
        order_sql = "distance_km, p.name, p.id"
    where_sql = " AND ".join(clauses)
    count_row = conn.execute(
        f"SELECT COUNT(*) AS total FROM places p WHERE {where_sql}",
        where_params,
    ).fetchone()
    distance_select_params = distance_select_params if latitude is not None and longitude is not None else []
    rows = conn.execute(
        f"""
        SELECT {PLACE_COLUMNS},
               {distance_sql},
               EXISTS (SELECT 1 FROM account_visits av WHERE av.account_id = %s AND av.place_id = p.id) AS visited
        FROM places p
        WHERE {where_sql}
        ORDER BY {order_sql}
        LIMIT %s OFFSET %s
        """,
        distance_select_params + [account_id] + where_params + [limit, offset],
    ).fetchall()
    return rows, count_row["total"]


def place_detail_row(conn: Connection, account_id: str, place_id: str) -> dict | None:
    row = conn.execute(
        f"""
        SELECT {PLACE_COLUMNS},
               EXISTS (SELECT 1 FROM account_visits av WHERE av.account_id = %s AND av.place_id = p.id) AS visited
        FROM places p
        WHERE p.id = %s AND p.active
        """,
        (account_id, place_id),
    ).fetchone()
    return row
