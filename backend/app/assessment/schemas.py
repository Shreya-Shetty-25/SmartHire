from datetime import datetime

from pydantic import BaseModel, EmailStr, Field


ASSESSMENT_TYPE_PATTERN = "^[a-z][a-z0-9_]{0,31}$"


class JobOut(BaseModel):
    id: int
    title: str
    description: str
    skills_required: list[str] | None = None
    additional_skills: list[str] | None = None

    model_config = {"from_attributes": True}


class ExamCreateRequest(BaseModel):
    # Either provide job_id (when JOBS_DATABASE_URL is configured) or provide
    # job_title + job_description (+ optional skills) directly.
    job_id: int | None = None
    job_title: str | None = None
    job_description: str | None = None
    skills_required: list[str] | None = None
    additional_skills: list[str] | None = None
    candidate_name: str = Field(min_length=2, max_length=255)
    candidate_email: EmailStr
    assessment_type: str = Field(default="onscreen", pattern=ASSESSMENT_TYPE_PATTERN)
    duration_minutes: int = Field(default=30, ge=10, le=180)
    question_count: int = Field(default=10, ge=4, le=30)
    difficulty: str = Field(default="hard")
    resume_skills: list[str] | None = None
    question_generation_mode: str = Field(default="auto", pattern="^(auto|fast)$")


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


class ExamAntiCheatRequirements(BaseModel):
    requires_fullscreen: bool = True
    requires_face_verification: bool = True
    blocks_high_risk_environment: bool = True
    supports_secondary_camera: bool = True


class ExamDetailsResponse(BaseModel):
    session_code: str
    candidate_name: str
    duration_minutes: int
    assessment_type: str = "onscreen"
    status: str
    started_at: datetime | None = None
    anti_cheat: ExamAntiCheatRequirements = Field(default_factory=ExamAntiCheatRequirements)
    questions: list[ExamQuestion]


class ExamSubmitRequest(BaseModel):
    answers: list[dict]


class ExamSubmitResponse(BaseModel):
    score: int
    total: int
    percentage: float
    passed: bool
    status: str
    result_analysis: dict | None = None


class ExamBeginResponse(BaseModel):
    session_code: str
    status: str
    started_at: datetime


class ExamResultResponse(BaseModel):
    session_code: str
    candidate_name: str
    candidate_email: str
    job_title: str | None = None
    score: int
    total: int
    percentage: float
    passed: bool
    status: str
    result_analysis: dict | None = None
    email_sent: str | None = None
    call_sid: str | None = None
    call_status: str | None = None
    call_responses: list[dict] | None = None
    submitted_at: datetime | None = None

    model_config = {"from_attributes": True}


class ProctorFrameRequest(BaseModel):
    session_code: str
    assessment_type: str = Field(default="onscreen", pattern=ASSESSMENT_TYPE_PATTERN)
    camera_type: str = Field(pattern="^(primary|secondary)$")
    image_base64: str = Field(max_length=7_000_000)


class FaceIdVerificationRequest(BaseModel):
    session_code: str
    assessment_type: str = Field(default="onscreen", pattern=ASSESSMENT_TYPE_PATTERN)
    government_id_type: str | None = Field(default=None, max_length=64)
    id_image_base64: str = Field(max_length=7_000_000)
    selfie_image_base64: str = Field(max_length=7_000_000)


class FaceIdVerificationResponse(BaseModel):
    model_config = {"protected_namespaces": ()}

    verified: bool
    similarity: float | None = None
    threshold: float
    flags: list[str] = []
    blocking_flags: list[str] = []
    guidance: list[dict] = []
    next_steps: list[str] = []
    can_retry: bool = True
    id_face_count: int = 0
    selfie_face_count: int = 0
    government_id_uploaded: bool = False
    government_id_type: str | None = None
    government_id_type_valid: bool = False
    accepted_government_id_types: list[str] = [
        "aadhaar",
        "pan",
        "driving_license",
        "voter_id",
    ]
    id_document_confidence: float = 0.0
    face_quality_score: float = 0.0
    model_source: str = "none"
    similarity_breakdown: dict | None = None
    id_document_signals: dict | None = None
    image_meta: dict | None = None


class ProctorEventRequest(BaseModel):
    session_code: str
    assessment_type: str = Field(default="onscreen", pattern=ASSESSMENT_TYPE_PATTERN)
    event_type: str
    severity: str = "medium"
    payload: dict | None = None


class ProctorEventOut(BaseModel):
    assessment_type: str = "onscreen"
    event_type: str
    severity: str
    payload: dict | None
    created_at: datetime

    model_config = {"from_attributes": True}


class EnvCheckRequest(BaseModel):
    session_code: str
    user_agent: str = ""
    platform: str = ""
    hardware_concurrency: int | None = None
    device_memory: float | None = None
    webgl_renderer: str = ""
    webgl_vendor: str = ""
    screen_width: int | None = None
    screen_height: int | None = None
    screen_color_depth: int | None = None
    max_touch_points: int | None = None
    timezone: str = ""
    languages: list[str] = []
    plugins_count: int | None = None
    has_pointer: bool = True


class SecondaryRegisterRequest(BaseModel):
    session_code: str
    pairing_token: str = Field(min_length=8, max_length=128)


class SecondaryUploadRequest(BaseModel):
    session_code: str
    assessment_type: str = Field(default="onscreen", pattern=ASSESSMENT_TYPE_PATTERN)
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


class AdminExamSessionOut(BaseModel):
    session_code: str
    assessment_type: str
    candidate_name: str
    candidate_email: EmailStr
    job_title: str | None = None
    status: str
    score: int | None = None
    total: int | None = None
    percentage: float | None = None
    passed: bool | None = None
    started_at: datetime | None = None
    submitted_at: datetime | None = None
    created_at: datetime | None = None


class CandidateExamSessionOut(BaseModel):
    session_code: str
    assessment_type: str
    candidate_name: str
    candidate_email: EmailStr
    job_title: str | None = None
    status: str
    score: int | None = None
    total: int | None = None
    percentage: float | None = None
    passed: bool | None = None
    started_at: datetime | None = None
    submitted_at: datetime | None = None
    created_at: datetime | None = None
    call_status: str | None = None
    identity_status: str | None = None


class AdminExamDetailOut(BaseModel):
    session_code: str
    assessment_type: str
    job_id: int | None = None
    candidate_name: str
    candidate_email: EmailStr
    candidate_phone: str | None = None
    job_title: str | None = None
    status: str
    duration_minutes: int
    score: int | None = None
    total: int | None = None
    percentage: float | None = None
    passed: bool | None = None
    started_at: datetime | None = None
    submitted_at: datetime | None = None
    created_at: datetime | None = None
    questions_json: list[dict]
    answers_json: list[dict] | None = None
    result_analysis: dict | None = None
    severity: dict
    green_signals: list[dict]
    red_signals: list[dict]
    ai_summary: dict | None = None
    call_sid: str | None = None
    call_status: str | None = None
    call_attempt_count: int = 0
    identity_status: str | None = None
    identity_submitted_at: datetime | None = None
    government_id_image_base64: str | None = None
    live_selfie_image_base64: str | None = None
    pipeline_stage: str | None = None
    recruiter_notes: str | None = None
    manual_assessment_score: float | None = None
    interview_scheduled_for: datetime | None = None
    interview_status: str | None = None
    decision_history: list[dict] = []
    call_interview_logs: list[dict] = []
    events: list[ProctorEventOut]


class AdminScheduleCallRequest(BaseModel):
    threshold_percentage: float = Field(default=60.0, ge=0.0, le=100.0)
    delay_seconds: int = Field(default=60, ge=15, le=900)
    scheduled_for: datetime | None = None


class AdminExamReviewUpdateRequest(BaseModel):
    stage: str | None = None
    recruiter_notes: str | None = None
    manual_assessment_score: float | None = Field(default=None, ge=0.0, le=100.0)
    interview_status: str | None = None
    interview_scheduled_for: datetime | None = None
    append_history_note: str | None = None


class AdminActionResponse(BaseModel):
    ok: bool = True
    message: str
    session_code: str
