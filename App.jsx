import React, { useState, useRef, useEffect } from 'react';
import * as faceapi from '@vladmandic/face-api';

// ---------------- CONFIG ----------------
const SVPCET_LAT = 13.6288;
const SVPCET_LNG = 79.4192;
const MAX_RADIUS_KM = 0.5;
const DEV_BYPASS_GPS = true; // set to false in production (testing outside campus)
const MODEL_URL = '/models'; // put face-api model files in public/models

// ---------------- STUDENTS ----------------
const INITIAL_STUDENTS = [
  { rollNo: '25G01A4370', name: 'Vasudeva', presentDays: 0, absentDays: 0 },
  { rollNo: '23SV1A3101', name: 'Aarav Sharma', presentDays: 18, absentDays: 2 },
  { rollNo: '23SV1A3102', name: 'Bhavya Reddy', presentDays: 19, absentDays: 1 },
  { rollNo: '23SV1A3103', name: 'Chaitanya Kumar', presentDays: 15, absentDays: 5 },
];

// ---------------- FACE POSES (front, left, right, down) ----------------
// yaw  = nose position between jaw edges (0..1, ~0.5 = straight)
// pitch = nose position between eye line and chin (higher = looking down)
const POSES = [
  { key: 'front', label: 'Look straight at the camera', ok: (p) => p.yaw > 0.42 && p.yaw < 0.58 && p.pitch < 0.58, threshold: 0.5 },
  { key: 'left', label: 'Turn your face to the LEFT', ok: (p) => p.yaw > 0.65, threshold: 0.6 },
  { key: 'right', label: 'Turn your face to the RIGHT', ok: (p) => p.yaw < 0.35, threshold: 0.6 },
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

// ---------------- STORAGE HELPERS ----------------
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const save = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const today = () => new Date().toISOString().slice(0, 10);

export default function App() {
  const [role, setRole] = useState(null);
  const [students, setStudents] = useState(() => load('svpcet_students', INITIAL_STUDENTS));
  const [bulkText, setBulkText] = useState('');
  const [currentUser, setCurrentUser] = useState(null);
  const [rollNo, setRollNo] = useState('');
  const [password, setPassword] = useState('');

  const [locationVerified, setLocationVerified] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [modelsReady, setModelsReady] = useState(false);

  // scan state
  const [mode, setMode] = useState(null); // 'enroll' | 'verify' | null
  const [stepIndex, setStepIndex] = useState(0);
  const [stepsDone, setStepsDone] = useState([]);

  // persisted data
  const [faces, setFaces] = useState(() => load('svpcet_faces', {})); // {rollNo: {front:[..], left:[..], ...}}
  const [logs, setLogs] = useState(() => load('svpcet_logs', {}));    // {rollNo: {date: 'PRESENT'|'ABSENT'}}

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const stepRef = useRef(0);
  const capturedRef = useRef({});
  const mismatchRef = useRef(0);
  const stepStartRef = useRef(0);

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
    setLocationVerified(false); setStepsDone([]); setStatusMessage('');
    setRollNo(''); setPassword('');
  };

  // ---------- 1. GPS geofence ----------
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

  // ---------- 2. Start scan (enroll first time, verify afterwards) ----------
  const startScan = async () => {
    if (!modelsReady) return setStatusMessage('Face models are still loading...');
    const enrolled = !!faces[currentUser.rollNo];
    try {
      setMode(enrolled ? 'verify' : 'enroll');
      setStepsDone([]);
      setStepIndex(0);
      stepRef.current = 0;
      capturedRef.current = {};
      mismatchRef.current = 0;
      stepStartRef.current = Date.now();
      await new Promise((r) => setTimeout(r, 50)); // let <video> mount
      await startCamera();
      setStatusMessage(POSES[0].label);
      timerRef.current = setInterval(() => scanFrame(enrolled), 450);
    } catch (err) {
      console.error(err);
      setMode(null);
      setStatusMessage('Camera access denied or unavailable.');
    }
  };

  const failScan = (reason) => {
    stopCamera();
    setMode(null);
    markAttendance('ABSENT');
    setStatusMessage(`Verification failed: ${reason}. Marked ABSENT - you can try again.`);
  };

  // ---------- 3. Process one video frame ----------
  const scanFrame = async (enrolled) => {
    const video = videoRef.current;
    if (!video || video.readyState < 2) return;
    const i = stepRef.current;
    const pose = POSES[i];

    if (Date.now() - stepStartRef.current > 25000) return failScan('timed out');

    const results = await faceapi
      .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 }))
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (results.length === 0) return setStatusMessage(`No face found. ${pose.label}`);
    if (results.length > 1) return setStatusMessage('Only ONE face allowed in the camera.');

    const { landmarks, descriptor } = results[0];
    if (!pose.ok(getPose(landmarks))) return setStatusMessage(pose.label);

    // Pose is correct -> check identity (verify mode only)
    if (enrolled) {
      const me = faces[currentUser.rollNo]?.[pose.key];
      const myDist = me ? faceapi.euclideanDistance(descriptor, me) : 99;

      // face must belong to THIS roll number and no other roll number
      let bestRoll = null, bestDist = 99;
      Object.entries(faces).forEach(([roll, p]) => {
        if (p[pose.key]) {
          const d = faceapi.euclideanDistance(descriptor, p[pose.key]);
          if (d < bestDist) { bestDist = d; bestRoll = roll; }
        }
      });

      if (myDist > pose.threshold || bestRoll !== currentUser.rollNo) {
        mismatchRef.current += 1;
        setStatusMessage('Face does not match this roll number...');
        if (mismatchRef.current >= 6) failScan('face does not match roll number');
        return;
      }
    }

    // Step passed
    capturedRef.current[pose.key] = Array.from(descriptor);
    mismatchRef.current = 0;
    setStepsDone((s) => [...s, pose.key]);

    if (i + 1 < POSES.length) {
      stepRef.current = i + 1;
      stepStartRef.current = Date.now();
      setStepIndex(i + 1);
      setStatusMessage(`${pose.key.toUpperCase()} done. ${POSES[i + 1].label}`);
    } else {
      finishScan(enrolled);
    }
  };

  const finishScan = (enrolled) => {
    stopCamera();
    if (!enrolled) {
      const updated = { ...faces, [currentUser.rollNo]: capturedRef.current };
      setFaces(updated);
      save('svpcet_faces', updated);
      setMode(null);
      setStatusMessage('Face registered for your roll number. Scan again to mark attendance.');
      return;
    }
    setMode(null);
    markAttendance('PRESENT');
    setStatusMessage('Face verified from all sides! Attendance marked PRESENT.');
  };

  // HOD: add many students at once. One per line: ROLLNO, Name
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

  const markAttendance = (status) => {
    const roll = currentUser.rollNo;
    const d = today();
    setLogs((prev) => {
      if (prev[roll]?.[d] === 'PRESENT') return prev; // never downgrade
      const updated = { ...prev, [roll]: { ...(prev[roll] || {}), [d]: status } };
      save('svpcet_logs', updated);
      return updated;
    });
  };

  // ---------- Derived counts ----------
  const stats = (s) => {
    const l = Object.values(logs[s.rollNo] || {});
    const present = s.presentDays + l.filter((x) => x === 'PRESENT').length;
    const absent = s.absentDays + l.filter((x) => x === 'ABSENT').length;
    const total = present + absent;
    return { present, absent, pct: total ? ((present / total) * 100).toFixed(1) : null };
  };
  const todayStatus = (roll) => logs[roll]?.[today()] || 'ABSENT';

  const markedToday = currentUser && logs[currentUser.rollNo]?.[today()] === 'PRESENT';
  const enrolled = currentUser && !!faces[currentUser.rollNo];

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
          </div>
        ) : role === 'student' ? (
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
                {enrolled ? 'Daily Face Attendance (Front, Left, Right, Down)' : 'First-time Face Registration'}
              </h3>
              <p className="text-sm text-slate-600 mb-4">{statusMessage}</p>

              {markedToday ? (
                <div className="p-4 bg-green-50 text-green-700 rounded-lg font-semibold border border-green-200">
                  Today's attendance: PRESENT
                </div>
              ) : (
                <>
                  {mode && (
                    <div className="flex flex-col items-center gap-3 mb-4">
                      <div className="w-72 h-56 bg-black rounded-lg overflow-hidden border-2 border-blue-500">
                        <video ref={videoRef} muted playsInline className="w-full h-full object-cover" />
                      </div>
                      <div className="flex gap-2">
                        {POSES.map((p, i) => (
                          <span
                            key={p.key}
                            className={`px-3 py-1 rounded-full text-xs font-bold ${
                              stepsDone.includes(p.key)
                                ? 'bg-green-100 text-green-800'
                                : i === stepIndex ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-500'
                            }`}
                          >
                            {stepsDone.includes(p.key) ? '✓ ' : ''}{p.key.toUpperCase()}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {locationVerified && !mode && (
                    <button
                      onClick={startScan} disabled={!modelsReady}
                      className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-400 text-white font-bold px-6 py-2.5 rounded-lg transition"
                    >
                      {!modelsReady ? 'Loading face models...' : enrolled ? 'Start Face Scan & Mark Attendance' : 'Register My Face'}
                    </button>
                  )}

                  <p className="mt-3 text-xs text-slate-500">
                    Today's status: <b className={todayStatus(currentUser.rollNo) === 'PRESENT' ? 'text-green-700' : 'text-red-600'}>
                      {todayStatus(currentUser.rollNo)}
                    </b>
                  </p>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-xl shadow-md border border-slate-200">
              <h2 className="text-xl font-bold text-slate-800 mb-1">HOD Monitoring Control Panel</h2>
              <p className="text-sm text-slate-500">Department of AI - R23 Batch Overview</p>
            </div>

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
                Total: <b>{students.length}</b> | Present today: <b className="text-green-700">{students.filter((x) => todayStatus(x.rollNo) === 'PRESENT').length}</b> | Absent today: <b className="text-red-600">{students.filter((x) => todayStatus(x.rollNo) !== 'PRESENT').length}</b>
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
          </div>
        )}
      </main>
    </div>
  );
}