#!/usr/bin/env swift
//
// reminders.swift — Query macOS Reminders.app via EventKit, output JSON.
//
// Usage: swift scripts/reminders.swift [--list "List Name"]
//   --list NAME   Only fetch reminders from this list (default: all lists)
//
// Output: JSON array of incomplete reminders to stdout.
// On error: {"error": "description"} to stdout, exit 1.
//

import EventKit
import Foundation

// ── Argument parsing ────────────────────────────────────────

var filterList: String? = nil
let args = CommandLine.arguments
if let idx = args.firstIndex(of: "--list"), idx + 1 < args.count {
    filterList = args[idx + 1]
}

// ── EventKit setup ──────────────────────────────────────────

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)
var accessGranted = false
var accessError: Error?

if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { granted, error in
        accessGranted = granted
        accessError = error
        semaphore.signal()
    }
} else {
    store.requestAccess(to: .reminder) { granted, error in
        accessGranted = granted
        accessError = error
        semaphore.signal()
    }
}

semaphore.wait()

guard accessGranted else {
    let msg = accessError?.localizedDescription ?? "Reminders access denied. Grant access in System Settings > Privacy & Security > Reminders."
    let errorJSON: [String: String] = ["error": msg]
    if let data = try? JSONSerialization.data(withJSONObject: errorJSON),
       let str = String(data: data, encoding: .utf8) {
        print(str)
    } else {
        print("{\"error\":\"Reminders access denied\"}")
    }
    exit(1)
}

// ── Query reminders ─────────────────────────────────────────

var calendars: [EKCalendar]? = nil
if let filterList = filterList {
    calendars = store.calendars(for: .reminder).filter { $0.title == filterList }
    if calendars?.isEmpty ?? true {
        print("{\"error\":\"Reminder list '\\(filterList)' not found\"}")
        exit(1)
    }
}

let predicate = store.predicateForIncompleteReminders(
    withDueDateStarting: nil,
    ending: nil,
    calendars: calendars
)

let fetchSemaphore = DispatchSemaphore(value: 0)
var reminders: [EKReminder]? = nil

store.fetchReminders(matching: predicate) { items in
    reminders = items
    fetchSemaphore.signal()
}

fetchSemaphore.wait()

guard let fetchedReminders = reminders else {
    print("{\"error\":\"Failed to fetch reminders\"}")
    exit(1)
}

// ── Format output ───────────────────────────────────────────

let dateFormatter = DateFormatter()
dateFormatter.dateFormat = "yyyy-MM-dd"
dateFormatter.locale = Locale(identifier: "en_US_POSIX")

var results: [[String: Any]] = []

for reminder in fetchedReminders {
    var entry: [String: Any] = [
        "title": reminder.title ?? "(No title)",
        "list": reminder.calendar.title,
        "priority": reminder.priority   // 0 = none, 1 = high, 5 = medium, 9 = low
    ]

    if let dueDate = reminder.dueDateComponents,
       let date = Calendar.current.date(from: dueDate) {
        entry["dueDate"] = dateFormatter.string(from: date)
    }

    if reminder.hasNotes, let notes = reminder.notes {
        entry["notes"] = String(notes.prefix(100))
    }

    results.append(entry)
}

// Sort: by priority (high first), then by due date, then alphabetically
results.sort { a, b in
    let aPri = a["priority"] as? Int ?? 0
    let bPri = b["priority"] as? Int ?? 0
    // Priority: 1 (high) < 5 (medium) < 9 (low) < 0 (none)
    let aNorm = aPri == 0 ? 99 : aPri
    let bNorm = bPri == 0 ? 99 : bPri
    if aNorm != bNorm { return aNorm < bNorm }
    let aDate = a["dueDate"] as? String ?? "9999-99-99"
    let bDate = b["dueDate"] as? String ?? "9999-99-99"
    if aDate != bDate { return aDate < bDate }
    let aTitle = a["title"] as? String ?? ""
    let bTitle = b["title"] as? String ?? ""
    return aTitle < bTitle
}

// ── Output JSON ─────────────────────────────────────────────

do {
    let data = try JSONSerialization.data(withJSONObject: results, options: [.sortedKeys])
    if let str = String(data: data, encoding: .utf8) {
        print(str)

        // Write to cache file (same pattern as calendar-events.swift)
        let cacheDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".cache/kithkit")
        try? FileManager.default.createDirectory(at: cacheDir, withIntermediateDirectories: true)
        let cachePath = cacheDir.appendingPathComponent("reminders.json")
        let cacheEntry: [String: Any] = [
            "reminders": results,
            "cached_at": ISO8601DateFormatter().string(from: Date()),
            "count": results.count
        ]
        if let cacheData = try? JSONSerialization.data(withJSONObject: cacheEntry, options: [.sortedKeys]),
           let cacheStr = String(data: cacheData, encoding: .utf8) {
            try? cacheStr.write(to: cachePath, atomically: true, encoding: .utf8)
        }
    } else {
        print("[]")
    }
} catch {
    print("{\"error\":\"JSON serialization failed: \(error.localizedDescription)\"}")
    exit(1)
}
