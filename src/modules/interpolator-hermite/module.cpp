// Hermite interpolator (C++ -> WASM compute module).
//
// Input  port "states": f64 array, 7 doubles per node [epoch,x,y,z,vx,vy,vz].
// Input  port "query" : f64 array [order, t1, t2, ...] (order ignored — cubic).
// Output port "states": f64 array, 7 doubles per query [t, x,y,z,vx,vy,vz].
//
// Uses cubic Hermite interpolation between the two bracketing nodes, with
// position interpolated from (p0,v0,p1,v1) and velocity from the analytic
// derivative of the same cubic — so position and velocity stay consistent.
// This is well suited to finely sampled ephemerides (e.g. Starlink at 60 s).

#include "space_data_module_invoke.h"

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

namespace {
std::vector<double> readFrame(const char* port) {
  const int32_t idx = plugin_find_input_index(port, 0);
  if (idx < 0) return {};
  const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
  const uint32_t n = f->payload_length / sizeof(double);
  std::vector<double> v(n);
  if (n) std::memcpy(v.data(), f->payload, n * sizeof(double));
  return v;
}
}  // namespace

extern "C" int interpolate(void) {
  const std::vector<double> states = readFrame("states");
  const std::vector<double> query = readFrame("query");
  if (states.empty() || query.empty()) {
    plugin_set_error("bad_input", "interpolate expects non-empty 'states' and 'query' frames");
    return 1;
  }
  const size_t n = states.size() / 7;
  std::vector<double> epochs(n);
  for (size_t i = 0; i < n; i++) epochs[i] = states[i * 7];

  std::vector<double> out;
  out.reserve((query.size() - 1) * 7);

  for (size_t qi = 1; qi < query.size(); qi++) {
    const double t = query[qi];
    // Bracketing interval [i, i+1].
    size_t hi = static_cast<size_t>(
        std::upper_bound(epochs.begin(), epochs.end(), t) - epochs.begin());
    size_t i0 = (hi == 0) ? 0 : hi - 1;
    if (i0 >= n - 1) i0 = (n >= 2) ? n - 2 : 0;
    const size_t i1 = std::min(i0 + 1, n - 1);

    const double* a = &states[i0 * 7];
    const double* b = &states[i1 * 7];
    const double h = (b[0] - a[0]) != 0.0 ? (b[0] - a[0]) : 1.0;
    const double s = (t - a[0]) / h;
    const double s2 = s * s, s3 = s2 * s;

    const double H00 = 2 * s3 - 3 * s2 + 1;
    const double H10 = s3 - 2 * s2 + s;
    const double H01 = -2 * s3 + 3 * s2;
    const double H11 = s3 - s2;
    const double dH00 = 6 * s2 - 6 * s;
    const double dH10 = 3 * s2 - 4 * s + 1;
    const double dH01 = -6 * s2 + 6 * s;
    const double dH11 = 3 * s2 - 2 * s;

    out.push_back(t);
    // Position components (offset 1..3), with velocities at offset 4..6.
    for (int c = 0; c < 3; c++) {
      const double p0 = a[1 + c], p1 = b[1 + c], v0 = a[4 + c], v1 = b[4 + c];
      const double pos = H00 * p0 + H10 * h * v0 + H01 * p1 + H11 * h * v1;
      out.push_back(pos);
    }
    for (int c = 0; c < 3; c++) {
      const double p0 = a[1 + c], p1 = b[1 + c], v0 = a[4 + c], v1 = b[4 + c];
      const double vel = (dH00 * p0 + dH01 * p1) / h + dH10 * v0 + dH11 * v1;
      out.push_back(vel);
    }
  }

  plugin_reset_output_state();
  plugin_push_output("states", "", "", reinterpret_cast<const uint8_t*>(out.data()),
                     static_cast<uint32_t>(out.size() * sizeof(double)));
  return 0;
}
