// main.js - grouped device bars per week + area growth + month/year charts (year as bar+line)
const API = window.API_BASE || window.location.origin;
console.log("API base:", API);

// ensure Chart.js exists
if (!window.Chart) console.error("Chart.js not found - load chart.js before main.js");
if (window.Chart && window.ChartDataLabels) Chart.register(ChartDataLabels);

// reduce animations
if (window.Chart) {
  Chart.defaults.animation = false;
  Chart.defaults.transitions = {};
}

// helpers
const $ = id => document.getElementById(id);
const sum = arr => (arr && arr.length) ? arr.reduce((a,b)=>a+(Number(b)||0),0) : 0;
const weekdays = ['T2','T3','T4','T5','T6','T7','CN'];
const devicesFixed = ['M1','M2','M3','M4','M5','M6'];

// chart holders
let charts = { day:null, week:null, month:null, year:null };

// create charts
function createCharts(){
  if (charts.day) return;
  // day: grouped bar (pass and fail per day in week)
  charts.day = new Chart($('chartDay').getContext('2d'), {
    type: 'bar',
    data: { labels: [], datasets: [
      { label: 'Pass', data: [], backgroundColor: 'rgba(96,165,250,0.9)' },
      { label: 'Fail', data: [], backgroundColor: 'rgba(255,99,132,0.85)' }
    ] },
    options: {
      responsive: true, maintainAspectRatio:false,
      plugins:{legend:{position:'top'}},
      scales:{ y:{ beginAtZero:true, stacked: false } , x: { stacked: false } }
    }
  });

  // week: area (pass / fail trend across week)
  charts.week = new Chart($('chartWeek').getContext('2d'), {
    type:'line',
    data:{ labels: [], datasets: [
      { label:'Pass', data:[], borderColor:'#60a5fa', backgroundColor:'rgba(96,165,250,0.18)', fill:true },
      { label:'Fail', data:[], borderColor:'#ff6384', backgroundColor:'rgba(255,99,132,0.12)', fill:true }
    ]},
    options:{ responsive:true, maintainAspectRatio:false, elements:{line:{tension:0.35}}, plugins:{legend:{position:'top'}} }
  });

  // month: combo - two bars (pass+fail) + line (pass rate) on second axis
  charts.month = new Chart($('chartMonth').getContext('2d'), {
    data:{ labels: [], datasets: [
      { type:'bar', label:'Pass', data:[], backgroundColor:'rgba(96,165,250,0.9)' },
      { type:'bar', label:'Fail', data:[], backgroundColor:'rgba(255,99,132,0.85)' },
      { type:'line', label:'Tỷ lệ Pass (%)', data:[], borderColor:'#22c55e', yAxisID:'y1', fill:false, tension:0.35 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'top'}},
      scales:{ y:{ beginAtZero:true }, y1:{ position:'right', grid:{drawOnChartArea:false}, beginAtZero:true, ticks:{callback:v=>v+'%'} } }
    }
  });

  // year: combo - Pass/Fail bars per month + line for Pass rate (%) (this is the changed chart)
  charts.year = new Chart($('chartYear').getContext('2d'), {
    data:{ labels: [], datasets: [
      { type:'bar', label:'Pass', data:[], backgroundColor:'rgba(96,165,250,0.9)' },
      { type:'bar', label:'Fail', data:[], backgroundColor:'rgba(255,99,132,0.85)' },
      { type:'line', label:'Tỷ lệ Pass (%)', data:[], borderColor:'#22c55e', yAxisID:'y1', fill:false, tension:0.35 }
    ]},
    options:{
      responsive:true, maintainAspectRatio:false,
      plugins:{legend:{position:'top'}},
      scales:{
        y:{ beginAtZero:true },
        y1:{ position:'right', grid:{ drawOnChartArea:false }, beginAtZero:true, ticks:{ callback:v=>v+'%' } }
      }
    }
  });
}

// fetch helper with good error handling
async function fetchJSON(url){
  const r = await fetch(url);
  if(!r.ok){
    const t = await r.text();
    throw new Error(`${r.status} ${r.statusText} - ${t}`);
  }
  return await r.json();
}

// build week dates (Mon..Sun) containing given date
function weekDatesFrom(dateStr){
  const d = new Date(dateStr);
  // adjust: JS getDay: 0=Sun, 1=Mon...
  const day = d.getDay();
  // compute Monday: if day==0 => previous Monday = d-6
  const diffToMon = (day === 0) ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  const arr = [];
  for(let i=0;i<7;i++){
    const dd = new Date(mon);
    dd.setDate(mon.getDate() + i);
    arr.push(dd.toISOString().slice(0,10));
  }
  return arr;
}

// --- LOADERS ---
// loadDay(date): fetch /data/day for hourly table and /logs/day for device stats per day aggregated across devices for the week's dates
async function loadDay(dateStr){
  try {
    const deviceParam = selectedDevice !== 'all' ? `?device=${selectedDevice}` : '';
    // 1) hourly for the selected date (for the log table)
    const hourly = await fetchJSON(`${API}/data/day/${dateStr}${deviceParam}`);
    renderDayLog(dateStr, hourly);

    // 2) for grouped bar pass/fail per day in week: call /logs/day/{dt} for each date in week
    const weekDates = weekDatesFrom(dateStr);
    // build arrays for pass and fail per day
    const passArr = Array(7).fill(0);
    const failArr = Array(7).fill(0);
    // fetch each day's device stats serially (could be parallel but keep simple)
    const promises = weekDates.map(dt => fetchJSON(`${API}/logs/day/${dt}${deviceParam}`).catch(e=>{ console.warn('logs/day failed',dt,e); return []; }));
    const perDayArr = await Promise.all(promises);
    perDayArr.forEach((arr, idx) => {
      // arr is list of device stats [{ device_id, pass, fail, ... }]
      if(!Array.isArray(arr)) return;
      let dayPass = 0, dayFail = 0;
      arr.forEach(item => {
        dayPass += Number(item.pass || 0);
        dayFail += Number(item.fail || 0);
      });
      passArr[idx] = dayPass;
      failArr[idx] = dayFail;
    });
    // update grouped bar chart
    charts.day.data.labels = weekDates.map(d=> {
      const dd = new Date(d);
      return `${weekdays[dd.getDay() === 0 ? 6 : dd.getDay()-1]} ${d.slice(5)}`; // e.g. T2 09-01
    });
    charts.day.data.datasets[0].data = passArr;
    charts.day.data.datasets[1].data = failArr;
    charts.day.update('none');

    // 3) update week area chart (growth) from /data/week
    const y = dateStr.slice(0,4), m = Number(dateStr.slice(5,7));
    // compute week index inside month
    const day = Number(dateStr.slice(8,10));
    const weekIdx = Math.floor((day-1)/7)+1;
    const weekData = await fetchJSON(`${API}/data/week/${y}/${m}/${weekIdx}${deviceParam}`);
    // cumulative growth
    const passCum = [];
    const failCum = [];
    let pSum=0, fSum=0;
    for(let i=0;i<weekData.labels.length;i++){
      pSum += Number(weekData.pass[i]||0);
      fSum += Number(weekData.fail[i]||0);
      passCum.push(pSum);
      failCum.push(fSum);
    }
    charts.week.data.labels = weekData.labels.map(l=> l.slice(5)); // show MM-DD
    charts.week.data.datasets[0].data = passCum;
    charts.week.data.datasets[1].data = failCum;
    charts.week.update('none');

  } catch(err){
    console.error('loadDay error', err);
  }
}

// loadWeek(year,month,week)
async function loadWeek(y,m,w){
  try {
    const deviceParam = selectedDevice !== 'all' ? `?device=${selectedDevice}` : '';
    const j = await fetchJSON(`${API}/data/week/${y}/${m}/${w}${deviceParam}`);
    charts.week.data.labels = j.labels.map(l=> l.slice(5));
    charts.week.data.datasets[0].data = j.pass.map(v=>Number(v||0));
    charts.week.data.datasets[1].data = j.fail.map(v=>Number(v||0));
    charts.week.update('none');
    $('weekLabel').innerText = j.range || '';
  } catch(err){ console.error('loadWeek', err); $('weekLabel').innerText = 'Lỗi'; }
}

// loadMonth(year, month)
async function loadMonth(y,m){
  try {
    const deviceParam = selectedDevice !== 'all' ? `?device=${selectedDevice}` : '';
    const j = await fetchJSON(`${API}/data/month/${y}/${m}${deviceParam}`);
    charts.month.data.labels = j.labels;
    charts.month.data.datasets[0].data = j.pass.map(v=>Number(v||0)); // pass bar
    charts.month.data.datasets[1].data = j.fail.map(v=>Number(v||0)); // fail bar
    // pass rate percent = pass / (pass+fail) * 100
    const rate = j.labels.map((_,i)=>{
      const p = Number(j.pass[i]||0), f = Number(j.fail[i]||0);
      const tot = p+f;
      return tot? Math.round((p/tot)*100) : 0;
    });
    charts.month.data.datasets[2].data = rate;
    charts.month.update('none');
    $('monthLabel').innerText = j.month || '';
  } catch(err){ console.error('loadMonth', err); $('monthLabel').innerText = 'Lỗi'; }
}

// loadYear(year) - now produces Pass/Fail per month + Pass rate (%) as line
async function loadYear(y){
  try {
    const deviceParam = selectedDevice !== 'all' ? `?device=${selectedDevice}` : '';
    const j = await fetchJSON(`${API}/data/year/${y}${deviceParam}`);
    // j.labels should be months (e.g. ["01","02",...]) or ["Tháng 1",...]
    charts.year.data.labels = j.labels;
    const passArr = j.pass.map(v=>Number(v||0));
    const failArr = j.fail.map(v=>Number(v||0));
    charts.year.data.datasets[0].data = passArr;
    charts.year.data.datasets[1].data = failArr;
    // compute pass rate per month
    const rate = j.labels.map((_,i)=> {
      const p = Number(j.pass[i]||0), f = Number(j.fail[i]||0);
      const tot = p+f;
      return tot ? Math.round((p/tot)*100) : 0;
    });
    // ensure third dataset exists and assign
    if (charts.year.data.datasets.length < 3) {
      charts.year.data.datasets.push({ type:'line', label:'Tỷ lệ Pass (%)', data:rate, borderColor:'#22c55e', yAxisID:'y1', fill:false, tension:0.35 });
    } else {
      charts.year.data.datasets[2].data = rate;
      charts.year.data.datasets[2].type = 'line';
      charts.year.data.datasets[2].label = 'Tỷ lệ Pass (%)';
      charts.year.data.datasets[2].borderColor = '#22c55e';
      charts.year.data.datasets[2].yAxisID = 'y1';
      charts.year.data.datasets[2].fill = false;
    }

    charts.year.update('none');
    $('yearLabel').innerText = String(y);
  } catch(err){ console.error('loadYear', err); $('yearLabel').innerText = 'Lỗi'; }
}

// render hourly log table
function renderDayLog(dateStr, data){
  const tbl = $('logTable'); if(!tbl) return;
  tbl.innerHTML = '';
  const summary = $('logSummary');
  summary.innerText = `Ngày: ${dateStr} — Tổng Pass: ${sum(data.pass)} — Tổng Fail: ${sum(data.fail)}`;

  const thead = `<tr style="text-align:left;color:var(--muted);font-size:13px"><th style="padding:6px">Giờ</th><th style="padding:6px">Pass</th><th style="padding:6px">Fail</th></tr>`;
  tbl.insertAdjacentHTML('beforeend', thead);
  for(let h=0; h<24; h++){
    const p = data.pass && data.pass[h] != null ? data.pass[h] : 0;
    const f = data.fail && data.fail[h] != null ? data.fail[h] : 0;
    const tr = `<tr><td style="padding:6px">${h}:00</td><td style="padding:6px">${p}</td><td style="padding:6px">${f}</td></tr>`;
    tbl.insertAdjacentHTML('beforeend', tr);
  }
}

// --- Devices ---
async function fetchDevices(){
  try {
    const arr = await fetchJSON(`${API}/devices`);
    renderDevices(arr);
  } catch(err){
    console.error('fetchDevices', err);
    const el = $('devicesList'); if(el) el.innerHTML = '<div style="color:#ff8080">Lỗi kết nối</div>';
  }
}
function renderDevices(list){
  const el = $('devicesList'); if(!el) return; el.innerHTML = '';
  const allItem = document.createElement('div'); allItem.className='device-item'; allItem.dataset.isAll='true';
  allItem.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><span class="status-dot" style="background:transparent"></span><div><strong>Tất cả</strong><div style="font-size:12px;color:var(--muted)">Xem tất cả thiết bị</div></div></div><div><button class="btn small">Chọn</button></div>`;
  allItem.querySelector('button').onclick = ()=> { selectedDevice = 'all'; setSelectedDeviceUI(); reloadCurrentView(); };
  el.appendChild(allItem);

  if(!list || list.length===0){ el.insertAdjacentHTML('beforeend','<div class="device-item">Chưa có thiết bị</div>'); return; }
  list.forEach(d=>{
    const item = document.createElement('div'); item.className='device-item';
    const dotClass = d.status===1 ? 'status-on' : 'status-off';
    item.innerHTML = `<div style="display:flex;gap:8px;align-items:center"><span class="status-dot ${dotClass}"></span><div><strong>${d.name}</strong><div style="font-size:12px;color:var(--muted)">${d.last_seen||'Không có'}</div></div></div><div style="display:flex;gap:6px"><button class="btn small select">Chọn</button><button class="btn small del">Xóa</button></div>`;
    item.querySelector('.select').onclick = ()=>{ selectedDevice = d.name; setSelectedDeviceUI(); reloadCurrentView(); };
    item.querySelector('.del').onclick = async ()=>{ if(!confirm(`Xóa ${d.name}?`)) return; await fetch(`${API}/devices/${d.id}`,{method:'DELETE'}); fetchDevices(); };
    el.appendChild(item);
  });
  setSelectedDeviceUI();
}
async function addDevice(){
  const name = $('deviceName').value.trim();
  if(!name) return alert('Nhập tên thiết bị');
  try{
    const res = await fetch(`${API}/devices`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name }) });
    if(!res.ok) throw new Error('HTTP ' + res.status);
    $('deviceName').value = '';
    fetchDevices();
  } catch(err){ console.error('addDevice', err); alert('Thêm thất bại'); }
}

let selectedDevice = 'all';
function setSelectedDeviceUI(){
  document.querySelectorAll('.device-item').forEach(it=>{
    const strong = it.querySelector('strong');
    const nameEl = strong ? strong.innerText : '';
    if(selectedDevice === 'all' && it.dataset.isAll === 'true') it.classList.add('device-selected');
    else if(nameEl === selectedDevice) it.classList.add('device-selected');
    else it.classList.remove('device-selected');
  });
}

// --- calendar popup ---
function createCalendar(container){
  container.innerHTML = '';
  const cal = document.createElement('div'); cal.className = 'calendar';
  const head = document.createElement('div'); head.className='cal-head';
  const btnPrev = document.createElement('button'); btnPrev.innerHTML = '&#9664;';
  const btnNext = document.createElement('button'); btnNext.innerHTML = '&#9654;';
  const title = document.createElement('div');
  head.appendChild(btnPrev); head.appendChild(title); head.appendChild(btnNext);
  cal.appendChild(head);

  const tbl = document.createElement('table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>CN</th><th>T2</th><th>T3</th><th>T4</th><th>T5</th><th>T6</th><th>T7</th></tr>';
  tbl.appendChild(thead);
  const tbody = document.createElement('tbody');
  tbl.appendChild(tbody);
  cal.appendChild(tbl);
  container.appendChild(cal);

  let cur = new Date();

  function render(y,m){
    title.innerText = `${y} - ${String(m).padStart(2,'0')}`;
    tbody.innerHTML = '';
    const first = new Date(y,m-1,1);
    const startWeekday = first.getDay(); // 0..6 (Sun..Sat)
    const days = new Date(y,m,0).getDate();
    let row = document.createElement('tr');
    for(let i=0;i<startWeekday;i++) row.appendChild(document.createElement('td'));
    for(let d=1; d<=days; d++){
      const weekday = (startWeekday + d -1) % 7;
      const td = document.createElement('td');
      const btn = document.createElement('button'); btn.innerText = d;
      const iso = `${String(y).padStart(4,'0')}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const today = new Date();
      if(today.getFullYear()===y && today.getMonth()+1===m && today.getDate()===d) btn.classList.add('today');
      btn.onclick = ()=>{ $('dayInput').value = iso; loadDay(iso); container.style.display='none'; };
      td.appendChild(btn); row.appendChild(td);
      if(weekday===6){ tbody.appendChild(row); row=document.createElement('tr'); }
    }
    if(row.children.length) tbody.appendChild(row);
  }

  btnPrev.onclick = ()=> { cur.setMonth(cur.getMonth()-1); render(cur.getFullYear(), cur.getMonth()+1); };
  btnNext.onclick = ()=> { cur.setMonth(cur.getMonth()+1); render(cur.getFullYear(), cur.getMonth()+1); };

  render(cur.getFullYear(), cur.getMonth()+1);

  return { show: ()=>{ container.style.display='block'; container.style.zIndex=999 }, hide: ()=>{ container.style.display='none' } };
}
let calendarInst = null;
function openCalendar(){
  const container = $('calendarPopup');
  if(!calendarInst) calendarInst = createCalendar(container);
  calendarInst.show();
}
document.addEventListener('click', (e)=>{
  const cal = $('calendarPopup'); const openBtn = $('btnOpenCalendar');
  if(!cal) return;
  if(cal.contains(e.target) || (openBtn && openBtn.contains(e.target))) return;
  cal.style.display = 'none';
});

// selects
function populateSelects(){
  const now = new Date();
  const THIS_YEAR = now.getFullYear();
  let years = [];
  for(let y=THIS_YEAR-2;y<=THIS_YEAR+1;y++) years.push(y);
  const yo = years.map(y=>`<option value="${y}" ${y===THIS_YEAR?'selected':''}>${y}</option>`).join('');
  $('weekYear').innerHTML = yo; $('monthYear').innerHTML = yo; $('yearSelect').innerHTML = yo;

  const mo = Array.from({length:12},(_,i)=>`<option value="${i+1}" ${i===now.getMonth()?'selected':''}>${i+1}</option>`).join('');
  $('weekMonth').innerHTML = mo; $('monthSelect').innerHTML = mo;

  buildWeekIndex();
}
function buildWeekIndex(){
  const y = parseInt($('weekYear').value), m = parseInt($('weekMonth').value);
  const days = new Date(y,m,0).getDate();
  let start=1, idx=1, html='';
  while(start<=days){
    const end = Math.min(start+6, days);
    html += `<option value="${idx}">Tuần ${idx} (${start}-${end})</option>`;
    start+=7; idx++;
  }
  $('weekIndex').innerHTML = html;
}
function syncSelectionsFromDate(dateStr){
  const d = new Date(dateStr);
  if(isNaN(d)) return;
  const yyyy = d.getFullYear(), mm = d.getMonth()+1, dd = d.getDate();
  $('dayInput').value = dateStr;
  $('weekYear').value = String(yyyy); $('monthYear').value = String(yyyy); $('yearSelect').value = String(yyyy);
  $('weekMonth').value = String(mm); $('monthSelect').value = String(mm);
  buildWeekIndex();
  const wk = Math.floor((dd-1)/7)+1;
  $('weekIndex').value = String(wk);
}

// attach interactions (drill down)
function attachInteractions(){
  $('chartWeek').onclick = (evt)=>{
    const items = charts.week.getElementsAtEventForMode(evt,'nearest',{intersect:true},true);
    if(items && items.length){
      const idx = items[0].index; const label = charts.week.data.labels[idx];
      // label originally is YYYY-MM-DD or trimmed; here we used MM-DD in some places; check format
      if(/^\d{4}-\d{2}-\d{2}$/.test(label)) { syncSelectionsFromDate(label); loadDay(label); }
      else { // if only MM-DD show full by using week labels from charts.week.data.labelsFull if exists
        if(charts.week.data.labelsFull && charts.week.data.labelsFull[idx]) { syncSelectionsFromDate(charts.week.data.labelsFull[idx]); loadDay(charts.week.data.labelsFull[idx]); }
      }
    }
  };
  $('chartMonth').onclick = (evt)=>{
    const items = charts.month.getElementsAtEventForMode(evt,'nearest',{intersect:true},true);
    if(items && items.length){
      const idx = items[0].index; const label = charts.month.data.labels[idx];
      const match = label && label.match(/Tuần\s*(\d+)/i);
      if(match){ const wk = parseInt(match[1]); loadWeek($('weekYear').value, $('weekMonth').value, wk); $('weekIndex').value = String(wk); }
    }
  };
  $('chartYear').onclick = (evt)=>{
    const items = charts.year.getElementsAtEventForMode(evt,'nearest',{intersect:true},true);
    if(items && items.length){
      const idx = items[0].index; const label = charts.year.data.labels[idx];
      const match = label && label.match(/Tháng\s*(\d+)/i);
      if(match){ const mon = parseInt(match[1]); $('monthSelect').value = String(mon); buildWeekIndex(); loadMonth($('monthYear').value, mon); }
    }
  };
}

// bind UI
function bindUI(){
  $('btnOpenCalendar').onclick = ()=> openCalendar();
  $('btnLoadDay').onclick = ()=> { const d = $('dayInput').value; if(!d) return alert('Chọn ngày'); syncSelectionsFromDate(d); loadDay(d); };
  $('btnLoadWeek').onclick = ()=> loadWeek($('weekYear').value, $('weekMonth').value, $('weekIndex').value);
  $('btnLoadMonth').onclick = ()=> loadMonth($('monthYear').value, $('monthSelect').value);
  $('btnLoadYear').onclick = ()=> loadYear($('yearSelect').value);
  $('weekYear').onchange = buildWeekIndex; $('weekMonth').onchange = buildWeekIndex;
  $('btnAddDevice').onclick = addDevice;
  $('deviceName').onkeypress = (e)=>{ if(e.key === 'Enter') addDevice(); };

  // Toggle views
  const sideBtns = document.querySelectorAll('.side-btn');
  sideBtns.forEach(btn => {
    btn.onclick = () => {
      sideBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const period = btn.dataset.period;
      // Toggle controls
      document.querySelectorAll('.control-row').forEach(row => row.style.display = 'none');
      const control = $(`control-${period}`);
      if (control) control.style.display = 'block';
      // Toggle charts
      document.querySelectorAll('.card').forEach(card => card.style.display = 'none');
      const card = $(`card-${period}`);
      if (card) card.style.display = 'block';
      // Toggle day log panel
      const dayLog = $('dayLogPanel');
      if (dayLog) dayLog.style.display = period === 'day' ? 'block' : 'none';
      // Reload current view
      reloadCurrentView();
    };
  });
}

function reloadCurrentView() {
  const activeBtn = document.querySelector('.side-btn.active');
  if (!activeBtn) return;
  const period = activeBtn.dataset.period;
  if (period === 'day') {
    const d = $('dayInput').value || new Date().toISOString().slice(0,10);
    loadDay(d);
  } else if (period === 'week') {
    loadWeek($('weekYear').value, $('weekMonth').value, $('weekIndex').value);
  } else if (period === 'month') {
    loadMonth($('monthYear').value, $('monthSelect').value);
  } else if (period === 'year') {
    loadYear($('yearSelect').value);
  }
}

// startup
async function start(){
  createCharts();
  populateSelects();
  bindUI();
  attachInteractions();

  const today = new Date().toISOString().slice(0,10);
  $('dayInput').value = today;
  syncSelectionsFromDate(today);

  await fetchDevices();
  await loadDay(today);
  await loadWeek($('weekYear').value, $('weekMonth').value, $('weekIndex').value);
  await loadMonth($('monthYear').value, $('monthSelect').value);
  await loadYear($('yearSelect').value);

  // realtime update: update only if viewing today (so no jump when user looking at older days)
  setInterval(async ()=>{
    const activePeriod = document.querySelector('.side-btn.active')?.dataset.period;
    const selected = $('dayInput').value || '';
    const todayNow = new Date().toISOString().slice(0,10);
    if (activePeriod === 'day' && selected === todayNow) {
      await loadDay(selected);
    } else if (activePeriod === 'week') {
      await loadWeek($('weekYear').value, $('weekMonth').value, $('weekIndex').value);
    } else if (activePeriod === 'month') {
      await loadMonth($('monthYear').value, $('monthSelect').value);
    } else if (activePeriod === 'year') {
      await loadYear($('yearSelect').value);
    }
    fetchDevices();
  }, 500); // every 5s (bạn có thể tăng lên 10s)
}

start();
