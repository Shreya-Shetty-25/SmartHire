import { useEffect, useMemo, useState } from 'react'
import { candidates } from '../api'

function formatValue(value) {
  if (value === null || value === undefined || value === '') return '—'
  if (Array.isArray(value)) {
    return value.length ? value.join(', ') : '—'
  }
  return String(value)
}

function parseFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null
  const match = /filename\*?=(?:UTF-8''|"?)([^";]+)"?/i.exec(headerValue)
  if (!match) return null
  try {
    return decodeURIComponent(match[1])
  } catch {
    return match[1]
  }
}

function Candidates() {
  const token = useMemo(() => localStorage.getItem('token'), [])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedCandidate, setSelectedCandidate] = useState(null)

  const [file, setFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  const loadCandidates = async () => {
    if (!token) {
      setError('Missing token. Please log in again.')
      setLoading(false)
      return
    }

    setError('')
    setLoading(true)
    try {
      const data = await candidates.list(token)
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load candidates')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadCandidates()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onUpload = async (event) => {
    event.preventDefault()

    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    if (!file) {
      setError('Please choose a PDF file to upload.')
      return
    }

    if (file.type && file.type !== 'application/pdf') {
      setError('Only PDF files are supported.')
      return
    }

    setError('')
    setUploading(true)
    try {
      const created = await candidates.uploadResume(token, file)
      setRows((prev) => [created, ...prev])
      setFile(null)
    } catch (err) {
      setError(err?.message || 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  const onViewResume = async (candidateId) => {
    if (!token) {
      setError('Missing token. Please log in again.')
      return
    }

    setError('')
    try {
      const { blob, contentDisposition } = await candidates.downloadResume(token, candidateId)
      const filename = parseFilenameFromContentDisposition(contentDisposition) || 'resume.pdf'
      const url = URL.createObjectURL(blob)

      const newTab = window.open(url, '_blank', 'noopener,noreferrer')
      if (!newTab) {
        const link = document.createElement('a')
        link.href = url
        link.download = filename
        document.body.appendChild(link)
        link.click()
        link.remove()
      }

      setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (err) {
      setError(err?.message || 'Failed to load resume PDF')
    }
  }

  const onOpenCandidate = (candidate) => {
    setSelectedCandidate(candidate)
  }

  const onCloseModal = () => {
    setSelectedCandidate(null)
  }

  const onModalKeyDown = (event) => {
    if (event.key === 'Escape') {
      onCloseModal()
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header">
          <h1 className="page-title">Candidates</h1>
          <p className="page-subtitle">Upload resumes and review parsed candidate profiles.</p>
        </div>

        <article className="card" style={{ marginBottom: '1.25rem' }}>
          <div className="card-header" style={{ marginBottom: 0 }}>
            <div>
              <h2 className="card-title">Upload resume</h2>
              <p className="card-subtitle">PDF only. The backend will parse fields using your selected LLM provider.</p>
            </div>
          </div>

          <form className="form-row" onSubmit={onUpload}>
            <div className="field" style={{ marginBottom: 0, flex: 1 }}>
              <label className="label" htmlFor="resume">
                Resume PDF
              </label>
              <input
                id="resume"
                className="input"
                type="file"
                accept="application/pdf"
                onChange={(e) => setFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
              />
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="submit" className="btn btn-primary" disabled={uploading}>
                {uploading ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </form>

          {error ? <div className="error-banner">{error}</div> : null}
        </article>

        <article className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All candidates</h2>
              <p className="card-subtitle">{loading ? 'Loading…' : `${rows.length} total`}</p>
            </div>
            <button type="button" className="btn btn-ghost" onClick={loadCandidates} disabled={loading}>
              Refresh
            </button>
          </div>

          <div className="table-wrap">
            <table className="table" aria-label="Candidates table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Resume</th>
                  <th>View</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading ? (
                  <tr>
                    <td colSpan={5} className="table-empty">
                      No candidates yet.
                    </td>
                  </tr>
                ) : null}

                {rows.map((candidate) => (
                  <tr key={candidate.id}>
                    <td>{formatValue(candidate.full_name)}</td>
                    <td className="table-muted">{formatValue(candidate.email)}</td>
                    <td className="table-muted">{formatValue(candidate.phone_number)}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => onViewResume(candidate.id)}
                      >
                        View PDF
                      </button>
                    </td>
                    <td>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => onOpenCandidate(candidate)}>
                        View
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      {selectedCandidate ? (
        <div
          className="modal-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Candidate details"
          tabIndex={-1}
          onKeyDown={onModalKeyDown}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onCloseModal()
          }}
        >
          <div className="modal-card">
            <div className="modal-header">
              <div>
                <div className="modal-title">{formatValue(selectedCandidate.full_name)}</div>
                <div className="modal-subtitle">{formatValue(selectedCandidate.email)}</div>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={onCloseModal}>
                Close
              </button>
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-primary" onClick={() => onViewResume(selectedCandidate.id)}>
                View PDF
              </button>
            </div>

            <div className="detail-grid">
              <div className="detail-item">
                <div className="detail-label">Phone</div>
                <div className="detail-value">{formatValue(selectedCandidate.phone_number)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">College</div>
                <div className="detail-value">{formatValue(selectedCandidate.college_details)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">School</div>
                <div className="detail-value">{formatValue(selectedCandidate.school_details)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Skills</div>
                <div className="detail-value">{formatValue(selectedCandidate.skills)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Projects</div>
                <div className="detail-value">{formatValue(selectedCandidate.projects)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Work experience</div>
                <div className="detail-value">{formatValue(selectedCandidate.work_experience)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Extra-curricular</div>
                <div className="detail-value">{formatValue(selectedCandidate.extra_curricular_activities)}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Links</div>
                <div className="detail-value">{formatValue(selectedCandidate.website_links)}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  )
}

export default Candidates
