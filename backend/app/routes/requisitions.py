from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db import get_db
from ..deps import get_current_admin
from ..models import HireRequisition, User
from ..schemas import RequisitionCreate, RequisitionResponse, RequisitionUpdate

router = APIRouter(prefix="/api/requisitions", tags=["requisitions"])

_VALID_STATUSES = {"draft", "submitted", "approved", "rejected"}


@router.get("", response_model=list[RequisitionResponse])
async def list_requisitions(
    status_filter: str | None = Query(default=None, alias="status"),
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> list[HireRequisition]:
    q = select(HireRequisition).order_by(HireRequisition.created_at.desc())
    if status_filter and status_filter in _VALID_STATUSES:
        q = q.where(HireRequisition.status == status_filter)
    result = await db.execute(q)
    return list(result.scalars().all())


@router.post("", response_model=RequisitionResponse, status_code=status.HTTP_201_CREATED)
async def create_requisition(
    payload: RequisitionCreate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = HireRequisition(
        department_id=payload.department_id,
        job_title=payload.job_title.strip(),
        justification=payload.justification,
        headcount=payload.headcount,
        employment_type=payload.employment_type,
        salary_budget_min=payload.salary_budget_min,
        salary_budget_max=payload.salary_budget_max,
        salary_currency=payload.salary_currency or "INR",
        requested_by_name=payload.requested_by_name,
        requested_by_email=payload.requested_by_email,
        status="draft",
    )
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return req


@router.get("/{req_id}", response_model=RequisitionResponse)
async def get_requisition(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")
    return req


@router.patch("/{req_id}", response_model=RequisitionResponse)
async def update_requisition(
    req_id: int,
    payload: RequisitionUpdate,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")

    if payload.department_id is not None:
        req.department_id = payload.department_id
    if payload.job_title is not None:
        req.job_title = payload.job_title.strip()
    if payload.justification is not None:
        req.justification = payload.justification
    if payload.headcount is not None:
        req.headcount = payload.headcount
    if payload.employment_type is not None:
        req.employment_type = payload.employment_type
    if payload.salary_budget_min is not None:
        req.salary_budget_min = payload.salary_budget_min
    if payload.salary_budget_max is not None:
        req.salary_budget_max = payload.salary_budget_max
    if payload.salary_currency is not None:
        req.salary_currency = payload.salary_currency
    if payload.requested_by_name is not None:
        req.requested_by_name = payload.requested_by_name
    if payload.requested_by_email is not None:
        req.requested_by_email = payload.requested_by_email
    if payload.status is not None:
        req.status = payload.status
    if payload.approver_notes is not None:
        req.approver_notes = payload.approver_notes

    await db.commit()
    await db.refresh(req)
    return req


@router.post("/{req_id}/submit", response_model=RequisitionResponse)
async def submit_requisition(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")
    if req.status not in ("draft",):
        raise HTTPException(status_code=400, detail=f"Cannot submit from status '{req.status}'")
    req.status = "submitted"
    await db.commit()
    await db.refresh(req)
    return req


@router.post("/{req_id}/approve", response_model=RequisitionResponse)
async def approve_requisition(
    req_id: int,
    notes: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")
    if req.status not in ("submitted", "draft"):
        raise HTTPException(status_code=400, detail=f"Cannot approve from status '{req.status}'")
    req.status = "approved"
    if notes:
        req.approver_notes = notes
    await db.commit()
    await db.refresh(req)
    return req


@router.post("/{req_id}/reject", response_model=RequisitionResponse)
async def reject_requisition(
    req_id: int,
    notes: str | None = None,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> HireRequisition:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")
    req.status = "rejected"
    if notes:
        req.approver_notes = notes
    await db.commit()
    await db.refresh(req)
    return req


@router.delete("/{req_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_requisition(
    req_id: int,
    db: AsyncSession = Depends(get_db),
    _user: User = Depends(get_current_admin),
) -> None:
    req = await db.get(HireRequisition, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requisition not found")
    await db.delete(req)
    await db.commit()
