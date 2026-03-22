from __future__ import annotations

import argparse
import asyncio
import ast
import csv
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from loguru import logger
from sqlalchemy import func, select, text

BACKEND_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = BACKEND_ROOT.parent

if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

os.chdir(BACKEND_ROOT)

from app.db import SessionLocal, init_db
from app.models import Base, Job


@dataclass
class JobRow:
    id: int
    title: str
    description: str
    education: str | None
    years_experience: int | None
    skills_required: list[str]
    additional_skills: list[str]
    location: str | None
    employment_type: str | None


def _clean_text(value: str | None) -> str | None:
    if value is None:
        return None
    text_value = value.strip()
    return text_value or None


def _parse_int(value: str | None) -> int | None:
    cleaned = _clean_text(value)
    if cleaned is None:
        return None
    return int(cleaned)


def _parse_list_field(tokens: list[str]) -> list[str]:
    joined = ",".join(tokens).strip()
    normalized = (
        joined.replace('"\'', "'")
        .replace('\'"', "'")
        .replace('"[', '[')
        .replace(']"', ']')
    )

    parsed = ast.literal_eval(normalized)
    if not isinstance(parsed, list):
        raise ValueError(f"Expected list field, got: {normalized}")

    return [str(item).strip() for item in parsed if str(item).strip()]


def _split_middle_list_fields(tokens: list[str]) -> tuple[list[str], list[str]]:
    chunks: list[list[str]] = []
    current: list[str] = []

    for token in tokens:
        current.append(token)
        if "]" in token:
            chunks.append(current)
            current = []

    if current:
        chunks.append(current)

    if len(chunks) != 2:
        raise ValueError(f"Expected 2 list fields in CSV row middle section, got {len(chunks)}")

    return _parse_list_field(chunks[0]), _parse_list_field(chunks[1])


def _parse_csv_row(raw_row: list[str]) -> JobRow:
    if len(raw_row) < 10:
        raise ValueError(f"Expected at least 10 columns, got {len(raw_row)}")

    location = _clean_text(raw_row[-3])
    employment_type = _clean_text(raw_row[-2])
    skills_required, additional_skills = _split_middle_list_fields(raw_row[5:-3])

    return JobRow(
        id=int(raw_row[0].strip()),
        title=raw_row[1].strip(),
        description=raw_row[2].strip(),
        education=_clean_text(raw_row[3]),
        years_experience=_parse_int(raw_row[4]),
        skills_required=skills_required,
        additional_skills=additional_skills,
        location=location,
        employment_type=employment_type,
    )


def load_jobs_from_csv(csv_path: Path) -> list[JobRow]:
    rows: list[JobRow] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.reader(handle)
        for line_number, raw_row in enumerate(reader, start=1):
            if not raw_row or not any(cell.strip() for cell in raw_row):
                continue
            try:
                rows.append(_parse_csv_row(raw_row))
            except Exception as exc:
                raise ValueError(f"Failed to parse row {line_number}: {exc}") from exc
    return rows


async def ingest_jobs(*, csv_path: Path, replace_existing: bool) -> None:
    await init_db(Base.metadata)
    parsed_rows = load_jobs_from_csv(csv_path)

    async with SessionLocal() as db:
        existing_count = await db.scalar(select(func.count()).select_from(Job))

        if existing_count and not replace_existing:
            raise RuntimeError(
                f"jobs table already contains {existing_count} rows. Re-run with --replace-existing to refresh it."
            )

        if replace_existing and existing_count:
            await db.execute(text("TRUNCATE TABLE jobs RESTART IDENTITY CASCADE"))

        for row in parsed_rows:
            db.add(
                Job(
                    id=row.id,
                    title=row.title,
                    description=row.description,
                    education=row.education,
                    years_experience=row.years_experience,
                    skills_required=row.skills_required,
                    additional_skills=row.additional_skills,
                    location=row.location,
                    employment_type=row.employment_type,
                )
            )

        await db.commit()

        await db.execute(
            text(
                "SELECT setval(pg_get_serial_sequence('jobs', 'id'), COALESCE((SELECT MAX(id) FROM jobs), 1), true)"
            )
        )
        await db.commit()

        final_count = await db.scalar(select(func.count()).select_from(Job))
        logger.info("Imported {} jobs from {} into jobs table", final_count, csv_path)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest jobs.csv into the SmartHire jobs table")
    parser.add_argument(
        "--csv-path",
        default=str(WORKSPACE_ROOT / "jobs.csv"),
        help="Path to jobs CSV file (default: workspace-root/jobs.csv)",
    )
    parser.add_argument(
        "--replace-existing",
        action="store_true",
        help="Replace existing rows in jobs before importing",
    )
    return parser.parse_args()


def main() -> None:
    args = _parse_args()
    csv_path = Path(args.csv_path).resolve()
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")

    logger.info("Importing jobs from {}", csv_path)
    asyncio.run(ingest_jobs(csv_path=csv_path, replace_existing=bool(args.replace_existing)))


if __name__ == "__main__":
    main()