const DEFAULT_API_BASE_URL = '/api'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '')

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

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = {
    Accept: 'application/json',
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(buildApiUrl(path), {
    method,
    credentials: 'include',
    headers,
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

async function requestFormData(path, { method = 'POST', token, formData } = {}) {
  const headers = {}

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(buildApiUrl(path), {
    method,
    credentials: 'include',
    headers,
    body: formData,
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

async function requestBlob(path, { method = 'GET', token } = {}) {
  const headers = {}
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const response = await fetch(buildApiUrl(path), {
    method,
    credentials: 'include',
    headers,
  })

  if (!response.ok) {
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
}

export const jobs = {
  async list(token) {
    return request('/api/jobs', {
      method: 'GET',
      token,
    })
  },

  async create(token, payload) {
    return request('/api/jobs', {
      method: 'POST',
      token,
      body: payload,
    })
  },

  async get(token, jobId) {
    return request(`/api/jobs/${jobId}`, {
      method: 'GET',
      token,
    })
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
}

export const realtime = {
  streamUrl(token, { eventTypes = [] } = {}) {
    const t = String(token || '').trim()
    if (!t) return ''
    const params = new URLSearchParams({ token: t })
    if (Array.isArray(eventTypes) && eventTypes.length) {
      params.set('event_types', eventTypes.map((v) => String(v || '').trim()).filter(Boolean).join(','))
    }
    return `${buildApiUrl('/api/realtime/stream')}?${params.toString()}`
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
}
