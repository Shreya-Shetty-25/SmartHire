from app.security import hash_password, verify_password


def test_hash_and_verify_roundtrip() -> None:
    hashed = hash_password("correct horse battery staple")
    assert isinstance(hashed, str)
    assert hashed.startswith("$2")
    assert verify_password("correct horse battery staple", hashed) is True
    assert verify_password("wrong", hashed) is False
