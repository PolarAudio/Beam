#!/bin/bash
# Waits for twelve fresh [perf] lines in Beam's log and prints the GPU time of
# the last ten: mean, median, min and max, with the draw count.
#
# Beam writes a [perf] line every few seconds. Hold the scene still while it
# samples; to compare two states, sample one, change it, sample again.
#
# Usage: bash tools/dev/perf-sample.sh [label] [log]
#   log defaults to tools/dev/out/app.log, where launch.ps1 writes.
label="${1:-sample}"
log="${2:-$(dirname "$0")/out/app.log}"
start=$(grep -a -c '"\[perf\] {' "$log")
for i in $(seq 1 60); do
  now=$(grep -a -c '"\[perf\] {' "$log")
  [ $((now - start)) -ge 12 ] && break
  sleep 1
done
grep -a -o '"gpuMs":[0-9.]*,"cpuMs":[0-9.]*,"passes":[0-9]*,"draws":[0-9]*' "$log" | tail -10 |
  awk -F'[:,]' -v l="$label" '{ g[NR] = $2; c += $4; s += $2; d = $8 }
    END { n = asort(g); printf "%s: gpuMs mean %.2f median %.2f min %.2f max %.2f, cpuMs mean %.2f (draws %s, n=%d)\n",
      l, s / n, (g[5] + g[6]) / 2, g[1], g[n], c / n, d, n }'
