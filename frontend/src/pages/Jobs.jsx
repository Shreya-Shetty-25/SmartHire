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
        <div className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1 className="page-title">Jobs</h1>
            <p className="page-subtitle">Manage job postings and track candidates per role.</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? 'Cancel' : '+ Create job'}
          </button>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        {showForm ? (
          <article className="card" style={{ marginBottom: '1.25rem' }}>
            <h2 className="card-title" style={{ marginBottom: '1rem' }}>New Job Posting</h2>
            <form onSubmit={onCreateJob}>
              <div className="form-grid">
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-title">Job title *</label>
                  <input id="job-title" className="input" value={form.title} onChange={updateField('title')} placeholder="e.g. Senior Frontend Developer" />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label className="label" htmlFor="job-location">Location</label>
                  <input id="job-location" className="input" value={form.location} onChange={updateField('location')} placeholder="e.g. Remote, New York, etc." />
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
                <label className="label" htmlFor="job-addskills">Nice-to-have skills (comma-separated)</label>
                <input id="job-addskills" className="input" value={form.additional_skills} onChange={updateField('additional_skills')} placeholder="e.g. GraphQL, AWS" />
              </div>
              <div className="field" style={{ marginTop: '0.5rem' }}>
                <label className="label" htmlFor="job-desc">Description *</label>
                <textarea id="job-desc" className="input" rows={4} value={form.description} onChange={updateField('description')} placeholder="Describe the role, responsibilities, and requirements…" />
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.75rem' }}>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? 'Creating…' : 'Create job'}
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
              <p className="card-subtitle">{loading ? 'Loading…' : `${filteredRows.length} of ${rows.length} jobs`}</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={loadJobs} disabled={loading}>Refresh</button>
          </div>

          <div className="search-bar">
            <span className="search-icon">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            </span>
            <input className="input" placeholder="Search by title, location, or skill…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>

          {filteredRows.length === 0 && !loading ? (
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>
              </div>
              <div className="empty-state-title">No jobs found</div>
              <div className="empty-state-desc">{search ? 'Try a different search term.' : 'Create your first job posting to get started.'}</div>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Jobs table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Location</th>
                    <th>Type</th>
                    <th>Experience</th>
                    <th>Skills</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((job) => (
                    <tr key={job.id}>
                      <td style={{ fontWeight: 600 }}>{job.title || '—'}</td>
                      <td className="table-muted">{job.location || '—'}</td>
                      <td><span className="badge-soft">{job.employment_type || '—'}</span></td>
                      <td className="table-muted">{job.years_experience != null ? `${job.years_experience}+ yrs` : '—'}</td>
                      <td>
                        <div className="chip-row" style={{ marginTop: 0 }}>
                          {(job.skills_required || []).slice(0, 4).map((s) => <span key={s} className="chip">{s}</span>)}
                          {(job.skills_required || []).length > 4 ? <span className="chip">+{job.skills_required.length - 4}</span> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>
    </main>
  )
}

export default Jobs
