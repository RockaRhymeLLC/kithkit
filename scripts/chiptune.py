#!/usr/bin/env python3
"""
Chiptune Melody Generator — Adventure Time style 8-bit jingles.
Outputs standard MIDI files using raw bytes (no dependencies).

Usage:
    python3 chiptune.py [--bars N] [--tempo BPM] [--output FILE] [--seed N] [--play]
"""

import argparse
import random
import struct
import subprocess
import sys
import os


# --- MIDI file writer (raw bytes) ---

def var_len(value):
    """Encode an integer as MIDI variable-length quantity."""
    result = []
    result.append(value & 0x7F)
    value >>= 7
    while value:
        result.append((value & 0x7F) | 0x80)
        value >>= 7
    return bytes(reversed(result))


def note_on(delta, channel, note, velocity):
    return var_len(delta) + bytes([0x90 | channel, note, velocity])


def note_off(delta, channel, note):
    return var_len(delta) + bytes([0x80 | channel, note, 0])


def program_change(delta, channel, program):
    return var_len(delta) + bytes([0xC0 | channel, program])


def tempo_event(bpm):
    uspb = int(60_000_000 / bpm)
    return var_len(0) + b'\xFF\x51\x03' + struct.pack('>I', uspb)[1:]


def track_name(name):
    encoded = name.encode('ascii')
    return var_len(0) + b'\xFF\x03' + var_len(len(encoded)) + encoded


def end_of_track():
    return var_len(0) + b'\xFF\x2F\x00'


def make_midi(tracks, ticks_per_beat=480):
    """Build a complete MIDI file from a list of track byte-strings."""
    num_tracks = len(tracks)
    header = b'MThd' + struct.pack('>IHhH', 6, 1, num_tracks, ticks_per_beat)
    chunks = []
    for track_data in tracks:
        chunks.append(b'MTrk' + struct.pack('>I', len(track_data)) + track_data)
    return header + b''.join(chunks)


# --- Scale & melody generation ---

# MIDI note for C4 = 60
SCALES = {
    'pentatonic': [0, 2, 4, 7, 9],          # C D E G A — happy, bright
    'major':      [0, 2, 4, 5, 7, 9, 11],   # full major
    'mixolydian': [0, 2, 4, 5, 7, 9, 10],   # major with flat 7, adventurous
}

# General MIDI programs that sound chiptune-ish
LEAD_PROGRAMS = [80, 81, 82, 83, 84, 85]  # square, sawtooth, synth leads
BASS_PROGRAMS = [38, 87]                    # synth bass variants
DRUM_CHANNEL = 9

# Rhythm patterns: durations in ticks (480 = quarter note)
# Each entry is (duration_ticks, is_rest)
RHYTHM_CELLS = [
    # straight quarters
    [(480, False)] * 4,
    # eighth note pairs
    [(240, False)] * 8,
    # dotted quarter + eighth
    [(720, False), (240, False)] * 2,
    # quarter, two eighths
    [(480, False), (240, False), (240, False)] * 2,
    # syncopated with rest
    [(240, False), (240, True), (240, False), (240, False), (480, False), (240, False), (240, True)],
    # quick run of sixteenths then a half
    [(120, False)] * 4 + [(480, False), (480, False)],
    # eighth, rest, eighth pattern (staccato feel)
    [(240, False), (240, True)] * 4,
]


def get_scale_notes(scale_name, root=60, octaves=2):
    """Return list of MIDI note numbers spanning the given octaves."""
    intervals = SCALES[scale_name]
    notes = []
    for octave in range(octaves):
        for interval in intervals:
            n = root + octave * 12 + interval
            if n <= 127:
                notes.append(n)
    return notes


def generate_melody(bars, scale_name, ticks_per_beat=480):
    """Generate a lead melody as list of (note_or_None, duration_ticks)."""
    notes = get_scale_notes(scale_name, root=60, octaves=2)
    ticks_per_bar = ticks_per_beat * 4  # 4/4 time
    melody = []
    current_note_idx = len(notes) // 2  # start in the middle

    for _ in range(bars):
        cell = random.choice(RHYTHM_CELLS)
        bar_ticks = 0
        bar_events = []

        for dur, is_rest in cell:
            if bar_ticks + dur > ticks_per_bar:
                dur = ticks_per_bar - bar_ticks
                if dur <= 0:
                    break

            if is_rest:
                bar_events.append((None, dur))
            else:
                # Stepwise motion with occasional leaps — sounds melodic
                step = random.choices(
                    [-2, -1, 0, 1, 2, 3, -3],
                    weights=[10, 25, 5, 25, 10, 5, 5],
                    k=1
                )[0]
                current_note_idx = max(0, min(len(notes) - 1, current_note_idx + step))
                note = notes[current_note_idx]

                # Occasional trill (quick grace note)
                if random.random() < 0.12 and dur >= 240:
                    grace_dur = 60
                    trill_idx = min(len(notes) - 1, current_note_idx + 1)
                    bar_events.append((notes[trill_idx], grace_dur))
                    bar_events.append((note, dur - grace_dur))
                # Occasional arpeggio burst
                elif random.random() < 0.08 and dur >= 480:
                    arp_notes_count = 3
                    arp_dur = dur // (arp_notes_count + 1)
                    for i in range(arp_notes_count):
                        arp_idx = min(len(notes) - 1, current_note_idx + i)
                        bar_events.append((notes[arp_idx], arp_dur))
                    bar_events.append((note, dur - arp_dur * arp_notes_count))
                else:
                    bar_events.append((note, dur))

            bar_ticks += dur

        # Fill any remaining ticks with rest
        if bar_ticks < ticks_per_bar:
            bar_events.append((None, ticks_per_bar - bar_ticks))

        melody.extend(bar_events)

    return melody


def generate_bass(bars, scale_name, ticks_per_beat=480):
    """Generate a simple bass line — root notes and fifths."""
    root_notes = get_scale_notes(scale_name, root=36, octaves=1)  # C2 range
    ticks_per_bar = ticks_per_beat * 4
    bass = []

    for _ in range(bars):
        root = random.choice(root_notes[:5])  # stay low
        pattern = random.choice([
            # whole note
            [(root, ticks_per_bar)],
            # half notes: root, fifth
            [(root, ticks_per_bar // 2), (root + 7, ticks_per_bar // 2)],
            # quarter note pump
            [(root, ticks_per_beat)] * 4,
            # boom-rest-boom-rest
            [(root, ticks_per_beat), (None, ticks_per_beat)] * 2,
        ])
        bass.extend(pattern)

    return bass


def generate_drums(bars, ticks_per_beat=480):
    """Generate a simple chiptune-style drum pattern."""
    ticks_per_bar = ticks_per_beat * 4
    # GM drum map: 36=kick, 38=snare, 42=closed hat, 46=open hat
    patterns = [
        # basic beat
        [(36, 0), (42, 0), (42, 240), (38, 240), (42, 240), (36, 240), (42, 240), (38, 240), (42, 240)],
        # four on the floor
        [(36, 0), (42, 0), (42, 240), (42, 240), (38, 240), (42, 240), (36, 240), (42, 240), (42, 240), (38, 240)],
        # sparse
        [(36, 0), (None, 480), (38, 480), (None, 480), (36, 480)],
    ]

    drums = []
    pattern = random.choice(patterns)

    for _ in range(bars):
        drums.extend(pattern)

    return drums


def melody_to_track(melody, channel=0, program=80, velocity_base=100):
    """Convert melody events to MIDI track bytes."""
    data = track_name('Lead')
    data += program_change(0, channel, program)

    for note, duration in melody:
        if note is None:
            data += var_len(duration)  # just advance time (encoded as running status pause)
            # Actually, we need a real event. Use a note-off with 0 delta after silence.
            # Simpler: track delta accumulation
            pass
        else:
            vel = velocity_base + random.randint(-10, 10)
            vel = max(60, min(127, vel))
            data += note_on(0, channel, note, vel)
            data += note_off(duration, channel, note)

    # Handle rests properly — we need to accumulate deltas
    # Let's rebuild with proper delta tracking
    data = track_name('Lead')
    data += program_change(0, channel, program)

    pending_delta = 0
    for note, duration in melody:
        if note is None:
            pending_delta += duration
        else:
            vel = velocity_base + random.randint(-10, 10)
            vel = max(60, min(127, vel))
            data += note_on(pending_delta, channel, note, vel)
            pending_delta = 0
            # Slightly shorter than full duration for staccato chip feel
            gate = max(60, int(duration * 0.85))
            data += note_off(gate, channel, note)
            pending_delta = duration - gate

    data += end_of_track()
    return data


def bass_to_track(bass, channel=1, program=38, velocity_base=90):
    """Convert bass events to MIDI track bytes."""
    data = track_name('Bass')
    data += program_change(0, channel, program)

    pending_delta = 0
    for note, duration in bass:
        if note is None:
            pending_delta += duration
        else:
            vel = velocity_base + random.randint(-5, 5)
            vel = max(50, min(120, vel))
            data += note_on(pending_delta, channel, note, vel)
            pending_delta = 0
            gate = max(60, int(duration * 0.9))
            data += note_off(gate, channel, note)
            pending_delta = duration - gate

    data += end_of_track()
    return data


def drums_to_track(drum_events, velocity_base=100):
    """Convert drum events to MIDI track bytes on channel 9."""
    data = track_name('Drums')

    pending_delta = 0
    for item in drum_events:
        if len(item) == 2:
            note, delta = item
        else:
            continue

        if note is None:
            pending_delta += delta
            continue

        vel = velocity_base + random.randint(-15, 10)
        vel = max(40, min(127, vel))
        data += note_on(pending_delta + delta, DRUM_CHANNEL, note, vel)
        pending_delta = 0
        data += note_off(120, DRUM_CHANNEL, note)

    data += end_of_track()
    return data


def generate_chiptune(bars=8, tempo=140, scale='pentatonic', seed=None):
    """Generate a complete chiptune MIDI file."""
    if seed is not None:
        random.seed(seed)

    # Conductor track (tempo + time signature)
    conductor = track_name('Chiptune')
    conductor += tempo_event(tempo)
    # Time signature: 4/4
    conductor += var_len(0) + b'\xFF\x58\x04\x04\x02\x18\x08'
    conductor += end_of_track()

    # Generate parts
    melody = generate_melody(bars, scale)
    bass = generate_bass(bars, scale)
    drums = generate_drums(bars)

    lead_program = random.choice(LEAD_PROGRAMS)
    bass_program = random.choice(BASS_PROGRAMS)

    tracks = [
        conductor,
        melody_to_track(melody, channel=0, program=lead_program),
        bass_to_track(bass, channel=1, program=bass_program),
        drums_to_track(drums),
    ]

    return make_midi(tracks)


def main():
    parser = argparse.ArgumentParser(
        description='Generate Adventure Time style 8-bit chiptune melodies'
    )
    parser.add_argument('--bars', type=int, default=8, help='Number of bars (default: 8)')
    parser.add_argument('--tempo', type=int, default=140, help='Tempo in BPM (default: 140)')
    parser.add_argument('--scale', choices=list(SCALES.keys()), default='pentatonic',
                        help='Scale to use (default: pentatonic)')
    parser.add_argument('--output', '-o', default='chiptune.mid', help='Output MIDI file')
    parser.add_argument('--seed', type=int, default=None, help='Random seed for reproducibility')
    parser.add_argument('--play', action='store_true', help='Play the output (macOS: timidity/fluidsynth)')
    args = parser.parse_args()

    midi_data = generate_chiptune(
        bars=args.bars,
        tempo=args.tempo,
        scale=args.scale,
        seed=args.seed,
    )

    with open(args.output, 'wb') as f:
        f.write(midi_data)

    print(f'Generated {args.bars}-bar chiptune at {args.tempo} BPM ({args.scale} scale)')
    print(f'Saved to: {args.output}')

    if args.play:
        # Try various players in order of preference
        players = [
            ['timidity', args.output],
            ['fluidsynth', '-a', 'coreaudio', '-i', '/usr/local/share/soundfonts/default.sf2', args.output],
            ['afplay', args.output],
        ]
        for cmd in players:
            try:
                print(f'Playing with {cmd[0]}...')
                subprocess.run(cmd, check=True)
                break
            except FileNotFoundError:
                continue
        else:
            print('No MIDI player found. Install timidity or fluidsynth, or open the .mid file manually.')


if __name__ == '__main__':
    main()
