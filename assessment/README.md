# SmartHire Assessment Portal (Free Stack)

This folder contains a standalone online examination portal with:
- React frontend (`assessment/frontend`)
- FastAPI backend (`assessment/backend`)
- Job Description based question generation from the existing `jobs` table
- Anti-cheat monitoring (primary camera, face+ID pre-verification, object detection, eye movement, audio anomaly, strict tab/fullscreen policy)
- ngrok-friendly deployment link support

## 1) Backend setup

```powershell
cd assessment/backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

Update `.env` values:
- `JOBS_DATABASE_URL`: must point to your main SmartHire Postgres where `jobs` table exists.
- `PUBLIC_BASE_URL`: exam portal URL. Use localhost for local run; use your ngrok URL when public.
- `USE_HF_LLM=false` by default.

Run backend:

```powershell
uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload
```

## 2) Frontend setup

```powershell
cd ../frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:5173`.

Optional `.env` in frontend (only needed if you do NOT want proxy mode):

```env
VITE_ASSESSMENT_API=http://127.0.0.1:8100
```

## 3) Free ngrok exposure

Install ngrok (free account is enough), then:

```powershell
ngrok http 5173
```

Use generated URL (e.g. `https://xxxx.ngrok-free.app`) as `PUBLIC_BASE_URL` in backend `.env`, restart backend.

This works with a single tunnel because frontend `/api/*` calls are proxied by Vite to `http://127.0.0.1:8100`.

## 4) Ready-made free model option (Hugging Face)

This app already supports an optional ready-made free model path:
- provider: Hugging Face Inference API
- default model: `google/flan-t5-base`

Enable in backend `.env`:

```env
USE_HF_LLM=true
HF_API_TOKEN=your_free_hf_token
HF_MODEL=google/flan-t5-base
```

If HF output is invalid or rate-limited, backend automatically falls back to deterministic JD-based question generation.

## 5) API summary

- `GET /api/jobs` → list jobs from existing DB
- `POST /api/exams/create` → generate exam from selected JD
- `POST /api/exams/access` → candidate enters session code
- `POST /api/exams/{session_code}/submit` → submit answers
- `POST /api/proctor/analyze-frame` → camera frame analysis
- `POST /api/proctor/verify-identity` → mandatory face + ID verification before exam start
- `POST /api/proctor/audio` → audio anomaly signal
- `POST /api/proctor/events` → generic anti-cheat events
- `GET /api/exams/{session_code}/proctor-report` → full event report

## 6) Notes

- Candidate must pass face + ID verification before starting exam.
- All resources used here are free/open-source by default.
- For production use, add authentication, encrypted storage, and stronger proctoring review workflows.
