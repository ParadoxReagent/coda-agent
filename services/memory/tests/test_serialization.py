from src.services.serialization import normalize_metadata


class TestNormalizeMetadata:
    def test_mapping_passthrough(self):
        assert normalize_metadata({"k": "v"}) == {"k": "v"}

    def test_json_string_object(self):
        assert normalize_metadata('{"k":"v","n":1}') == {"k": "v", "n": 1}

    def test_invalid_string_returns_empty_object(self):
        assert normalize_metadata("not-json") == {}

    def test_non_mapping_json_returns_empty_object(self):
        assert normalize_metadata("[1,2,3]") == {}

    def test_key_value_iterable(self):
        assert normalize_metadata([("k", "v")]) == {"k": "v"}

    def test_bad_iterable_returns_empty_object(self):
        assert normalize_metadata(["k"]) == {}
