from datetime import datetime
from pydantic import BaseModel, EmailStr, Field


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
    limit: int = Field(default=25, ge=1, le=200)


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
