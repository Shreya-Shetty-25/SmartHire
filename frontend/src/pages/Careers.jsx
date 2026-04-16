import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { candidatePortal } from '../api'

function parseListText(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  return raw.split(',').map((item) => item.trim()).filter(Boolean)
}

function toTextList(values) {
  if (!Array.isArray(values) || values.length === 0) return ''
  return values.join(', ')
}

function timeAgo(dateStr) {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return ''
    const diff = Date.now() - d.getTime()
    const days = Math.floor(diff / 86400000)
    if (days < 1) return 'Today'
    if (days === 1) return '1 day ago'
    if (days < 7) return `${days} days ago`
    if (days < 30) return `${Math.floor(days / 7)} week${Math.floor(days / 7) > 1 ? 's' : ''} ago`
    return `${Math.floor(days / 30)} month${Math.floor(days / 30) > 1 ? 's' : ''} ago`
  } catch { return '' }
}

function Careers() {
  const token = useMemo(() => localStorage.getItem('token') || '', [])
  const [searchParams, setSearchParams] = useSearchParams()

  const [jobs, setJobs] = useState([])
  const [relatedJobs, setRelatedJobs] = useState([])
  const [selectedJobId, setSelectedJobId] = useState(null)
  const [search, setSearch] = useState('')

  const [profile, setProfile] = useState(null)
  const [applyForm, setApplyForm] = useState({
    full_name: '', phone_number: '', location: '', years_experience: '', skills_text: '',
  })

  const [loadingJobs, setLoadingJobs] = useState(true)
  const [loadingRelated, setLoadingRelated] = useState(false)
  const [savingProfile, setSavingProfile] = useState(false)
  const [applying, setApplying] = useState(false)
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyNote, setApplyNote] = useState('')
  const [applySuccess, setApplySuccess] = useState(false)

  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const selectedJob = useMemo(
    () => jobs.find((job) => Number(job.id) === Number(selectedJobId)) || null,
    [jobs, selectedJobId],
  )

  const filteredJobs = useMemo(() => {
    const query = String(search || '').trim().toLowerCase()
    if (!query) return jobs
    return jobs.filter((job) => {
      const title = String(job.title || '').toLowerCase()
      const location = String(job.location || '').toLowerCase()
      const description = String(job.description || '').toLowerCase()
      const skills = (job.skills_required || []).join(' ').toLowerCase()
      return title.includes(query) || location.includes(query) || description.includes(query) || skills.includes(query)
    })
  }, [jobs, search])

  // Auto-dismiss messages
  useEffect(() => {
    if (!message) return
    const t = setTimeout(() => setMessage(''), 5000)
    return () => clearTimeout(t)
  }, [message])

  useEffect(() => {
    let cancelled = false
    async function loadInitialData() {
      if (!token) { setLoadingJobs(false); return }
      setError(''); setMessage(''); setLoadingJobs(true)
      try {
        const [jobsData, profileData] = await Promise.all([
          candidatePortal.listJobs(token),
          candidatePortal.getProfile(token),
        ])
        if (cancelled) return
        const allJobs = Array.isArray(jobsData) ? jobsData : []
        setJobs(allJobs)
        // Auto-select job from ?highlight=ID query parameter
        const highlightId = searchParams.get('highlight')
        if (highlightId && allJobs.some(j => String(j.id) === String(highlightId))) {
          setSelectedJobId(Number(highlightId))
          setSearchParams({}, { replace: true })
        }
        setProfile(profileData || null)
        if (profileData) {
          setApplyForm({
            full_name: String(profileData.full_name || ''),
            phone_number: String(profileData.phone_number || ''),
            location: String(profileData.location || ''),
            years_experience: profileData.years_experience == null ? '' : String(profileData.years_experience),
            skills_text: toTextList(profileData.skills),
          })
        }
      } catch (err) {
        if (!cancelled) setError(err?.message || 'Failed to load careers data')
      } finally {
        if (!cancelled) setLoadingJobs(false)
      }
    }
    void loadInitialData()
    return () => { cancelled = true }
  }, [token])

  useEffect(() => {
    let cancelled = false
    async function loadRelatedJobs() {
      if (!token || !selectedJobId) { setRelatedJobs([]); return }
      setLoadingRelated(true)
      try {
        const data = await candidatePortal.relatedJobs(token, selectedJobId, 4)
        if (!cancelled) setRelatedJobs(Array.isArray(data) ? data : [])
      } catch {
        if (!cancelled) setRelatedJobs([])
      } finally {
        if (!cancelled) setLoadingRelated(false)
      }
    }
    void loadRelatedJobs()
    return () => { cancelled = true }
  }, [selectedJobId, token])

  function openApplyModal() {
    if (!profile) return
    setApplyForm({
      full_name: String(profile.full_name || ''),
      phone_number: String(profile.phone_number || ''),
      location: String(profile.location || ''),
      years_experience: profile.years_experience == null ? '' : String(profile.years_experience),
      skills_text: toTextList(profile.skills),
    })
    setApplyNote('')
    setApplySuccess(false)
    setApplyOpen(true)
  }

  async function submitApplication() {
    if (!token || !selectedJob) { setError('Select a job first.'); return }
    setSavingProfile(true); setApplying(true); setError(''); setMessage('')
    try {
      const profilePayload = {
        full_name: String(applyForm.full_name || '').trim() || null,
        phone_number: String(applyForm.phone_number || '').trim() || null,
        location: String(applyForm.location || '').trim() || null,
        years_experience: String(applyForm.years_experience || '').trim() ? Number(applyForm.years_experience) : null,
        skills: parseListText(applyForm.skills_text),
      }
      const updatedProfile = await candidatePortal.updateProfile(token, profilePayload)
      setProfile(updatedProfile || null)
      await candidatePortal.applyToJob(token, selectedJob.id, { note: String(applyNote || '').trim() || null })
      setApplySuccess(true)
    } catch (err) {
      setError(err?.message || 'Failed to apply for this job')
    } finally {
      setSavingProfile(false); setApplying(false)
    }
  }

  function closeApplyModal() {
    setApplyOpen(false)
    if (applySuccess) {
      setMessage(`Application submitted for ${selectedJob?.title}!`)
      setApplySuccess(false)
    }
  }

  const alreadyApplied = useMemo(() => {
    if (!profile || !selectedJob) return false
    return (profile.applications || []).some((a) => Number(a.job_id) === Number(selectedJob?.id))
  }, [profile, selectedJob])

  const appliedJobIds = useMemo(() => {
    if (!profile) return new Set()
    return new Set((profile.applications || []).map((a) => Number(a.job_id)))
  }, [profile])

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Candidate Portal</p>
            <h1 className="page-title">Careers</h1>
            <p className="page-subtitle">Explore open roles and apply for positions that match your skills.</p>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <Link to="/">
              <button type="button" className="btn btn-ghost">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
                Dashboard
              </button>
            </Link>
            <Link to="/profile">
              <button type="button" className="btn btn-ghost">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                My Profile
              </button>
            </Link>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {message && (
          <div className="alert alert-success" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
            {message}
          </div>
        )}

        <div className="careers-two-col">
          {/* Left: Job List */}
          <div className="careers-job-list-col">
            <article className="card" style={{ height: '100%' }}>
              <div className="card-header" style={{ marginBottom: '0.6rem' }}>
                <div>
                  <div className="card-title">Open Roles</div>
                  <div className="card-subtitle">{loadingJobs ? 'Loading…' : `${filteredJobs.length} role${filteredJobs.length !== 1 ? 's' : ''} available`}</div>
                </div>
              </div>
              <div className="search-bar" style={{ marginBottom: '0.75rem' }}>
                <span className="search-icon">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                </span>
                <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by title, skill, location…" />
              </div>
              <div className="careers-job-list">
                {loadingJobs && (
                  <div style={{ padding: '2rem 0', textAlign: 'center' }}>
                    <span className="loading-spinner" style={{ width: 20, height: 20, borderWidth: 2 }} />
                    <p className="muted" style={{ marginTop: '0.5rem', fontSize: '0.82rem' }}>Loading roles…</p>
                  </div>
                )}
                {!loadingJobs && filteredJobs.length === 0 && (
                  <div style={{ padding: '2rem 0', textAlign: 'center' }}>
                    <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, marginBottom: '0.5rem' }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    <p className="muted" style={{ fontSize: '0.85rem' }}>No roles found{search ? ' for your search' : ''}.</p>
                  </div>
                )}
                {!loadingJobs && filteredJobs.map((job) => {
                  const isApplied = appliedJobIds.has(Number(job.id))
                  return (
                    <button key={job.id} type="button"
                      className={`careers-job-item ${Number(selectedJobId) === Number(job.id) ? 'is-active' : ''}`}
                      onClick={() => setSelectedJobId(job.id)}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <div className="careers-job-title">{job.title}</div>
                        {isApplied && <span className="badge-soft badge-green" style={{ fontSize: '0.65rem', padding: '0.15rem 0.45rem', flexShrink: 0 }}>Applied</span>}
                      </div>
                      <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                        {job.location && (
                          <span className="careers-meta-item">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                            {job.location}
                          </span>
                        )}
                        {job.employment_type && (
                          <span className="careers-meta-item">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                            {job.employment_type}
                          </span>
                        )}
                        {job.created_at && (
                          <span className="careers-meta-item">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            {timeAgo(job.created_at)}
                          </span>
                        )}
                      </div>
                      <div className="chip-row" style={{ marginTop: '0.5rem' }}>
                        {(job.skills_required || []).slice(0, 3).map((skill) => <span key={`${job.id}-${skill}`} className="chip">{skill}</span>)}
                        {(job.skills_required || []).length > 3 && <span className="chip">+{job.skills_required.length - 3}</span>}
                      </div>
                    </button>
                  )
                })}
              </div>
            </article>
          </div>

          {/* Right: Job Detail Panel */}
          <div className="careers-detail-col">
            {!selectedJob ? (
              <div className="careers-detail-empty">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.4 }}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                <p style={{ marginTop: '1rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Select a role to view details</p>
                <p className="muted" style={{ fontSize: '0.82rem', marginTop: '0.3rem' }}>Click on any role from the list to see full job description and apply.</p>
              </div>
            ) : (
              <article className="card careers-detail-panel" style={{ animation: 'fadeIn 0.2s ease' }}>
                {/* Job Header */}
                <div className="careers-detail-header">
                  <div style={{ flex: 1 }}>
                    <h2 className="careers-detail-title">{selectedJob.title}</h2>
                    <div className="careers-detail-meta">
                      {selectedJob.location && (
                        <span className="careers-detail-meta-item">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                          {selectedJob.location}
                        </span>
                      )}
                      {selectedJob.employment_type && (
                        <span className="careers-detail-meta-item">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                          {selectedJob.employment_type}
                        </span>
                      )}
                      {selectedJob.years_experience != null && (
                        <span className="careers-detail-meta-item">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                          {selectedJob.years_experience}+ yrs
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem', flexShrink: 0 }}>
                    {alreadyApplied ? (
                      <span className="badge-soft badge-green" style={{ fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}>✓ Applied</span>
                    ) : (
                      <button type="button" className="btn btn-primary" onClick={openApplyModal}>Apply Now</button>
                    )}
                    {selectedJob.created_at && <span className="muted" style={{ fontSize: '0.72rem' }}>Posted {timeAgo(selectedJob.created_at)}</span>}
                  </div>
                </div>

                <hr className="careers-divider" />

                {/* Job Info Grid */}
                <div className="careers-info-grid">
                  {selectedJob.education && (
                    <div className="careers-info-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
                      <div>
                        <div className="careers-info-label">Education</div>
                        <div className="careers-info-value">{selectedJob.education}</div>
                      </div>
                    </div>
                  )}
                  {selectedJob.years_experience != null && (
                    <div className="careers-info-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      <div>
                        <div className="careers-info-label">Experience</div>
                        <div className="careers-info-value">{selectedJob.years_experience}+ years</div>
                      </div>
                    </div>
                  )}
                  {selectedJob.employment_type && (
                    <div className="careers-info-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                      <div>
                        <div className="careers-info-label">Type</div>
                        <div className="careers-info-value">{selectedJob.employment_type}</div>
                      </div>
                    </div>
                  )}
                  {selectedJob.location && (
                    <div className="careers-info-item">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      <div>
                        <div className="careers-info-label">Location</div>
                        <div className="careers-info-value">{selectedJob.location}</div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Required Skills */}
                {(selectedJob.skills_required || []).length > 0 && (
                  <div className="careers-section">
                    <h3 className="careers-section-title">Required Skills</h3>
                    <div className="chip-row" style={{ marginTop: 0 }}>
                      {selectedJob.skills_required.map((skill) => <span key={`detail-${skill}`} className="chip">{skill}</span>)}
                    </div>
                  </div>
                )}

                {/* Additional Skills */}
                {(selectedJob.additional_skills || []).length > 0 && (
                  <div className="careers-section">
                    <h3 className="careers-section-title">Nice to Have</h3>
                    <div className="chip-row" style={{ marginTop: 0 }}>
                      {selectedJob.additional_skills.map((skill) => <span key={`add-${skill}`} className="chip" style={{ borderStyle: 'dashed' }}>{skill}</span>)}
                    </div>
                  </div>
                )}

                {/* Description */}
                <div className="careers-section">
                  <h3 className="careers-section-title">Job Description</h3>
                  <div className="careers-description">{selectedJob.description || 'No description provided.'}</div>
                </div>

                {/* Related Jobs */}
                {(relatedJobs.length > 0 || loadingRelated) && (
                  <div className="careers-section" style={{ paddingTop: '0.5rem', borderTop: '1px solid var(--border)' }}>
                    <h3 className="careers-section-title">You Might Also Like</h3>
                    {loadingRelated && <div className="muted" style={{ fontSize: '0.85rem' }}>Finding similar roles…</div>}
                    <div style={{ display: 'grid', gap: '0.4rem' }}>
                      {relatedJobs.map((job) => (
                        <button key={`related-${job.id}`} type="button" className="careers-related-item" onClick={() => setSelectedJobId(job.id)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{job.title}</span>
                          <span className="badge-soft" style={{ fontSize: '0.7rem' }}>{Math.min(100, Math.round(job.relevance_score || 0))}% match</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Bottom CTA */}
                {!alreadyApplied && (
                  <div style={{ marginTop: '1.5rem' }}>
                    <button type="button" className="btn btn-primary btn-lg" style={{ width: '100%', justifyContent: 'center' }} onClick={openApplyModal}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
                      Apply for this position
                    </button>
                  </div>
                )}
              </article>
            )}
          </div>
        </div>
      </section>

      {/* Apply Modal */}
      {applyOpen && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) closeApplyModal() }}>
          <div className="modal-card careers-apply-modal" style={{ padding: 0, background: 'var(--bg)', border: '1px solid var(--border)', overflow: 'hidden', maxWidth: 640 }}>
            {/* Modal Header */}
            <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)', background: 'var(--bg-soft)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Apply for {selectedJob?.title}</h2>
                  <p className="muted" style={{ fontSize: '0.82rem', marginTop: 2 }}>{selectedJob?.location}{selectedJob?.employment_type ? ` · ${selectedJob.employment_type}` : ''}</p>
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={closeApplyModal} style={{ fontSize: '1.2rem', lineHeight: 1, padding: '0.25rem 0.5rem' }}>×</button>
              </div>
            </div>

            {applySuccess ? (
              /* Success State */
              <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--green-soft)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>Application Submitted!</h3>
                <p className="muted" style={{ maxWidth: 340, margin: '0 auto', lineHeight: 1.6 }}>
                  Your application for <strong>{selectedJob?.title}</strong> has been submitted successfully. You can track the status in your profile.
                </p>
                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginTop: '1.5rem' }}>
                  <Link to="/profile"><button type="button" className="btn btn-ghost">View Profile</button></Link>
                  <button type="button" className="btn btn-primary" onClick={closeApplyModal}>Continue Browsing</button>
                </div>
              </div>
            ) : (
              /* Form */
              <div style={{ padding: '1.5rem', maxHeight: '70vh', overflowY: 'auto' }}>
                <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
                  Review your profile details before submitting. These will be shared with the hiring team.
                </p>

                {/* Section: Personal Information */}
                <div className="apply-section">
                  <h4 className="apply-section-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                    Personal Information
                  </h4>
                  <div className="apply-field-group">
                    <div className="apply-field">
                      <label className="label" htmlFor="am-name">Full name</label>
                      <input id="am-name" className="input" value={applyForm.full_name} onChange={(e) => setApplyForm((p) => ({ ...p, full_name: e.target.value }))} placeholder="Your full name" />
                    </div>
                    <div className="apply-field">
                      <label className="label" htmlFor="am-phone">Phone number</label>
                      <input id="am-phone" className="input" type="tel" value={applyForm.phone_number} onChange={(e) => setApplyForm((p) => ({ ...p, phone_number: e.target.value }))} placeholder="+91 98765 43210" />
                    </div>
                  </div>
                </div>

                {/* Section: Professional Details */}
                <div className="apply-section">
                  <h4 className="apply-section-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                    Professional Details
                  </h4>
                  <div className="apply-field-group">
                    <div className="apply-field">
                      <label className="label" htmlFor="am-location">Location</label>
                      <input id="am-location" className="input" value={applyForm.location} onChange={(e) => setApplyForm((p) => ({ ...p, location: e.target.value }))} placeholder="City, Country" />
                    </div>
                    <div className="apply-field">
                      <label className="label" htmlFor="am-years">Years of experience</label>
                      <input id="am-years" className="input" type="number" min="0" value={applyForm.years_experience} onChange={(e) => setApplyForm((p) => ({ ...p, years_experience: e.target.value }))} placeholder="3" />
                    </div>
                  </div>
                  <div className="apply-field" style={{ marginTop: '0.75rem' }}>
                    <label className="label" htmlFor="am-skills">Skills <span className="muted">(comma separated)</span></label>
                    <input id="am-skills" className="input" value={applyForm.skills_text} onChange={(e) => setApplyForm((p) => ({ ...p, skills_text: e.target.value }))} placeholder="React, Node.js, Python…" />
                  </div>
                </div>

                {/* Section: Cover Note */}
                <div className="apply-section" style={{ borderBottom: 'none', paddingBottom: 0 }}>
                  <h4 className="apply-section-title">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                    Cover Note & Resume
                  </h4>
                  <div className="apply-field">
                    <label className="label" htmlFor="am-note">Cover note <span className="muted">(optional)</span></label>
                    <textarea id="am-note" className="input" rows={3} value={applyNote} onChange={(e) => setApplyNote(e.target.value)} placeholder="Share why you're a great fit for this role…" />
                  </div>
                  {profile?.resume_filename && (
                    <div className="careers-resume-badge" style={{ marginTop: '0.75rem' }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <span>Resume attached: <strong>{profile.resume_filename}</strong></span>
                    </div>
                  )}
                </div>

                {error && <div className="error-banner" style={{ marginTop: '0.75rem' }}>{error}</div>}

                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end', paddingTop: '1rem', marginTop: '0.75rem', borderTop: '1px solid var(--border)' }}>
                  <button type="button" className="btn btn-ghost" onClick={closeApplyModal}>Cancel</button>
                  <button type="button" className="btn btn-primary" onClick={submitApplication} disabled={applying || savingProfile}>
                    {applying || savingProfile
                      ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Submitting…</>
                      : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 4 }}><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>Submit Application</>}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  )
}

export default Careers
