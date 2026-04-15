from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, field_validator

from .pipeline import PIPELINE_STAGES


# Auth schemas
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str | None = None
    role: str | None = Field(default=None, pattern="^(admin|candidate)$")


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str | None
    role: str
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: str = "candidate"


class TokenData(BaseModel):
    user_id: int | None = None


# Candidate schemas
class CandidateParsed(BaseModel):
    full_name: str = Field(min_length=1)
    email: EmailStr
    phone_number: str | None = None

    college_details: str | None = None
    school_details: str | None = None

    projects: list[str] | None = None
    skills: list[str] | None = None
    work_experience: list[str] | None = None
    extra_curricular_activities: list[str] | None = None
    website_links: list[str] | None = None

    years_experience: int | None = Field(default=None, ge=0)
    location: str | None = None
    certifications: list[str] | None = None

    @field_validator("years_experience", mode="before")
    @classmethod
    def _coerce_years_experience(cls, v):
        if v is None or v == "":
            return None
        if isinstance(v, bool):
            return None
        if isinstance(v, (int, float)):
            return int(v)
        if isinstance(v, str):
            s = v.strip()
            if not s:
                return None
            try:
                return int(float(s))
            except Exception:
                return None
        return None

    @field_validator("website_links", "projects", "skills", "work_experience", "extra_curricular_activities", "certifications", mode="before")
    @classmethod
    def _clean_string_lists(cls, v):
        if v is None:
            return None
        if isinstance(v, str):
            v = [v]
        if not isinstance(v, list):
            return None
        out: list[str] = []
        for item in v:
            if item is None:
                continue
            s = str(item).strip()
            if s:
                out.append(s)
        return out or None


class CandidateResponse(BaseModel):
    id: int
    full_name: str
    email: str
    phone_number: str | None
    college_details: str | None
    school_details: str | None
    projects: list[str] | None
    skills: list[str] | None
    work_experience: list[str] | None
    extra_curricular_activities: list[str] | None
    website_links: list[str] | None
    years_experience: int | None
    location: str | None
    certifications: list[str] | None
    resume_filename: str | None
    created_at: datetime

    class Config:
        from_attributes = True


class CandidateDecisionHistoryItem(BaseModel):
    timestamp: datetime | str
    action: str
    stage: str | None = None
    actor: str | None = None
    note: str | None = None
    details: dict | None = None


class JobCandidateProgressResponse(BaseModel):
    id: int
    job_id: int
    job_title: str | None = None
    candidate_id: int
    stage: str
    recruiter_notes: str | None = None
    manual_rank_score: float | None = None
    manual_assessment_score: float | None = None
    last_assessment_session_code: str | None = None
    assessment_status: str | None = None
    assessment_score: float | None = None
    assessment_passed: bool | None = None
    interview_scheduled_for: datetime | None = None
    interview_status: str | None = None
    last_contacted_at: datetime | None = None
    decision_history: list[dict] = []
    created_at: datetime
    updated_at: datetime | None = None


class CandidateDetailResponse(CandidateResponse):
    job_progress: list[JobCandidateProgressResponse] = []


class CandidateProgressUpdateRequest(BaseModel):
    stage: str | None = Field(default=None, pattern=f"^({'|'.join(PIPELINE_STAGES)})$")
    recruiter_notes: str | None = None
    manual_rank_score: float | None = Field(default=None, ge=0.0, le=100.0)
    manual_assessment_score: float | None = Field(default=None, ge=0.0, le=100.0)
    assessment_status: str | None = None
    assessment_passed: bool | None = None
    last_assessment_session_code: str | None = Field(default=None, max_length=64)
    interview_scheduled_for: datetime | None = None
    interview_status: str | None = None
    append_history_note: str | None = None


class CandidateBulkActionRequest(BaseModel):
    job_id: int | None = None
    candidate_ids: list[int] = Field(min_length=1, max_length=250)
    action: str = Field(min_length=1, max_length=64)
    stage: str | None = Field(default=None, pattern=f"^({'|'.join(PIPELINE_STAGES)})$")
    recruiter_notes: str | None = None
    manual_rank_score: float | None = Field(default=None, ge=0.0, le=100.0)
    manual_assessment_score: float | None = Field(default=None, ge=0.0, le=100.0)
    interview_scheduled_for: datetime | None = None
    interview_status: str | None = None
    send_assessment: bool = False
    question_count: int | None = Field(default=10, ge=5, le=30)
    duration_minutes: int | None = Field(default=30, ge=10, le=180)
    difficulty: str | None = Field(default="hard")


class CandidateBulkActionResponse(BaseModel):
    ok: bool = True
    updated_count: int
    updated_candidate_ids: list[int]
    message: str


# Jobs schemas
class JobCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    description: str = Field(min_length=1)
    education: str | None = None
    years_experience: int | None = Field(default=None, ge=0)
    skills_required: list[str] | None = None
    additional_skills: list[str] | None = None
    location: str | None = None
    employment_type: str | None = None


class JobResponse(BaseModel):
    id: int
    title: str
    description: str
    education: str | None
    years_experience: int | None
    skills_required: list[str] | None
    additional_skills: list[str] | None
    location: str | None
    employment_type: str | None
    created_at: datetime

    class Config:
        from_attributes = True


# Hire / shortlist / ranking schemas
class HireShortlistRequest(BaseModel):
    job_id: int
    limit: int = Field(default=5, ge=1, le=200)


class HireShortlistItem(BaseModel):
    candidate: CandidateResponse
    score: float = Field(ge=0)


class HireShortlistResponse(BaseModel):
    job_id: int
    results: list[HireShortlistItem]


class HireRankRequest(BaseModel):
    job_id: int
    candidate_ids: list[int] = Field(min_length=1, max_length=200)
    threshold_score: float = Field(default=70.0, ge=0.0, le=100.0)
    source: str = Field(default="upload")


class HireRankResultItem(BaseModel):
    candidate: CandidateResponse
    score: float = Field(ge=0.0, le=100.0)
    passed: bool
    analysis: dict | None = None
    effective_score: float | None = Field(default=None, ge=0.0, le=100.0)
    manual_rank_score: float | None = Field(default=None, ge=0.0, le=100.0)
    pipeline_stage: str | None = None
    recruiter_notes: str | None = None


class HireRankResponse(BaseModel):
    run_id: int
    job_id: int
    threshold_score: float
    results: list[HireRankResultItem]


class HireSendTestLinkEmailRequest(BaseModel):
    job_id: int | None = None
    candidate_email: EmailStr
    candidate_name: str | None = None
    job_title: str | None = None
    test_link: str | None = None
    session_code: str | None = None
    duration_minutes: int | None = Field(default=None, ge=10, le=180)
    question_count: int | None = Field(default=10, ge=5, le=30)
    difficulty: str | None = Field(default="hard")


class HireSendTestLinkEmailResponse(BaseModel):
    status: str = "queued"
    to: str
    session_code: str | None = None


class HireJobPipelineCandidateItem(BaseModel):
    candidate: CandidateResponse
    progress: JobCandidateProgressResponse | None = None
    latest_rank_score: float | None = None
    latest_rank_passed: bool | None = None


class HireJobPipelineResponse(BaseModel):
    job_id: int
    job_title: str | None = None
    candidates: list[HireJobPipelineCandidateItem]


# Calls / voice agent schemas
class VoiceDemoCallRequest(BaseModel):
    phone_number: str = Field(min_length=5, max_length=32)
    position: str = Field(min_length=1, max_length=255)
    candidate_name: str = Field(min_length=1, max_length=255)
    session_code: str | None = Field(default=None, max_length=64)
    candidate_email: EmailStr | None = None


class VoiceDemoCallResponse(BaseModel):
    call_sid: str
    status: str | None = None
    to: str
    from_number: str
    twiml_url: str
