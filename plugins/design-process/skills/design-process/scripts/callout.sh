#!/usr/bin/env bash
# Crop a board PNG and draw numbered callout markers on it.
# Usage: callout.sh <in.png> <out.png> <crop WxH+X+Y | full> [x,y,N ...]
#   x,y are in CROPPED-image pixels (measure on the crop); N is the number printed in the marker.
set -euo pipefail
in=$1 out=$2 crop=$3; shift 3
args=()
[ "$crop" != full ] && args+=(-crop "$crop" +repage)
draw=()
for m in "$@"; do
  IFS=, read -r x y n <<<"$m"
  draw+=(-fill '#e0007a' -stroke white -strokewidth 3 -draw "circle $x,$y $((x+15)),$y")
  if [ ${#n} -gt 1 ]; then ps=14 dx=9 dy=8; else ps=18 dx=5 dy=10; fi
  draw+=(-stroke none -fill white -pointsize $ps -font DejaVu-Sans-Bold -gravity NorthWest -annotate "+$((x-dx))+$((y-dy))" "$n")
done
convert "$in" "${args[@]}" "${draw[@]}" "$out"
