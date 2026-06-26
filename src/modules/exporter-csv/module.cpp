// CSV exporter (C++ -> WASM compute module).
//
// Input  port "states": f64 array, 7 doubles per state [epoch,x,y,z,vx,vy,vz].
// Output port "out"    : UTF-8 CSV bytes with a header row; epoch is emitted as
//                        both Unix seconds and ISO-8601 UTC.

#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {
// Civil date from days since Unix epoch (Howard Hinnant's algorithm).
void civil_from_days(long z, int& y, unsigned& m, unsigned& d) {
  z += 719468;
  const long era = (z >= 0 ? z : z - 146096) / 146097;
  const unsigned doe = static_cast<unsigned>(z - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const int yy = static_cast<int>(yoe) + static_cast<int>(era) * 400;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y = yy + (m <= 2);
}

std::string iso(double epoch) {
  long days = static_cast<long>(epoch / 86400.0);
  double rem = epoch - static_cast<double>(days) * 86400.0;
  if (rem < 0) { rem += 86400.0; days -= 1; }
  int y; unsigned m, d;
  civil_from_days(days, y, m, d);
  const int hh = static_cast<int>(rem / 3600.0);
  const int mm = static_cast<int>((rem - hh * 3600) / 60.0);
  const double ss = rem - hh * 3600 - mm * 60;
  char buf[40];
  std::snprintf(buf, sizeof(buf), "%04d-%02u-%02uT%02d:%02d:%06.3fZ", y, m, d, hh, mm, ss);
  return buf;
}
}  // namespace

extern "C" int export_csv(void) {
  const int32_t idx = plugin_find_input_index("states", 0);
  if (idx < 0) {
    plugin_set_error("no_states", "exporter expects a 'states' input frame");
    return 1;
  }
  const plugin_input_frame_t* f = plugin_get_input_frame(static_cast<uint32_t>(idx));
  const uint32_t n = f->payload_length / (7 * sizeof(double));
  std::vector<double> s(n * 7);
  if (n) std::memcpy(s.data(), f->payload, n * 7 * sizeof(double));

  std::string csv;
  csv.reserve(n * 160 + 128);
  csv += "epoch_unix_s,epoch_iso,x_m,y_m,z_m,vx_mps,vy_mps,vz_mps\n";
  char line[256];
  for (uint32_t i = 0; i < n; i++) {
    const double* p = &s[i * 7];
    std::snprintf(line, sizeof(line),
                  "%.3f,%s,%.6f,%.6f,%.6f,%.9f,%.9f,%.9f\n",
                  p[0], iso(p[0]).c_str(), p[1], p[2], p[3], p[4], p[5], p[6]);
    csv += line;
  }

  plugin_reset_output_state();
  plugin_push_output("out", "", "", reinterpret_cast<const uint8_t*>(csv.data()),
                     static_cast<uint32_t>(csv.size()));
  return 0;
}
