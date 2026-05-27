const DEFAULT_API_BASE_URL = '/api'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '')
const REQUEST_TIMEOUT_MS = 30_000

function buildApiUrl(path) {
  const normalizedPath = String(path || '')
  if (!API_BASE_URL) {
    return normalizedPath
  }

  if (API_BASE_URL.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    return `${API_BASE_URL}${normalizedPath.slice(4)}`
  }

  return `${API_BASE_URL}${normalizedPath}`
}

function _withTimeout(signal, ms = REQUEST_TIMEOUT_MS) {
  // Combine the caller's AbortSignal (if any) with our own timeout.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), ms)
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }
  return { signal: controller.signal, cleanup: () => clearTimeout(timer) }
}

function _handleAuthFailure(status) {
  // 401 → server says cookie is missing/expired. Bounce to /login unless we
  // are already there (avoids redirect loops).
  if (status === 401 && typeof window !== 'undefined') {
    try { localStorage.removeItem('token') } catch {}
    const path = window.location?.pathname || ''
    if (!path.startsWith('/login') && !path.startsWith('/signup')) {
      window.location.replace('/login')
    }
  }
}

async function request(path, { method = 'GET', token, body, signal } = {}) {
  const headers = {
    Accept: 'application/json',
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const { signal: abortSignal, cleanup } = _withTimeout(signal)
  let response
  try {
    response = await fetch(buildApiUrl(path), {
      method,
      credentials: 'include',
      headers,
      signal: abortSignal,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } finally {
    cleanup()
  }

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null)

  if (!response.ok) {
    _handleAuthFailure(response.status)
    const message =
      (data && typeof data === 'object' && (data.detail || data.message)) || `Request failed (${response.status})`
    throw new Error(message)
  }

  return data
}

async function requestFormData(path, { method = 'POST', token, formData, signal } = {}) {
  const headers = {}

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const { signal: abortSignal, cleanup } = _withTimeout(signal, 90_000)
  let response
  try {
    response = await fetch(buildApiUrl(path), {
      method,
      credentials: 'include',
      headers,
      signal: abortSignal,
      body: formData,
    })
  } finally {
    cleanup()
  }

  const contentType = response.headers.get('content-type') || ''
  const isJson = contentType.includes('application/json')
  const data = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null)

  if (!response.ok) {
    _handleAuthFailure(response.status)
    const message =
      (data && typeof data === 'object' && (data.detail || data.message)) || `Request failed (${response.status})`
    throw new Error(message)
  }

  return data
}

async function requestBlob(path, { method = 'GET', token, signal } = {}) {
  const headers = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const { signal: abortSignal, cleanup } = _withTimeout(signal)
  let response
  try {
    response = await fetch(buildApiUrl(path), {
      method,
      credentials: 'include',
      headers,
      signal: abortSignal,
    })
  } finally {
    cleanup()
  }

  if (!response.ok) {
    _handleAuthFailure(response.status)
    const contentType = response.headers.get('content-type') || ''
    const isJson = contentType.includes('application/json')
    const data = isJson ? await response.json().catch(() => null) : await response.text().catch(() => null)
    const message =
      (data && typeof data === 'object' && (data.detail || data.message)) || `Request failed (${response.status})`
    throw new Error(message)
  }

  const blob = await response.blob()
  const contentDisposition = response.headers.get('content-disposition')
  return { blob, contentDisposition }
}

export const auth = {
  async signup(email, password, fullName, role) {
    return request('/api/auth/signup', {
      method: 'POST',
      body: {
        email,
        password,
        full_name: fullName,
        role: role || undefined,
      },
    })
  },

  async login(email, password) {
    return request('/api/auth/login', {
      method: 'POST',
      body: { email, password },
    })
  },

  async me(token) {
    return request('/api/auth/me', {
      method: 'GET',
      token,
    })
  },

  async logout() {
    return request('/api/auth/logout', {
      method: 'POST',
    })
  },

  async changePassword(token, currentPassword, newPassword) {
    return request('/api/auth/password', {
      method: 'PATCH',
      token,
      body: { current_password: currentPassword, new_password: newPassword },
    })
  },
}

export const candidates = {
  async list(token) {
    return request('/api/candidates', {
      method: 'GET',
      token,
    })
  },

  async uploadResume(token, file) {
    const formData = new FormData()
    formData.append('file', file)
    return requestFormData('/api/candidates/upload', {
      method: 'POST',
      token,
      formData,
    })
  },

  async downloadResume(token, candidateId) {
    return requestBlob(`/api/candidates/${candidateId}/resume`, {
      method: 'GET',
      token,
    })
  },

  async get(token, candidateId) {
    return request(`/api/candidates/${candidateId}`, {
      method: 'GET',
      token,
    })
  },

  async updateProgress(token, candidateId, jobId, payload) {
    return request(`/api/candidates/${candidateId}/progress/${jobId}`, {
      method: 'PATCH',
      token,
      body: payload,
    })
  },

  async delete(token, candidateId) {
    return request(`/api/candidates/${candidateId}`, {
      method: 'DELETE',
      token,
    })
  },
}

export const jobs = {
  async list(token) {
    return request('/api/jobs', { method: 'GET', token })
  },

  async listTemplates(token) {
    return request('/api/jobs?templates_only=true', { method: 'GET', token })
  },

  async create(token, payload) {
    return request('/api/jobs', { method: 'POST', token, body: payload })
  },

  async get(token, jobId) {
    return request(`/api/jobs/${jobId}`, { method: 'GET', token })
  },

  async update(token, jobId, payload) {
    return request(`/api/jobs/${jobId}`, { method: 'PUT', token, body: payload })
  },

  async delete(token, jobId) {
    return request(`/api/jobs/${jobId}`, { method: 'DELETE', token })
  },

  async generateJD(token, payload) {
    return request('/api/jobs/generate-jd', { method: 'POST', token, body: payload })
  },
}

export const departments = {
  async list(token) {
    return request('/api/departments', { method: 'GET', token })
  },

  async create(token, payload) {
    return request('/api/departments', { method: 'POST', token, body: payload })
  },

  async update(token, deptId, payload) {
    return request(`/api/departments/${deptId}`, { method: 'PUT', token, body: payload })
  },

  async delete(token, deptId) {
    return request(`/api/departments/${deptId}`, { method: 'DELETE', token })
  },
}

export const requisitions = {
  async list(token, statusFilter) {
    const qs = statusFilter ? `?status=${statusFilter}` : ''
    return request(`/api/requisitions${qs}`, { method: 'GET', token })
  },

  async create(token, payload) {
    return request('/api/requisitions', { method: 'POST', token, body: payload })
  },

  async update(token, reqId, payload) {
    return request(`/api/requisitions/${reqId}`, { method: 'PATCH', token, body: payload })
  },

  async submit(token, reqId) {
    return request(`/api/requisitions/${reqId}/submit`, { method: 'POST', token })
  },

  async approve(token, reqId, notes) {
    return request(`/api/requisitions/${reqId}/approve${notes ? `?notes=${encodeURIComponent(notes)}` : ''}`, { method: 'POST', token })
  },

  async reject(token, reqId, notes) {
    return request(`/api/requisitions/${reqId}/reject${notes ? `?notes=${encodeURIComponent(notes)}` : ''}`, { method: 'POST', token })
  },

  async delete(token, reqId) {
    return request(`/api/requisitions/${reqId}`, { method: 'DELETE', token })
  },
}

export const hire = {
  async bulkUploadResumes(token, files) {
    const formData = new FormData()
    Array.from(files || []).forEach((file) => formData.append('files', file))
    return requestFormData('/api/hire/resumes/upload', {
      method: 'POST',
      token,
      formData,
    })
  },

  async shortlistFromDump(token, jobId, limit = 5) {
    return request('/api/hire/shortlist', {
      method: 'POST',
      token,
      body: {
        job_id: jobId,
        limit,
      },
    })
  },

  async rank(token, payload) {
    return request('/api/hire/rank', {
      method: 'POST',
      token,
      body: payload,
    })
  },

  async sendTestLinkEmail(token, payload) {
    return request('/api/hire/send-test-link', {
      method: 'POST',
      token,
      body: payload,
    })
  },

  async getPipeline(token, jobId) {
    return request(`/api/hire/jobs/${jobId}/pipeline`, {
      method: 'GET',
      token,
    })
  },

  async bulkAction(token, jobId, payload) {
    return request(`/api/hire/jobs/${jobId}/bulk-action`, {
      method: 'POST',
      token,
      body: payload,
    })
  },

  async exportPipeline(token, jobId) {
    return requestBlob(`/api/hire/jobs/${jobId}/pipeline/export`, {
      method: 'GET',
      token,
    })
  },
}

export const dashboard = {
  async stats(token) {
    return request('/api/dashboard/stats', {
      method: 'GET',
      token,
    })
  },
}

export const candidatePortal = {
  async listJobs(token) {
    return request('/api/candidate-portal/jobs', {
      method: 'GET',
      token,
    })
  },

  async relatedJobs(token, jobId, limit = 6) {
    const params = new URLSearchParams({ limit: String(limit) })
    return request(`/api/candidate-portal/jobs/${jobId}/related?${params.toString()}`, {
      method: 'GET',
      token,
    })
  },

  async getProfile(token) {
    return request('/api/candidate-portal/profile', {
      method: 'GET',
      token,
    })
  },

  async updateProfile(token, payload) {
    return request('/api/candidate-portal/profile', {
      method: 'PUT',
      token,
      body: payload,
    })
  },

  async autofillResume(token, file) {
    const formData = new FormData()
    formData.append('file', file)
    return requestFormData('/api/candidate-portal/profile/resume-autofill', {
      method: 'POST',
      token,
      formData,
    })
  },

  async uploadDocument(token, file, docType = '') {
    const formData = new FormData()
    formData.append('file', file)
    if (String(docType || '').trim()) {
      formData.append('doc_type', String(docType || '').trim())
    }
    return requestFormData('/api/candidate-portal/profile/documents', {
      method: 'POST',
      token,
      formData,
    })
  },

  async deleteDocument(token, documentId) {
    return request(`/api/candidate-portal/profile/documents/${documentId}`, {
      method: 'DELETE',
      token,
    })
  },

  async downloadDocument(token, documentId) {
    return requestBlob(`/api/candidate-portal/profile/documents/${documentId}/download`, {
      method: 'GET',
      token,
    })
  },

  async applyToJob(token, jobId, payload = {}) {
    return request(`/api/candidate-portal/jobs/${jobId}/apply`, {
      method: 'POST',
      token,
      body: payload,
    })
  },

  async withdrawApplication(token, jobId) {
    return request(`/api/candidate-portal/jobs/${jobId}/apply`, {
      method: 'DELETE',
      token,
    })
  },
}

export const knockoutQuestions = {
  async list(jobId) {
    return request(`/api/knockout-questions?job_id=${jobId}`)
  },

  async create(token, jobId, payload) {
    return request(`/api/knockout-questions?job_id=${jobId}`, { method: 'POST', token, body: payload })
  },

  async update(token, questionId, payload) {
    return request(`/api/knockout-questions/${questionId}`, { method: 'PUT', token, body: payload })
  },

  async delete(token, questionId) {
    return request(`/api/knockout-questions/${questionId}`, { method: 'DELETE', token })
  },
}

export const referrals = {
  async list(token, jobId, status) {
    const qs = new URLSearchParams()
    if (jobId) qs.set('job_id', jobId)
    if (status) qs.set('status', status)
    return request(`/api/referrals${qs.toString() ? `?${qs}` : ''}`, { method: 'GET', token })
  },

  async activeJobs() {
    // Public — lists active jobs for the referral form (no token needed)
    return request('/api/referrals/active-jobs')
  },

  async submit(payload) {
    // Public — no token needed
    return request('/api/referrals', { method: 'POST', body: payload })
  },

  async updateStatus(token, referralId, newStatus) {
    return request(`/api/referrals/${referralId}/status?new_status=${encodeURIComponent(newStatus)}`, { method: 'PATCH', token })
  },

  async delete(token, referralId) {
    return request(`/api/referrals/${referralId}`, { method: 'DELETE', token })
  },
}

export const bulkImport = {
  async uploadZip(token, zipFile, sourceTag = 'bulk_import') {
    const formData = new FormData()
    formData.append('zip_file', zipFile)
    return requestFormData(`/api/hire/bulk-import?source_tag=${encodeURIComponent(sourceTag)}`, {
      method: 'POST',
      token,
      formData,
    })
  },
}

export const realtime = {
  streamUrl(token, { eventTypes = [] } = {}) {
    // The backend authenticates the SSE stream via the httpOnly cookie. We no
    // longer pass `?token=…` (which leaked into proxy/access logs and the
    // browser address bar). EventSource will automatically include cookies
    // when constructed with `{ withCredentials: true }`.
    const params = new URLSearchParams()
    if (Array.isArray(eventTypes) && eventTypes.length) {
      params.set('event_types', eventTypes.map((v) => String(v || '').trim()).filter(Boolean).join(','))
    }
    const qs = params.toString()
    const base = buildApiUrl('/api/realtime/stream')
    return qs ? `${base}?${qs}` : base
  },
}

export const insights = {
  async getSummary(token, candidateId) {
    return request(`/api/insights/${candidateId}/summary`, { method: 'GET', token })
  },

  async analyzeAll(token, candidateId) {
    return request(`/api/insights/${candidateId}/analyze-all`, { method: 'POST', token })
  },

  async getRedFlags(token, candidateId) {
    return request(`/api/insights/red-flags/${candidateId}`, { method: 'GET', token })
  },

  async runRedFlags(token, candidateId) {
    return request(`/api/insights/red-flags/${candidateId}`, { method: 'POST', token })
  },

  async getSkillDecay(token, candidateId) {
    return request(`/api/insights/skill-decay/${candidateId}`, { method: 'GET', token })
  },

  async runSkillDecay(token, candidateId) {
    return request(`/api/insights/skill-decay/${candidateId}`, { method: 'POST', token })
  },

  async getCandidateMemory(token, candidateId) {
    return request(`/api/insights/candidate-memory/${candidateId}`, { method: 'GET', token })
  },

  async recordMemory(token, candidateId, jobId, outcome, gaps, rejectionReasons) {
    const params = new URLSearchParams({ job_id: jobId, outcome })
    if (gaps) params.set('gaps', gaps)
    if (rejectionReasons) params.set('rejection_reasons', rejectionReasons)
    return request(`/api/insights/candidate-memory/${candidateId}/record?${params}`, { method: 'POST', token })
  },

  async analyzeReapplication(token, candidateId, jobId) {
    return request(`/api/insights/candidate-memory/${candidateId}/analyze-reapplication?job_id=${jobId}`, { method: 'POST', token })
  },
}

export const chat = {
  async sendMessage(message, history = []) {
    const token = localStorage.getItem('token')
    return request('/api/chat/message', {
      method: 'POST',
      token: token || undefined,
      body: { message, history },
    })
  },

  async sendAdminMessage(message, history = []) {
    const token = localStorage.getItem('token')
    return request('/api/chat/admin', {
      method: 'POST',
      token: token || undefined,
      body: { message, history },
    })
  },

  async sendJobsMessage(message, history = []) {
    const token = localStorage.getItem('token')
    return request('/api/chat/jobs', {
      method: 'POST',
      token: token || undefined,
      body: { message, history },
    })
  },

  async sendCandidatesMessage(message, history = []) {
    const token = localStorage.getItem('token')
    return request('/api/chat/candidates', {
      method: 'POST',
      token: token || undefined,
      body: { message, history },
    })
  },

  async jobSuggestions(payload) {
    const token = localStorage.getItem('token')
    return request('/api/chat/job-suggestions', {
      method: 'POST',
      token: token || undefined,
      body: payload,
    })
  },
}

export const calls = {
  async placeCall({ phone_number, position, candidate_name, session_code, candidate_email }) {
    const token = localStorage.getItem('token')
    return request('/api/calls/voice/demo', {
      method: 'POST',
      token,
      body: { phone_number, position, candidate_name, session_code, candidate_email },
    })
  },

  async getAnalysis(sessionCode) {
    const token = localStorage.getItem('token')
    return request(`/api/calls/voice/analysis/${encodeURIComponent(sessionCode)}`, {
      method: 'GET',
      token,
    })
  },

  async triggerAnalysis(sessionCode) {
    const token = localStorage.getItem('token')
    return request(`/api/calls/voice/analysis/${encodeURIComponent(sessionCode)}/trigger`, {
      method: 'POST',
      token,
    })
  },
}
