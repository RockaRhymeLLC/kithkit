#!/usr/bin/env python3
"""Generate voice client menu bar icons — outline (idle) and filled (active)."""

from PIL import Image, ImageDraw

# macOS menu bar icons: 18x18 @1x, 36x36 @2x
# We'll create @2x versions for retina crispness
SIZE = 36  # @2x retina


def draw_bmo(draw, filled=False):
    """Draw a tiny game console character.

    A rectangular game console icon with:
    - Rounded rectangle body
    - Screen area (upper portion) with face
    - Two dot eyes and a small smile
    - Button hints below the screen
    """
    # Colors
    if filled:
        # Active: signature teal/green
        body_fill = (100, 200, 180, 255)     # Teal body
        screen_fill = (180, 230, 210, 255)   # Lighter screen
        outline = (60, 140, 120, 255)        # Darker teal outline
        face_color = (40, 100, 80, 255)      # Dark teal for face features
        button_color = (60, 140, 120, 255)   # Button color
    else:
        # Idle: white outline (template-style)
        body_fill = None
        screen_fill = None
        outline = (255, 255, 255, 200)       # White outline
        face_color = (255, 255, 255, 200)    # White face features
        button_color = (255, 255, 255, 120)  # Dim white buttons

    # Body — rounded rectangle (leave 2px margin)
    body_rect = [4, 2, 31, 33]
    draw.rounded_rectangle(body_rect, radius=4, fill=body_fill, outline=outline, width=2)

    # Screen area — slightly inset rectangle in upper portion
    screen_rect = [8, 5, 27, 21]
    draw.rounded_rectangle(screen_rect, radius=2, fill=screen_fill, outline=outline, width=1)

    # Eyes — two small dots
    # Left eye
    draw.ellipse([12, 10, 15, 13], fill=face_color)
    # Right eye
    draw.ellipse([20, 10, 23, 13], fill=face_color)

    # Mouth — small arc/smile
    draw.arc([14, 13, 21, 19], start=0, end=180, fill=face_color, width=1)

    # Buttons below screen — D-pad (left) + action button (right)
    # D-pad: small cross
    draw.line([10, 27, 14, 27], fill=button_color, width=1)  # horizontal
    draw.line([12, 25, 12, 29], fill=button_color, width=1)  # vertical

    # Action buttons: two small dots
    draw.ellipse([22, 25, 24, 27], fill=button_color)
    draw.ellipse([26, 26, 28, 28], fill=button_color)


def create_icon(filename, filled=False):
    """Create a single icon."""
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_bmo(draw, filled=filled)
    img.save(filename, "PNG")
    print(f"Created {filename} ({SIZE}x{SIZE})")


if __name__ == "__main__":
    import os
    icon_dir = os.path.dirname(os.path.abspath(__file__))

    create_icon(os.path.join(icon_dir, "icon_idle.png"), filled=False)
    create_icon(os.path.join(icon_dir, "icon_active.png"), filled=True)

    # Also create processing and speaking variants
    # Processing: filled but with a slightly different shade
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # Use a "thinking" blue-teal
    draw.rounded_rectangle([4, 2, 31, 33], radius=4,
                           fill=(100, 180, 210, 255),
                           outline=(60, 120, 160, 255), width=2)
    draw.rounded_rectangle([8, 5, 27, 21], radius=2,
                           fill=(170, 220, 240, 255),
                           outline=(60, 120, 160, 255), width=1)
    draw.ellipse([12, 10, 15, 13], fill=(40, 80, 120, 255))
    draw.ellipse([20, 10, 23, 13], fill=(40, 80, 120, 255))
    draw.arc([14, 13, 21, 19], start=0, end=180, fill=(40, 80, 120, 255), width=1)
    draw.line([10, 27, 14, 27], fill=(60, 120, 160, 255), width=1)
    draw.line([12, 25, 12, 29], fill=(60, 120, 160, 255), width=1)
    draw.ellipse([22, 25, 24, 27], fill=(60, 120, 160, 255))
    draw.ellipse([26, 26, 28, 28], fill=(60, 120, 160, 255))
    img.save(os.path.join(icon_dir, "icon_processing.png"), "PNG")
    print(f"Created icon_processing.png ({SIZE}x{SIZE})")

    # Speaking: warm orange-ish
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([4, 2, 31, 33], radius=4,
                           fill=(200, 180, 100, 255),
                           outline=(160, 140, 60, 255), width=2)
    draw.rounded_rectangle([8, 5, 27, 21], radius=2,
                           fill=(230, 220, 170, 255),
                           outline=(160, 140, 60, 255), width=1)
    draw.ellipse([12, 10, 15, 13], fill=(100, 80, 40, 255))
    draw.ellipse([20, 10, 23, 13], fill=(100, 80, 40, 255))
    # Open mouth for speaking
    draw.ellipse([15, 14, 20, 18], fill=(100, 80, 40, 255))
    draw.line([10, 27, 14, 27], fill=(160, 140, 60, 255), width=1)
    draw.line([12, 25, 12, 29], fill=(160, 140, 60, 255), width=1)
    draw.ellipse([22, 25, 24, 27], fill=(160, 140, 60, 255))
    draw.ellipse([26, 26, 28, 28], fill=(160, 140, 60, 255))
    img.save(os.path.join(icon_dir, "icon_speaking.png"), "PNG")
    print(f"Created icon_speaking.png ({SIZE}x{SIZE})")
