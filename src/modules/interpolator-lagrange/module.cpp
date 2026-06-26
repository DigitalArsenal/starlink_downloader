// Lagrange interpolator (C++ -> WASM compute module).
//
// Input  port "states": f64 array, 7 doubles per node [epoch,x,y,z,vx,vy,vz].
// Input  port "query" : f64 array [order, t1, t2, ...] — interpolation order
//                       followed by the query epochs (Unix seconds).
// Output port "states": f64 array, 7 doubles per query [t, x,y,z,vx,vy,vz].
//
// Each Cartesian component is interpolated independently with a windowed
// Lagrange polynomial of the requested order, centred on the query epoch.

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

// Lagrange value of the points (xs[i], ys[i]) evaluated at t.
double lagrange(const std::vector<double>& xs, const double* ys, size_t stride, size_t k, double t) {
  double acc = 0.0;
  for (size_t i = 0; i < k; i++) {
    double term = ys[i * stride];
    for (size_t j = 0; j < k; j++) {
      if (j == i) continue;
      term *= (t - xs[j]) / (xs[i] - xs[j]);
    }
    acc += term;
  }
  return acc;
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
  int order = static_cast<int>(query[0] + 0.5);
  if (order < 1) order = 1;
  size_t k = std::min<size_t>(static_cast<size_t>(order) + 1, n);
  if (k < 2) k = std::min<size_t>(2, n);

  // Node epochs.
  std::vector<double> epochs(n);
  for (size_t i = 0; i < n; i++) epochs[i] = states[i * 7];

  std::vector<double> out;
  out.reserve((query.size() - 1) * 7);

  for (size_t qi = 1; qi < query.size(); qi++) {
    const double t = query[qi];
    // Find first node with epoch > t.
    size_t hi = static_cast<size_t>(
        std::upper_bound(epochs.begin(), epochs.end(), t) - epochs.begin());
    // Centre a window of k nodes around the bracket.
    long start = static_cast<long>(hi) - static_cast<long>(k) / 2;
    start = std::max<long>(0, std::min<long>(start, static_cast<long>(n - k)));

    std::vector<double> xs(k);
    for (size_t i = 0; i < k; i++) xs[i] = epochs[static_cast<size_t>(start) + i];

    out.push_back(t);
    for (int c = 1; c <= 6; c++) {
      const double* ys = &states[(static_cast<size_t>(start)) * 7 + static_cast<size_t>(c)];
      out.push_back(lagrange(xs, ys, 7, k, t));
    }
  }

  plugin_reset_output_state();
  plugin_push_output("states", "", "", reinterpret_cast<const uint8_t*>(out.data()),
                     static_cast<uint32_t>(out.size() * sizeof(double)));
  return 0;
}
