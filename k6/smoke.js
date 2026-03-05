import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  vus: 5,
  duration: "15s",
};

const BASE_URL = __ENV.BASE_URL || "http://192.168.64.142:5000";

export default function () {
  const res = http.get(`${BASE_URL}/health`);

  check(res, {
    "status is 200": (r) => r.status === 200,
  });

  sleep(1);
}