import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 5,          // 5 virtual users
  duration: "10s", // for 10 seconds
  thresholds: {
    http_req_failed: ["rate<0.01"], // <1% errors
    http_req_duration: ["p(95)<500"], // 95% of requests < 500ms
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:5000";

export default function () {
  const res = http.get(`${BASE_URL}/api/health`);

  check(res, {
    "status is 200": (r) => r.status === 200,
    "success true": (r) => {
      try {
        return r.json("success") === true;
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}