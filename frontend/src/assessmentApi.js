const DEFAULT_ASSESSMENT_API_BASE = '/assessment-api'

const ASSESSMENT_API_BASE = (import.meta.env.VITE_ASSESSMENT_API || DEFAULT_ASSESSMENT_API_BASE).replace(/\/$/, '')

async function request(path, { method = 'GET', body, headers } = {}) {
  const url = `${ASSESSMENT_API_BASE}${path}`

  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : null),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null)

  if (!response.ok) {
    const message =
      (data && typeof data === 'object' && (data.detail || data.message)) || `Request failed (${response.status})`
    throw new Error(message)
  }

  return data
}

export const assessmentApi = {
  listJobs() {
    return request('/api/jobs', { method: 'GET' })
  },

  createExam(payload) {
    return request('/api/exams/create', { method: 'POST', body: payload })
  },

  accessExam(sessionCode) {
    return request('/api/exams/access', { method: 'POST', body: { session_code: sessionCode } })
  },

  submitExam(sessionCode, answers) {
    return request(`/api/exams/${encodeURIComponent(sessionCode)}/submit`, {
      method: 'POST',
      body: { answers },
    })
  },

  analyzeFrame(payload) {
    return request('/api/proctor/analyze-frame', { method: 'POST', body: payload })
  },

  verifyCandidateIdentity(payload) {
    return request('/api/proctor/verify-identity', { method: 'POST', body: payload })
  },

  analyzeAudio(payload) {
    return request('/api/proctor/audio', { method: 'POST', body: payload })
  },

  logEvent(payload) {
    return request('/api/proctor/events', { method: 'POST', body: payload })
  },

  registerSecondaryPairing(payload) {
    return request('/api/proctor/secondary/register', { method: 'POST', body: payload })
  },

  uploadSecondaryFrame(payload) {
    return request('/api/proctor/secondary/upload', { method: 'POST', body: payload })
  },

  getSecondaryStatus(sessionCode, pairingToken) {
    const params = new URLSearchParams({ session_code: sessionCode, pairing_token: pairingToken })
    return request(`/api/proctor/secondary/status?${params.toString()}`, { method: 'GET' })
  },
}
