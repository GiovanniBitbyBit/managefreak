# Genera assets/icon.png (512x512) — esagono arancione con onda, stile MicroFreak
import struct, zlib, math, os

W = H = 512

BG = (22, 22, 30)          # #16161e
HEX = (255, 138, 61)       # #ff8a3d (accento)
WAVE = (22, 22, 30)        # onda in negativo sull'esagono
BORDER = (232, 230, 240)   # contorno

def in_hex(x, y, cx, cy, r):
    # esagono regolare pointy-top? usiamo flat-top per compattezza
    q2x = 3.0 ** 0.5
    dx = abs(x - cx)
    dy = abs(y - cy)
    return dx <= r * q2x / 2 and dy <= r and (dx * 0.5 + dy * q2x / 2) <= r * q2x / 2

def wave_y(x, cx, r, amp, freq, phase):
    return cy + amp * math.sin(freq * (x - cx) / r + phase)

cx = cy = W / 2
R = 210

pixels = bytearray()
for y in range(H):
    pixels.append(0)  # filtro 0
    for x in range(W):
        if in_hex(x, y, cx, cy, R):
            # onda: banda attorno a sin
            wy = wave_y(x, cx, R, 55, 3.2, 0.0)
            if abs(y - wy) < 14:
                c = WAVE
            elif in_hex(x, y, cx, cy, R - 26) and not in_hex(x, y, cx, cy, R - 46):
                c = BORDER  # anello interno
            else:
                c = HEX
        else:
            c = BG
        pixels.extend(c)
        pixels.append(255)

def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

ihdr = struct.pack('>IIBBBBB', W, H, 8, 6, 0, 0, 0)  # 8 bit RGBA
png = b'\x89PNG\r\n\x1a\n'
png += chunk(b'IHDR', ihdr)
png += chunk(b'IDAT', zlib.compress(bytes(pixels), 9))
png += chunk(b'IEND', b'')

os.makedirs('assets', exist_ok=True)
with open('assets/icon.png', 'wb') as f:
    f.write(png)
print('icon.png', len(png), 'bytes')
