from backend.app.main import guest_progress_state, list_places
from fastapi import Response


class EmptyResult:
    def fetchall(self):
        return []


class StateResult:
    def __init__(self, has_progress: bool):
        self.has_progress = has_progress

    def fetchone(self):
        return {"has_progress": self.has_progress}


class ReadOnlyConnection:
    def __init__(self):
        self.queries: list[str] = []

    def execute(self, query: str, _params=()):
        self.queries.append(query)
        return EmptyResult()


def test_guest_catalogue_hydration_does_not_create_backend_collection_state():
    conn = ReadOnlyConnection()

    result = list_places(conn, authorization=None, x_collection_key="g" * 43)

    assert result["visited_ids"] == []
    assert result["visits"] == []
    assert result["completed_trail_ids"] == []
    assert conn.queries
    assert all(query.lstrip().upper().startswith("SELECT") for query in conn.queries)


def test_guest_progress_state_detects_any_visit_or_trail_row_without_mutating():
    class ProgressConnection:
        def __init__(self, has_visits: bool, has_trails: bool):
            self.has_visits = has_visits
            self.has_trails = has_trails
            self.queries: list[str] = []

        def execute(self, query: str, _params=()):
            self.queries.append(query)
            if "FROM visits" in query:
                return StateResult(self.has_visits)
            if "FROM guest_trail_completions" in query:
                return StateResult(self.has_trails)
            raise AssertionError(f"Unexpected query: {query}")

    for has_visits, has_trails, expected in (
        (False, False, False),
        (True, False, True),
        (False, True, True),
    ):
        conn = ProgressConnection(has_visits, has_trails)
        response = Response()

        result = guest_progress_state(
            response, conn, x_collection_key="g" * 43
        )

        assert result == {"hasProgress": expected}
        assert response.headers["cache-control"] == "no-store"
        assert len(conn.queries) == 2
        assert all(query.lstrip().upper().startswith("SELECT") for query in conn.queries)
        assert all("JOIN places" not in query for query in conn.queries)
