import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
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

function Careers() {
  const token = useMemo(() => localStorage.getItem('token') || '', [])

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
      setApplyOpen(false)
      setMessage(`Applied successfully for ${selectedJob.title}! Visit My Profile to track your application.`)
    } catch (err) {
      setError(err?.message || 'Failed to apply for this job')
    } finally {
      setSavingProfile(false); setApplying(false)
    }
  }

  const alreadyApplied = useMemo(() => {
    if (!profile || !selectedJob) return false
    return (profile.applications || []).some((a) => Number(a.job_id) === Number(selectedJob?.id))
  }, [profile, selectedJob])

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <p className="eyebrow">Candidate Portal</p>
            <h1 className="page-title">Careers</h1>
            <p className="page-subtitle">Explore open roles and apply for positions that match your skills.</p>
          </div>
          <Link to="/profile">
            <button type="button" className="btn btn-ghost">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
              My Profile
            </button>
          </Link>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {message ? <div className="alert alert-success">{message}</div> : null}

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
                {loadingJobs && <div className="muted" style={{ padding: '1rem 0', textAlign: 'center' }}>Loading jobs…</div>}
                {!loadingJobs && filteredJobs.length === 0 && <div className="muted" style={{ padding: '1rem 0', textAlign: 'center' }}>No jobs found.</div>}
                {!loadingJobs && filteredJobs.map((job) => (
                  <button key={job.id} type="button"
                    className={`careers-job-item ${Number(selectedJobId) === Number(job.id) ? 'is-active' : ''}`}
                    onClick={() => setSelectedJobId(job.id)}>
                    <div className="careers-job-title">{job.title}</div>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.3rem' }}>
                      {job.location && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                          {job.location}
                        </span>
                      )}
                      {job.employment_type && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                          {job.employment_type}
                        </span>
                      )}
                    </div>
                    <div className="chip-row" style={{ marginTop: '0.5rem' }}>
                      {(job.skills_required || []).slice(0, 3).map((skill) => <span key={`${job.id}-${skill}`} className="chip">{skill}</span>)}
                      {(job.skills_required || []).length > 3 ? <span className="chip">+{job.skills_required.length - 3}</span> : null}
                    </div>
                  </button>
                ))}
              </div>
            </article>
          </div>

          {/* Right: Job Detail Panel */}
          <div className="careers-detail-col">
            {!selectedJob ? (
              <div className="careers-detail-empty">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--border)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                <p style={{ marginTop: '0.75rem', color: 'var(--text-secondary)' }}>Select a job to see details</p>
              </div>
            ) : (
              <article className="card careers-detail-panel">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', flexWrap: 'wrap' }}>
                  <div>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)' }}>{selectedJob.title}</h2>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
                      {selectedJob.location && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                          {selectedJob.location}
                        </span>
                      )}
                      {selectedJob.employment_type && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
                          {selectedJob.employment_type}
                        </span>
                      )}
                      {selectedJob.years_experience != null && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                          {selectedJob.years_experience}+ years exp.
                        </span>
                      )}
                      {selectedJob.salary_range && (
                        <span className="badge-soft" style={{ fontSize: '0.8rem' }}>{selectedJob.salary_range}</span>
                      )}
                    </div>
                  </div>
                  {alreadyApplied ? (
                    <span className="badge-soft" style={{ color: '#22c55e', borderColor: '#86efac', background: '#f0fdf4', flexShrink: 0 }}>
                      ✓ Applied
                    </span>
                  ) : (
                    <button type="button" className="btn btn-primary" style={{ flexShrink: 0 }} onClick={openApplyModal}>
                      Apply Now
                    </button>
                  )}
                </div>

                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '1rem 0' }} />

                {/* Skills */}
                {(selectedJob.skills_required || []).length > 0 && (
                  <div style={{ marginBottom: '1rem' }}>
                    <h3 style={{ fontSize: '0.82rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Required Skills</h3>
                    <div className="chip-row">
                      {selectedJob.skills_required.map((skill) => <span key={`detail-${skill}`} className="chip">{skill}</span>)}
                    </div>
                  </div>
                )}

                {/* Description */}
                <div style={{ marginBottom: '1rem' }}>
                  <h3 style={{ fontSize: '0.82rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Job Description</h3>
                  <p style={{ fontSize: '0.9rem', lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{selectedJob.description || 'No description provided.'}</p>
                </div>

                {/* Related Jobs */}
                {(relatedJobs.length > 0 || loadingRelated) && (
                  <div style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ fontSize: '0.82rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', marginBottom: '0.6rem' }}>You Might Also Like</h3>
                    {loadingRelated && <div className="muted" style={{ fontSize: '0.85rem' }}>Finding related roles…</div>}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                      {relatedJobs.map((job) => (
                        <button key={`related-${job.id}`} type="button" className="careers-related-item" onClick={() => setSelectedJobId(job.id)}>
                          <span style={{ fontWeight: 600, fontSize: '0.88rem' }}>{job.title}</span>
                          <span className="muted" style={{ fontSize: '0.75rem', marginLeft: 'auto' }}>Match {Math.round((job.relevance_score || 0) * 100)}%</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {!alreadyApplied && (
                  <div style={{ marginTop: '1.5rem' }}>
                    <button type="button" className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }} onClick={openApplyModal}>
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 6 }}><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13 19.79 19.79 0 0 1 1.62 4.42 2 2 0 0 1 3.59 2.23h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 9.91a16 16 0 0 0 6.06 6.06l.91-.91a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                      Apply Now for {selectedJob.title}
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
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) setApplyOpen(false) }}>
          <div className="modal-card careers-apply-modal" style={{ padding: '1.75rem', background: 'var(--bg)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <div>
                <h2 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Apply for {selectedJob?.title}</h2>
                <p className="muted" style={{ fontSize: '0.83rem', marginTop: 2 }}>Review and update your profile before submitting.</p>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setApplyOpen(false)} style={{ fontSize: '1.2rem', lineHeight: 1, padding: '0.25rem 0.5rem' }}>×</button>
            </div>

            <div className="detail-grid" style={{ marginBottom: '0.75rem' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="am-name">Full name</label>
                <input id="am-name" className="input" value={applyForm.full_name} onChange={(e) => setApplyForm((p) => ({ ...p, full_name: e.target.value }))} placeholder="Your full name" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="am-phone">Phone number</label>
                <input id="am-phone" className="input" value={applyForm.phone_number} onChange={(e) => setApplyForm((p) => ({ ...p, phone_number: e.target.value }))} placeholder="+91 98765 43210" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="am-location">Location</label>
                <input id="am-location" className="input" value={applyForm.location} onChange={(e) => setApplyForm((p) => ({ ...p, location: e.target.value }))} placeholder="City, Country" />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label className="label" htmlFor="am-years">Years of experience</label>
                <input id="am-years" className="input" type="number" min="0" value={applyForm.years_experience} onChange={(e) => setApplyForm((p) => ({ ...p, years_experience: e.target.value }))} placeholder="3" />
              </div>
            </div>
            <div className="field" style={{ marginBottom: '0.75rem' }}>
              <label className="label" htmlFor="am-skills">Skills (comma separated)</label>
              <input id="am-skills" className="input" value={applyForm.skills_text} onChange={(e) => setApplyForm((p) => ({ ...p, skills_text: e.target.value }))} placeholder="React, Node.js, Python…" />
            </div>
            <div className="field" style={{ marginBottom: '1rem' }}>
              <label className="label" htmlFor="am-note">Cover note (optional)</label>
              <textarea id="am-note" className="input" rows={2} value={applyNote} onChange={(e) => setApplyNote(e.target.value)} placeholder="Share why you're a great fit for this role…" />
            </div>

            {profile?.resume_filename && (
              <div className="badge-soft" style={{ marginBottom: '1rem', display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.8rem' }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><polyline points="14 2 14 8 20 8"/></svg>
                Resume: {profile.resume_filename}
              </div>
            )}

            {error && <div className="error-banner" style={{ marginBottom: '0.75rem' }}>{error}</div>}

            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn-ghost" onClick={() => setApplyOpen(false)}>Cancel</button>
              <button type="button" className="btn btn-primary" onClick={submitApplication} disabled={applying || savingProfile}>
                {applying || savingProfile
                  ? <><span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />&nbsp;Submitting…</>
                  : 'Save Profile & Apply'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default Careers
