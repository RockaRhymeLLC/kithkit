#!/bin/bash
# Collect process data from all monitored hosts via SSH.
# Writes JSON files to daemon/public/processes/ for the status page.

DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$DIR/daemon/public/processes"
mkdir -p "$OUT"

# Host definitions: name|ip|user
HOSTS=(
  "hillkali01|10.0.2.7|kali"
  "hillkali02p400|10.0.2.8|kali"
  "hilldrlx01|10.0.2.2|marvho"
  "system76-popos|10.0.2.5|marvho"
)

collect_remote() {
  local name="$1" ip="$2" user="$3"
  local file="$OUT/${name}.json"

  # SSH with tight timeout, collect ps data
  DATA=$(ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=no -o BatchMode=yes "$user@$ip" '
    echo "{"
    echo "\"hostname\": \"$(hostname)\","
    echo "\"uptime\": \"$(uptime -p 2>/dev/null || uptime | sed "s/.*up /up /;s/,.*load.*//")\","
    echo "\"load\": \"$(cat /proc/loadavg 2>/dev/null | cut -d" " -f1-3)\","

    # Memory
    MEM_TOTAL=$(free -m 2>/dev/null | awk "/Mem:/{print \$2}")
    MEM_USED=$(free -m 2>/dev/null | awk "/Mem:/{print \$3}")
    MEM_PCT=$((MEM_USED * 100 / MEM_TOTAL))
    echo "\"mem_total_mb\": $MEM_TOTAL,"
    echo "\"mem_used_mb\": $MEM_USED,"
    echo "\"mem_pct\": $MEM_PCT,"

    # Disk
    DISK_LINE=$(df -h / | tail -1)
    DISK_USED=$(echo "$DISK_LINE" | awk "{print \$3}")
    DISK_TOTAL=$(echo "$DISK_LINE" | awk "{print \$2}")
    DISK_PCT=$(echo "$DISK_LINE" | awk "{print \$5}" | tr -d "%")
    echo "\"disk_used\": \"$DISK_USED\","
    echo "\"disk_total\": \"$DISK_TOTAL\","
    echo "\"disk_pct\": $DISK_PCT,"

    # Top processes by CPU
    echo "\"processes\": ["
    ps aux --sort=-%cpu 2>/dev/null | head -21 | tail -20 | awk "{
      gsub(/\"/, \"\\\\\"\", \$11);
      if (NR > 1) printf \",\";
      printf \"{\\\"user\\\":\\\"%s\\\",\\\"pid\\\":%s,\\\"cpu\\\":%s,\\\"mem\\\":%s,\\\"vsz\\\":%s,\\\"rss\\\":%s,\\\"stat\\\":\\\"%s\\\",\\\"command\\\":\\\"%s\\\"}\n\", \$1, \$2, \$3, \$4, \$5, \$6, \$8, \$11
    }"
    echo "],"

    echo "\"collected_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
    echo "\"online\": true"
    echo "}"
  ' 2>/dev/null)

  if [ $? -eq 0 ] && [ -n "$DATA" ]; then
    echo "$DATA" > "$file"
  else
    echo "{\"online\": false, \"collected_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$file"
  fi
}

# Collect local Mac data
collect_local() {
  local file="$OUT/Marvho-MacMini01.json"
  local uptime_secs=$(sysctl -n kern.boottime | awk -F'[= ,]' '{print systime()-$5}')
  local mem_total=$(($(sysctl -n hw.memsize) / 1048576))
  local disk_line=$(df -h / | tail -1)
  local disk_used=$(echo "$disk_line" | awk '{print $3}')
  local disk_total=$(echo "$disk_line" | awk '{print $2}')
  local disk_pct=$(echo "$disk_line" | awk '{print $5}' | tr -d '%')
  local load=$(sysctl -n vm.loadavg | awk '{print $1, $2, $3}')
  local ncpu=$(sysctl -n hw.ncpu)

  echo "{" > "$file"
  echo "\"hostname\": \"$(hostname)\"," >> "$file"
  echo "\"uptime_secs\": $uptime_secs," >> "$file"
  echo "\"load\": \"$load\"," >> "$file"
  echo "\"ncpu\": $ncpu," >> "$file"
  echo "\"mem_total_mb\": $mem_total," >> "$file"
  echo "\"disk_used\": \"$disk_used\"," >> "$file"
  echo "\"disk_total\": \"$disk_total\"," >> "$file"
  echo "\"disk_pct\": $disk_pct," >> "$file"

  # Top processes
  echo "\"processes\": [" >> "$file"
  ps aux -r | head -21 | tail -20 | awk '{
    gsub(/"/, "\\\"", $11);
    if (NR > 1) printf ",";
    printf "{\"user\":\"%s\",\"pid\":%s,\"cpu\":%s,\"mem\":%s,\"vsz\":%s,\"rss\":%s,\"stat\":\"%s\",\"command\":\"%s\"}\n", $1, $2, $3, $4, $5, $6, $8, $11
  }' >> "$file"
  echo "]," >> "$file"

  echo "\"collected_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"," >> "$file"
  echo "\"online\": true" >> "$file"
  echo "}" >> "$file"
}

# Run collection
collect_local &
for entry in "${HOSTS[@]}"; do
  IFS='|' read -r name ip user <<< "$entry"
  collect_remote "$name" "$ip" "$user" &
done
wait

echo "Process data collected at $(date)"
