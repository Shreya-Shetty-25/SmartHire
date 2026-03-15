from datetime import datetime
from pydantic import BaseModel, EmailStr, Field, field_validator


# Auth schemas
class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str | None = None


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserResponse(BaseModel):
    id: int
    email: str
    full_name: str | None
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


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
    candidate_ids: list[int] = Field(min_length=1)
    threshold_score: float = Field(default=70.0, ge=0.0, le=100.0)
    source: str = Field(default="upload")


class HireRankResultItem(BaseModel):
    candidate: CandidateResponse
    score: float = Field(ge=0.0, le=100.0)
    passed: bool
    analysis: dict | None = None


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
    test_link: str = Field(min_length=1)
    session_code: str | None = None
    duration_minutes: int | None = Field(default=None, ge=10, le=180)
    question_count: int | None = Field(default=None, ge=5, le=30)
    difficulty: str | None = None


class HireSendTestLinkEmailResponse(BaseModel):
    status: str = "queued"
    to: str


# Calls / voice agent schemas
class VoiceDemoCallRequest(BaseModel):
    phone_number: str = Field(min_length=5, max_length=32)
    position: str = Field(min_length=1, max_length=255)
    candidate_name: str = Field(min_length=1, max_length=255)


class VoiceDemoCallResponse(BaseModel):
    call_sid: str
    status: str | None = None
    to: str
    from_number: str
    twiml_url: str
