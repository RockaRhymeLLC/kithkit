#!/usr/bin/env python3
"""Generate R2-D2 voice client menu bar icons — outline (idle) and filled states.

R2-D2's iconic silhouette: dome top, cylindrical body, front eye/lens.
Same 36x36 @2x retina format as the BMO icons.
"""

from PIL import Image, ImageDraw

SIZE = 36  # @2x retina


def draw_r2(draw, color_scheme):
    """Draw a tiny R2-D2 silhouette.

    Shape breakdown (36x36 canvas):
    - Dome: rounded top half (semicircle-ish)
    - Body: rectangle below dome
    - Eye/lens: circle on dome
    - Front panel details: horizontal lines and indicator lights
    - Side legs hinted by small rectangles at bottom corners
    """
    outline = color_scheme["outline"]
    body_fill = color_scheme.get("body")
    dome_fill = color_scheme.get("dome")
    detail_color = color_scheme["detail"]
    eye_color = color_scheme["eye"]
    indicator = color_scheme.get("indicator")

    # === DOME (top portion) ===
    # Dome: arc from x=8 to x=27, top of body starts at y=16
    dome_bbox = [8, 2, 27, 22]  # Ellipse bounding box — bottom half hidden by body
    # Draw full ellipse, body will overlap bottom half
    if dome_fill:
        draw.ellipse(dome_bbox, fill=dome_fill, outline=outline, width=2)
    else:
        draw.ellipse(dome_bbox, outline=outline, width=2)

    # === BODY (lower cylinder) ===
    body_rect = [8, 13, 27, 30]
    if body_fill:
        draw.rectangle(body_rect, fill=body_fill, outline=outline, width=2)
    else:
        draw.rectangle(body_rect, outline=outline, width=2)

    # Cover the dome's bottom half outline so dome + body look seamless
    if body_fill:
        draw.rectangle([10, 13, 25, 15], fill=body_fill)
    else:
        draw.rectangle([10, 13, 25, 15], fill=(0, 0, 0, 0))
        # Redraw the sides so they're continuous
        draw.line([8, 13, 8, 15], fill=outline, width=2)
        draw.line([27, 13, 27, 15], fill=outline, width=2)

    # === EYE / MAIN LENS ===
    # Big central eye on the dome — R2's signature feature
    eye_bbox = [14, 5, 21, 12]
    draw.ellipse(eye_bbox, fill=eye_color, outline=outline, width=1)
    # Inner highlight dot
    if color_scheme.get("eye_highlight"):
        draw.ellipse([16, 7, 18, 9], fill=color_scheme["eye_highlight"])

    # === FRONT PANEL DETAILS ===
    # Horizontal detail lines on body
    draw.line([11, 18, 24, 18], fill=detail_color, width=1)
    draw.line([11, 22, 24, 22], fill=detail_color, width=1)

    # Small indicator lights / vents
    if indicator:
        draw.ellipse([12, 24, 14, 26], fill=indicator)
        draw.ellipse([21, 24, 23, 26], fill=indicator)
    else:
        draw.ellipse([12, 24, 14, 26], fill=detail_color)
        draw.ellipse([21, 24, 23, 26], fill=detail_color)

    # === SIDE LEGS (bottom hints) ===
    # Left leg
    draw.rectangle([5, 26, 8, 32], fill=body_fill, outline=outline, width=1)
    # Right leg
    draw.rectangle([27, 26, 30, 32], fill=body_fill, outline=outline, width=1)
    # Center leg (small, between the side legs)
    draw.rectangle([15, 29, 20, 33], fill=body_fill, outline=outline, width=1)


def create_icons(output_dir):
    """Create all four state icons."""
    import os

    states = {
        "icon_idle.png": {
            # White outline — template mode (macOS auto-colors for dark/light)
            "outline": (255, 255, 255, 200),
            "body": None,
            "dome": None,
            "detail": (255, 255, 255, 120),
            "eye": (255, 255, 255, 160),
            "eye_highlight": None,
            "indicator": (255, 255, 255, 100),
        },
        "icon_active.png": {
            # Listening: R2's signature blue/silver
            "outline": (40, 80, 160, 255),
            "body": (180, 195, 220, 255),      # Silver-blue body
            "dome": (120, 150, 200, 255),       # Blue dome
            "detail": (40, 80, 160, 255),       # Blue details
            "eye": (60, 60, 70, 255),           # Dark lens
            "eye_highlight": (200, 200, 220, 255),
            "indicator": (80, 130, 220, 255),   # Bright blue indicators
        },
        "icon_processing.png": {
            # Processing/thinking: warm amber (different from idle to show activity)
            "outline": (160, 120, 40, 255),
            "body": (220, 200, 150, 255),       # Warm silver
            "dome": (200, 180, 120, 255),       # Amber dome
            "detail": (160, 120, 40, 255),
            "eye": (80, 60, 30, 255),
            "eye_highlight": (240, 220, 160, 255),
            "indicator": (220, 180, 60, 255),   # Amber lights
        },
        "icon_speaking.png": {
            # Speaking: bright green (R2's happy chirps)
            "outline": (40, 140, 80, 255),
            "body": (170, 220, 180, 255),       # Light green body
            "dome": (100, 190, 130, 255),       # Green dome
            "detail": (40, 140, 80, 255),
            "eye": (30, 80, 50, 255),
            "eye_highlight": (180, 240, 200, 255),
            "indicator": (60, 200, 100, 255),   # Bright green lights
        },
    }

    for filename, scheme in states.items():
        img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)
        draw_r2(draw, scheme)
        path = os.path.join(output_dir, filename)
        img.save(path, "PNG")
        print(f"Created {filename} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    import os
    # Default: save to same directory as this script
    icon_dir = os.path.dirname(os.path.abspath(__file__))
    # But if called with an argument, use that as output dir
    import sys
    if len(sys.argv) > 1:
        icon_dir = sys.argv[1]
        os.makedirs(icon_dir, exist_ok=True)
    create_icons(icon_dir)
