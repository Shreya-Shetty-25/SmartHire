# SmartHire - AI-Powered Recruitment Platform

## Project Overview
SmartHire is a full-stack AI-powered recruitment platform with resume parsing, candidate ranking, proctored assessments, and AI voice interviews.

## Architecture
- **Main Backend** (`backend/`): FastAPI + PostgreSQL + async SQLAlchemy. Handles auth, jobs, candidates, resume parsing, ranking, email, and Twilio voice calls.
- **Assessment Backend** (`assessment/backend/`): FastAPI + SQLite. Handles exam sessions, Azure OpenAI question generation, proctoring, scoring, result emails, and AI interview calls.
- **Frontend** (`frontend/`): React + Vite. Single-page app with role-based access (admin vs candidate).

## Key Technologies
- Python 3.11+, FastAPI, SQLAlchemy 2.x, asyncpg, PostgreSQL
- Azure OpenAI (GPT) for question generation and analysis
- Twilio + ElevenLabs for voice AI interviews
- React 18, React Router, Vite
- OpenCV + MediaPipe for proctoring (face detection, gaze tracking)

## Development Commands
- Backend: `cd backend && uvicorn app.main:app --port 8001 --reload`
- Assessment: `cd assessment/backend && uvicorn app.main:app --port 8100 --reload`
- Frontend: `cd frontend && npm run dev`

## Environment
- Backend config: `backend/.env`
- Assessment config: `assessment/backend/.env`
- Frontend proxy: Vite proxies `/api` to backend:8001 and `/assessment-api` to assessment:8100

## Coding Conventions
- Use type hints in Python
- Pydantic models for request/response schemas
- Loguru for logging
- React functional components with hooks
- CSS variables for theming
