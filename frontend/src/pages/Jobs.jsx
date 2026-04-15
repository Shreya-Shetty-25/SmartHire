import { useEffect, useMemo, useState } from 'react'
import { jobs } from '../api'

function Jobs() {
  const token = useMemo(() => localStorage.getItem('token'), [])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [creating, setCreating] = useState(false)

  const [form, setForm] = useState({
    title: '',
    description: '',
    location: '',
    employment_type: 'Full-time',
    education: '',
    years_experience: '',
    skills_required: '',
    additional_skills: '',
  })

  const loadJobs = async () => {
    if (!token) { setError('Missing token. Please log in again.'); setLoading(false); return }
    setError('')
    setLoading(true)
    try {
      const data = await jobs.list(token)
      setRows(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err?.message || 'Failed to load jobs')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadJobs() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filteredRows = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return rows
    return rows.filter((j) =>
      (j.title || '').toLowerCase().includes(q) ||
      (j.location || '').toLowerCase().includes(q) ||
      (j.employment_type || '').toLowerCase().includes(q) ||
      (j.skills_required || []).join(' ').toLowerCase().includes(q)
    )
  }, [rows, search])

  const onCreateJob = async (e) => {
    e.preventDefault()
    if (!form.title.trim() || !form.description.trim()) {
      setError('Title and description are required.')
      return
    }
    setCreating(true)
    setError('')
    try {
      const payload = {
        title: form.title.trim(),
        description: form.description.trim(),
        location: form.location.trim() || null,
        employment_type: form.employment_type.trim() || null,
        education: form.education.trim() || null,
        years_experience: form.years_experience ? Number(form.years_experience) : null,
        skills_required: form.skills_required.split(',').map((s) => s.trim()).filter(Boolean),
        additional_skills: form.additional_skills.split(',').map((s) => s.trim()).filter(Boolean),
      }
      const created = await jobs.create(token, payload)
      setRows((prev) => [created, ...prev])
      setForm({ title: '', description: '', location: '', employment_type: 'Full-time', education: '', years_experience: '', skills_required: '', additional_skills: '' })
      setShowForm(false)
    } catch (err) {
      setError(err?.message || 'Failed to create job')
    } finally {
      setCreating(false)
    }
  }

  const updateField = (field) => (e) => setForm((prev) => ({ ...prev, [field]: e.target.value }))

  return (
    <main className="main">
      <section className="dashboard-page">
        <div className="page-header-row">
          <div>
            <h1 className="page-title">Jobs</h1>
            <p className="page-subtitle">Manage job postings and track candidates per role.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? (
              'Cancel'
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                New Job
              </>
            )}
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        {showForm ? (
          <article className="card" style={{ marginBottom: '1.5rem' }}>
            <h2 className="card-title" style={{ marginBottom: '1.5rem' }}>New Job Posting</h2>
            <form onSubmit={onCreateJob}>
              <div className="form-grid">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-title">Job title *</label>
                  <input id="job-title" className="input" value={form.title} onChange={updateField('title')} placeholder="e.g. Senior Frontend Developer" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-location">Location</label>
                  <input id="job-location" className="input" value={form.location} onChange={updateField('location')} placeholder="e.g. Remote, New York" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-type">Employment type</label>
                  <select id="job-type" className="input" value={form.employment_type} onChange={updateField('employment_type')}>
                    <option>Full-time</option>
                    <option>Part-time</option>
                    <option>Contract</option>
                    <option>Internship</option>
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-exp">Years of experience</label>
                  <input id="job-exp" className="input" type="number" min="0" value={form.years_experience} onChange={updateField('years_experience')} placeholder="e.g. 3" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-edu">Education</label>
                  <input id="job-edu" className="input" value={form.education} onChange={updateField('education')} placeholder="e.g. Bachelor's in CS" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-skills">Required skills (comma-separated)</label>
                  <input id="job-skills" className="input" value={form.skills_required} onChange={updateField('skills_required')} placeholder="e.g. React, TypeScript, Node.js" />
                </div>
              </div>
              <div className="field" style={{ marginTop: '1rem' }}>
                <label className="label" htmlFor="job-addskills">Nice-to-have skills</label>
                <input id="job-addskills" className="input" value={form.additional_skills} onChange={updateField('additional_skills')} placeholder="e.g. GraphQL, AWS" />
              </div>
              <div className="field" style={{ marginTop: '0.75rem' }}>
                <label className="label" htmlFor="job-desc">Description *</label>
                <textarea id="job-desc" className="input" rows={4} value={form.description} onChange={updateField('description')} placeholder="Describe the role, responsibilities, and requirements…" />
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1rem' }}>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? <><span className="loading-spinner" />Creating…</> : 'Create job'}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setShowForm(false)}>Cancel</button>
              </div>
            </form>
          </article>
        ) : null}

        <article className="card">
          <div className="card-header">
            <div>
              <h2 className="card-title">All Jobs</h2>
              <p className="card-subtitle">{loading ? 'Loading…' : `${filteredRows.length} of ${rows.length} job${rows.length !== 1 ? 's' : ''}`}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadJobs} disabled={loading}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Refresh
            </button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by title, location, or skill…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {loading ? (
            <div style={{ padding: '2rem 0', textAlign: 'center' }}>
              <span className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 3 }} />
              <p className="muted" style={{ marginTop: '0.75rem' }}>Loading jobs…</p>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
              </div>
              <div className="empty-state-title">No jobs found</div>
              <div className="empty-state-desc">{search ? 'Try a different search term.' : 'Create your first job posting to get started.'}</div>
            </div>
          ) : (
            <div className="job-cards-grid" style={{ marginTop: '0.25rem' }}>
              {filteredRows.map((job) => (
                <div key={job.id} className="job-card">
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem' }}>
                    <h3 className="job-card-title">{job.title || '—'}</h3>
                    <span className="badge-soft" style={{ flexShrink: 0 }}>{job.employment_type || 'Job'}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
                    {job.location && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                        {job.location}
                      </span>
                    )}
                    {job.years_experience != null && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        {job.years_experience}+ yrs
                      </span>
                    )}
                  </div>
                  {(job.skills_required || []).length > 0 && (
                    <div className="chip-row" style={{ marginTop: 0 }}>
                      {(job.skills_required || []).slice(0, 4).map((s) => <span key={s} className="chip">{s}</span>)}
                      {(job.skills_required || []).length > 4 ? <span className="chip">+{job.skills_required.length - 4}</span> : null}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </article>
      </section>
    </main>
  )
}

export default Jobs
