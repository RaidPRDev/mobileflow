#!/bin/bash

get_project_path() {
  if [[ -z "$RAIDX_CLIENTS_PATH" || -z "$CLIENT_ID" || -z "$BUILD_ID" || -z "$APP_XCODEPRJ_NAME" ]]; then
    echo "❌ Missing required parameters."
    echo "Environment variables missing: RAIDX_CLIENTS_PATH CLIENT_ID BUILD_ID APP_XCODEPRJ_NAME"
    echo "Make sure you are loading the {HOME}/RaidX/Tools/Support/globals.sh"
    exit 1
  fi

  echo "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/$APP_XCODEPRJ_NAME"
}

get_workspace_path() {
  if [[ -z "$RAIDX_CLIENTS_PATH" || -z "$CLIENT_ID" || -z "$BUILD_ID" || -z "$APP_WORKSPACE_NAME" ]]; then
    echo "❌ Missing required parameters."
    echo "Environment variables missing: RAIDX_CLIENTS_PATH CLIENT_ID BUILD_ID APP_WORKSPACE_NAME"
    echo "Make sure you are loading the {HOME}/RaidX/Tools/Support/globals.sh"
    exit 1
  fi

  echo "$RAIDX_CLIENTS_PATH/$CLIENT_ID/$BUILD_ID/ios/$APP_WORKSPACE_NAME"
}

set_header() {
  local label=$1
  
  echo $'\n===========================================\n'
  echo $' 🛠️  RaidX | '"$label"$'\n'
  echo $'===========================================\n'
}

new_line() {
  echo $"     "
}

dev_stop() {
  # DEBUG
  echo "❌ dev_stop()"
  exit 1
}

# ------------------------------------------------------------
# Function: draw_table
# Purpose : Render a simple ASCII table with headers and rows.
# Usage   :
#   draw_table "Name,Value" \
#              "Item A,123" \
#              "Item B,456" \
#              "Item C,789"
#
# Example Output:
#   +---------+-------+
#   | Name    | Value |
#   +---------+-------+
#   | Item A  |   123 |
#   | Item B  |   456 |
#   | Item C  |   789 |
#   +---------+-------+
# ------------------------------------------------------------
draw_table() {
  local -a rows=("$@")
  local IFS=','

  # Split headers
  read -ra headers <<< "${rows[0]}"
  unset 'rows[0]'

  # Find max width for each column
  local -a col_widths
  for ((i=0; i<${#headers[@]}; i++)); do
    col_widths[i]=${#headers[i]}
  done

  for row in "${rows[@]}"; do
    read -ra cols <<< "$row"
    for ((i=0; i<${#cols[@]}; i++)); do
      (( ${#cols[i]} > col_widths[i] )) && col_widths[i]=${#cols[i]}
    done
  done

  # Helper: print horizontal line
  print_line() {
    printf "+"
    for w in "${col_widths[@]}"; do
      printf "%0.s-" $(seq 1 $((w+2)))
      printf "+"
    done
    printf "\n"
  }

  # Helper: print row
  print_row() {
    local -a cols=("$@")
    printf "|"
    for ((i=0; i<${#cols[@]}; i++)); do
      printf " %-*s |" "${col_widths[i]}" "${cols[i]}"
    done
    printf "\n"
  }

  # Draw table
  print_line
  print_row "${headers[@]}"
  print_line
  for row in "${rows[@]}"; do
    read -ra cols <<< "$row"
    print_row "${cols[@]}"
  done
  print_line
}


# ------------------------------------------------------------
# Function: draw_summary_table
# Purpose : Render an ASCII summary table with a single full-width header
# Usage   :
#   draw_summary_table "Summary for gym 2.228.0" \
#                      "workspace,/Users/ionic-cloud-team/builds/RaidPRDev/capacitor/ios/App/App.xcworkspace" \
#                      "output_directory,/Users/ionic-cloud-team/builds/RaidPRDev/capacitor" \
#                      "output_name,c29c6de1-e740-4b77-9842-b8b3512f5afd-app-store"
# ------------------------------------------------------------
draw_summary_table() {
  local header="$1"
  shift
  local -a rows=("$@")
  local IFS=','

  # Find max width for each column
  local col1_width=0
  local col2_width=0
  for row in "${rows[@]}"; do
    read -ra cols <<< "$row"
    (( ${#cols[0]} > col1_width )) && col1_width=${#cols[0]}
    (( ${#cols[1]} > col2_width )) && col2_width=${#cols[1]}
  done

  # Total width for full-width header
  local total_width=$((col1_width + col2_width + 7)) # 7 = 3+3+1 for separators and spaces

  # Helper: print horizontal line
  print_line() {
    local width=$1
    printf "+"
    for ((i=0; i<width; i++)); do
      printf "-"
    done
    printf "+\n"
  }

  # Print full-width header
  print_line $total_width
  local padding=$(( (total_width - 2 - ${#header}) / 2 ))
  local extra_space=$(( (total_width - 2 - ${#header}) % 2 )) # handle odd width
  printf "|%*s%s%*s|\n" $padding "" "$header" $((padding+extra_space)) ""
  # printf "| %*s |\n" $((total_width-2)) "$header" | awk '{print "| " substr($0,3) " |"}'
  print_line $total_width

  # Print key/value rows
  for row in "${rows[@]}"; do
    read -ra cols <<< "$row"
    printf "| %-*s | %-*s |\n" "$col1_width" "${cols[0]}" "$col2_width" "${cols[1]}"
  done

  # Bottom line
  print_line $total_width
}

# -------------------------------
#  Table Examples
# -------------------------------

# draw_table "Name,Value" \
#   "MODE,$MODE" \
#   "CLIENT_ID,$CLIENT_ID" \
#   "BUILD_ID,$BUILD_ID" \
#   "P12_PATH,$P12_PATH" \
#   "PROVISION_ID,$PROVISION_ID" \
#   "PROVISION_PATH,$PROVISION_PATH" \
#   "PROVISION_NAME,$PROVISION_NAME" \
#   "Node version,$(node -v 2>/dev/null || echo 'Node not found')" \
#   "Ruby version,$(ruby -v 2>/dev/null || echo 'Ruby not found')" \
#   "rbenv version,$(rbenv -v 2>/dev/null || echo 'rbenv not found')" \
#   "CocoaPods version,$(pod --version 2>/dev/null || echo 'CocoaPods not found')" 

# draw_summary_table "Build Summary" \
#   "MODE,$MODE" \
#   "CLIENT_ID,$CLIENT_ID" \
#   "BUILD_ID,$BUILD_ID" \
#   "P12_PATH,$P12_PATH" \
#   "PROVISION_ID,$PROVISION_ID" \
#   "PROVISION_PATH,$PROVISION_PATH" \
#   "PROVISION_NAME,$PROVISION_NAME" \
#   "Node version,$(node -v 2>/dev/null || echo 'Node not found')" \
#   "Ruby version,$(ruby -v 2>/dev/null || echo 'Ruby not found')" \
#   "rbenv version,$(rbenv -v 2>/dev/null || echo 'rbenv not found')" \
#   "CocoaPods version,$(pod --version 2>/dev/null || echo 'CocoaPods not found')" 