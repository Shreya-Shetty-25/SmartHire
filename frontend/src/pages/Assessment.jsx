import { useCallback, useEffect, useRef, useState } from 'react'
import { assessmentApi } from '../assessmentApi'

function formatTime(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds || 0))
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function Assessment() {
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const [sessionCodeInput, setSessionCodeInput] = useState('')
  const [sessionCode, setSessionCode] = useState('')

  const [cameraOk, setCameraOk] = useState(false)
  const [micOk, setMicOk] = useState(false)
  const [speakerOk, setSpeakerOk] = useState(false)
  const [speakerTestPlayed, setSpeakerTestPlayed] = useState(false)
  const [micLevel, setMicLevel] = useState(0)

  const [starting, setStarting] = useState(false)
  const [exam, setExam] = useState(null)
  const [answers, setAnswers] = useState({})
  const [running, setRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)
  const [result, setResult] = useState(null)
  const [tabSwitchCount, setTabSwitchCount] = useState(0)

  const videoRef = useRef(null)
  const frameCanvasRef = useRef(null)
  const cameraStreamRef = useRef(null)
  const micStreamRef = useRef(null)
  const micCtxRef = useRef(null)
  const micIntervalRef = useRef(null)

  const tabSwitchCountRef = useRef(0)
  const proctorIntervalIdsRef = useRef([])
  const proctorListenersRef = useRef([])

  const hasCode = Boolean(String(sessionCodeInput || '').trim())
  const precheckPassed = cameraOk && micOk && speakerOk

  useEffect(() => {
    const queryCode = new URLSearchParams(window.location.search).get('code')
    if (queryCode) {
      setSessionCodeInput(String(queryCode).trim().toUpperCase())
    }

    startPrechecks()

    return () => {
      stopProctoring()
      stopPrechecks()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!running || timeLeft <= 0) return
    const timer = setInterval(() => {
      setTimeLeft((value) => {
        if (value <= 1) {
          clearInterval(timer)
          handleSubmit(true, 'Time ended. Auto-submitted.')
          return 0
        }
        return value - 1
      })
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, timeLeft])

  const handleSubmit = useCallback(
    async (auto = false, customMessage = '') => {
      if (!sessionCode || !exam || result) return

      setError('')
      try {
        const payload = (exam.questions || []).map((q) => ({ question_id: q.id, answer: answers[q.id] || '' }))
        const submitted = await assessmentApi.submitExam(sessionCode, payload)
        try {
          await assessmentApi.logEvent({
            session_code: sessionCode,
            event_type: 'exam_submitted',
            severity: 'low',
            payload: { auto, tab_switch_count: tabSwitchCountRef.current },
          })
        } catch {
          // ignore
        }
        setResult(submitted)
        setRunning(false)
        setInfo(customMessage || (auto ? 'Test submitted successfully.' : 'Test submitted successfully.'))
        stopProctoring()
        stopPrechecks()
      } catch (err) {
        setError(err?.message || 'Submit failed')
      }
    },
    [answers, exam, result, sessionCode],
  )

  const registerViolation = useCallback(
    (eventType, payload = null) => {
      if (!running || result) return

      tabSwitchCountRef.current += 1
      const next = tabSwitchCountRef.current
      setTabSwitchCount(next)

      try {
        void assessmentApi.logEvent({
          session_code: sessionCode,
          event_type: eventType,
          severity: next >= 4 ? 'high' : 'medium',
          payload: { count: next, ...(payload || {}) },
        })
      } catch {
        // ignore
      }

      if (next <= 3) {
        const remaining = 3 - next
        window.alert(
          remaining > 0
            ? `Tab switching is not allowed. Warning ${next}/3. Remaining attempts: ${remaining}.`
            : 'Tab switching is not allowed. Final warning (3/3). Next time the test will stop automatically.',
        )
        // Best-effort: try to pull the user back into fullscreen.
        try {
          if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            void document.documentElement.requestFullscreen()
          }
        } catch {
          // ignore
        }
        return
      }

      void handleSubmit(true, 'Test submitted successfully. Results will be shared soon.')
    },
    [handleSubmit, result, running, sessionCode],
  )

  useEffect(() => {
    if (!running || result) return

    const onVisibilityChange = () => {
      if (document.hidden) registerViolation('tab_switch_detected', { source: 'visibilitychange' })
      else {
        // When user comes back, try to re-enter fullscreen.
        try {
          if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            void document.documentElement.requestFullscreen()
          }
        } catch {
          // ignore
        }
      }
    }

    const onBlur = () => {
      registerViolation('window_blur', { source: 'blur' })
    }

    const onFullscreenChange = () => {
      if (!document.fullscreenElement) {
        registerViolation('fullscreen_exited', { source: 'fullscreenchange' })
      }
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('blur', onBlur)
    document.addEventListener('fullscreenchange', onFullscreenChange)

    proctorListenersRef.current.push(
      { target: document, event: 'visibilitychange', handler: onVisibilityChange },
      { target: window, event: 'blur', handler: onBlur },
      { target: document, event: 'fullscreenchange', handler: onFullscreenChange },
    )

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [registerViolation, result, running])

  useEffect(() => {
    if (!running || result) return
    // Make sure camera preview stays bound to the current <video> element.
    if (cameraStreamRef.current && videoRef.current) {
      videoRef.current.srcObject = cameraStreamRef.current
      videoRef.current.play().catch(() => {})
    }
  }, [running, result])

  function stopProctoring() {
    proctorIntervalIdsRef.current.forEach((id) => clearInterval(id))
    proctorIntervalIdsRef.current = []

    proctorListenersRef.current.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler)
    })
    proctorListenersRef.current = []
  }

  async function sendCameraFrame(session) {
    const video = videoRef.current
    const canvas = frameCanvasRef.current
    if (!video || !canvas || !session) return
    if (!video.videoWidth || !video.videoHeight) return

    const ctx = canvas.getContext('2d')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const image_base64 = canvas.toDataURL('image/jpeg', 0.7)
    try {
      await assessmentApi.analyzeFrame({
        session_code: session,
        camera_type: 'primary',
        image_base64,
      })
    } catch {
      // ignore transient failures
    }
  }

  async function sendAudioSample(session) {
    const bundle = micCtxRef.current
    if (!bundle || !session) return

    try {
      bundle.analyser.getFloatTimeDomainData(bundle.data)
      let sum = 0
      for (let i = 0; i < bundle.data.length; i += 1) sum += bundle.data[i] * bundle.data[i]
      const rms = Math.sqrt(sum / bundle.data.length)
      await assessmentApi.analyzeAudio({ session_code: session, rms })
    } catch {
      // ignore
    }
  }

  async function startPrechecks() {
    setError('')
    setInfo('Allow camera + microphone access to continue.')
    setSpeakerOk(false)
    setSpeakerTestPlayed(false)

    // Camera
    try {
      if (!cameraStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
        cameraStreamRef.current = stream
      }
      if (videoRef.current) {
        videoRef.current.srcObject = cameraStreamRef.current
        await videoRef.current.play()
      }
      setCameraOk(true)
    } catch (err) {
      setCameraOk(false)
      setError(err?.message || 'Camera permission denied or unavailable.')
    }

    // Microphone
    try {
      if (!micStreamRef.current) {
        const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true })
        micStreamRef.current = stream
      }

      if (!micCtxRef.current) {
        const ctx = new AudioContext()
        const source = ctx.createMediaStreamSource(micStreamRef.current)
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 1024
        source.connect(analyser)
        const data = new Float32Array(analyser.fftSize)
        micCtxRef.current = { ctx, analyser, data }
      }

      setMicOk(true)
      if (!micIntervalRef.current) {
        micIntervalRef.current = setInterval(() => {
          try {
            const bundle = micCtxRef.current
            if (!bundle) return
            bundle.analyser.getFloatTimeDomainData(bundle.data)
            let sum = 0
            for (let i = 0; i < bundle.data.length; i += 1) sum += bundle.data[i] * bundle.data[i]
            const rms = Math.sqrt(sum / bundle.data.length)
            setMicLevel(Number.isFinite(rms) ? rms : 0)
          } catch {
            // ignore
          }
        }, 250)
      }
    } catch (err) {
      setMicOk(false)
      setError(err?.message || 'Microphone permission denied or unavailable.')
    }
  }

  function stopPrechecks() {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current)
      micIntervalRef.current = null
    }

    if (micCtxRef.current?.ctx) {
      micCtxRef.current.ctx.close().catch(() => {})
    }
    micCtxRef.current = null

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop())
      micStreamRef.current = null
    }

    if (cameraStreamRef.current) {
      cameraStreamRef.current.getTracks().forEach((t) => t.stop())
      cameraStreamRef.current = null
    }
  }

  function stopPrecheckMeter() {
    if (micIntervalRef.current) {
      clearInterval(micIntervalRef.current)
      micIntervalRef.current = null
    }
  }

  async function playTestSound() {
    setError('')
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)()
      const oscillator = ctx.createOscillator()
      const gain = ctx.createGain()
      oscillator.type = 'sine'
      oscillator.frequency.value = 440
      gain.gain.value = 0.08
      oscillator.connect(gain)
      gain.connect(ctx.destination)
      oscillator.start()
      setTimeout(() => {
        try {
          oscillator.stop()
          ctx.close().catch(() => {})
        } catch {
          // ignore
        }
      }, 450)
      setSpeakerTestPlayed(true)
    } catch (err) {
      setSpeakerOk(false)
      setSpeakerTestPlayed(false)
      setError(err?.message || 'Unable to play test sound.')
    }
  }

  function confirmSpeakerHeard() {
    setSpeakerOk(true)
    setError('')
  }

  function onAnswer(questionId, option) {
    setAnswers((prev) => ({ ...prev, [questionId]: option }))
  }

  async function startAssessment() {
    const code = String(sessionCodeInput || '').trim().toUpperCase()
    if (!code) {
      setError('Please enter the session code from your email.')
      return
    }
    if (!precheckPassed) {
      setError('Complete all pre-exam checks before starting.')
      return
    }

    setStarting(true)
    setError('')
    setInfo('Loading assessment…')

    try {
      const data = await assessmentApi.accessExam(code)
      setSessionCode(data.session_code)
      setExam(data)
      setAnswers({})
      setResult(null)
      setTimeLeft(Number(data.duration_minutes || 0) * 60)
      tabSwitchCountRef.current = 0
      setTabSwitchCount(0)
      setRunning(true)
      setInfo('Assessment started.')
      stopPrecheckMeter()

      try {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen()
        }
      } catch {
        // ignore fullscreen failures
      }

      try {
        await assessmentApi.logEvent({
          session_code: data.session_code,
          event_type: 'exam_started',
          severity: 'low',
          payload: { fullscreen: Boolean(document.fullscreenElement) },
        })
      } catch {
        // ignore
      }

      // Periodic proctoring checks (no visible UI)
      stopProctoring()
      proctorIntervalIdsRef.current.push(
        setInterval(() => {
          void sendCameraFrame(data.session_code)
        }, 5000),
        setInterval(() => {
          void sendAudioSample(data.session_code)
        }, 4000),
      )
    } catch (err) {
      setError(err?.message || 'Unable to start assessment')
      setInfo('')
    } finally {
      setStarting(false)
    }
  }

  return (
    <main className="main">
      <section className="dashboard-page assessment-page">
        <div className="page-header">
          <h1 className="page-title">Assessment</h1>
          <p className="page-subtitle">Complete pre-exam checks to begin.</p>
        </div>

        {error ? <div className="error-banner">{error}</div> : null}
        {info ? <div className="error-banner">{info}</div> : null}

        {!running && !result ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Pre-exam checks</h2>
                <p className="card-subtitle">Camera, microphone, and audio output must work.</p>
              </div>
              <button type="button" className="btn btn-ghost" onClick={startPrechecks}>
                Re-check
              </button>
            </div>

            <div className="detail-grid" style={{ marginTop: '1rem' }}>
              <div className="detail-item">
                <div className="detail-label">Camera</div>
                <div className="detail-value">{cameraOk ? 'Passed' : 'Not ready'}</div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Microphone</div>
                <div className="detail-value">
                  {micOk ? 'Passed' : 'Not ready'}
                  <div className="muted" style={{ marginTop: '0.35rem' }}>
                    Input level: {Math.round(micLevel * 1000)}
                  </div>
                </div>
              </div>
              <div className="detail-item">
                <div className="detail-label">Audio (speaker)</div>
                <div className="detail-value">{speakerOk ? 'Passed' : speakerTestPlayed ? 'Played (confirm)' : 'Not checked'}</div>
              </div>
              <div className="detail-item" style={{ gridColumn: '1 / -1' }}>
                <div className="detail-label">Preview</div>
                <div className="detail-value">
                  <video className="assessment-video" ref={videoRef} autoPlay muted playsInline />
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem' }}>
              <button type="button" className="btn btn-ghost" onClick={playTestSound}>
                Play test sound
              </button>

              {speakerTestPlayed && !speakerOk ? (
                <button type="button" className="btn btn-primary" onClick={confirmSpeakerHeard}>
                  I heard the sound
                </button>
              ) : null}

              <div style={{ flex: 1, minWidth: 240 }}>
                <label className="label" htmlFor="sessionCode">
                  Session code
                </label>
                <input
                  id="sessionCode"
                  className="input"
                  value={sessionCodeInput}
                  onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase())}
                  placeholder="EXAM-XXXXXXXXXX"
                />
                <div className="muted" style={{ marginTop: '0.35rem' }}>
                  Enter the code sent in your email.
                </div>
              </div>

              {precheckPassed && hasCode ? (
                <button type="button" className="btn btn-primary" onClick={startAssessment} disabled={starting}>
                  {starting ? 'Starting…' : 'Start assessment'}
                </button>
              ) : null}
            </div>
          </article>
        ) : null}

        {running && exam ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Test</h2>
                <p className="card-subtitle">
                  Code {sessionCode} · Time left {formatTime(timeLeft)}
                </p>
              </div>
            </div>

            {tabSwitchCount > 0 ? (
              <div className="error-text" style={{ marginBottom: '0.75rem' }}>
                Tab switch warnings: {tabSwitchCount}/3
              </div>
            ) : null}

            {(exam.questions || []).map((q) => (
              <div className="assessment-question" key={q.id}>
                <div style={{ fontWeight: 650 }}>
                  Q{q.id}. {q.question}
                </div>
                {(q.options || []).map((opt) => (
                  <label className="assessment-option" key={`${q.id}-${opt}`}>
                    <input
                      type="radio"
                      name={`q-${q.id}`}
                      checked={answers[q.id] === opt}
                      onChange={() => onAnswer(q.id, opt)}
                    />
                    <span>{opt}</span>
                  </label>
                ))}
              </div>
            ))}

            <button type="button" className="btn btn-primary" onClick={() => handleSubmit(false)} disabled={Boolean(result)}>
              Submit
            </button>

            <video ref={videoRef} autoPlay muted playsInline style={{ display: 'none' }} />
            <canvas ref={frameCanvasRef} style={{ display: 'none' }} />
          </article>
        ) : null}

        {result ? (
          <article className="card" style={{ marginTop: '1rem' }}>
            <div className="card-header">
              <div>
                <h2 className="card-title">Result</h2>
                <p className="card-subtitle">Assessment submitted.</p>
              </div>
            </div>
            <div>Test submitted successfully.</div>
            <div className="muted" style={{ marginTop: '0.35rem' }}>Your results will be shared soon.</div>
          </article>
        ) : null}
      </section>
    </main>
  )
}

export default Assessment
