# backend.py
import os
import pyodbc
import datetime
import calendar
import traceback
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List
import uvicorn

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")

app = FastAPI(title="Dashboard API (ProductionStatus)")

# Serve index.html at root
@app.get("/")
async def root():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))

# Mount static at /static (do NOT mount at "/")
if os.path.isdir(FRONTEND_DIR):
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
    print(f"[INFO] Serving static files from: {FRONTEND_DIR} at /static")
else:
    print(f"[WARN] Frontend folder not found: {FRONTEND_DIR}")

# Connection string - update if needed or set env SQLSERVER_CONN
CONN_STR = os.environ.get("SQLSERVER_CONN") or (
    "DRIVER={ODBC Driver 17 for SQL Server};"
    "SERVER=(localdb)\\MSSQLLocalDB;"
    "DATABASE=DashboardDB;"
    "Trusted_Connection=yes;"
)
print("[INFO] Using connection string:", CONN_STR)


def get_conn():
    return pyodbc.connect(CONN_STR, timeout=10)


# Ensure required tables exist
def ensure_tables_exist():
    conn = None
    try:
        conn = get_conn()
        cur = conn.cursor()

        # devices
        cur.execute("""
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[devices]') AND type in (N'U'))
        BEGIN
            CREATE TABLE dbo.devices (
                id INT IDENTITY(1,1) PRIMARY KEY,
                name NVARCHAR(200) NOT NULL,
                status INT NOT NULL DEFAULT 1,
                last_seen DATETIME2 NULL
            );
        END
        """)
        conn.commit()

        # ProductionStatus
        cur.execute("""
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[ProductionStatus]') AND type in (N'U'))
        BEGIN
            CREATE TABLE dbo.ProductionStatus (
                id INT IDENTITY(1,1) PRIMARY KEY,
                device_id NVARCHAR(100) NOT NULL,
                status NVARCHAR(20) NOT NULL,
                created_at DATETIME2 NOT NULL
            );
            CREATE INDEX IX_ProductionStatus_created_at ON dbo.ProductionStatus(created_at);
            CREATE INDEX IX_ProductionStatus_device_id ON dbo.ProductionStatus(device_id);
        END
        """)
        conn.commit()

        # DailyMetrics (one row per device per date)
        cur.execute("""
        IF NOT EXISTS (SELECT * FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[DailyMetrics]') AND type in (N'U'))
        BEGIN
            CREATE TABLE dbo.DailyMetrics (
                id INT IDENTITY(1,1) PRIMARY KEY,
                device_id NVARCHAR(100) NOT NULL,
                [date] DATE NOT NULL,
                metric NVARCHAR(200) NULL,
                CONSTRAINT UQ_DailyMetrics UNIQUE (device_id, [date])
            );
            CREATE INDEX IX_DailyMetrics_date ON dbo.DailyMetrics([date]);
        END
        """)
        conn.commit()

    except Exception as e:
        print("[WARN] ensure_tables_exist:", e)
    finally:
        if conn:
            conn.close()


ensure_tables_exist()

# Models
class DeviceIn(BaseModel):
    name: str


class DeviceOut(BaseModel):
    id: int
    name: str
    status: int
    last_seen: Optional[str] = None


class StatusIn(BaseModel):
    device_id: str
    status: str
    created_at: Optional[datetime.datetime] = None


class DailyMetricIn(BaseModel):
    device_id: str
    date: str
    metric: Optional[str] = None


# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # restrict in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def make_device_filter_clause(device: Optional[str]):
    if device:
        return " AND device_id = ? ", [device]
    return "", []


# Devices endpoints
@app.get("/devices", response_model=List[DeviceOut])
def list_devices():
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT id, name, status, last_seen FROM devices ORDER BY id")
        rows = cur.fetchall()
        out = []
        for r in rows:
            last = None
            if r.last_seen:
                try:
                    last = r.last_seen.isoformat()
                except:
                    last = str(r.last_seen)
            out.append({"id": int(r.id), "name": r.name, "status": int(r.status), "last_seen": last})
        return out
    finally:
        conn.close()


@app.post("/devices", response_model=DeviceOut)
def add_device(d: DeviceIn):
    conn = get_conn()
    try:
        cur = conn.cursor()
        now = datetime.datetime.utcnow()
        cur.execute("INSERT INTO devices (name, status, last_seen) VALUES (?, ?, ?)", (d.name, 1, now))
        conn.commit()
        cur.execute("SELECT TOP 1 id, name, status, last_seen FROM devices ORDER BY id DESC")
        r = cur.fetchone()
        last = r.last_seen.isoformat() if r.last_seen else None
        return {"id": int(r.id), "name": r.name, "status": int(r.status), "last_seen": last}
    finally:
        conn.close()


@app.delete("/devices/{device_id}")
def delete_device(device_id: int):
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM devices WHERE id = ?", (device_id,))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


@app.put("/devices/{device_id}/status")
def update_device_status(device_id: int, status: int = Query(..., description="0 or 1")):
    if status not in (0, 1):
        raise HTTPException(status_code=400, detail="status must be 0 or 1")
    conn = get_conn()
    try:
        cur = conn.cursor()
        now = datetime.datetime.utcnow()
        cur.execute("UPDATE devices SET status = ?, last_seen = ? WHERE id = ?", (status, now, device_id))
        conn.commit()
        return {"ok": True}
    finally:
        conn.close()


# ingest ProductionStatus
@app.post("/status")
def post_status(s: StatusIn):
    conn = get_conn()
    try:
        cur = conn.cursor()
        ts = s.created_at or datetime.datetime.utcnow()
        cur.execute("INSERT INTO ProductionStatus (device_id, status, created_at) VALUES (?, ?, ?)",
                    (s.device_id, s.status, ts))
        conn.commit()
        # simple ack
        return {"ok": True}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()


# Data endpoints with optional ?device=...
@app.get("/data/day/{date_str}")
def data_day(date_str: str, device: Optional[str] = None):
    # date_str: YYYY-MM-DD
    try:
        datetime.date.fromisoformat(date_str)
    except Exception:
        raise HTTPException(status_code=400, detail="date_str must be YYYY-MM-DD")
    conn = get_conn()
    try:
        cur = conn.cursor()
        clause, params = make_device_filter_clause(device)
        q = f"""
            SELECT DATEPART(hour, created_at) as hr,
                   SUM(CASE WHEN status = 'Pass' THEN 1 ELSE 0 END) as pass_sum,
                   SUM(CASE WHEN status = 'Fail' THEN 1 ELSE 0 END) as fail_sum
            FROM ProductionStatus
            WHERE CONVERT(varchar(10), created_at, 120) = ? {clause}
            GROUP BY DATEPART(hour, created_at)
        """
        exec_params = (date_str, *params) if params else (date_str,)
        cur.execute(q, exec_params)
        rows = cur.fetchall()
        pass_arr = [0] * 24
        fail_arr = [0] * 24
        for r in rows:
            hr = int(r[0]) if r[0] is not None else 0
            if 0 <= hr < 24:
                pass_arr[hr] = int(r[1] or 0)
                fail_arr[hr] = int(r[2] or 0)
        return {"date": date_str, "hours": list(range(24)), "pass": pass_arr, "fail": fail_arr}
    finally:
        conn.close()


@app.get("/data/week/{year}/{month}/{week}")
def data_week(year: int, month: int, week: int, device: Optional[str] = None):
    try:
        year = int(year); month = int(month); week = int(week)
        days_in_month = calendar.monthrange(year, month)[1]
        start_day = (week - 1) * 7 + 1
        end_day = min(start_day + 6, days_in_month)
        start_date = datetime.date(year, month, start_day)
        end_date = datetime.date(year, month, end_day)

        clause, params = make_device_filter_clause(device)
        q = f"""
            SELECT CONVERT(varchar(10), created_at, 120) as d,
                   SUM(CASE WHEN status='Pass' THEN 1 ELSE 0 END) as pass_sum,
                   SUM(CASE WHEN status='Fail' THEN 1 ELSE 0 END) as fail_sum
            FROM ProductionStatus
            WHERE CONVERT(varchar(10), created_at, 120) BETWEEN ? AND ? {clause}
            GROUP BY CONVERT(varchar(10), created_at, 120)
            ORDER BY d
        """
        conn = get_conn()
        cur = conn.cursor()
        params_exec = [start_date.isoformat(), end_date.isoformat()] + params
        cur.execute(q, params_exec)
        rows = cur.fetchall()
        mapd = {r[0]: {"pass": int(r[1] or 0), "fail": int(r[2] or 0)} for r in rows}
        labels, pass_list, fail_list = [], [], []
        curdate = start_date
        while curdate <= end_date:
            ds = curdate.isoformat()
            labels.append(ds)
            if ds in mapd:
                pass_list.append(mapd[ds]["pass"])
                fail_list.append(mapd[ds]["fail"])
            else:
                pass_list.append(0)
                fail_list.append(0)
            curdate += datetime.timedelta(days=1)
        return {"range": f"{start_date.isoformat()} to {end_date.isoformat()}", "labels": labels, "pass": pass_list, "fail": fail_list}
    finally:
        try: conn.close()
        except: pass


@app.get("/data/month/{year}/{month}")
def data_month(year: int, month: int, device: Optional[str] = None):
    try:
        year = int(year); month = int(month)
        days_in_month = calendar.monthrange(year, month)[1]
        clause, params = make_device_filter_clause(device)
        q = f"""
            SELECT DATEPART(day, created_at) as day,
                   SUM(CASE WHEN status='Pass' THEN 1 ELSE 0 END) as pass_sum,
                   SUM(CASE WHEN status='Fail' THEN 1 ELSE 0 END) as fail_sum
            FROM ProductionStatus
            WHERE YEAR(created_at)=? AND MONTH(created_at)=? {clause}
            GROUP BY DATEPART(day, created_at)
            ORDER BY DATEPART(day, created_at)
        """
        conn = get_conn()
        cur = conn.cursor()
        params_exec = [year, month] + params
        cur.execute(q, params_exec)
        rows = cur.fetchall()
        weeks = {}
        for r in rows:
            day = int(r[0] or 1)
            week_idx = (day - 1) // 7 + 1
            if week_idx not in weeks:
                weeks[week_idx] = {"pass": 0, "fail": 0}
            weeks[week_idx]["pass"] += int(r[1] or 0)
            weeks[week_idx]["fail"] += int(r[2] or 0)
        max_week = (days_in_month + 6) // 7
        labels = [f"Tuần {w}" for w in range(1, max_week + 1)]
        pass_list = [weeks[w]["pass"] if w in weeks else 0 for w in range(1, max_week + 1)]
        fail_list = [weeks[w]["fail"] if w in weeks else 0 for w in range(1, max_week + 1)]
        return {"month": f"{year:04d}-{month:02d}", "labels": labels, "pass": pass_list, "fail": fail_list}
    finally:
        try: conn.close()
        except: pass


@app.get("/data/year/{year}")
def data_year(year: int, device: Optional[str] = None):
    try:
        year = int(year)
        clause, params = make_device_filter_clause(device)
        q = f"""
            SELECT MONTH(created_at) as m,
                   SUM(CASE WHEN status='Pass' THEN 1 ELSE 0 END) as sum_pass,
                   SUM(CASE WHEN status='Fail' THEN 1 ELSE 0 END) as sum_fail
            FROM ProductionStatus
            WHERE YEAR(created_at)=? {clause}
            GROUP BY MONTH(created_at)
            ORDER BY MONTH(created_at)
        """
        conn = get_conn()
        cur = conn.cursor()
        params_exec = [year] + params
        cur.execute(q, params_exec)
        rows = cur.fetchall()
        mapm = {int(r[0]): {"pass": int(r[1] or 0), "fail": int(r[2] or 0)} for r in rows}
        labels = [f"Tháng {m}" for m in range(1, 13)]
        pass_list = [mapm[m]["pass"] if m in mapm else 0 for m in range(1, 13)]
        fail_list = [mapm[m]["fail"] if m in mapm else 0 for m in range(1, 13)]
        return {"year": year, "labels": labels, "pass": pass_list, "fail": fail_list}
    finally:
        try: conn.close()
        except: pass


# Logs endpoints (per-day summary + set daily metric)
@app.get("/logs/day/{date_str}")
def logs_day(date_str: str, device: Optional[str] = None):
    try:
        datetime.date.fromisoformat(date_str)
    except Exception:
        raise HTTPException(status_code=400, detail="date_str must be YYYY-MM-DD")
    conn = get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM devices ORDER BY id")
        device_rows = cur.fetchall()
        device_names = [r[0] for r in device_rows]

        clause, params = make_device_filter_clause(device)
        q = f"""
            SELECT device_id,
                   SUM(CASE WHEN status = 'Pass' THEN 1 ELSE 0 END) as pass_sum,
                   SUM(CASE WHEN status = 'Fail' THEN 1 ELSE 0 END) as fail_sum
            FROM ProductionStatus
            WHERE CONVERT(varchar(10), created_at, 120) = ? { 'AND device_id = ?' if device else '' }
            GROUP BY device_id
        """
        exec_params = (date_str, *params) if params else (date_str,)
        cur.execute(q, exec_params)
        rows = cur.fetchall()
        stats = {r[0]: {"Pass": int(r[1] or 0), "Fail": int(r[2] or 0)} for r in rows}

        cur.execute("SELECT device_id, metric FROM DailyMetrics WHERE [date] = ?", (date_str,))
        metric_rows = cur.fetchall()
        metrics = {r[0]: r[1] for r in metric_rows}

        all_devices = set(device_names) | set(stats.keys()) | set(metrics.keys())
        if device:
            all_devices = {device}

        out = []
        for dev in sorted(all_devices):
            p = stats.get(dev, {}).get("Pass", 0)
            f = stats.get(dev, {}).get("Fail", 0)
            tot = p + f
            out.append({
                "device_id": dev,
                "name": dev,
                "pass": p,
                "fail": f,
                "total": tot,
                "metric": metrics.get(dev) or ""
            })
        return out
    finally:
        conn.close()


@app.post("/logs")
def post_logs(payload: DailyMetricIn):
    try:
        datetime.date.fromisoformat(payload.date)
        conn = get_conn()
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM DailyMetrics WHERE device_id = ? AND [date] = ?", (payload.device_id, payload.date))
        exists = cur.fetchone()[0]
        if exists:
            cur.execute("UPDATE DailyMetrics SET metric = ? WHERE device_id = ? AND [date] = ?", (payload.metric, payload.device_id, payload.date))
        else:
            cur.execute("INSERT INTO DailyMetrics (device_id, [date], metric) VALUES (?, ?, ?)", (payload.device_id, payload.date, payload.metric))
        conn.commit()
        return {"ok": True}
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        try:
            conn.close()
        except:
            pass


if __name__ == "__main__":
    print("[INFO] Starting uvicorn on 127.0.0.1:5500")
    uvicorn.run("backend:app", host="127.0.0.1", port=5500, reload=True)
