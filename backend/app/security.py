import bcrypt
from loguru import logger


def hash_password(password: str) -> str:
    if password is None:
        raise TypeError("password must be a str")
    password_bytes = password.encode("utf-8")
    hashed_bytes = bcrypt.hashpw(password_bytes, bcrypt.gensalt())
    return hashed_bytes.decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    if plain_password is None or hashed_password is None:
        return False
    try:
        return bcrypt.checkpw(plain_password.encode("utf-8"), hashed_password.encode("utf-8"))
    except (ValueError, TypeError) as exc:
        # Malformed hash or non-bytes input. Treat as failure but record so we can
        # spot data-corruption issues quickly.
        logger.warning("security.verify_password: invalid hash format ({})", exc)
        return False
    except Exception as exc:  # pragma: no cover — defensive
        logger.exception("security.verify_password: unexpected error ({})", exc)
        return False
