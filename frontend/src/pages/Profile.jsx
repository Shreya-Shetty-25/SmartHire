import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { candidatePortal } from '../api'

function formatDate(value) {
  if (!value) return '--'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleString()
  } catch {
    return String(value)
  }
}

function fileNameFromDisposition(contentDisposition) {
  const value = String(contentDisposition || '')
  const utfMatch = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utfMatch?.[1]) {
    try { return decodeURIComponent(utfMatch[1]) } catch { return utfMatch[1] }
  }
  const match = value.match(/filename="?([^"]+)"?/i)
  return match?.[1] || ''
}

function toTextList(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.join(', ')
}

function parseListText(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function Profile() {
  const token = useMemo(() => localStorage.getItem('token') || '', [])
  const resumeInputRef = useRef(null)
  const documentInputRef = useRef(null)

  const [profile, setProfile] = useState(null)
  const [form, setForm] = useState({
    full_name: '',
    phone_number: '',
    location: '',
    years_experience: '',
    skills_text: '',
    work_experience_text: '',
    college_details: '',
    website_links_text: '',
  })

  const [loadingProfile, setLoadingProfile] = useState(true)
  const [savingProfile, setSavingProfile] = useState(false)
  const [autofillingResume, setAutofillingResume] = useState(false)
  const [uploadingDocument, setUploadingDocument] = useState(false)
  const [deletingDocId, setDeletingDocId] = useState(null)

  const [resumeFile, setResumeFile] = useState(null)
  const [documentFile, setDocumentFile] = useState(null)
  const [documentType, setDocumentType] = useState('identity')

  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const checklist = Array.isArray(profile?.profile_checklist) ? profile.profile_checklist : []
  const completion = Number(profile?.profile_completion || 0)
  const documents = Array.isArray(profile?.documents) ? profile.documents : []
  const applications = Array.isArray(profile?.applications) ? profile.applications : []

  useEffect(() => {
    if (!profile) return
    setForm({
      full_name: String(profile.full_name || ''),
      phone_number: String(profile.phone_number || ''),
      location: String(profile.location || ''),
      years_experience: profile.years_experience == null ? '' : String(profile.years_experience),
      skills_text: toTextList(profile.skills),
      work_experience_text: toTextList(profile.work_experience),
      college_details: String(profile.college_details || ''),
      website_links_text: toTextList(profile.website_links),
    })
  }, [profile])

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!token) { setLoadingProfile(false); return }
      setLoadingProfile(true)
      try {
        const data = await candidatePortal.getProfile(token)
        if (!cancelled) setProfile(data || null)
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load profile')
      } finally {
        if (!cancelled) setLoadingProfile(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [token])

  const setFormField = (field) => (event) => {
    setForm((prev) => ({ ...prev, [field]: event.target.value }))
  }

  async function saveProfile({ silent = false } = {}) {
    if (!token) return
    setSavingProfile(true)
    if (!silent) { setError(''); setMessage('') }
    try {
      const payload = {
        full_name: String(form.full_name || '').trim() || null,
        phone_number: String(form.phone_number || '').trim() || null,
        location: String(form.location || '').trim() || null,
        years_experience: String(form.years_experience || '').trim() ? Number(form.years_experience) : null,
        skills: parseListText(form.skills_text),
        work_experience: parseListText(form.work_experience_text),
        college_details: String(form.college_details || '').trim() || null,
        website_links: parseListText(form.website_links_text),
      }
      const data = await candidatePortal.updateProfile(token, payload)
      setProfile(data || null)
      if (!silent) setMessage('Profile saved successfully.')
    } catch (err) {
      if (!silent) setError(err?.message || 'Failed to save profile')
    } finally {
      setSavingProfile(false)
    }
  }

  async function autofillFromResume() {
    if (!token || !resumeFile) { setError('Select a PDF resume first.'); return }
    setAutofillingResume(true); setError(''); setMessage('')
    try {
      const data = await candidatePortal.autofillResume(token, resumeFile)
      setProfile(data || null)
      setResumeFile(null)
      if (resumeInputRef.current) resumeInputRef.current.value = ''
      setMessage('Resume uploaded and profile autofilled.')
    } catch (err) {
      setError(err?.message || 'Failed to autofill profile from resume')
    } finally {
      setAutofillingResume(false)
    }
  }

  async function uploadDocument() {
    if (!token || !documentFile) { setError('Select a document file first.'); return }
    setUploadingDocument(true); setError(''); setMessage('')
    try {
      const data = await candidatePortal.uploadDocument(token, documentFile, documentType)
      setProfile(data || null)
      setDocumentFile(null)
      if (documentInputRef.current) documentInputRef.current.value = ''
      setMessage('Document uploaded.')
    } catch (err) {
      setError(err?.message || 'Failed to upload document')
    } finally {
      setUploadingDocument(false)
    }
  }

  async function deleteDocument(documentId) {
    if (!token) return
    setDeletingDocId(documentId); setError(''); setMessage('')
    try {
      const data = await candidatePortal.deleteDocument(token, documentId)
      setProfile(data || null)
    } catch (err) {
      setError(err?.message || 'Failed to delete document')
    } finally {
      setDeletingDocId(null)
    }
  }

  async function downloadDocument(doc) {
    if (!token || !doc?.id) return
    try {
      const payload = await candidatePortal.downloadDocument(token, doc.id)
      const fileName = fileNameFromDisposition(payload?.contentDisposition) || doc.file_name || `document-${doc.id}`
      const url = URL.createObjectURL(payload.blob)
      const link = window.document.createElement('a')
      link.href = url; link.download = fileName
      window.document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setError(err?.message || 'Failed to download document')
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Candidate Portal</p>
            <h1 className="page-title">My Profile</h1>
            <p className="page-subtitle">Manage your profile, upload your resume, and track applications.</p>
          </div>
          <Link to="/careers">
            <button type="button" className="btn btn-ghost">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><polyline points="15 18 9 12 15 6"/></svg>
              Back to Careers
            </button>
          </Link>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {message ? <div className="alert alert-success">{message}</div> : null}

        {loadingProfile ? (
          <div style={{ padding: '3rem 0', textAlign: 'center' }}>
            <span className="loading-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
            <p className="muted" style={{ marginTop: '1rem' }}>Loading profile…</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '1.5rem' }}>

            {/* Completion ring + checklist */}
            <article className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">Profile Completion</h2>
                  <p className="card-subtitle">{completion}% complete — fill in all fields to improve matching.</p>
                </div>
                <div style={{ position: 'relative', width: 64, height: 64, flexShrink: 0 }}>
                  <svg width="64" height="64" style={{ transform: 'rotate(-90deg)' }}>
                    <circle cx="32" cy="32" r="26" fill="none" stroke="var(--bg-soft)" strokeWidth="6" />
                    <circle cx="32" cy="32" r="26" fill="none" stroke="var(--accent)" strokeWidth="6"
                      strokeDasharray={`${2 * Math.PI * 26}`}
                      strokeDashoffset={`${2 * Math.PI * 26 * (1 - completion / 100)}`}
                      strokeLinecap="round" />
                  </svg>
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.72rem', fontWeight: 700, color: 'var(--accent)' }}>{completion}%</div>
                </div>
              </div>
              <div className="progress-bar" style={{ marginBottom: '0.75rem' }}>
                <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, completion))}%` }} />
              </div>
              <div className="careers-checklist">
                {checklist.map((item) => (
                  <div key={item.key} className={`careers-check-item ${item.completed ? 'is-done' : ''}`}>
                    <span>{item.label}</span>
                    <strong>{item.completed ? 'Done' : 'Pending'}</strong>
                  </div>
                ))}
              </div>
            </article>

            {/* Resume Autofill */}
            <article className="card">
              <div className="card-header" style={{ marginBottom: '0.5rem' }}>
                <div>
                  <h2 className="card-title">Resume Autofill</h2>
                  <p className="card-subtitle">Upload your PDF resume to automatically populate profile fields using AI.</p>
                </div>
                {profile?.resume_filename && (
                  <span className="badge-soft" style={{ fontSize: '0.78rem' }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
                    {profile.resume_filename}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
                  <label className="label" htmlFor="resume-upload">PDF Resume</label>
                  <input id="resume-upload" ref={resumeInputRef} className="input" type="file" accept=".pdf,application/pdf"
                    onChange={(e) => setResumeFile(e.target.files?.[0] || null)} />
                  {resumeFile && <p style={{ marginTop: '0.3rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{resumeFile.name}</p>}
                </div>
                <button type="button" className="btn btn-primary" onClick={autofillFromResume}
                  disabled={autofillingResume || !resumeFile} style={{ flexShrink: 0 }}>
                  {autofillingResume
                    ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Autofilling…</>
                    : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 20h16"/></svg>Upload &amp; Autofill</>}
                </button>
              </div>
            </article>

            {/* Manual Profile Form */}
            <article className="card">
              <div className="card-header" style={{ marginBottom: '0.75rem' }}>
                <div>
                  <h2 className="card-title">Profile Details</h2>
                  <p className="card-subtitle">Edit your profile manually. These details are used when applying for jobs.</p>
                </div>
              </div>
              <div className="detail-grid">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-name">Full name</label>
                  <input id="pf-name" className="input" value={form.full_name} onChange={setFormField('full_name')} placeholder="Your full name" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-phone">Phone number</label>
                  <input id="pf-phone" className="input" value={form.phone_number} onChange={setFormField('phone_number')} placeholder="+91 98765 43210" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-location">Location</label>
                  <input id="pf-location" className="input" value={form.location} onChange={setFormField('location')} placeholder="City, Country" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-years">Years of experience</label>
                  <input id="pf-years" className="input" type="number" min="0" value={form.years_experience} onChange={setFormField('years_experience')} placeholder="3" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-skills">Skills (comma separated)</label>
                  <input id="pf-skills" className="input" value={form.skills_text} onChange={setFormField('skills_text')} placeholder="React, Node.js, Python, SQL" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="pf-work">Work experience (comma separated)</label>
                  <input id="pf-work" className="input" value={form.work_experience_text} onChange={setFormField('work_experience_text')} placeholder="Software Engineer at Acme, Freelance Developer" />
                </div>
              </div>
              <div className="field" style={{ marginTop: '0.85rem', marginBottom: '0.85rem' }}>
                <label className="label" htmlFor="pf-edu">Education details</label>
                <textarea id="pf-edu" className="input" rows={2} value={form.college_details} onChange={setFormField('college_details')} placeholder="B.Tech Computer Science, XYZ University (2020)" />
              </div>
              <div className="field" style={{ marginBottom: '1rem' }}>
                <label className="label" htmlFor="pf-links">Website / portfolio links (comma separated)</label>
                <input id="pf-links" className="input" value={form.website_links_text} onChange={setFormField('website_links_text')} placeholder="https://github.com/username, https://portfolio.com" />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-primary" onClick={() => { void saveProfile() }} disabled={savingProfile}>
                  {savingProfile ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Saving…</> : 'Save Profile'}
                </button>
              </div>
            </article>

            {/* Supporting Documents */}
            <article className="card">
              <div className="card-header" style={{ marginBottom: '0.75rem' }}>
                <div>
                  <h2 className="card-title">Supporting Documents</h2>
                  <p className="card-subtitle">Upload certificates, identity documents, or portfolio files.</p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '1rem' }}>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="doc-type">Document type</label>
                  <select id="doc-type" className="input" style={{ minWidth: 160 }} value={documentType} onChange={(e) => setDocumentType(e.target.value)}>
                    <option value="identity">Identity</option>
                    <option value="certificate">Certificate</option>
                    <option value="portfolio">Portfolio</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0, flex: 1, minWidth: 200 }}>
                  <label className="label" htmlFor="doc-file">File</label>
                  <input id="doc-file" ref={documentInputRef} className="input" type="file"
                    onChange={(e) => setDocumentFile(e.target.files?.[0] || null)} />
                </div>
                <button type="button" className="btn btn-primary" onClick={uploadDocument}
                  disabled={uploadingDocument || !documentFile} style={{ flexShrink: 0 }}>
                  {uploadingDocument ? 'Uploading…' : 'Upload'}
                </button>
              </div>

              {documents.length === 0 ? (
                <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                  <div className="empty-state-title">No documents yet</div>
                  <div className="empty-state-desc">Upload your first supporting document above.</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '0.5rem' }}>
                  {documents.map((doc) => (
                    <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem', background: 'var(--bg-soft)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: '0.88rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.file_name}</div>
                        <div className="muted" style={{ fontSize: '0.75rem' }}>{doc.doc_type || 'general'} · {Math.max(1, Math.round((doc.file_size || 0) / 1024))} KB · {formatDate(doc.created_at)}</div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.4rem', flexShrink: 0 }}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void downloadDocument(doc) }}>Download</button>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ color: '#b91c1c', borderColor: '#fca5a5' }}
                          onClick={() => { void deleteDocument(doc.id) }}
                          disabled={deletingDocId === doc.id}>
                          {deletingDocId === doc.id ? '…' : 'Delete'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </article>

            {/* Applications */}
            <article className="card">
              <div className="card-header" style={{ marginBottom: 0 }}>
                <div>
                  <h2 className="card-title">My Applications</h2>
                  <p className="card-subtitle">Jobs you have applied for via the Careers portal.</p>
                </div>
                <Link to="/careers"><button type="button" className="btn btn-primary btn-sm">Browse More Jobs</button></Link>
              </div>
              {applications.length === 0 ? (
                <div className="empty-state" style={{ padding: '1.5rem 0' }}>
                  <div className="empty-state-title">No applications yet</div>
                  <div className="empty-state-desc">Visit Careers to find and apply for open roles.</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.75rem' }}>
                  {applications.map((app) => {
                    const stage = String(app.stage || 'applied').toLowerCase()
                    const stageColor = stage === 'hired' ? '#22c55e' : stage === 'rejected' ? '#ef4444' : stage === 'assessment_passed' ? '#6366f1' : 'var(--text-secondary)'
                    return (
                      <div key={`${app.job_id}-${app.created_at}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', padding: '0.85rem 1rem', background: 'var(--bg-soft)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontWeight: 600 }}>{app.job_title || `Job #${app.job_id}`}</div>
                          <div className="muted" style={{ fontSize: '0.78rem', marginTop: 2 }}>Applied {formatDate(app.created_at)}</div>
                        </div>
                        <span className="badge-soft" style={{ color: stageColor, borderColor: stageColor, background: `${stageColor}15` }}>{app.stage}</span>
                      </div>
                    )
                  })}
                </div>
              )}
            </article>

          </div>
        )}
      </section>
    </main>
  )
}

export default Profile
