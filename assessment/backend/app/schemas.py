from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


class JobOut(BaseModel):
    id: int
    title: str
    description: str
    skills_required: list[str] | None = None
    additional_skills: list[str] | None = None

    model_config = {"from_attributes": True}


class ExamCreateRequest(BaseModel):
    job_id: int
    candidate_name: str = Field(min_length=2, max_length=255)
    candidate_email: EmailStr
    duration_minutes: int = Field(default=30, ge=10, le=180)
    question_count: int = Field(default=10, ge=5, le=30)
    difficulty: str = Field(default="medium")


class ExamQuestion(BaseModel):
    id: int
    question: str
    options: list[str]


class ExamCreateResponse(BaseModel):
    session_code: str
    exam_link: str
    duration_minutes: int
    questions: list[ExamQuestion]


class ExamAccessRequest(BaseModel):
    session_code: str


class ExamDetailsResponse(BaseModel):
    session_code: str
    candidate_name: str
    duration_minutes: int
    status: str
    questions: list[ExamQuestion]


class ExamSubmitRequest(BaseModel):
    answers: list[dict]


class ExamSubmitResponse(BaseModel):
    score: int
    total: int
    status: str


class ProctorFrameRequest(BaseModel):
    session_code: str
    camera_type: str = Field(pattern="^(primary|secondary)$")
    image_base64: str


class FaceIdVerificationRequest(BaseModel):
    session_code: str
    id_image_base64: str
    selfie_image_base64: str


class FaceIdVerificationResponse(BaseModel):
    verified: bool
    similarity: float | None = None
    threshold: float
    flags: list[str] = []
    id_face_count: int = 0
    selfie_face_count: int = 0
    government_id_uploaded: bool = False
    id_document_confidence: float = 0.0
    face_quality_score: float = 0.0
    model_source: str = "none"
    similarity_breakdown: dict | None = None
    id_document_signals: dict | None = None


class ProctorEventRequest(BaseModel):
    session_code: str
    event_type: str
    severity: str = "medium"
    payload: dict | None = None


class ProctorEventOut(BaseModel):
    event_type: str
    severity: str
    payload: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class SecondaryRegisterRequest(BaseModel):
    session_code: str
    pairing_token: str = Field(min_length=8, max_length=128)


class SecondaryUploadRequest(BaseModel):
    session_code: str
    pairing_token: str = Field(min_length=8, max_length=128)
    image_base64: str


class SecondaryStatusResponse(BaseModel):
    connected: bool
    frames_received: int
    last_seen_at: datetime | None = None
    latest_flags: list[str] = []
    is_stale: bool = True
    last_seen_age_seconds: float | None = None
    blocking_flags: list[str] = []
