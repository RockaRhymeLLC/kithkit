#!/usr/bin/env swift
//
// calendar-events.swift — Query macOS Calendar.app via EventKit, output JSON.
//
// Usage: swift scripts/calendar-events.swift [--days N]
//   --days N   Number of days to query (default: 1 = today only)
//
// Output: JSON array of events to stdout.
// On error: {"error": "description"} to stdout, exit 1.
//

import EventKit
import Foundation

// ── Argument parsing ────────────────────────────────────────

var days = 1
let args = CommandLine.arguments
if let idx = args.firstIndex(of: "--days"), idx + 1 < args.count,
   let n = Int(args[idx + 1]), n > 0 {
    days = n
}

// ── EventKit setup ──────────────────────────────────────────

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var accessGranted = false
var accessError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { granted, error in
        accessGranted = granted
        accessError = error
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .event) { granted, error in
        accessGranted = granted
        accessError = error
        semaphore.signal()
    }
}

semaphore.wait()

guard accessGranted else {
    let msg = accessError?.localizedDescription ?? "Calendar access denied. Grant access in System Settings > Privacy & Security > Calendars."
    let errorJSON: [String: String] = ["error": msg]
    if let data = try? JSONSerialization.data(withJSONObject: errorJSON),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"error\":\"Calendar access denied\"}")
    }
    exit(1)
}

// ── Query events ────────────────────────────────────────────

let calendar = Calendar.current
let startOfToday = calendar.startOfDay(for: Date())
guard let endDate = calendar.date(byAdding: .day, value: days, to: startOfToday) else {
    print("{\"error\":\"Failed to compute date range\"}")
    exit(1)
}

let predicate = store.predicateForEvents(withStart: startOfToday, end: endDate, calendars: nil)
let events = store.events(matching: predicate)

// ── Format output ───────────────────────────────────────────

let timeFormatter = DateFormatter()
timeFormatter.dateFormat = "HH:mm"
timeFormatter.locale = Locale(identifier: "en_US_POSIX")

var results: [[String: Any]] = []

for event in events {
    var entry: [String: Any] = [
        "title": event.title ?? "(No title)",
        "allDay": event.isAllDay,
        "calendar": event.calendar.title
    ]

    if event.isAllDay {
        entry["startTime"] = ""
        entry["endTime"] = ""
    } else {
        entry["startTime"] = timeFormatter.string(from: event.startDate)
        entry["endTime"] = timeFormatter.string(from: event.endDate)
    }

    results.append(entry)
}

// Sort: all-day first, then by startTime
results.sort { a, b in
    let aAllDay = a["allDay"] as? Bool ?? false
    let bAllDay = b["allDay"] as? Bool ?? false
    if aAllDay != bAllDay { return aAllDay }
    let aTime = a["startTime"] as? String ?? ""
    let bTime = b["startTime"] as? String ?? ""
    return aTime < bTime
}

// ── Output JSON ─────────────────────────────────────────────

do {
    let data = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
    if let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("[]")
    }
} catch {
    print("{\"error\":\"JSON serialization failed: \(error.localizedDescription)\"}")
    exit(1)
}
