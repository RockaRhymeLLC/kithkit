# LKG (Lake Gaston) UniFi WiFi Network — Troubleshooting Guide

> **Location**: 111 Hickory Point Rd, Littleton, NC  
> **Controller**: UniFi Cloud Gateway (managed via UniFi Site Manager at unifi.ui.com)  
> **Admin account**: marvelousho (Super Admin)  
> **Last updated**: April 1, 2026

---

## Network Overview

### Equipment

| Device | Role | Backhaul | Notes |
|--------|------|----------|-------|
| Cloud Gateway | Router/Controller | Wired (ISP uplink) | Main gateway |
| Family Room AP | Access Point | Wired | Primary indoor AP |
| Upstairs AP | Access Point | **Wireless mesh** | Needs ethernet run — mesh causes performance issues |
| Rec Room AP | Access Point | Wired | |
| Dock AC Pro | Access Point | Wired | Was offline, brought back online Mar 2026 |
| UDB Pro | Access Point | Wired | Was offline, brought back online Mar 2026 |

### Current Channel Assignments (5 GHz)

Optimized March 31, 2026 to eliminate co-channel interference:

| AP | 5 GHz Channel | Band |
|----|---------------|------|
| AP 1 | 36 | UNII-1 |
| AP 2 | 149 | UNII-3 |
| AP 3 | 157 | UNII-3 |

> **Previous state**: All three APs were on Channel 48, causing severe co-channel interference and TX retry rates of 25–35%.

### 2.4 GHz

Channels should be spread across 1, 6, and 11 (the only non-overlapping 2.4 GHz channels). Check in UniFi → Settings → WiFi → each AP's radio settings.

---

## Known Issues & History

### 1. Co-Channel Interference (Fixed — March 31, 2026)

**Symptom**: Slow speeds, high latency, intermittent drops.  
**Root cause**: Three 5 GHz APs all on Channel 48. When multiple APs share a channel in the same physical space, they contend for airtime and cause retransmissions.  
**Fix**: Spread channels to 36, 149, 157 (non-overlapping, across different UNII bands).  
**Verification**: Check RF Environment in UniFi → Devices → [AP] → Insights. TX retry rate should be under 10%. If it's above 15%, channels may need adjustment again.

**How to check/change in UniFi**:
1. Go to **Devices** → select the AP
2. Click **Settings** (gear icon)
3. Under **Radios** → **5 GHz**, set Channel manually (don't rely on Auto)
4. Set Channel Width to **40 MHz** (80 MHz is tempting but causes more interference in multi-AP setups)
5. Apply changes (AP will briefly disconnect clients)

### 2. WiFi Drops During Speed Tests (Reported — March 31, 2026)

**Symptom**: Running a bandwidth speed test on WiFi starts normally but then locks up and causes the WiFi connection to drop entirely.  
**Likely causes**:
- **Wireless mesh backhaul saturation**: The Upstairs AP uses wireless mesh — a speed test through it saturates the mesh link, causing the AP to drop clients. This is the most likely cause if the drops happen when connected to the Upstairs AP.
- **Channel contention under load**: If co-channel interference wasn't fully resolved, high-bandwidth activity triggers contention.
- **Airtime fairness**: If enabled, can throttle a single client doing a speed test. Check in UniFi → Settings → WiFi → Advanced.
- **Band steering issues**: Client may be bouncing between 2.4 and 5 GHz mid-test.

**Troubleshooting steps**:
1. Identify which AP you're connected to (UniFi → Clients → find your device)
2. If connected to the **Upstairs AP** (mesh), try moving closer to a wired AP and retest
3. Check **Devices → [AP] → Insights** for TX retries and channel utilization during the test
4. Try disabling **Airtime Fairness** temporarily (Settings → WiFi → Advanced)
5. Pin your device to 5 GHz only (forget the 2.4 GHz SSID or use separate SSIDs)

**Long-term fix**: Run ethernet to the Upstairs AP to eliminate mesh backhaul as a bottleneck.

### 3. Upstairs AP on Wireless Mesh (Open — Needs Ethernet Run)

**Problem**: The Upstairs AP has no wired backhaul and relies on wireless mesh to communicate with the gateway. This halves its effective throughput and adds latency. Under load (speed tests, video calls, large downloads), the mesh link saturates and clients drop.  
**Fix**: Run an ethernet cable from the Cloud Gateway (or nearest switch) to the Upstairs AP.  
**Workaround**: Lower TX power on the Upstairs AP so fewer clients connect to it, pushing them to wired APs. In UniFi → Devices → Upstairs AP → Settings → Radios, set TX Power to Low or Medium.

### 4. Dock AC Pro & UDB Pro Were Offline (Fixed — March 2026)

These two APs were offline/disconnected. Brought back online in March 2026. If they go offline again:
1. Check physical power (PoE injector or switch port)
2. Check adoption status in UniFi → Devices (look for "Pending Adoption")
3. If adopted but offline, SSH into the AP and run `info` to check connectivity to the controller
4. Factory reset as last resort: hold reset button 10+ seconds

---

## General Troubleshooting Playbook

### Slow WiFi

1. **Which AP are you on?** → UniFi → Clients → find device → note AP name
2. **Is it the mesh AP (Upstairs)?** → If yes, that's likely the bottleneck. Move closer to a wired AP.
3. **Channel utilization?** → Devices → [AP] → Insights → RF Environment. Over 50% utilization = congested.
4. **TX retries?** → Same page. Over 15% = interference. Check if another AP is on the same channel.
5. **How many clients on this AP?** → Devices → [AP] → Clients tab. Over 15-20 clients on one AP can degrade performance.
6. **Is Auto channel enabled?** → If so, the controller may have picked a bad channel. Set manually using the channel plan above.

### Client Drops / Disconnects

1. **Check AP uptime** → Devices → [AP]. If it recently restarted, could be a firmware crash.
2. **Check AP logs** → Devices → [AP] → Insights → Events. Look for "radar detected" (DFS channel change), "station deauth", or "channel changed".
3. **DFS channels** → Channels 52-144 are DFS and can be forced off by radar. Channels 36, 149, 153, 157, 161 are non-DFS and safer.
4. **DHCP issues** → Settings → Networks → check DHCP range isn't exhausted. Look at active leases.
5. **Roaming issues** → If BSS Transition (802.11v) or Fast Roaming (802.11r) are enabled, some older devices handle them poorly. Try disabling under Settings → WiFi → Advanced.

### AP Not Adopting / Offline

1. **Physical check**: Confirm PoE power, ethernet cable, link lights
2. **In UniFi**: Devices → look for the AP in "Pending Adoption" state
3. **SSH to AP** (if accessible): `ssh ubnt@<ap-ip>` (default password: ubnt)
   - Run `info` to see controller URL and adoption status
   - Run `set-inform http://<gateway-ip>:8080/inform` to point it at the controller
4. **Factory reset**: Hold reset button 10+ seconds, then re-adopt

### Internet Down but WiFi Connected

1. **Check gateway status** → Devices → Cloud Gateway → WAN status
2. **ISP issue?** → Check if WAN IP is assigned. If not, ISP modem may need reboot.
3. **DNS?** → Try `nslookup google.com` from a connected device. If DNS fails, check DNS settings in Settings → Networks.

---

## UniFi Browser Interface Quick Reference

### Key Navigation Paths

| Task | Path |
|------|------|
| See all APs and status | Devices |
| See connected clients | Clients |
| Check AP channel/power | Devices → [AP] → Settings → Radios |
| Check RF environment | Devices → [AP] → Insights |
| Change WiFi settings | Settings → WiFi |
| View DHCP leases | Settings → Networks → [Network] → DHCP |
| Check WAN status | Devices → Cloud Gateway → Ports |
| View events/logs | System Log (bottom of left sidebar) |
| Firmware updates | Devices → [AP] → check for update icon |

### Settings to Know About

| Setting | Where | Recommendation |
|---------|-------|----------------|
| Channel Width (5 GHz) | Devices → AP → Radios | 40 MHz (not 80) for multi-AP environments |
| TX Power | Devices → AP → Radios | Medium for most APs; Low for Upstairs mesh AP |
| Minimum RSSI | Settings → WiFi → Advanced | -75 dBm (forces weak clients to roam to closer AP) |
| Band Steering | Settings → WiFi → Advanced | Prefer 5 GHz |
| Airtime Fairness | Settings → WiFi → Advanced | Off unless needed for many-client environments |
| Auto-Optimize | Settings → WiFi | Off — manual channel plan is better |
| Fast Roaming (802.11r) | Settings → WiFi → Advanced | Off if older devices have issues |

---

## Network Diagram (Text)

```
                    ┌──────────────┐
                    │   Internet   │
                    └──────┬───────┘
                           │
                    ┌──────┴───────┐
                    │ Cloud Gateway│  (Router + Controller)
                    │   (Wired)    │
                    └──┬───┬───┬───┘
                       │   │   │
            ┌──────────┘   │   └──────────┐
            │              │              │
     ┌──────┴──────┐ ┌────┴─────┐ ┌──────┴──────┐
     │ Family Room │ │ Rec Room │ │  Dock Area  │
     │     AP      │ │    AP    │ │   AC Pro    │
     │  (Wired)    │ │ (Wired)  │ │  (Wired)    │
     └─────────────┘ └──────────┘ └─────────────┘
            │
            │  ~~~~ wireless mesh ~~~~
            │
     ┌──────┴──────┐        ┌─────────────┐
     │  Upstairs   │        │  UDB Pro    │
     │     AP      │        │  (Wired)    │
     │  (MESH)     │        └─────────────┘
     └─────────────┘
     ⚠️ Needs ethernet
```

---

## Action Items

- [ ] **Run ethernet to Upstairs AP** — Eliminates the mesh bottleneck, fixes speed test drops
- [ ] **Monitor TX retry rates** — Check weekly in Devices → Insights; should stay under 10%
- [ ] **Consider separate SSIDs** — One for 2.4 GHz, one for 5 GHz, to prevent band-hopping during tests
- [ ] **Firmware updates** — Keep all APs on latest stable firmware (check Devices for update badges)

---

## Credentials & Access

- **UniFi Site Manager**: https://unifi.ui.com → sign in as `marvelousho`
- **2FA**: Required — code comes via Fastmail (marvho@marvho.ai)
- **Controller type**: Cloud Gateway (direct cloud access, no self-hosted controller)
- **Local controller access**: May be available at `https://<gateway-ip>` on the LAN

---

*Generated by marvbot from troubleshooting sessions March 31 – April 1, 2026*
