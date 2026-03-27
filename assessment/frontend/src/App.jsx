import { useEffect, useMemo, useRef, useState } from 'react'
import { assessmentApi } from './api'

function rmsFromFloatArray(data) {
  let sum = 0
  for (let i = 0; i < data.length; i += 1) {
    sum += data[i] * data[i]
  }
  return Math.sqrt(sum / data.length)
}

function createLockToken() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replace(/-/g, '').slice(0, 24)
  }
  return `${Date.now()}${Math.random().toString(36).slice(2, 12)}`
}

const MAX_ID_UPLOAD_BYTES = 8 * 1024 * 1024

function App() {
  const [jobs, setJobs] = useState([])
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')

  const [form, setForm] = useState({
    job_id: '',
    candidate_name: '',
    candidate_email: '',
    duration_minutes: 30,
    question_count: 10,
    difficulty: 'medium',
  })

  const [sessionCodeInput, setSessionCodeInput] = useState('')
  const [sessionCode, setSessionCode] = useState('')
  const [exam, setExam] = useState(null)
  const [answers, setAnswers] = useState({})
  const [result, setResult] = useState(null)
  const [antiCheatFlags, setAntiCheatFlags] = useState([])

  const [running, setRunning] = useState(false)
  const [timeLeft, setTimeLeft] = useState(0)

  const [idImageBase64, setIdImageBase64] = useState('')
  const [idImageName, setIdImageName] = useState('')
  const [selfieImageBase64, setSelfieImageBase64] = useState('')
  const [identityCheck, setIdentityCheck] = useState(null)
  const [identityVerified, setIdentityVerified] = useState(false)
  const [verifyingIdentity, setVerifyingIdentity] = useState(false)

  const primaryVideoRef = useRef(null)
  const frameCanvasRef = useRef(null)
  const captureCanvasRef = useRef(null)

  const previewStreamRef = useRef(null)
  const intervalsRef = useRef([])
  const streamRefs = useRef([])
  const audioRef = useRef({ ctx: null, analyser: null, data: null, stream: null })
  const listenerRef = useRef([])
  const activeSessionRef = useRef('')

  const tabIdRef = useRef(createLockToken())
  const closingPolicyRef = useRef(false)
  const devtoolsFlaggedRef = useRef(false)
  const shortcutRef = useRef({ timestamps: [], flagged: false })
  const livenessRef = useRef({ prompt: '', deadlineTs: 0, active: false })
  const [livenessPrompt, setLivenessPrompt] = useState('')

  const scoreText = useMemo(() => {
    if (!result) return ''
    return `${result.score}/${result.total}`
  }, [result])

  useEffect(() => {
    const queryCode = new URLSearchParams(window.location.search).get('code')
    if (queryCode) {
      setSessionCodeInput(queryCode)
    }

    assessmentApi
      .listJobs()
      .then((data) => setJobs(data))
      .catch((err) => setError(err.message))
  }, [])

  useEffect(() => {
    if (!exam || running || result) return
    ensurePreviewCamera().catch((err) => setError(err.message || 'Unable to start primary camera preview'))
  }, [exam, running, result])

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
  }, [running, timeLeft])

  useEffect(() => {
    return () => {
      stopAllMonitoring()
      stopPreviewCamera()
    }
  }, [])

  function resetVerification() {
    setIdImageBase64('')
    setIdImageName('')
    setSelfieImageBase64('')
    setIdentityCheck(null)
    setIdentityVerified(false)
    setLivenessPrompt('')
  }

  async function ensurePreviewCamera() {
    if (previewStreamRef.current) return
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    })
    previewStreamRef.current = stream
    if (primaryVideoRef.current) {
      primaryVideoRef.current.srcObject = stream
      await primaryVideoRef.current.play().catch(() => {})
    }
  }

  function stopPreviewCamera() {
    if (!previewStreamRef.current) return
    previewStreamRef.current.getTracks().forEach((track) => track.stop())
    previewStreamRef.current = null
  }

  function stopAllMonitoring() {
    intervalsRef.current.forEach((id) => clearInterval(id))
    intervalsRef.current = []

    streamRefs.current.forEach((stream) => {
      stream.getTracks().forEach((track) => track.stop())
    })
    streamRefs.current = []

    if (audioRef.current.ctx) {
      audioRef.current.ctx.close().catch(() => {})
    }
    audioRef.current = { ctx: null, analyser: null, data: null, stream: null }

    listenerRef.current.forEach(({ target, event, handler }) => {
      target.removeEventListener(event, handler)
    })
    listenerRef.current = []

    if (activeSessionRef.current) {
      const key = `assessment_exam_lock_${activeSessionRef.current}`
      try {
        const raw = localStorage.getItem(key)
        if (raw) {
          const lock = JSON.parse(raw)
          if (lock.tabId === tabIdRef.current) {
            localStorage.removeItem(key)
          }
        }
      } catch {
        // ignore lock cleanup errors
      }
      activeSessionRef.current = ''
    }

    livenessRef.current = { prompt: '', deadlineTs: 0, active: false }
    setLivenessPrompt('')
    closingPolicyRef.current = false
    setRunning(false)
  }

  async function createExam(event) {
    event.preventDefault()
    setError('')
    setInfo('')

    try {
      const created = await assessmentApi.createExam({
        ...form,
        job_id: Number(form.job_id),
        duration_minutes: Number(form.duration_minutes),
        question_count: Number(form.question_count),
      })
      setInfo(`Exam created. Session code: ${created.session_code} | Link: ${created.exam_link}`)
      setSessionCodeInput(created.session_code)
    } catch (err) {
      setError(err.message)
    }
  }

  async function handleAccessExam(event) {
    event.preventDefault()
    setError('')
    setInfo('')

    try {
      const data = await assessmentApi.accessExam(sessionCodeInput.trim())
      setSessionCode(data.session_code)
      setExam(data)
      setAnswers({})
      setResult(null)
      setAntiCheatFlags([])
      setTimeLeft(data.duration_minutes * 60)
      resetVerification()
      setInfo('Exam prepared. Complete ID + face verification before starting.')
    } catch (err) {
      setError(err.message)
    }
  }

  function onAnswer(questionId, option) {
    setAnswers((prev) => ({ ...prev, [questionId]: option }))
  }

  function recordFlag(text) {
    setAntiCheatFlags((prev) => [text, ...prev].slice(0, 30))
  }

  async function sendEvent(eventType, severity = 'medium', payload = null) {
    if (!sessionCode) return
    try {
      await assessmentApi.logEvent({ session_code: sessionCode, event_type: eventType, severity, payload })
    } catch {
      // no-op
    }
  }

  function evaluateLiveness(gaze) {
    const challenge = livenessRef.current
    if (!challenge.active || !challenge.prompt) return

    const now = Date.now()
    if (now > challenge.deadlineTs) {
      challenge.active = false
      setLivenessPrompt('')
      recordFlag('liveness challenge failed')
      sendEvent('liveness_challenge_failed', 'high', { expected: challenge.prompt, observed: gaze })
      return
    }

    const expected = `looking_${challenge.prompt}`
    if (gaze === expected) {
      challenge.active = false
      setLivenessPrompt('')
      sendEvent('liveness_challenge_passed', 'low', { expected })
    }
  }

  function startLivenessChallenges() {
    const options = ['left', 'right', 'up', 'down']
    const id = setInterval(() => {
      const current = livenessRef.current
      if (current.active) return
      const prompt = options[Math.floor(Math.random() * options.length)]
      livenessRef.current = {
        prompt,
        deadlineTs: Date.now() + 12000,
        active: true,
      }
      setLivenessPrompt(`Liveness check: look ${prompt.toUpperCase()} for 1-2 seconds`)
      sendEvent('liveness_challenge_issued', 'low', { prompt })
    }, 45000)
    intervalsRef.current.push(id)
  }

  async function closeExamByPolicy(reason, eventType, severity = 'high', payload = null) {
    if (!running || result || closingPolicyRef.current) return
    closingPolicyRef.current = true
    recordFlag(reason)
    await sendEvent(eventType, severity, payload)
    await handleSubmit(true, reason)
  }

  function startSingleTabLock(sessionCodeForLock) {
    const key = `assessment_exam_lock_${sessionCodeForLock}`
    const writeLock = () => {
      localStorage.setItem(key, JSON.stringify({ tabId: tabIdRef.current, ts: Date.now() }))
    }

    writeLock()
    const id = setInterval(() => {
      const raw = localStorage.getItem(key)
      if (!raw) {
        writeLock()
        return
      }
      try {
        const lock = JSON.parse(raw)
        if (lock.tabId !== tabIdRef.current) {
          void closeExamByPolicy('Exam closed: multiple exam tabs detected', 'multiple_tabs_detected', 'high', { owner: lock.tabId })
          return
        }
      } catch {
        // malformed lock, recover
      }
      writeLock()
    }, 2500)
    intervalsRef.current.push(id)

    const storageHandler = (event) => {
      if (event.key !== key || !event.newValue) return
      try {
        const lock = JSON.parse(event.newValue)
        if (lock.tabId !== tabIdRef.current) {
          void closeExamByPolicy('Exam closed: opened in another tab', 'multiple_tabs_detected', 'high', { owner: lock.tabId })
        }
      } catch {
        // ignore parse errors
      }
    }
    window.addEventListener('storage', storageHandler)
    listenerRef.current.push({ target: window, event: 'storage', handler: storageHandler })
  }

  function startDevtoolsDetection() {
    devtoolsFlaggedRef.current = false
    const id = setInterval(() => {
      const widthGap = Math.abs(window.outerWidth - window.innerWidth)
      const heightGap = Math.abs(window.outerHeight - window.innerHeight)
      const open = widthGap > 160 || heightGap > 160
      if (open && !devtoolsFlaggedRef.current) {
        devtoolsFlaggedRef.current = true
        recordFlag('devtools or debug pane detected')
        sendEvent('devtools_detected', 'high', { widthGap, heightGap })
      }
      if (!open) {
        devtoolsFlaggedRef.current = false
      }
    }, 2000)
    intervalsRef.current.push(id)
  }

  function startShortcutMonitoring() {
    shortcutRef.current = { timestamps: [], flagged: false }
    const keydownHandler = (event) => {
      const suspicious =
        (event.ctrlKey && ['c', 'v', 'x', 'u', 's', 'p'].includes(event.key.toLowerCase())) ||
        (event.altKey && event.key.toLowerCase() === 'tab') ||
        event.key === 'F12'
      if (!suspicious) return

      const now = Date.now()
      const recent = shortcutRef.current.timestamps.filter((ts) => now - ts < 10000)
      recent.push(now)
      shortcutRef.current.timestamps = recent

      if (recent.length >= 5 && !shortcutRef.current.flagged) {
        shortcutRef.current.flagged = true
        recordFlag('suspicious keyboard shortcut burst')
        sendEvent('shortcut_burst_detected', 'high', { count_10s: recent.length })
      }
    }

    const offlineHandler = () => {
      recordFlag('network offline during exam')
      sendEvent('network_offline', 'high')
    }
    const onlineHandler = () => {
      sendEvent('network_online', 'low')
    }

    document.addEventListener('keydown', keydownHandler)
    window.addEventListener('offline', offlineHandler)
    window.addEventListener('online', onlineHandler)

    listenerRef.current.push(
      { target: document, event: 'keydown', handler: keydownHandler },
      { target: window, event: 'offline', handler: offlineHandler },
      { target: window, event: 'online', handler: onlineHandler }
    )
  }

  async function analyzePrimaryVideo() {
    const video = primaryVideoRef.current
    const canvas = frameCanvasRef.current
    if (!video || !canvas || video.videoWidth === 0 || video.videoHeight === 0 || !sessionCode) return

    const ctx = canvas.getContext('2d')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)

    const image_base64 = canvas.toDataURL('image/jpeg', 0.7)
    try {
      const resultFrame = await assessmentApi.analyzeFrame({
        session_code: sessionCode,
        camera_type: 'primary',
        image_base64,
      })
      if (resultFrame.flags?.length) {
        const message = `primary: ${resultFrame.flags.join(', ')}`
        recordFlag(message)
      }
      const mismatchStreak = resultFrame?.identity?.mismatch_streak || 0
      if (mismatchStreak >= 3) {
        recordFlag('possible candidate identity change detected')
        sendEvent('identity_mismatch_detected', 'high', {
          similarity: resultFrame?.identity?.similarity,
          mismatch_streak: mismatchStreak,
        })
      }
      if (resultFrame?.object_detection?.suspicious_count > 0) {
        sendEvent('suspicious_object_detected', 'high', resultFrame.object_detection)
      }
      evaluateLiveness(resultFrame?.gaze)
    } catch {
      // ignore temporary frame errors
    }
  }

  async function setupAudioMonitoring(currentSessionCode) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
    const ctx = new AudioContext()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    source.connect(analyser)

    const data = new Float32Array(analyser.fftSize)

    audioRef.current = { ctx, analyser, data, stream }
    streamRefs.current.push(stream)

    const id = setInterval(async () => {
      analyser.getFloatTimeDomainData(data)
      const rms = rmsFromFloatArray(data)
      try {
        const resultAudio = await assessmentApi.analyzeAudio({ session_code: currentSessionCode, rms })
        if (resultAudio.is_anomaly) {
          recordFlag(`audio anomaly (rms=${resultAudio.audio_rms})`)
        }
      } catch {
        // ignore
      }
    }, 2500)

    intervalsRef.current.push(id)
  }

  async function setupPrimaryCameraMonitoring() {
    let stream = previewStreamRef.current
    if (!stream) {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
    }
    previewStreamRef.current = null
    streamRefs.current.push(stream)

    if (primaryVideoRef.current) {
      primaryVideoRef.current.srcObject = stream
      await primaryVideoRef.current.play().catch(() => {})
    }
  }

  async function startMonitoring(currentSessionCode) {
    activeSessionRef.current = currentSessionCode
    if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {})
    }

    await setupPrimaryCameraMonitoring()
    await setupAudioMonitoring(currentSessionCode)
    startSingleTabLock(currentSessionCode)
    startDevtoolsDetection()
    startShortcutMonitoring()
    startLivenessChallenges()

    const p1 = setInterval(() => analyzePrimaryVideo(), 5000)
    intervalsRef.current.push(p1)

    const visibilityHandler = () => {
      if (document.hidden) {
        void closeExamByPolicy('Exam closed: tab switched / page hidden', 'tab_switched', 'high', { hidden: true })
      }
    }
    const blurHandler = () => {
      void closeExamByPolicy('Exam closed: window focus lost', 'window_blur', 'high')
    }
    const fullscreenHandler = () => {
      if (!document.fullscreenElement) {
        void closeExamByPolicy('Exam closed: fullscreen exited', 'fullscreen_exited', 'high')
      }
    }

    document.addEventListener('visibilitychange', visibilityHandler)
    window.addEventListener('blur', blurHandler)
    document.addEventListener('fullscreenchange', fullscreenHandler)

    listenerRef.current.push(
      { target: document, event: 'visibilitychange', handler: visibilityHandler },
      { target: window, event: 'blur', handler: blurHandler },
      { target: document, event: 'fullscreenchange', handler: fullscreenHandler }
    )

    /* ── VM / remote desktop detection ── */
    try {
      const vmFlags = []
      const ua = navigator.userAgent || ''
      if (/VirtualBox|VMware|Hyper-V|QEMU|Parallels/i.test(ua)) vmFlags.push('ua_vm')
      if (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 1) vmFlags.push('single_core')
      if (typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 1) vmFlags.push('low_memory')
      const gl = document.createElement('canvas').getContext('webgl')
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          const renderer = (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '').toLowerCase()
          if (/swiftshader|llvmpipe|virtualbox|vmware|mesa|parallels/i.test(renderer)) vmFlags.push('vm_gpu')
        }
      }
      if (vmFlags.length >= 2) {
        recordFlag('VM / virtual environment detected')
        sendEvent('vm_detected', 'high', { signals: vmFlags })
      }
    } catch { /* */ }

    /* ── server-side environment check ── */
    try {
      const gl = document.createElement('canvas').getContext('webgl')
      let renderer = '', vendor = ''
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info')
        if (dbg) {
          renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || ''
          vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || ''
        }
      }
      void assessmentApi.envCheck({
        session_code: currentSessionCode,
        user_agent: navigator.userAgent || '',
        platform: navigator.platform || '',
        hardware_concurrency: navigator.hardwareConcurrency || null,
        device_memory: navigator.deviceMemory || null,
        webgl_renderer: renderer,
        webgl_vendor: vendor,
        screen_width: screen.width,
        screen_height: screen.height,
        screen_color_depth: screen.colorDepth,
        max_touch_points: navigator.maxTouchPoints ?? 0,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
        languages: [...(navigator.languages || [])],
        plugins_count: navigator.plugins?.length ?? 0,
        has_pointer: window.matchMedia?.('(pointer: fine)')?.matches ?? true,
      }).catch(() => {})
    } catch { /* */ }

    /* ── browser extension detection ── */
    const extScanId = setInterval(() => {
      try {
        const injected = document.querySelectorAll('[data-extension], [class*="grammarly"], [data-gramm], iframe[src*="chrome-extension"], [id*="lastpass"]')
        if (injected.length) {
          recordFlag(`Browser extension detected (${injected.length} elements)`)
          sendEvent('browser_extension_detected', 'medium', { count: injected.length })
        }
      } catch { /* */ }
    }, 20000)
    intervalsRef.current.push(extScanId)

    /* ── clipboard content detection ── */
    const clipHandler = (e) => {
      e.preventDefault()
      let content = ''
      try { content = (e.clipboardData || window.clipboardData)?.getData('text') || '' } catch { /* */ }
      if (content.length > 10) {
        recordFlag('Clipboard content detected')
        sendEvent('clipboard_content_detected', 'high', { length: content.length, preview: content.substring(0, 40) })
      }
    }
    document.addEventListener('paste', clipHandler, true)
    listenerRef.current.push({ target: document, event: 'paste', handler: clipHandler })

    /* ── typing biometrics ── */
    const typingState = { keyTimes: [], lastKeyAt: 0, burstCount: 0, avgInterval: null }
    const typingHandler = (e) => {
      if (!e.key || e.key.length > 1) return
      const now = Date.now()
      if (typingState.lastKeyAt) {
        const gap = now - typingState.lastKeyAt
        typingState.keyTimes.push(gap)
        if (typingState.keyTimes.length > 200) typingState.keyTimes.shift()
        if (typingState.keyTimes.length >= 20 && !typingState.avgInterval) {
          typingState.avgInterval = typingState.keyTimes.reduce((a, b) => a + b, 0) / typingState.keyTimes.length
        }
        if (typingState.avgInterval && gap < 15) {
          typingState.burstCount += 1
          if (typingState.burstCount >= 8) {
            recordFlag('Typing anomaly: paste-like burst')
            sendEvent('typing_anomaly_detected', 'high', { reason: 'paste_like_burst', burst: typingState.burstCount })
            typingState.burstCount = 0
          }
        } else { typingState.burstCount = 0 }
      }
      typingState.lastKeyAt = now
    }
    window.addEventListener('keydown', typingHandler)
    listenerRef.current.push({ target: window, event: 'keydown', handler: typingHandler })

    /* ── IP geofencing ── */
    let initialIp = null
    async function checkIp() {
      try {
        const resp = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
        const data = await resp.json()
        if (!data?.ip) return
        if (!initialIp) { initialIp = data.ip; sendEvent('ip_recorded', 'low', { ip: data.ip }) }
        else if (data.ip !== initialIp) {
          recordFlag('IP address changed mid-exam')
          sendEvent('ip_changed', 'high', { initial: initialIp, current: data.ip })
        }
      } catch { /* */ }
    }
    void checkIp()
    const ipId = setInterval(checkIp, 60000)
    intervalsRef.current.push(ipId)

    /* ── periodic screenshot capture ── */
    function scheduleScreenshot() {
      const delay = 30000 + Math.floor(Math.random() * 60000)
      const tid = setTimeout(async () => {
        try {
          const v = primaryVideoRef.current; const c = frameCanvasRef.current
          if (v && c && v.videoWidth && v.videoHeight) {
            const ctx = c.getContext('2d'); c.width = v.videoWidth; c.height = v.videoHeight; ctx.drawImage(v, 0, 0, c.width, c.height)
            const img = c.toDataURL('image/jpeg', 0.5)
            await assessmentApi.logEvent({ session_code: currentSessionCode, event_type: 'screenshot_captured', severity: 'low', payload: { timestamp: new Date().toISOString(), image_base64: img } })
          }
        } catch { /* */ }
        scheduleScreenshot()
      }, delay)
      intervalsRef.current.push(tid)
    }
    scheduleScreenshot()
  }

  async function captureSelfieFromPrimaryCamera() {
    if (!primaryVideoRef.current || primaryVideoRef.current.videoWidth === 0 || primaryVideoRef.current.videoHeight === 0) {
      setError('Primary camera is not ready yet. Please allow camera access and retry.')
      return
    }

    const canvas = captureCanvasRef.current
    const ctx = canvas.getContext('2d')
    canvas.width = primaryVideoRef.current.videoWidth
    canvas.height = primaryVideoRef.current.videoHeight
    ctx.drawImage(primaryVideoRef.current, 0, 0, canvas.width, canvas.height)
    setSelfieImageBase64(canvas.toDataURL('image/jpeg', 0.85))
    setIdentityCheck(null)
    setIdentityVerified(false)
    setInfo('Live selfie captured. Upload ID image and verify.')
  }

  async function onIdUpload(event) {
    const file = event.target.files?.[0]
    if (!file) return

    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image file for government ID.')
      setIdImageBase64('')
      setIdImageName('')
      return
    }
    if (file.size > MAX_ID_UPLOAD_BYTES) {
      setError('Government ID image is too large. Please upload an image under 8MB.')
      setIdImageBase64('')
      setIdImageName('')
      return
    }

    const asDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = () => reject(new Error('Unable to read ID image'))
      reader.readAsDataURL(file)
    })

    setIdImageBase64(String(asDataUrl))
    setIdImageName(file.name)
    setIdentityCheck(null)
    setIdentityVerified(false)
    setError('')
    setInfo('Government ID image uploaded. Capture selfie and run verification.')
  }

  async function verifyIdentityBeforeExam() {
    if (!sessionCode) return
    if (!idImageBase64) {
      setError('Upload an ID image first.')
      return
    }
    if (!selfieImageBase64) {
      setError('Capture a live selfie from the primary camera first.')
      return
    }

    setError('')
    setVerifyingIdentity(true)
    try {
      const verifyResult = await assessmentApi.verifyCandidateIdentity({
        session_code: sessionCode,
        id_image_base64: idImageBase64,
        selfie_image_base64: selfieImageBase64,
      })
      setIdentityCheck(verifyResult)
      setIdentityVerified(Boolean(verifyResult.verified))
      if (verifyResult.verified) {
        setInfo('Identity verified. You can now begin the exam.')
      } else {
        setError(`Identity verification failed: ${(verifyResult.flags || []).join(', ') || 'unknown reason'}`)
      }
    } catch (err) {
      setError(err.message || 'Identity verification failed')
    } finally {
      setVerifyingIdentity(false)
    }
  }

  async function beginExam() {
    if (!exam || !sessionCode) return
    if (!identityVerified) {
      setError('Face + ID verification is mandatory before starting the exam.')
      return
    }

    setError('')
    try {
      await startMonitoring(sessionCode)
      setRunning(true)
      setInfo('Exam started. Proctoring is active on primary camera.')
    } catch (err) {
      setError(err.message || 'Unable to start exam monitoring')
      stopAllMonitoring()
    }
  }

  async function handleSubmit(auto = false, customMessage = '') {
    if (!sessionCode || !exam || result) return

    try {
      const payload = exam.questions.map((q) => ({ question_id: q.id, answer: answers[q.id] || '' }))
      const submitted = await assessmentApi.submitExam(sessionCode, payload)
      setResult(submitted)
      stopAllMonitoring()
      stopPreviewCamera()
      setInfo(customMessage || (auto ? 'Exam auto-submitted.' : 'Exam submitted successfully.'))
    } catch (err) {
      setError(err.message)
      closingPolicyRef.current = false
    }
  }

  function formatTime(seconds) {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }

  return (
    <div className="container">
      <h1>SmartHire Examination Portal</h1>

      {error && <div className="card warn">{error}</div>}
      {info && <div className="card success">{info}</div>}

      <div className="grid">
        <div className="card">
          <h2>Admin: Create Exam (JD-based)</h2>
          <form onSubmit={createExam}>
            <label>Job Description (from jobs table)</label>
            <select
              value={form.job_id}
              onChange={(e) => setForm((prev) => ({ ...prev, job_id: e.target.value }))}
              required
            >
              <option value="">Select job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  #{job.id} - {job.title}
                </option>
              ))}
            </select>

            <label>Candidate Name</label>
            <input
              value={form.candidate_name}
              onChange={(e) => setForm((prev) => ({ ...prev, candidate_name: e.target.value }))}
              required
            />

            <label>Candidate Email</label>
            <input
              type="email"
              value={form.candidate_email}
              onChange={(e) => setForm((prev) => ({ ...prev, candidate_email: e.target.value }))}
              required
            />

            <label>Difficulty</label>
            <select
              value={form.difficulty}
              onChange={(e) => setForm((prev) => ({ ...prev, difficulty: e.target.value }))}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>

            <label>Question Count</label>
            <input
              type="number"
              min="5"
              max="30"
              value={form.question_count}
              onChange={(e) => setForm((prev) => ({ ...prev, question_count: Number(e.target.value) }))}
            />

            <label>Duration (minutes)</label>
            <input
              type="number"
              min="10"
              max="180"
              value={form.duration_minutes}
              onChange={(e) => setForm((prev) => ({ ...prev, duration_minutes: Number(e.target.value) }))}
            />

            <button type="submit">Generate Exam</button>
          </form>
        </div>

        <div className="card">
          <h2>Candidate: Join Exam</h2>
          <form onSubmit={handleAccessExam}>
            <label>Session Code</label>
            <input
              value={sessionCodeInput}
              onChange={(e) => setSessionCodeInput(e.target.value.toUpperCase())}
              placeholder="EXAM-XXXXXXXXXX"
              required
            />
            <button type="submit">Prepare Exam</button>
          </form>

          <p>
            <span className="tag">Anti-cheat active</span>
            primary camera + multiple-face detection + object detection + liveness + audio + strict tab policy
          </p>

          {running && <h3>Time Left: {formatTime(timeLeft)}</h3>}
        </div>
      </div>

      {exam && (
        <>
          <div className="card">
            <h2>Mandatory Verification Before Start</h2>
            <p>Step 1: Keep your face clearly visible in primary camera.</p>
            <p>Step 2: Upload a clear government ID image (not selfie screenshot).</p>
            <p>Step 3: Capture live selfie and run Face-ID verification.</p>

            <video ref={primaryVideoRef} autoPlay muted playsInline />
            <canvas ref={captureCanvasRef} style={{ display: 'none' }} />

            <div style={{ marginTop: 12 }}>
              <button type="button" onClick={captureSelfieFromPrimaryCamera}>
                Capture Live Selfie
              </button>
            </div>

            <div style={{ marginTop: 12 }}>
              <label>Upload Government ID Image</label>
              <input type="file" accept="image/*" onChange={onIdUpload} />
              {idImageName ? <p>ID file: {idImageName}</p> : null}
              {selfieImageBase64 ? <p>Selfie captured ✅</p> : null}
            </div>

            <button
              type="button"
              style={{ marginTop: 12 }}
              onClick={verifyIdentityBeforeExam}
              disabled={verifyingIdentity || !idImageBase64 || !selfieImageBase64}
            >
              {verifyingIdentity ? 'Verifying...' : 'Verify Face + ID'}
            </button>

            {identityCheck ? (
              <>
                <p>
                  Verification: {identityCheck.verified ? 'Passed ✅' : 'Failed ❌'}
                  {identityCheck.similarity !== null ? ` | Similarity: ${identityCheck.similarity}` : ''}
                  {identityCheck?.flags?.length ? ` | Flags: ${identityCheck.flags.join(', ')}` : ''}
                </p>
                <p>
                  Gov ID uploaded: {identityCheck.government_id_uploaded ? 'Yes' : 'No'}
                  {` | ID confidence: ${identityCheck.id_document_confidence ?? 0}`}
                  {` | Face quality: ${identityCheck.face_quality_score ?? 0}`}
                </p>
              </>
            ) : null}

            <button onClick={beginExam} disabled={running || !identityVerified} style={{ marginTop: 12 }}>
              {running ? 'Exam Running' : 'Begin Exam'}
            </button>
            {!identityVerified && !running ? <p className="warn">Verification is required before exam start.</p> : null}
          </div>

          {running && (
            <>
              <div className="card">
                <h2>Primary Proctoring Stream</h2>
                <video ref={primaryVideoRef} autoPlay muted playsInline />
                <canvas ref={frameCanvasRef} style={{ display: 'none' }} />
              </div>

              <div className="card">
                <h2>Questions</h2>
                {exam.questions.map((q) => (
                  <div className="question" key={q.id}>
                    <strong>
                      Q{q.id}. {q.question}
                    </strong>
                    {q.options.map((opt) => (
                      <label className="option" key={`${q.id}-${opt}`}>
                        <input
                          type="radio"
                          name={`q-${q.id}`}
                          checked={answers[q.id] === opt}
                          onChange={() => onAnswer(q.id, opt)}
                        />
                        {opt}
                      </label>
                    ))}
                  </div>
                ))}
                <button onClick={() => handleSubmit(false)} disabled={Boolean(result)}>
                  Submit Exam
                </button>
              </div>
            </>
          )}

          <div className="card">
            <h2>Anti-Cheat Events (latest)</h2>
            {livenessPrompt ? <p className="tag">{livenessPrompt}</p> : null}
            {antiCheatFlags.length === 0 ? (
              <p>No flags yet.</p>
            ) : (
              antiCheatFlags.map((flag, idx) => <p className="warn" key={`${flag}-${idx}`}>• {flag}</p>)
            )}
          </div>
        </>
      )}

      {result && (
        <div className="card">
          <h2>Result</h2>
          <p>
            Final score: <strong>{scoreText}</strong>
          </p>
          <p>Status: {result.status}</p>
        </div>
      )}
    </div>
  )
}

export default App
