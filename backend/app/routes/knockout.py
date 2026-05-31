"""Knockout questions — per-job screening questions that auto-reject on wrong answer."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_admin
from ..models import Job, KnockoutQuestion, User
from ..schemas import KnockoutQuestionCreate, KnockoutQuestionPublicResponse, KnockoutQuestionResponse

router = APIRouter(prefix="/api/knockout-questions", tags=["knockout_questions"])


@router.get("", response_model=list[KnockoutQuestionPublicResponse])
async def list_questions(
    job_id: int,
    db: AsyncSession = Depends(get_db),
) -> list[KnockoutQuestion]:
    """Public — needed by the Careers page to show questions to applicants."""
    result = await db.execute(
        select(KnockoutQuestion)
        .where(KnockoutQuestion.job_id == job_id)
        .order_by(KnockoutQuestion.order_index)
    )
    return list(result.scalars().all())


@router.post("", response_model=KnockoutQuestionResponse, status_code=status.HTTP_201_CREATED)
async def create_question(
    payload: KnockoutQuestionCreate,
    job_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> KnockoutQuestion:
    job = await db.get(Job, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    q = KnockoutQuestion(
        job_id=job_id,
        question_text=payload.question_text.strip(),
        expected_answer=payload.expected_answer,
        is_required=payload.is_required,
        order_index=payload.order_index,
    )
    db.add(q)
    await db.commit()
    await db.refresh(q)
    return q


@router.put("/{question_id}", response_model=KnockoutQuestionResponse)
async def update_question(
    question_id: int,
    payload: KnockoutQuestionCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> KnockoutQuestion:
    q = await db.get(KnockoutQuestion, question_id)
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    q.question_text = payload.question_text.strip()
    q.expected_answer = payload.expected_answer
    q.is_required = payload.is_required
    q.order_index = payload.order_index
    await db.commit()
    await db.refresh(q)
    return q


@router.delete("/{question_id}", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def delete_question(
    question_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> None:
    q = await db.get(KnockoutQuestion, question_id)
    if not q:
        raise HTTPException(status_code=404, detail="Question not found")
    await db.delete(q)
    await db.commit()
