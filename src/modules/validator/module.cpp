// Ephemeris validator (C++ -> WASM compute module).
//
// Input  port "states": f64 array, 7 doubles per state [epoch,x,y,z,vx,vy,vz] (SI).
// Output port "result": UTF-8 JSON { ok, confidence, issues:[{check,severity,message}] }.
//
// Checks: monotonic epochs, duplicate epochs, NaN/Inf, reasonable altitude,
// reasonable velocity magnitude, reasonable (bound) orbital energy, and velocity
// continuity (position increments consistent with the reported velocities).

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {
constexpr double kMu = 3.986004418e14;   // m^3/s^2
constexpr double kRe = 6378137.0;        // m
constexpr double kMinAlt = 80e3;         // m
constexpr double kMaxAlt = 60000e3;      // m (beyond GEO)

struct Issue {
  const char* check;
  const char* severity;
  std::string message;
};

void add(std::vector<Issue>& v, const char* c, const char* sev, std::string m) {
  v.push_back({c, sev, std::move(m)});
}

std::string jescape(const std::string& s) {
  std::string o;
  for (char ch : s) {
    if (ch == '"' || ch == '\\') { o.push_back('\\'); o.push_back(ch); }
    else o.push_back(ch);
  }
  return o;
}
}  // namespace

extern "C" int validate(void) {
  const int32_t idx = plugin_find_input_index("states", 0);
  if (idx < 0) {
    plugin_set_error("no_states", "validator expects a 'states' input frame");
    return 1;
  }
  const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
  const uint32_t bytes = f->payload_length;
  const uint32_t n = bytes / (7 * sizeof(double));

  std::vector<double> s(n * 7);
  if (n > 0) std::memcpy(s.data(), f->payload, n * 7 * sizeof(double));

  std::vector<Issue> issues;
  int errors = 0;

  if (n == 0) {
    add(issues, "state-count", "error", "ephemeris contains no state vectors");
    errors++;
  }

  int nan_count = 0, dup = 0, non_mono = 0, alt_bad = 0, vel_bad = 0, energy_bad = 0, cont_bad = 0;

  for (uint32_t i = 0; i < n; i++) {
    const double* p = &s[i * 7];
    for (int k = 0; k < 7; k++) {
      if (std::isnan(p[k]) || std::isinf(p[k])) nan_count++;
    }
    const double r = std::sqrt(p[1] * p[1] + p[2] * p[2] + p[3] * p[3]);
    const double v = std::sqrt(p[4] * p[4] + p[5] * p[5] + p[6] * p[6]);
    const double alt = r - kRe;
    if (alt < kMinAlt || alt > kMaxAlt) alt_bad++;
    if (v < 100.0 || v > 15000.0) vel_bad++;
    // Specific orbital energy; bound orbits have eps < 0 and a within bounds.
    if (r > 1.0) {
      const double eps = v * v / 2.0 - kMu / r;
      const double a = -kMu / (2.0 * eps);
      if (!(eps < 0.0) || a < (kRe + kMinAlt) || a > (kRe + kMaxAlt) * 2.0) energy_bad++;
    }

    if (i > 0) {
      const double* q = &s[(i - 1) * 7];
      const double dt = p[0] - q[0];
      if (dt <= 0.0) {
        if (dt == 0.0) dup++; else non_mono++;
      } else {
        // Position increment vs. mean velocity * dt (trapezoidal).
        const double mvx = (p[4] + q[4]) * 0.5, mvy = (p[5] + q[5]) * 0.5, mvz = (p[6] + q[6]) * 0.5;
        const double ex = p[1] - q[1] - mvx * dt;
        const double ey = p[2] - q[2] - mvy * dt;
        const double ez = p[3] - q[3] - mvz * dt;
        const double err = std::sqrt(ex * ex + ey * ey + ez * ez);
        const double scale = std::max(1.0, v * dt);
        if (err / scale > 0.05) cont_bad++;
      }
    }
  }

  if (nan_count) { add(issues, "nan", "error", std::to_string(nan_count) + " NaN/Inf component(s)"); errors++; }
  if (non_mono) { add(issues, "monotonic-epochs", "error", std::to_string(non_mono) + " non-monotonic epoch step(s)"); errors++; }
  if (dup) { add(issues, "duplicate-epochs", "warning", std::to_string(dup) + " duplicate epoch(s)"); }
  if (alt_bad) { add(issues, "altitude", "warning", std::to_string(alt_bad) + " state(s) with implausible altitude"); }
  if (vel_bad) { add(issues, "velocity-magnitude", "warning", std::to_string(vel_bad) + " state(s) with implausible speed"); }
  if (energy_bad) { add(issues, "orbital-energy", "warning", std::to_string(energy_bad) + " state(s) not on a bound orbit"); }
  if (cont_bad) { add(issues, "velocity-continuity", "warning", std::to_string(cont_bad) + " state(s) where position/velocity disagree"); }

  const bool ok = errors == 0;
  double confidence = 1.0;
  if (n > 0) {
    const double bad = static_cast<double>(dup + alt_bad + vel_bad + energy_bad + cont_bad);
    confidence = std::max(0.0, 1.0 - bad / static_cast<double>(n));
    if (!ok) confidence = std::min(confidence, 0.5);
  } else {
    confidence = 0.0;
  }

  std::string json = "{\"ok\":";
  json += ok ? "true" : "false";
  char cbuf[32];
  std::snprintf(cbuf, sizeof(cbuf), "%.4f", confidence);
  json += ",\"confidence\":";
  json += cbuf;
  json += ",\"stateCount\":" + std::to_string(n);
  json += ",\"issues\":[";
  for (size_t i = 0; i < issues.size(); i++) {
    if (i) json += ",";
    json += "{\"check\":\"" + std::string(issues[i].check) + "\",\"severity\":\"" +
            issues[i].severity + "\",\"message\":\"" + jescape(issues[i].message) + "\"}";
  }
  json += "]}";

  plugin_reset_output_state();
  plugin_push_output("result", "", "", reinterpret_cast<const uint8_t*>(json.data()),
                     static_cast<uint32_t>(json.size()));
  return 0;
}
