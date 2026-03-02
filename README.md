# SmartHire

SmartHire is a smart HR recruitment system with a React+Vite frontend and a FastAPI backend using PostgreSQL (local dev).

## Structure

- frontend/ - React + Vite (JavaScript)
- backend/ - FastAPI (Python) + PostgreSQL

## Backend configuration (local Postgres)

- In backend/, copy .env.example to .env and set DATABASE_URL.
- Start Postgres locally (ensure the user/password/db in DATABASE_URL exist).

## Candidates + resume parsing

- The backend exposes authenticated endpoints under /api/candidates.
- Resume upload uses an LLM provider (Azure OpenAI / Gemini / Groq) selected via boolean env flags.
- Configure exactly one of USE_AZURE_OPENAI / USE_GEMINI / USE_GROQ in backend/.env (see backend/.env.example).
