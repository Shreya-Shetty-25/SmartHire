const API_BASE = (import.meta.env.VITE_ASSESSMENT_API || '').replace(/\/$/, '')

async function request(path, options = {}) {
  const url = API_BASE ? `${API_BASE}${path}` : path
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  })

  const data = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error((data && data.detail) || `Request failed (${response.status})`)
  }
  return data
}

export const assessmentApi = {
  listJobs() {
    return request('/api/jobs')
  },
  createExam(payload) {
    return request('/api/exams/create', { method: 'POST', body: JSON.stringify(payload) })
  },
  accessExam(session_code) {
    return request('/api/exams/access', { method: 'POST', body: JSON.stringify({ session_code }) })
  },
  submitExam(sessionCode, answers) {
    return request(`/api/exams/${sessionCode}/submit`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    })
  },
  analyzeFrame(payload) {
    return request('/api/proctor/analyze-frame', { method: 'POST', body: JSON.stringify(payload) })
  },
  verifyCandidateIdentity(payload) {
    return request('/api/proctor/verify-identity', { method: 'POST', body: JSON.stringify(payload) })
  },
  analyzeAudio(payload) {
    return request('/api/proctor/audio', { method: 'POST', body: JSON.stringify(payload) })
  },
  logEvent(payload) {
    return request('/api/proctor/events', { method: 'POST', body: JSON.stringify(payload) })
  },
  envCheck(payload) {
    return request('/api/proctor/env-check', { method: 'POST', body: JSON.stringify(payload) })
  },
  registerSecondaryPairing(payload) {
    return request('/api/proctor/secondary/register', { method: 'POST', body: JSON.stringify(payload) })
  },
  uploadSecondaryFrame(payload) {
    return request('/api/proctor/secondary/upload', { method: 'POST', body: JSON.stringify(payload) })
  },
  getSecondaryStatus(sessionCode, pairingToken) {
    const params = new URLSearchParams({ session_code: sessionCode, pairing_token: pairingToken })
    return request(`/api/proctor/secondary/status?${params.toString()}`, { method: 'GET' })
  },
}
