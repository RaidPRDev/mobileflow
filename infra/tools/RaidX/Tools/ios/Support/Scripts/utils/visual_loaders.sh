#!/bin/bash

# ------------------------------------------------------------
# Function: rectangle_progress
# Purpose : Animate dots around a rectangular pattern in the
#           terminal while a background process runs, without user input
#           interfering.
# Usage   :
#   rectangle_progress <pid>
# Example :
#   sshpass -p "mypassword" scp file.txt user@remote:/path/ &
#   pid=$!
#   rectangle_progress $pid
#   wait $pid
#
# Input   : $1 - PID of a running background process
# Output  : Animated rectangle dots in the terminal
#           Updates in-place and ends with "[ Done ]" when the
#           background process finishes.
# ------------------------------------------------------------
rectangle_progress() {
  local pid=$1
  local delay=0.2  # seconds per frame

  # Each string is a line of the rectangle
  local frames=(
    "●       "  # top-left to top-right
    " ●      "
    "  ●     "
    "   ●    "
    "    ●   "
    "     ●  "
    "      ● "
    "       ●"
    "      ● "
    "     ●  "
    "    ●   "
    "   ●    "
    "  ●     "
    " ●      "
  )

  # Save current terminal settings
  local old_stty=$(stty -g)
  stty -echo -icanon  # disable echo & canonical mode

  while kill -0 $pid 2>/dev/null; do
    for frame in "${frames[@]}"; do
      # Draw a simple rectangle simulation
      printf "\r[%s]" "$frame"
      sleep $delay
      kill -0 $pid 2>/dev/null || break
    done
  done

  # Restore terminal settings
  stty "$old_stty"

  printf "\r[ Done ]\n"
}

# ------------------------------------------------------------
# Function: square_progress
# Purpose : Animate a dot (●) moving around a 3x3 square grid
#           in-place while a background process runs.
# Usage   :
#   square_progress <pid>
# Example :
#   sshpass -p "mypassword" scp file.txt user@remote:/path/ &
#   pid=$!
#   square_progress $pid
#   wait $pid
# Input   : $1 - PID of a running background process
# Output  : Animated 3x3 square in terminal, ends with [ Done ]
# ------------------------------------------------------------
square_progress() {
  local pid=$1
  local delay=0.2

  local frames=(
    "● . .\n. . .\n. . ."
    ". ● .\n. . .\n. . ."
    ". . ●\n. . .\n. . ."
    ". . .\n. . ●\n. . ."
    ". . .\n. . .\n. ● ."
    ". . .\n. . .\n● . ."
  )

  # Save current terminal settings
  local old_stty=$(stty -g)
  stty -echo -icanon  # turn off echo & canonical mode

  # Reserve 3 lines
  echo -e "\n\n"

  while kill -0 $pid 2>/dev/null; do
    for frame in "${frames[@]}"; do
      printf "\033[3A"  # move cursor up 3 lines
      echo -e "$frame"
      sleep $delay
      kill -0 $pid 2>/dev/null || break
    done
  done

  # Restore terminal settings
  stty "$old_stty"

  # Overwrite last frame
  printf "\033[3A"
  printf "[ Done ]\n\n"
}

# ------------------------------------------------------------
# Function: spinner_progress
# Purpose : Display a fancy rotating loader with a custom label
#           while a background process runs.
# Usage   :
#   spinner_progress <pid> <label>
# Example :
#   sleep 5 &
#   pid=$!
#   spinner_progress $pid "Uploading file"
#   wait $pid
#
# Input   :
#   $1 - PID of a running background process
#   $2 - Label to display next to spinner
# Output  : Animated spinner in-place with label, ends with ✔ Done!
# ------------------------------------------------------------
spinner_progress() {
  local pid=$1
  local label=$2
  local delay=0.1
  local spin_chars=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
  local i=0

  # Save terminal settings
  local old_stty
  old_stty=$(stty -g)
  stty -echo -icanon

  while kill -0 "$pid" 2>/dev/null; do
    printf "\r%-50s" "${spin_chars[i]} ${label}"  
    sleep "$delay"
    ((i=(i+1)%${#spin_chars[@]}))
  done

  # Restore terminal settings
  stty "$old_stty"

  # Get exit status of the background process
  wait "$pid"
  local exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    printf "\r✔ %s, complete!\n" "$label"
  else
    printf "\r✖ %s, failed (exit code %d)\n" "$label" "$exit_code"
  fi

  return $exit_code
}
