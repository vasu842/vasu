import React, { useState, useRef, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

// ---------------- CONFIG ----------------
const SVPCET_LAT = 13.6288;
const SVPCET_LNG = 79.4192;
const MAX_RADIUS_KM = 0.5;
const DEV_BYPASS_GPS = true; // set to false in production
const MODEL_URL = '/models'; // face-api model files go in public/models
const MATCH_THRESHOLD = 0.5; // lower = stricter

// ---------------- STUDENTS ----------------
const INITIAL_STUDENTS = [
  { rollNo: '25G01A4370', name: 'Vasudeva', presentDays: 0, absentDays: 0 },
  { rollNo: '23SV1A3101', name: 'Aarav Sharma', presentDays: 18, absentDays: 2 },
  { rollNo: '23SV1A3102', name: 'Bhavya Reddy', presentDays: 19, absentDays: 1 },
  { rollNo: '23SV1A3103', name: 'Chaitanya Kumar', presentDays: 15, absentDays: 5 },
];

// ---------------- REGISTRATION POSES ----------------
const POSES = [
  { key: 'front', label: 'Look straight at the camera', ok: (p) => p.yaw > 0.42 && p.yaw < 0.58 && p.pitch > 0.4 && p.pitch < 0.58, threshold: 0.5 },
  { key: 'left', label: 'Turn your face to the LEFT', ok: (p) => p.yaw > 0.65, threshold: 0.6 },
  { key: 'right', label: 'Turn your face to the RIGHT', ok: (p) => p.yaw < 0.35, threshold: 0.6 },
  { key: 'up', label: 'Look UP', ok: (p) => p.pitch < 0.38 && p.yaw > 0.3 && p.yaw < 0.7, threshold: 0.6 },
  { key: 'down', label: 'Look DOWN', ok: (p) => p.pitch > 0.64 && p.yaw > 0.3 && p.yaw < 0.7, threshold: 0.6 },
];

const getPose = (landmarks) => {
  const pts = landmarks.positions;
  const nose = pts[30], jawL = pts[0], jawR = pts[16], chin = pts[8];
  const eyeY = (pts[36].y + pts[45].y) / 2;
  return {
    yaw: (nose.x - jawL.x) / (jawR.x - jawL.x),
    pitch: (nose.y - eyeY) / (chin.y - eyeY),
  };
};

// Eye aspect ratio (for blink / liveness). start = 36 (one eye) or 42 (other eye)
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const eyeEAR = (pts, s) => (dist(pts[s + 1], pts[s + 5]) + dist(pts[s + 2], pts[s + 4])) / (2 * dist(pts[s], pts[s + 3]));
const getEAR = (landmarks) => {
  const pts = landmarks.positions;
  return (eyeEAR(pts, 36) + eyeEAR(pts, 42)) / 2;
};

// ---------------- STORAGE HELPERS ----------------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));

// Academic year runs June -> May (e.g. 2026-27)
const academicYear = () => {
  const d = new Date();
  const y = d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
// Face data is kept for ONE academic year only; older registrations are deleted automatically
const loadFaces = () => {
  const all = load('svpcet_faces', {});
  const kept = {};
  Object.entries(all).forEach(([roll, v]) => { if (v && v.ay === academicYear()) kept[roll] = v; });
  if (Object.keys(kept).length !== Object.keys(all).length) save('svpcet_faces', kept);
  return kept;
};
const today = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [role, setRole] = useState(null); // 'student' | 'hod'
  const [students, setStudents] = useState(() => load('svpcet_students', INITIAL_STUDENTS));
  const [bulkText, setBulkText] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [rollNo, setRollNo] = useState('');
  const [password, setPassword] = useState('');
  const [showPolicy, setShowPolicy] = useState(false);
  const [consent, setConsent] = useState(false);

  const [locationVerified, setLocationVerified] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [modelsReady, setModelsReady] = useState(false);

  // registration / verification scan state
  const [mode, setMode] = useState(null); // 'enroll' | 'verify' | null
  const [stepIndex, setStepIndex] = useState(0);
  const [stepsDone, setStepsDone] = useState([]);

  // HOD state
  const [tab, setTab] = useState('overview'); // 'overview' | 'register' | 'kiosk'
  const [regRoll, setRegRoll] = useState(null);
  const [regConsent, setRegConsent] = useState(false);

  // kiosk (class attendance) state
  const [kioskOn, setKioskOn] = useState(false);
  const [kioskMsg, setKioskMsg] = useState('');
  const [ring, setRing] = useState(0);
  const [popup, setPopup] = useState(null); // {roll, name, already}
  const [syncMsg, setSyncMsg] = useState('');

  // persisted data
  const [faces, setFaces] = useState(loadFaces); // {roll: {ay, poses:{front,left,right,up,down}}}
  const [logs, setLogs] = useState(() => load('svpcet_logs', {})); // {roll: {date: 'PRESENT'|'ABSENT'}}

  // refs (used inside timers so they never see stale state)
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const stepRef = useRef(0);
  const capturedRef = useRef({});
  const mismatchRef = useRef(0);
  const stepStartRef = useRef(0);
  const targetRef = useRef(null);   // roll number being registered / verified
  const sourceRef = useRef('student'); // 'student' | 'hod'
  const kioskRef = useRef({ busy: false, cooldown: false, sawOpen: false, sawClosed: false, blinked: false });
  const facesRef = useRef(faces);
  const studentsRef = useRef(students);
  const logsRef = useRef(logs);
  facesRef.current = faces;
  studentsRef.current = students;
  logsRef.current = logs;

  // load face models once
  useEffect(() => {
    (async () => {
      try {
        await Promise.all([
          faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
          faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
          faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
        ]);
        setModelsReady(true);
      } catch (e) {
        console.error('Model load error', e);
        setStatusMessage('Face models not found in /public/models');
      }
    })();
    return () => stopCamera();
  }, []);

  const calculateDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLon = (lon2 - lon1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  // ---------- Login ----------
  const handleLogin = (e) => {
    e.preventDefault();
    const id = rollNo.trim().toUpperCase();
    if (id === 'HOD' && password === 'admin123') {
      setRole('hod');
      setCurrentUser({ name: 'Head of Department (AI)' });
      return;
    }
    const student = students.find((s) => s.rollNo === id);
    if (student && password === 'student123') {
      setRole('student');
      setCurrentUser(student);
      verifyLocation();
    } else {
      alert('Invalid Roll Number or Password!');
    }
  };

  const logout = () => {
    stopCamera();
    setRole(null); setCurrentUser(null); setMode(null);
    setKioskOn(false); setRegRoll(null); setTab('overview'); setPopup(null);
    setLocationVerified(false); setStepsDone([]); setStatusMessage('');
    setRollNo(''); setPassword('');
  };

  const changeTab = (t) => {
    stopCamera();
    setMode(null); setKioskOn(false); setRegRoll(null); setPopup(null);
    setStepsDone([]); setStatusMessage(''); setKioskMsg('');
    setTab(t);
  };

  // ---------- GPS geofence (student self-service) ----------
  const verifyLocation = () => {
    setStatusMessage('Checking campus GPS location...');
    if (DEV_BYPASS_GPS) {
      setLocationVerified(true);
      setStatusMessage('Location check skipped (dev mode).');
      return;
    }
    if (!navigator.geolocation) {
      setStatusMessage('GPS not supported on this device.');
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const d = calculateDistance(pos.coords.latitude, pos.coords.longitude, SVPCET_LAT, SVPCET_LNG);
        if (d <= MAX_RADIUS_KM) {
          setLocationVerified(true);
          setStatusMessage('Location Verified: Inside SVPCET Campus.');
        } else {
          setLocationVerified(false);
          setStatusMessage('Error: You are outside the SVPCET Campus boundary.');
        }
      },
      () => {
        setLocationVerified(false);
        setStatusMessage('Please allow location access to mark attendance.');
      }
    );
  };

  // ---------- Camera ----------
  const startCamera = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
    streamRef.current = stream;
    videoRef.current.srcObject = stream;
    await videoRef.current.play();
  };

  const stopCamera = () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // ---------- Attendance writes ----------
  const markFor = (roll, status) => {
    const d = today();
    setLogs((prev) => {
      if (prev[roll]?.[d] === 'PRESENT') return prev; // never downgrade
      const updated = { ...prev, [roll]: { ...(prev[roll] || {}), [d]: status } };
      save('svpcet_logs', updated);
      return updated;
    });
  };

  // Faculty "sync": anyone not scanned today is recorded ABSENT
  const finalizeDay = () => {
    const d = today();
    let count = 0;
    setLogs((prev) => {
      const u = { ...prev };
      studentsRef.current.forEach((s) => {
        if (!u[s.rollNo]?.[d]) { u[s.rollNo] = { ...(u[s.rollNo] || {}), [d]: 'ABSENT' }; count += 1; }
      });
      save('svpcet_logs', u);
      return u;
    });
    setSyncMsg(`Attendance saved for ${d}. Students not scanned are recorded ABSENT.`);
  };

  // =====================================================
  //  A) REGISTRATION (5 angles) and STUDENT SELF-VERIFY
  // =====================================================
  const startScan = async (roll, source, forceEnroll = false) => {
    if (!modelsReady) return setStatusMessage('Face models are still loading...');
    const isEnrolled = !!facesRef.current[roll] && !forceEnroll;
    targetRef.current = roll;
    sourceRef.current = source;
    try {
      setMode(isEnrolled ? 'verify' : 'enroll');
      setStepsDone([]);
      setStepIndex(0);
      stepRef.current = 0;
      capturedRef.current = {};
      mismatchRef.current = 0;
      stepStartRef.current = Date.now();
      await new Promise((r) => setTimeout(r, 50)); // let <video> mount
      await startCamera();
      setStatusMessage(POSES[0].label);
      timerRef.current = setInterval(() => scanFrame(isEnrolled), 450);
    } catch (err) {
      console.error(err);
      setMode(null);
      setStatusMessage('Camera access denied or unavailable.');
    }
  };

  const failScan = (reason) => {
    stopCamera();
    setMode(null);
    if (sourceRef.current === 'student') {
      markFor(targetRef.current, 'ABSENT');
      setStatusMessage(`Verification failed: ${reason}. Marked ABSENT - you can try again.`);
    } else {
      setStatusMessage(`Registration failed: ${reason}. Please try again.`);
    }
  };

  const scanFrame = async (isEnrolled) => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const i = stepRef.current;
    const pose = POSES[i];
    const roll = targetRef.current;

    if (Date.now() - stepStartRef.current > 25000) return failScan('timed out');

    const results = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (results.length === 0) return setStatusMessage(`No face found. ${pose.label}`);
    if (results.length > 1) return setStatusMessage('Only ONE face allowed in the camera.');

    const { landmarks, descriptor } = results[0];
    if (!pose.ok(getPose(landmarks))) return setStatusMessage(pose.label);

    if (isEnrolled) {
      const me = facesRef.current[roll]?.poses?.[pose.key];
      const myDist = me ? faceapi.euclideanDistance(descriptor, me) : 99;

      // the face must belong to THIS roll number and to no other roll number
      let bestRoll = null, bestDist = 99;
      Object.entries(facesRef.current).forEach(([r, v]) => {
        const ref = v.poses?.[pose.key];
        if (ref) {
          const d = faceapi.euclideanDistance(descriptor, ref);
          if (d < bestDist) { bestDist = d; bestRoll = r; }
        }
      });

      if (myDist > pose.threshold || bestRoll !== roll) {
        mismatchRef.current += 1;
        setStatusMessage('Face does not match this roll number...');
        if (mismatchRef.current >= 6) failScan('face does not match roll number');
        return;
      }
    }

    capturedRef.current[pose.key] = Array.from(descriptor);
    mismatchRef.current = 0;
    setStepsDone((s) => [...s, pose.key]);

    if (i + 1 < POSES.length) {
      stepRef.current = i + 1;
      stepStartRef.current = Date.now();
      setStepIndex(i + 1);
      setStatusMessage(`${pose.key.toUpperCase()} done. ${POSES[i + 1].label}`);
    } else {
      finishScan(isEnrolled);
    }
  };

  const finishScan = (isEnrolled) => {
    stopCamera();
    setMode(null);
    const roll = targetRef.current;
    if (!isEnrolled) {
      const updated = { ...facesRef.current, [roll]: { ay: academicYear(), poses: capturedRef.current } };
      setFaces(updated);
      save('svpcet_faces', updated);
      setRegConsent(false);
      setConsent(false);
      setStatusMessage(
        sourceRef.current === 'hod'
          ? `Face registered for ${roll}. Next student can register.`
          : 'Face registered for your roll number. Scan again to mark attendance.'
      );
      if (sourceRef.current === 'hod') setRegRoll(null);
      return;
    }
    markFor(roll, 'PRESENT');
    setStatusMessage('Face verified from all sides! Attendance marked PRESENT.');
  };

  const deleteFace = (roll) => {
    if (!window.confirm(`Delete registered face data for ${roll}? Registration must be done again.`)) return;
    const updated = { ...facesRef.current };
    delete updated[roll];
    setFaces(updated);
    save('svpcet_faces', updated);
    setConsent(false);
    setStatusMessage('Face data deleted.');
  };

  // =====================================================
  //  B) CLASS ATTENDANCE KIOSK (blink -> match -> popup -> next student)
  // =====================================================
  const resetKioskCycle = () => {
    const k = kioskRef.current;
    k.sawOpen = false; k.sawClosed = false; k.blinked = false;
    setRing(0);
  };

  const startKiosk = async () => {
    if (!modelsReady) return setKioskMsg('Face models are still loading...');
    if (Object.keys(facesRef.current).length === 0) return setKioskMsg('No registered faces yet. Register students first.');
    try {
      setSyncMsg('');
      setKioskOn(true);
      kioskRef.current = { busy: false, cooldown: false, sawOpen: false, sawClosed: false, blinked: false };
      setRing(0);
      await new Promise((r) => setTimeout(r, 50));
      await startCamera();
      setKioskMsg('SLOWLY BLINK YOUR EYES');
      timerRef.current = setInterval(kioskFrame, 150);
    } catch (err) {
      console.error(err);
      setKioskOn(false);
      setKioskMsg('Camera access denied or unavailable.');
    }
  };

  const stopKiosk = () => {
    stopCamera();
    setKioskOn(false);
    setPopup(null);
    setKioskMsg('');
  };

  const kioskFrame = async () => {
    const k = kioskRef.current;
    const video = videoRef.current;
    if (k.busy || k.cooldown || !video || video.readyState < 2) return;
    k.busy = true;
    try {
      const res = await faceapi
        .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
        .withFaceLandmarks()
        .withFaceDescriptors();

      if (res.length !== 1) {
        setKioskMsg(res.length ? 'ONE STUDENT AT A TIME' : 'SHOW YOUR FACE');
        resetKioskCycle();
        return;
      }
      const { landmarks, descriptor } = res[0];
      const pose = getPose(landmarks);
      if (pose.yaw < 0.35 || pose.yaw > 0.65) {
        setKioskMsg('LOOK STRAIGHT AT THE CAMERA');
        return;
      }

      // Step 1: liveness - a full blink (open -> closed -> open)
      if (!k.blinked) {
        const ear = getEAR(landmarks);
        setRing(0.25);
        setKioskMsg('SLOWLY BLINK YOUR EYES');
        if (ear > 0.26) {
          if (k.sawClosed) k.blinked = true; else k.sawOpen = true;
        } else if (ear < 0.21 && k.sawOpen) {
          k.sawClosed = true;
        }
        return;
      }

      // Step 2: recognise this face against every registered student (1:N)
      setRing(0.7);
      setKioskMsg('MATCHING...');
      let bestRoll = null, bestDist = 99;
      Object.entries(facesRef.current).forEach(([roll, v]) => {
        const ref = v.poses?.front;
        if (ref) {
          const d = faceapi.euclideanDistance(descriptor, ref);
          if (d < bestDist) { bestDist = d; bestRoll = roll; }
        }
      });

      k.cooldown = true;
      if (bestRoll && bestDist < MATCH_THRESHOLD) {
        const st = studentsRef.current.find((s) => s.rollNo === bestRoll);
        const already = logsRef.current[bestRoll]?.[today()] === 'PRESENT';
        markFor(bestRoll, 'PRESENT');
        setRing(1);
        setPopup({ roll: bestRoll, name: st ? st.name : bestRoll, already });
        setTimeout(() => {
          setPopup(null);
          resetKioskCycle();
          setKioskMsg('NEXT STUDENT - SLOWLY BLINK YOUR EYES');
          k.cooldown = false;
        }, 3000);
      } else {
        setRing(0);
        setPopup({ roll: null, name: null, failed: true });
        setTimeout(() => {
          setPopup(null);
          resetKioskCycle();
          setKioskMsg('SLOWLY BLINK YOUR EYES');
          k.cooldown = false;
        }, 2500);
      }
    } finally {
      k.busy = false;
    }
  };

  // =====================================================
  //  C) HOD: add students in bulk
  // =====================================================
  const addStudents = () => {
    const existing = new Set(students.map((s) => s.rollNo));
    const added = [];
    bulkText.split('\n').forEach((line) => {
      const parts = line.trim().split(/[,\t]+|\s{2,}|\s(?=[A-Za-z])/);
      const roll = (parts[0] || '').trim().toUpperCase();
      const name = parts.slice(1).join(' ').trim();
      if (roll && name && !existing.has(roll)) {
        existing.add(roll);
        added.push({ rollNo: roll, name, presentDays: 0, absentDays: 0 });
      }
    });
    if (!added.length) return alert('No new students found. Use one per line: ROLLNO, Name');
    const updated = [...students, ...added];
    setStudents(updated);
    save('svpcet_students', updated);
    setBulkText('');
    alert(`${added.length} students added.`);
  };

  // ---------- Derived values ----------
  const stats = (s) => {
    const l = Object.values(logs[s.rollNo] || {});
    const present = s.presentDays + l.filter((x) => x === 'PRESENT').length;
    const absent = s.absentDays + l.filter((x) => x === 'ABSENT').length;
    const total = present + absent;
    return { present, absent, pct: total ? ((present / total) * 100).toFixed(1) : null };
  };
  const todayStatus = (roll) => logs[roll]?.[today()] || 'ABSENT';
  const isPresentToday = (roll) => logs[roll]?.[today()] === 'PRESENT';

  const markedToday = currentUser && role === 'student' && isPresentToday(currentUser.rollNo);
  const enrolled = currentUser && role === 'student' && !!faces[currentUser.rollNo];
  const presentCount = students.filter((s) => isPresentToday(s.rollNo)).length;

  // ---------- Small UI pieces ----------
  const PoseChips = () => (
    <div className="flex gap-2 flex-wrap justify-center">
      {POSES.map((p, i) => (
        <span
          key={p.key}
          className={`px-3 py-1 rounded-full text-xs font-bold ${
            stepsDone.includes(p.key) ? 'bg-green-100 text-green-800'
              : i === stepIndex ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {stepsDone.includes(p.key) ? '✓ ' : ''}{p.key.toUpperCase()}
        </span>
      ))}
    </div>
  );

  const RectCamera = () => (
    <div className="flex flex-col items-center gap-3 mb-4">
      <div className="w-72 h-56 bg-black rounded-lg overflow-hidden border-2 border-blue-500">
        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
      </div>
      <PoseChips />
    </div>
  );

  const CIRC = 295.3;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      <header className="bg-blue-900 text-white py-4 px-6 shadow-md flex justify-between items-center">
        <div>
          <h1 className="text-xl font-bold">SVPCET Attendance Portal</h1>
          <p className="text-xs text-blue-200">Department of AI - R23 Batch</p>
        </div>
        {role && (
          <button onClick={logout} className="bg-red-500 hover:bg-red-600 px-3 py-1.5 rounded text-sm font-semibold transition">
            Logout
          </button>
        )}
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto p-6">
        {/* ================= LOGIN ================= */}
        {!role ? (
          <div className="bg-white p-8 rounded-xl shadow-lg border border-slate-200 max-w-md mx-auto mt-10">
            <h2 className="text-2xl font-bold text-center text-slate-800 mb-6">Portal Sign In</h2>
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1">Roll No / ID</label>
                <input
                  type="text" required placeholder="e.g. 25G01A4370 or HOD"
                  value={rollNo} onChange={(e) => setRollNo(e.target.value)}
                  className="w-full border border-slate-300 p-2.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-600 mb-1">Password</label>
                <input
                  type="password" required placeholder="••••••••"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full border border-slate-300 p-2.5 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <button type="submit" className="w-full bg-blue-700 hover:bg-blue-800 text-white font-bold py-2.5 rounded-lg transition">
                Login to Portal
              </button>
            </form>
            <p className="text-center text-xs text-slate-500 mt-4">
              <button onClick={() => setShowPolicy(true)} className="text-blue-700 underline">Privacy Policy (Face Data)</button>
            </p>
          </div>

        ) : role === 'student' ? (
          /* ================= STUDENT ================= */
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200 flex justify-between items-center">
              <div>
                <h2 className="text-xl font-bold text-slate-800">{currentUser.name}</h2>
                <p className="text-sm text-slate-500">Roll No: {currentUser.rollNo} | Branch: AI (R23)</p>
              </div>
              <div className="flex gap-4 text-center">
                <div className="bg-green-100 text-green-800 px-4 py-2 rounded-lg font-bold">
                  {stats(currentUser).present} Days
                  <span className="block text-xs font-normal">Present</span>
                </div>
                <div className="bg-red-100 text-red-800 px-4 py-2 rounded-lg font-bold">
                  {stats(currentUser).absent} Days
                  <span className="block text-xs font-normal">Absent</span>
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200 text-center">
              <h3 className="text-lg font-bold text-slate-800 mb-2">
                {enrolled ? 'Daily Face Attendance (Front, Left, Right, Up, Down)' : 'First-time Face Registration'}
              </h3>
              <p className="text-sm text-slate-600 mb-4">{statusMessage}</p>

              {markedToday ? (
                <div className="p-4 bg-green-50 text-green-700 rounded-lg font-semibold border border-green-200">
                  Today's attendance: PRESENT
                </div>
              ) : (
                <>
                  {mode && <RectCamera />}

                  {!enrolled && !mode && (
                    <label className="flex items-start gap-2 justify-center text-xs text-slate-600 mb-3 text-left max-w-sm mx-auto">
                      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
                      <span>
                        I agree to the capture of my face images (front, left, right, up, down) for attendance, as described in the{' '}
                        <button type="button" onClick={() => setShowPolicy(true)} className="text-blue-700 underline">Privacy Policy</button>.
                      </span>
                    </label>
                  )}

                  {locationVerified && !mode && (
                    <button
                      onClick={() => startScan(currentUser.rollNo, 'student')}
                      disabled={!modelsReady || (!enrolled && !consent)}
                      className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 text-white font-bold px-6 py-2.5 rounded-lg transition"
                    >
                      {!modelsReady ? 'Loading face models...' : enrolled ? 'Start Face Scan & Mark Attendance' : 'Register My Face'}
                    </button>
                  )}

                  {enrolled && !mode && (
                    <p className="mt-3 text-xs text-slate-500">
                      Face registered for {faces[currentUser.rollNo].ay}.{' '}
                      <button onClick={() => deleteFace(currentUser.rollNo)} className="text-red-600 underline">Delete my face data</button>
                    </p>
                  )}
                  <p className="mt-3 text-xs text-slate-500">
                    Today's status: <b className={isPresentToday(currentUser.rollNo) ? 'text-green-700' : 'text-red-600'}>
                      {todayStatus(currentUser.rollNo)}
                    </b>
                  </p>
                </>
              )}
            </div>
          </div>

        ) : (
          /* ================= HOD / FACULTY ================= */
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
              <h2 className="text-xl font-bold text-slate-800 mb-1">HOD Monitoring Control Panel</h2>
              <p className="text-sm text-slate-500 mb-4">Department of AI - R23 Batch</p>
              <div className="flex gap-2 flex-wrap">
                {[
                  ['overview', 'Students & Reports'],
                  ['register', 'Face Registration'],
                  ['kiosk', 'Take Class Attendance'],
                ].map(([key, label]) => (
                  <button
                    key={key} onClick={() => changeTab(key)}
                    className={`px-4 py-2 rounded-lg text-sm font-semibold transition ${
                      tab === key ? 'bg-blue-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                    }`}
                  >{label}</button>
                ))}
              </div>
            </div>

            {/* ---------- TAB: OVERVIEW ---------- */}
            {tab === 'overview' && (
              <>
                <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Add All Students</h3>
                  <p className="text-xs text-slate-500 mb-3">Paste one student per line: ROLLNO, Name (copy from Excel works too). Default password: student123</p>
                  <textarea
                    rows={5} value={bulkText} onChange={(e) => setBulkText(e.target.value)}
                    placeholder={'25G01A4371, Student Name\n25G01A4372, Student Name'}
                    className="w-full border border-slate-300 p-2.5 rounded-lg font-mono text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button onClick={addStudents} className="mt-2 bg-blue-700 hover:bg-blue-800 text-white font-bold px-5 py-2 rounded-lg transition">
                    Add Students
                  </button>
                  <p className="mt-3 text-sm text-slate-600">
                    Total: <b>{students.length}</b> | Present today: <b className="text-green-700">{presentCount}</b> | Absent today: <b className="text-red-600">{students.length - presentCount}</b>
                  </p>
                </div>

                <div className="bg-white rounded-xl shadow-md border border-slate-200 overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="bg-slate-100 border-b border-slate-200 text-slate-600 text-sm">
                        <th className="p-4">Roll Number</th>
                        <th className="p-4">Student Name</th>
                        <th className="p-4">Present</th>
                        <th className="p-4">Absent</th>
                        <th className="p-4">Rate</th>
                        <th className="p-4">Today</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 text-sm">
                      {students.map((s) => {
                        const st = stats(s);
                        const t = todayStatus(s.rollNo);
                        return (
                          <tr key={s.rollNo} className="hover:bg-slate-50">
                            <td className="p-4 font-mono font-semibold text-blue-700">{s.rollNo}</td>
                            <td className="p-4 font-medium">{s.name}</td>
                            <td className="p-4 text-green-600 font-bold">{st.present}</td>
                            <td className="p-4 text-red-600 font-bold">{st.absent}</td>
                            <td className="p-4">
                              {st.pct === null ? '—' : (
                                <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                  Number(st.pct) >= 75 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                                }`}>{st.pct}%</span>
                              )}
                            </td>
                            <td className="p-4">
                              <span className={`px-2.5 py-1 rounded-full text-xs font-bold ${
                                t === 'PRESENT' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'
                              }`}>{t}</span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {/* ---------- TAB: FACE REGISTRATION (all students) ---------- */}
            {tab === 'register' && (
              <>
                <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Face Registration</h3>
                  <p className="text-xs text-slate-500 mb-4">
                    Pick a student, get their consent, then they look front, left, right, up and down in front of the camera.
                    Registered: <b>{students.filter((s) => faces[s.rollNo]).length}</b> / {students.length}
                  </p>

                  {regRoll && (
                    <div className="border border-blue-200 bg-blue-50 rounded-lg p-4 mb-4 text-center">
                      <p className="font-bold text-slate-800 mb-1">
                        {students.find((s) => s.rollNo === regRoll)?.name} ({regRoll})
                      </p>
                      <p className="text-sm text-slate-600 mb-3">{statusMessage}</p>
                      {mode && <RectCamera />}
                      {!mode && (
                        <>
                          <label className="flex items-start gap-2 justify-center text-xs text-slate-600 mb-3 text-left max-w-sm mx-auto">
                            <input type="checkbox" checked={regConsent} onChange={(e) => setRegConsent(e.target.checked)} className="mt-0.5" />
                            <span>
                              The student agrees to face capture as described in the{' '}
                              <button type="button" onClick={() => setShowPolicy(true)} className="text-blue-700 underline">Privacy Policy</button>.
                            </span>
                          </label>
                          <button
                            onClick={() => startScan(regRoll, 'hod', true)}
                            disabled={!modelsReady || !regConsent}
                            className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 text-white font-bold px-6 py-2 rounded-lg transition mr-2"
                          >
                            {modelsReady ? 'Start Registration' : 'Loading face models...'}
                          </button>
                          <button onClick={() => { setRegRoll(null); setStatusMessage(''); }} className="text-sm text-slate-600 underline">Cancel</button>
                        </>
                      )}
                    </div>
                  )}

                  {!regRoll && statusMessage && <p className="text-sm text-green-700 font-semibold mb-3">{statusMessage}</p>}

                  <div className="divide-y divide-slate-200">
                    {students.map((s) => (
                      <div key={s.rollNo} className="py-3 flex items-center justify-between gap-3">
                        <div>
                          <p className="font-medium text-slate-800">{s.name}</p>
                          <p className="text-xs font-mono text-blue-700">{s.rollNo}</p>
                        </div>
                        <div className="flex items-center gap-3">
                          {faces[s.rollNo] ? (
                            <>
                              <span className="text-xs font-bold bg-green-100 text-green-800 px-2.5 py-1 rounded-full">✓ Registered {faces[s.rollNo].ay}</span>
                              <button onClick={() => deleteFace(s.rollNo)} className="text-xs text-red-600 underline">Delete</button>
                            </>
                          ) : (
                            <span className="text-xs font-bold bg-slate-100 text-slate-600 px-2.5 py-1 rounded-full">Not registered</span>
                          )}
                          <button
                            disabled={!!mode}
                            onClick={() => { setRegRoll(s.rollNo); setRegConsent(false); setStatusMessage(''); }}
                            className="text-sm bg-blue-700 hover:bg-blue-800 disabled:bg-slate-400 text-white font-semibold px-3 py-1.5 rounded-lg"
                          >
                            {faces[s.rollNo] ? 'Re-register' : 'Register'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* ---------- TAB: CLASS ATTENDANCE KIOSK ---------- */}
            {tab === 'kiosk' && (
              <>
                <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200 text-center">
                  <h3 className="text-lg font-bold text-slate-800 mb-1">Student Attendance - 1:1</h3>
                  <p className="text-xs text-slate-500 mb-4">
                    Each student blinks slowly to start. The app recognises the face, shows enrollment number and name,
                    marks a green tick, then is ready for the next student.
                  </p>

                  {kioskOn ? (
                    <>
                      <div className="relative w-64 h-64 mx-auto">
                        <div className="absolute inset-4 rounded-full overflow-hidden bg-black">
                          <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
                        </div>
                        <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90 pointer-events-none">
                          <circle cx="50" cy="50" r="47" fill="none" stroke="#d1d5db" strokeWidth="3" />
                          <circle
                            cx="50" cy="50" r="47" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round"
                            strokeDasharray={CIRC} strokeDashoffset={CIRC * (1 - ring)}
                            style={{ transition: 'stroke-dashoffset 0.3s' }}
                          />
                        </svg>
                      </div>
                      <p className="mt-3 text-sm font-bold text-slate-700 tracking-wide">{kioskMsg}</p>
                      <button onClick={stopKiosk} className="mt-4 bg-slate-600 hover:bg-slate-700 text-white font-semibold px-5 py-2 rounded-lg">
                        Stop Camera
                      </button>
                    </>
                  ) : (
                    <>
                      {kioskMsg && <p className="text-sm text-red-600 mb-3">{kioskMsg}</p>}
                      <button
                        onClick={startKiosk} disabled={!modelsReady}
                        className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 text-white font-bold px-6 py-2.5 rounded-lg transition"
                      >
                        {modelsReady ? 'Open Attendance Camera' : 'Loading face models...'}
                      </button>
                    </>
                  )}
                </div>

                <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
                  <div className="flex justify-between items-center mb-4 flex-wrap gap-2">
                    <h3 className="font-bold text-slate-800">
                      Class AI (R23) Attendance: <span className="text-green-700">{presentCount}</span>/{students.length}
                    </h3>
                    <button onClick={finalizeDay} className="bg-blue-700 hover:bg-blue-800 text-white text-sm font-semibold px-4 py-2 rounded-lg">
                      Sync / Save Attendance
                    </button>
                  </div>
                  {syncMsg && <p className="text-sm text-green-700 font-semibold mb-3">{syncMsg}</p>}
                  <div className="grid grid-cols-3 sm:grid-cols-5 gap-4">
                    {students.map((s) => {
                      const present = isPresentToday(s.rollNo);
                      return (
                        <div key={s.rollNo} className="text-center">
                          <div className="relative w-14 h-14 mx-auto rounded-full bg-blue-100 text-blue-800 flex items-center justify-center text-lg font-bold">
                            {s.name.charAt(0)}
                            {present && (
                              <span className="absolute -top-1 -right-1 w-5 h-5 bg-green-500 text-white rounded-full text-xs flex items-center justify-center">✓</span>
                            )}
                          </div>
                          <p className="mt-1 text-[10px] font-mono text-slate-600 truncate">{s.rollNo}</p>
                          <p className="text-[10px] font-semibold text-slate-800 truncate">{s.name}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {/* ================= KIOSK POPUP ================= */}
      {popup && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-2xl w-72 p-6 text-center">
            {popup.failed ? (
              <>
                <div className="w-14 h-14 mx-auto rounded-full bg-red-100 text-red-600 flex items-center justify-center text-2xl font-bold">!</div>
                <p className="mt-3 font-semibold text-slate-700">Face not recognised</p>
                <p className="text-xs text-slate-500 mt-1">Register this student first, then try again.</p>
              </>
            ) : (
              <>
                <div className="w-14 h-14 mx-auto rounded-full bg-green-100 text-green-600 flex items-center justify-center text-2xl font-bold">✓</div>
                <p className="mt-3 text-sm text-slate-600">
                  {popup.already ? 'Attendance already captured' : 'Your Attendance is captured'}
                </p>
                <p className="mt-3 text-xs text-slate-500">Enrollment No.</p>
                <p className="font-bold text-slate-800">{popup.roll}</p>
                <p className="mt-2 text-xs text-slate-500">Name</p>
                <p className="font-bold text-slate-800">{popup.name}</p>
              </>
            )}
          </div>
        </div>
      )}

      {/* ================= PRIVACY POLICY ================= */}
      {showPolicy && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50" onClick={() => setShowPolicy(false)}>
          <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-8" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-2xl font-bold text-slate-900">Privacy Policy</h2>
            <p className="text-xs text-slate-500 mb-5">SVPCET Facial Recognition Attendance (FRS)</p>
            {[
              ['1. What face data is collected?', 'The app uses the camera to capture your face during registration and attendance. During registration, face images are captured from different angles - front, left, right, up and down - to support accurate identity verification. At attendance time a slow blink is used to confirm a live person. Only numeric facial features (not photos) are kept.'],
              ['2. How is it used?', 'Only for registration, identity verification and attendance marking. It is not used for advertising, marketing, tracking or any unrelated purpose.'],
              ['3. Is it shared? Where is it stored?', 'It is not sold or shared with third parties. In this version the data is stored in the browser of the device where the portal is used. Attendance visible to the HOD is limited to roll number, name and present/absent status.'],
              ['4. How long is it kept?', 'For one academic year (June to May). After that the face data is deleted automatically and you must register again at the start of the new academic year. Face data can also be deleted at any time from the portal.'],
              ['5. Your consent', 'Face registration only starts after consent is given. Without consent, face registration is not possible.'],
            ].map(([h, t]) => (
              <div key={h} className="mb-4">
                <h3 className="font-bold text-slate-800 mb-1">{h}</h3>
                <p className="text-sm text-slate-600">{t}</p>
              </div>
            ))}
            <button onClick={() => setShowPolicy(false)} className="mt-2 bg-blue-700 hover:bg-blue-800 text-white font-bold px-5 py-2 rounded-lg">Close</button>
          </div>
        </div>
      )}
    </div>
  );
}