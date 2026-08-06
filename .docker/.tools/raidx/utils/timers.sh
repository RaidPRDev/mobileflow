#!/bin/bash

# ------------------------------------------------------------
# Function: start_time
# Purpose : Capture the current timestamp in nanoseconds
# Usage   : 
#   start=$(start_time)
#
# Output  : A single integer representing current time in nanoseconds
# Example : 1724153123456789012
# ------------------------------------------------------------
start_time() {
  echo "$(date +%s%N)"
}

# ------------------------------------------------------------
# Function: end_time
# Purpose : Calculate elapsed time since a given start timestamp
# Usage   : 
#   start=$(date +%s%N)    # capture start time in nanoseconds
#   sleep 3
#   elapsed=$(end_time "$start")
#   echo "Elapsed: $elapsed"
#
# Input   : $1 - start time (nanoseconds, from date +%s%N)
# Output  : Elapsed time in format HH:MM:SS.mmm
# Example : 00:00:03.001
# -
end_time() {
  local start=$1
  local end=$(date +%s%N)
  local elapsed_ns=$(( end - start )) # seconds
  
  local ms=$(( (elapsed_ns / 1000000) % 1000 ))
  local s=$(( (elapsed_ns / 1000000000) % 60 ))
  local m=$(( (elapsed_ns / 60000000000) % 60 ))
  local h=$(( elapsed_ns / 3600000000000 ))

  printf "%02d:%02d:%02d.%03d\n" $h $m $s $ms
}