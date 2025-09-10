import socket
import pyodbc
import re
from datetime import datetime
import time

# --- Kết nối database ---
def connect_db():
    return pyodbc.connect(
        "DRIVER={ODBC Driver 17 for SQL Server};"
        "SERVER=(localdb)\\MSSQLLocalDB;"
        "DATABASE=DashboardDB;"
        "Trusted_Connection=yes;"
    )

def insert_data(device_id, status):
    try:
        conn = connect_db()
        cursor = conn.cursor()
        now = datetime.now()
        cursor.execute("""
            INSERT INTO ProductionStatus (device_id, status, created_at)
            VALUES (?, ?, ?)
        """, (device_id, status, now))
        conn.commit()
        cursor.close()
        conn.close()
        print(f"✅ Đã lưu vào DB: {device_id} | {status} | {now}")
    except Exception as e:
        print("❌ Lỗi khi lưu DB:", e)

# --- Parse line: extract device and status ---
def parse_line(line):
    """
    Trả về tuple (device_or_None, status_or_None)
    - device: ví dụ 'M1', 'S1', 'SN123', 'SN'
    - status: 'Pass' hoặc 'Fail' (Chuẩn hoá)
    Logic:
      - Loại bỏ prefix log như [2025-..] [Info] ...:
      - Tìm token PASS/FAIL (case-insensitive)
      - Tìm token device theo thứ tự ưu tiên:
          1) [SM]\d+ (ví dụ M1, S2)
          2) SN:xxx or SNxxx or SN-xxx or plain SN
          3) nếu token đầu không phải PASS/FAIL thì lấy token đầu
    """
    if not line:
        return (None, None)

    s = line.strip()

    # Remove leading bracketed log prefixes like [2025-09-10 ...] [Info] ...:
    # remove repeated bracket groups and trailing colon
    while s.startswith('['):
        m = re.match(r'^\[[^\]]*\]\s*', s)
        if not m:
            break
        s = s[m.end():].lstrip()
    # remove any prefix up to last ':' if it's part of log header
    if ':' in s and re.match(r'^[^:]{0,80}:\s*', s):
        # heuristic: if there is a "):" pattern earlier (like "...): SN Fail") remove header
        # remove everything up to last ') :' or up to first ': ' if header-like
        # Try to remove header ending with '):' first
        if '):' in line:
            s = s.split('):', 1)[1].strip()
        else:
            # remove first "timestamp-like" header if present
            parts = s.split(':', 1)
            if len(parts) == 2 and re.search(r'[A-Za-z]', parts[1]):
                s = parts[1].strip()

    # Split tokens
    tokens = [t for t in re.split(r'\s+|,|;|\||\t', s) if t]
    if not tokens:
        return (None, None)

    # Normalize tokens for matching
    tokens_upper = [t.upper() for t in tokens]

    # Find status token (PASS/FAIL)
    status = None
    for i, tok in enumerate(tokens_upper):
        if tok in ("PASS", "FAIL"):
            status = "Pass" if tok == "PASS" else "Fail"
            # remove tokens around? not necessary here
            break

    # Find device token:
    device = None

    # 1) look for S/M + digits (e.g. M1, S2)
    for t in tokens:
        if re.match(r'^[SM]\d+$', t, re.IGNORECASE):
            device = t.upper()
            break

    # 2) look for SN patterns: SN123, SN:1234, SN-ABC, or token exactly 'SN'
    if not device:
        for t in tokens:
            m = re.match(r'^(SN[:\-]?\s*([A-Za-z0-9\-]+))$', t, re.IGNORECASE)
            if m:
                # If token like SN:123 or SN-123 or SN123
                # normalize to SN + captured
                raw = m.group(0)
                # remove spaces after colon/hyphen
                device = raw.replace(':', '').replace('-', '').replace(' ', '').upper()
                break
        # if none matched but the first token is literally 'SN' then use 'SN'
        if not device and tokens_upper[0] == 'SN':
            device = 'SN'

    # 3) fallback: if first token looks like a device and not a PASS/FAIL, use it
    if not device:
        first_tok = tokens[0]
        if first_tok.upper() not in ("PASS", "FAIL"):
            # avoid setting to common words like INFO, TCPCLIENT, etc.
            if not re.match(r'^[A-Z]{2,}$', first_tok) or re.match(r'^[SM]\d+$', first_tok, re.IGNORECASE) or first_tok.upper().startswith('SN'):
                device = first_tok

    return (device, status)


# --- TCP Client ---
SERVER_IP = "127.0.0.1"
SERVER_PORT = 10002

def run_client(retry_delay=5):
    while True:
        try:
            client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            client.settimeout(10)
            client.connect((SERVER_IP, SERVER_PORT))
            client.settimeout(None)  # normal blocking
            print(f"Đã kết nối tới {SERVER_IP}:{SERVER_PORT}")

            buffer = ""
            current_device = None  # lưu tên máy hiện tại

            while True:
                data = client.recv(4096)
                if not data:
                    # server closed? try reconnect
                    print("⚠️ Kết nối bị đóng bởi server, thử kết nối lại...")
                    client.close()
                    break
                # decode and preserve potential multi-line
                text = data.decode("utf-8", errors="ignore")
                # append to buffer then splitlines
                buffer += text
                lines = buffer.splitlines()
                # if last char not newline, keep last partial in buffer
                if not buffer.endswith("\n") and not buffer.endswith("\r"):
                    buffer = lines.pop() if lines else ""
                else:
                    buffer = ""

                for line in lines:
                    line = line.strip()
                    if not line:
                        continue
                    print(f"📩 Nhận: {line}")

                    # parse
                    device_token, status_token = parse_line(line)
                    # if parse returns device but no status: treat as current device update
                    if device_token and not status_token:
                        current_device = device_token
                        print(f"➡️ Cập nhật thiết bị hiện tại: {current_device}")
                        continue

                    # if status present but device missing -> use last current_device
                    if status_token:
                        if device_token:
                            # if message includes both device & status, prefer that device and update current_device
                            current_device = device_token
                        if current_device is None:
                            print("⚠️ Chưa có device_id, bỏ qua (không tìm thấy thiết bị trong dòng và cũng chưa có device hiện tại)")
                            continue
                        # insert
                        insert_data(current_device, status_token)
                        # send ACK back
                        try:
                            client.sendall(b"ACK\n")
                            print("↩️ Đã gửi ACK về server TCP")
                        except Exception as e:
                            print("⚠️ Lỗi khi gửi ACK:", e)
                    else:
                        # nothing to do
                        print("⚠️ Dòng không chứa Pass/Fail và không phải cập nhật device")

        except Exception as ex:
            print("❌ Lỗi kết nối hoặc runtime:", ex)
            try:
                client.close()
            except:
                pass
            print(f"⏳ Thử kết nối lại sau {retry_delay}s...")
            time.sleep(retry_delay)

if __name__ == "__main__":
    run_client()
