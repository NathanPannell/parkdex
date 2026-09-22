from backend.app.main import list_places


class EmptyResult:
    def fetchall(self):
        return []


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
