import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { candidatePortal } from '../api'

function formatDate(value) {
  if (!value) return '--'
  try {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return String(value)
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
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

function getStageConfig(stage) {
  const s = String(stage || 'applied').toLowerCase()
  if (s === 'hired') return { color: '#22c55e', bg: '#f0fdf4', border: '#86efac', label: 'Hired' }
  if (s === 'rejected') return { color: '#ef4444', bg: '#fef2f2', border: '#fca5a5', label: 'Rejected' }
  if (s === 'assessment_sent' || s === 'assessment_passed') return { color: '#0e7490', bg: 'rgba(14,116,144,0.06)', border: 'rgba(14,116,144,0.2)', label: s.replace('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) }
  if (s === 'screening' || s === 'interview') return { color: '#f59e0b', bg: '#fffbeb', border: '#fcd34d', label: s.charAt(0).toUpperCase() + s.slice(1) }
  return { color: 'var(--text-secondary)', bg: 'var(--bg-soft)', border: 'var(--border)', label: s.charAt(0).toUpperCase() + s.slice(1) }
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
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)

  const checklist = Array.isArray(profile?.profile_checklist) ? profile.profile_checklist : []
  const completion = Number(profile?.profile_completion || 0)
  const documents = Array.isArray(profile?.documents) ? profile.documents : []
  const applications = Array.isArray(profile?.applications) ? profile.applications : []

  // Auto-dismiss success messages
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(''), 4000)
    return () => clearTimeout(t)
  }, [message])

  useEffect(() => {
    if (!profile) return
    setForm({
      full_name: String(profile.full_name || ''),
      phone_number: String(profile.phone_number || ''),
      location: String(profile.location || ''),
      years_experience: profile.years_experience == null ? '' : String(profile.years_experience),
      skills_text: toTextList(profile.skills),
      work_experience_text: Array.isArray(profile.work_experience) ? profile.work_experience.join('\n') : String(profile.work_experience || ''),
      college_details: String(profile.college_details || ''),
      website_links_text: Array.isArray(profile.website_links) ? profile.website_links.join('\n') : String(profile.website_links || ''),
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
        work_experience: form.work_experience_text.split('\n').map(s => s.trim()).filter(Boolean),
        college_details: String(form.college_details || '').trim() || null,
        website_links: form.website_links_text.split('\n').map(s => s.trim()).filter(Boolean),
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
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Link to="/">
              <button type="button" className="btn btn-ghost">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                Dashboard
              </button>
            </Link>
            <Link to="/careers">
              <button type="button" className="btn btn-primary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                Browse Jobs
              </button>
            </Link>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && (
          <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            {message}
          </div>
        )}

        {loadingProfile ? (
          <div style={{ padding: '3rem 0', textAlign: 'center' }}>
            <span className="loading-spinner" style={{ width: 28, height: 28, borderWidth: 3 }} />
            <p className="muted" style={{ marginTop: '1rem' }}>Loading profile…</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gap: '1.5rem' }}>

            {/* Completion Summary */}
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
              <div className="profile-completion-grid">
                {checklist.map((item) => (
                  <div key={item.key} className={`profile-completion-tile ${item.completed ? 'is-done' : ''}`}>
                    <div className="profile-completion-icon">
                      {item.completed
                        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                        : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/></svg>}
                    </div>
                    <span className="profile-completion-label">{item.label}</span>
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

              {/* Section: Personal Information */}
              <div className="profile-section">
                <h4 className="profile-section-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                  Personal Information
                </h4>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-name">Full name</label>
                  <input id="pf-name" className="input" value={form.full_name} onChange={setFormField('full_name')} placeholder="Your full name" />
                </div>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-phone">Phone number</label>
                  <input id="pf-phone" className="input" value={form.phone_number} onChange={setFormField('phone_number')} placeholder="+91 98765 43210" />
                </div>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-location">Location</label>
                  <input id="pf-location" className="input" value={form.location} onChange={setFormField('location')} placeholder="City, Country" />
                </div>
              </div>

              {/* Section: Professional Details */}
              <div className="profile-section">
                <h4 className="profile-section-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                  Professional Details
                </h4>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-years">Years of experience</label>
                  <input id="pf-years" className="input" type="number" min="0" value={form.years_experience} onChange={setFormField('years_experience')} placeholder="0" />
                </div>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-skills">Skills <span className="muted">(comma separated)</span></label>
                  <input id="pf-skills" className="input" value={form.skills_text} onChange={setFormField('skills_text')} placeholder="React, Node.js, Python, SQL" />
                </div>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-work">Work experience <span className="muted">(one entry per line)</span></label>
                  <textarea id="pf-work" className="input" rows={3} value={form.work_experience_text} onChange={setFormField('work_experience_text')} placeholder={"Software Engineer at Acme Corp (2022-Present)\nIntern at TechStartup (2021-2022)"} />
                </div>
              </div>

              {/* Section: Education */}
              <div className="profile-section">
                <h4 className="profile-section-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                  Education
                </h4>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-edu">Education details</label>
                  <textarea id="pf-edu" className="input" rows={2} value={form.college_details} onChange={setFormField('college_details')} placeholder="e.g. B.Tech Computer Science, XYZ University (2020)" />
                </div>
              </div>

              {/* Section: Links */}
              <div className="profile-section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                <h4 className="profile-section-title">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                  Website / Portfolio Links
                </h4>
                <div className="profile-field-row">
                  <label className="label" htmlFor="pf-links">Links <span className="muted">(one per line)</span></label>
                  <textarea id="pf-links" className="input" rows={2} value={form.website_links_text} onChange={setFormField('website_links_text')} placeholder={"https://github.com/username\nhttps://portfolio.com"} />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
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
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => { void downloadDocument(doc) }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 3 }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                          Download
                        </button>
                        {confirmDeleteId === doc.id ? (
                          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                            <button type="button" className="btn btn-danger btn-sm" onClick={() => { void deleteDocument(doc.id); setConfirmDeleteId(null) }} disabled={deletingDocId === doc.id}>
                              {deletingDocId === doc.id ? '…' : 'Confirm'}
                            </button>
                            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
                          </div>
                        ) : (
                          <button type="button" className="btn btn-ghost btn-sm" style={{ color: '#b91c1c' }} onClick={() => setConfirmDeleteId(doc.id)}>
                            Delete
                          </button>
                        )}
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
                    const cfg = getStageConfig(app.stage)
                    return (
                      <div key={`${app.job_id}-${app.created_at}`} className="profile-app-card">
                        <div className="profile-app-left">
                          <div className="profile-app-avatar">{(app.job_title || '?').charAt(0).toUpperCase()}</div>
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{app.job_title || `Job #${app.job_id}`}</div>
                            <div className="muted" style={{ fontSize: '0.75rem', marginTop: 2 }}>Applied {formatDate(app.created_at)}</div>
                          </div>
                        </div>
                        <span className="badge-soft" style={{ color: cfg.color, borderColor: cfg.border, background: cfg.bg }}>{cfg.label}</span>
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
