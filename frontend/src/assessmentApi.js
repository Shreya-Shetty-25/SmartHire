const DEFAULT_ASSESSMENT_API_BASE = '/assessment-api'
const DEFAULT_TIMEOUT_MS = 15000

const ASSESSMENT_API_BASE = (import.meta.env.VITE_ASSESSMENT_API || DEFAULT_ASSESSMENT_API_BASE).replace(/\/$/, '')

async function request(path, { method = 'GET', body, headers } = {}) {
  const url = `${ASSESSMENT_API_BASE}${path}`

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  let response
  try {
    response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : null),
        ...(headers || {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Assessment service timeout. Please try again in a moment.')
    }
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

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

  getExamResult(sessionCode) {
    return request(`/api/exams/${encodeURIComponent(sessionCode)}/result`, { method: 'GET' })
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

  getStats() {
    return request('/api/assessment/stats', { method: 'GET' })
  },

  adminListExams({ assessmentType = 'onscreen', candidateEmail = '', limit = 50, offset = 0 } = {}) {
    const params = new URLSearchParams({
      assessment_type: String(assessmentType || 'onscreen'),
      limit: String(limit),
      offset: String(offset),
    })
    if (candidateEmail && String(candidateEmail).trim()) {
      params.set('candidate_email', String(candidateEmail).trim())
    }
    return request(`/api/admin/exams?${params.toString()}`, { method: 'GET' })
  },

  adminGetExamDetail(sessionCode, { assessmentType = '' } = {}) {
    const params = new URLSearchParams()
    if (assessmentType && String(assessmentType).trim()) {
      params.set('assessment_type', String(assessmentType).trim())
    }
    const suffix = params.toString() ? `?${params.toString()}` : ''
    return request(`/api/admin/exams/${encodeURIComponent(sessionCode)}${suffix}`, { method: 'GET' })
  },

  adminScheduleCall(sessionCode, { thresholdPercentage = 60, delaySeconds = 60 } = {}) {
    return request(`/api/admin/exams/${encodeURIComponent(sessionCode)}/schedule-call`, {
      method: 'POST',
      body: {
        threshold_percentage: Number(thresholdPercentage),
        delay_seconds: Number(delaySeconds),
      },
    })
  },

  adminRejectCandidate(sessionCode) {
    return request(`/api/admin/exams/${encodeURIComponent(sessionCode)}/reject`, {
      method: 'POST',
      body: {},
    })
  },
}
