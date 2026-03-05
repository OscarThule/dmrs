import http from "k6/http";
import { check, sleep } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";

// ---- test credentials via env vars ----
// Patient
const PATIENT_ID = __ENV.PATIENT_ID || "123";
const PATIENT_PASS = __ENV.PATIENT_PASS || "pass";

// Medical center (change keys to match your controller, often email/password or reg/email)
const CENTER_EMAIL = __ENV.CENTER_EMAIL || "center@mail.com";
const CENTER_PASS = __ENV.CENTER_PASS || "pass";

// Practitioner
const PRAC_ID = __ENV.PRAC_ID || "123";
const PRAC_PASS = __ENV.PRAC_PASS || "pass";

export const options = {
  scenarios: {
    patients_login: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 10 },
        { duration: "20s", target: 30 },
        { duration: "10s", target: 0 },
      ],
      exec: "patientLogin",
    },

    centers_login: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 15 },
        { duration: "10s", target: 0 },
      ],
      exec: "medicalCenterLogin",
    },

    practitioners_login: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 5 },
        { duration: "20s", target: 20 },
        { duration: "10s", target: 0 },
      ],
      exec: "practitionerLogin",
    },
  },

  thresholds: {
    http_req_failed: ["rate<0.02"],     // <2% failures
    http_req_duration: ["p(95)<800"],   // 95% under 800ms
  },
};

// ---------- helpers ----------
function postJson(url, bodyObj) {
  return http.post(url, JSON.stringify(bodyObj), {
    headers: { "Content-Type": "application/json" },
    timeout: "60s",
  });
}

function tokenFromResponse(res) {
  try {
    const b = res.json();
    // support multiple shapes
    return b?.token || b?.data?.token || null;
  } catch {
    return null;
  }
}

// ---------- scenarios ----------
export function patientLogin() {
  const res = postJson(`${BASE_URL}/api/patients/login`, {
    idNumber: PATIENT_ID,
    password: PATIENT_PASS,
  });

  const ok = check(res, {
    "patient login 200/201": (r) => r.status === 200 || r.status === 201,
    "patient token exists": (r) => !!tokenFromResponse(r),
  });

  if (!ok && Math.random() < 0.05) {
    console.log(`PATIENT login failed: ${res.status} ${res.body?.slice(0, 120)}`);
  }

  sleep(1);
}

export function medicalCenterLogin() {
  // ⚠️ adjust payload fields if your controller uses different ones
  const res = postJson(`${BASE_URL}/api/medical-centers/login`, {
    email: CENTER_EMAIL,
    password: CENTER_PASS,
  });

  const ok = check(res, {
    "center login 200/201": (r) => r.status === 200 || r.status === 201,
    "center token exists": (r) => !!tokenFromResponse(r),
  });

  if (!ok && Math.random() < 0.05) {
    console.log(`CENTER login failed: ${res.status} ${res.body?.slice(0, 120)}`);
  }

  sleep(1);
}

export function practitionerLogin() {
  const res = postJson(`${BASE_URL}/api/practitioners/login`, {
    idNumber: PRAC_ID,
    password: PRAC_PASS,
  });

  const ok = check(res, {
    "practitioner login 200/201": (r) => r.status === 200 || r.status === 201,
    "practitioner token exists": (r) => !!tokenFromResponse(r),
  });

  if (!ok && Math.random() < 0.05) {
    console.log(`PRACTITIONER login failed: ${res.status} ${res.body?.slice(0, 120)}`);
  }

  sleep(1);
}