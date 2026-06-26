// Starlink MEME ephemeris parser (C++ -> WASM compute module).
//
// Input  port "raw"   : the raw bytes of a Starlink public ephemeris .txt file.
// Output port "meta"  : UTF-8 JSON metadata (frame, time system, validity, ...).
// Output port "states": little-endian f64 array, 7 doubles per state vector:
//                       [epoch_unix_seconds, x, y, z (m), vx, vy, vz (m/s)].
//
// The Starlink file is the "Mean Equator / Mean Equinox of J2000" (≈ EME2000 /
// J2000) frame, UTC time, positions in km and velocities in km/s, with each
// record being one state line followed by three covariance lines. We keep the
// state vectors (SI units) and drop the covariance here.

#include "space_data_module_invoke.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

// Days since Unix epoch for a civil (proleptic Gregorian) y/m/d.
long days_from_civil(int y, unsigned m, unsigned d) {
  y -= m <= 2;
  const long era = (y >= 0 ? y : y - 399) / 400;
  const unsigned yoe = static_cast<unsigned>(y - era * 400);
  const unsigned doy = (153u * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
  const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
  return era * 146097L + static_cast<long>(doe) - 719468L;
}

// Parse "YYYYDOYHHMMSS.fff" -> Unix seconds (UTC).
double parse_meme_epoch(const std::string& tok) {
  const size_t dot = tok.find('.');
  std::string whole = dot == std::string::npos ? tok : tok.substr(0, dot);
  if (whole.size() < 13) return 0.0;
  const int year = std::stoi(whole.substr(0, 4));
  const int doy = std::stoi(whole.substr(4, 3));
  const int hh = std::stoi(whole.substr(7, 2));
  const int mm = std::stoi(whole.substr(9, 2));
  const int ss = std::stoi(whole.substr(11, 2));
  double frac = 0.0;
  if (dot != std::string::npos) frac = std::strtod(("0." + tok.substr(dot + 1)).c_str(), nullptr);
  const long days = days_from_civil(year, 1, 1) + (doy - 1);
  return static_cast<double>(days) * 86400.0 + hh * 3600.0 + mm * 60.0 + ss + frac;
}

// Convert a Starlink "2026-06-25 22:33:12 UTC" stamp to ISO-8601 "…Z".
std::string to_iso(const std::string& raw) {
  std::string s = raw;
  // trim
  while (!s.empty() && (s.back() == ' ' || s.back() == '\r' || s.back() == '\n')) s.pop_back();
  size_t start = 0;
  while (start < s.size() && s[start] == ' ') start++;
  s = s.substr(start);
  // strip trailing " UTC"
  const std::string utc = " UTC";
  if (s.size() >= utc.size() && s.compare(s.size() - utc.size(), utc.size(), utc) == 0) {
    s = s.substr(0, s.size() - utc.size());
  }
  const size_t sp = s.find(' ');
  if (sp != std::string::npos) s[sp] = 'T';
  return s + "Z";
}

std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (s[a] == ' ' || s[a] == '\t' || s[a] == '\r' || s[a] == '\n')) a++;
  while (b > a && (s[b - 1] == ' ' || s[b - 1] == '\t' || s[b - 1] == '\r' || s[b - 1] == '\n')) b--;
  return s.substr(a, b - a);
}

std::vector<std::string> split_ws(const std::string& line) {
  std::vector<std::string> out;
  size_t i = 0;
  while (i < line.size()) {
    while (i < line.size() && (line[i] == ' ' || line[i] == '\t')) i++;
    size_t j = i;
    while (j < line.size() && line[j] != ' ' && line[j] != '\t') j++;
    if (j > i) out.push_back(line.substr(i, j - i));
    i = j;
  }
  return out;
}

// Extract a header value: text after `key` up to `stop` (or end of line).
std::string header_value(const std::string& line, const char* key, const char* stop) {
  const size_t k = line.find(key);
  if (k == std::string::npos) return "";
  size_t from = k + std::strlen(key);
  size_t to = line.size();
  if (stop && *stop) {
    const size_t s = line.find(stop, from);
    if (s != std::string::npos) to = s;
  }
  return trim(line.substr(from, to - from));
}

std::string json_escape(const std::string& s) {
  std::string out;
  for (char c : s) {
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(c);
    } else if (c == '\n') {
      out += "\\n";
    } else if (static_cast<unsigned char>(c) < 0x20) {
      char buf[8];
      std::snprintf(buf, sizeof(buf), "\\u%04x", c);
      out += buf;
    } else {
      out.push_back(c);
    }
  }
  return out;
}

}  // namespace

extern "C" int parse(void) {
  const uint32_t count = plugin_get_input_count();
  if (count == 0) {
    plugin_set_error("no_input", "starlink-parser expects a 'raw' input frame");
    return 1;
  }
  plugin_reset_output_state();

  for (uint32_t fi = 0; fi < count; fi++) {
    const plugin_input_frame_t* frame = plugin_get_input_frame(fi);
    if (frame == nullptr || frame->payload == nullptr) {
      plugin_set_error("bad_input", "input frame had no payload");
      return 1;
    }
    const std::string text(reinterpret_cast<const char*>(frame->payload), frame->payload_length);

    std::string creation, vstart, vstop, ephem_source;
    double step_size = 0.0;
    bool in_data = false;

    std::vector<double> states;  // 7 doubles per state
    states.reserve(4096);

    size_t pos = 0;
    while (pos <= text.size()) {
      size_t nl = text.find('\n', pos);
      std::string line = text.substr(pos, nl == std::string::npos ? std::string::npos : nl - pos);
      pos = nl == std::string::npos ? text.size() + 1 : nl + 1;
      const std::string t = trim(line);
      if (t.empty()) continue;

      if (!in_data) {
        if (t.find("created:") != std::string::npos) {
          creation = to_iso(header_value(t, "created:", nullptr));
          continue;
        }
        if (t.find("ephemeris_start:") != std::string::npos) {
          vstart = to_iso(header_value(t, "ephemeris_start:", "ephemeris_stop:"));
          vstop = to_iso(header_value(t, "ephemeris_stop:", "step_size:"));
          const std::string ss = header_value(t, "step_size:", nullptr);
          if (!ss.empty()) step_size = std::strtod(ss.c_str(), nullptr);
          continue;
        }
        if (t.find("ephemeris_source:") != std::string::npos) {
          ephem_source = header_value(t, "ephemeris_source:", nullptr);
          continue;
        }
        // The covariance-frame marker line (e.g. "UVW") precedes the data block.
        if (t == "UVW" || t == "RIC" || t == "RTN") {
          in_data = true;
          continue;
        }
      }

      // Data region: classify by the magnitude of the first token. State lines
      // start with a large epoch (~2.0e12); covariance lines are tiny (~1e-7).
      const std::vector<std::string> tok = split_ws(t);
      if (tok.size() < 7) continue;
      const double first = std::strtod(tok[0].c_str(), nullptr);
      if (first < 1.0e9) continue;  // covariance / non-state line
      in_data = true;

      const double epoch = parse_meme_epoch(tok[0]);
      states.push_back(epoch);
      for (int c = 1; c <= 3; c++) states.push_back(std::strtod(tok[c].c_str(), nullptr) * 1000.0);
      for (int c = 4; c <= 6; c++) states.push_back(std::strtod(tok[c].c_str(), nullptr) * 1000.0);
    }

    const uint32_t state_count = static_cast<uint32_t>(states.size() / 7);

    std::string meta = "{";
    meta += "\"referenceFrame\":\"J2000\",";
    meta += "\"timeSystem\":\"UTC\",";
    meta += "\"interpolationType\":\"lagrange\",";
    meta += "\"creationDate\":" + (creation.empty() ? std::string("null") : "\"" + json_escape(creation) + "\"") + ",";
    meta += "\"validityStart\":\"" + json_escape(vstart) + "\",";
    meta += "\"validityEnd\":\"" + json_escape(vstop) + "\",";
    meta += "\"version\":\"1\",";
    meta += "\"stateCount\":" + std::to_string(state_count) + ",";
    meta += "\"parserConfidence\":" + std::string(state_count > 0 ? "1.0" : "0.0") + ",";
    meta += "\"source\":\"" + json_escape(ephem_source) + "\",";
    char stepbuf[64];
    std::snprintf(stepbuf, sizeof(stepbuf), "%.6g", step_size);
    meta += "\"stepSizeSeconds\":" + std::string(stepbuf);
    meta += "}";

    plugin_push_output("meta", "", "", reinterpret_cast<const uint8_t*>(meta.data()),
                       static_cast<uint32_t>(meta.size()));
    const uint8_t* sptr = states.empty() ? reinterpret_cast<const uint8_t*>("")
                                         : reinterpret_cast<const uint8_t*>(states.data());
    plugin_push_output("states", "", "", sptr,
                       static_cast<uint32_t>(states.size() * sizeof(double)));
  }

  return 0;
}
