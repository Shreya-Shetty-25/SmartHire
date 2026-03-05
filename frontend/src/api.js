const DEFAULT_API_BASE_URL = 'http://127.0.0.1:8001'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE_URL).replace(/\/$/, '')

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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
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

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
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
  async signup(email, password, fullName) {
    return request('/api/auth/signup', {
      method: 'POST',
      body: {
        email,
        password,
        full_name: fullName,
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

  async shortlistFromDump(token, jobId, limit = 25) {
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
}
