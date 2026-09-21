

const $=id=>document.getElementById(id);

const MAX_FILES=25;
let selectedFiles=[], latestTextReport="";
const filePatientAssignments=new Map();
const extractionMemoryCache=new Map();
const patientReportCache=new Map();
const facilityReportCache=new Map();
const evidenceSummaryCache=new Map();
const IS_IOS=/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform==="MacIntel" && navigator.maxTouchPoints>1);
const EXTRACT_CONCURRENCY=IS_IOS?2:3;
const PATIENT_ANALYSIS_CONCURRENCY=/iPad|iPhone|iPod/i.test(navigator.userAgent)?2:3;
function fileKey(f){return `${f.name}::${f.size}::${f.lastModified}`;}
function fastHash(str){
  let h=2166136261;
  for(let i=0;i<str.length;i++){h^=str.charCodeAt(i);h=Math.imul(h,16777619);}
  return (h>>>0).toString(36)+":"+str.length;
}
async function mapLimit(items,limit,worker){
  const out=new Array(items.length); let next=0;
  const runners=Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const i=next++; if(i>=items.length) break; out[i]=await worker(items[i],i);}
  });
  await Promise.all(runners); return out;
}
function purgeLegacyCache(){
  try{ if('indexedDB' in window) indexedDB.deleteDatabase('rehab-ur-cache'); }catch(_){}
}
purgeLegacyCache();
async function cacheGet(key){
  return extractionMemoryCache.has(key)?extractionMemoryCache.get(key):null;
}
async function cachePut(key,value){
  extractionMemoryCache.set(key,value);
}
function extractLocalIcdEvidence(text){
  // Fast client-side ICD-10 pre-scan. This does not decide which code is correct;
  // it simply places likely diagnosis/code lines near the top of the AI input so
  // the model can verify Primary ICD-10 / Treatment Diagnoses faster.
  const lines=String(text||"").split(/\r?\n/);
  const codeRe=/\b[A-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?\b/g;
  const seen=new Set(), rows=[];
  const clean=(v)=>String(v||"").replace(/\s+/g," ").trim();
  for(let i=0;i<lines.length;i++){
    const line=clean(lines[i]);
    if(!line) continue;
    const matches=[...line.matchAll(codeRe)];
    if(!matches.length) continue;
    const nearby=clean([lines[i-2],lines[i-1],lines[i],lines[i+1],lines[i+2]].filter(Boolean).join(" | "));
    const diagContext=/diagnos|primary|principal|medical dx|medical diagnosis|treatment dx|treating dx|therapy dx|icd-?10/i.test(nearby);
    if(!diagContext) continue;
    let discipline="";
    if(/\bPT\b|physical therap/i.test(nearby)) discipline="PT";
    else if(/\bOT\b|occupational therap/i.test(nearby)) discipline="OT";
    else if(/\bSLP\b|speech(?:[- ]language)? therap|speech path/i.test(nearby)) discipline="SLP";
    let kind="Other";
    if(/\b(primary|principal|medical dx|medical diagnosis)\b/i.test(nearby)) kind="Primary";
    else if(/\b(treatment|treating|therapy)\s*(dx|diagnos)/i.test(nearby)) kind="Treatment";
    for(const m of matches){
      const code=m[0].toUpperCase();
      const key=`${discipline}|${kind}|${code}|${line.toLowerCase()}`;
      if(seen.has(key)) continue;
      seen.add(key);
      rows.push({discipline,kind,code,snippet:line.slice(0,220)});
      if(rows.length>=24) break;
    }
    if(rows.length>=24) break;
  }
  if(!rows.length) return "";
  const order=["Primary","Treatment","Other"];
  const chunks=[];
  for(const kind of order){
    const group=rows.filter(r=>r.kind===kind);
    if(!group.length) continue;
    chunks.push(`${kind} candidates:`);
    for(const r of group){
      chunks.push(`- ${r.discipline?`${r.discipline} | `:""}${r.code} | ${r.snippet}`);
    }
  }
  return `LOCAL ICD-10 CANDIDATES (client-side retrieval aid only; verify against source documentation and preserve discipline conflicts):\n${chunks.join("\n")}`;
}

function compactSourceText(text){
  // Speed-focused local cleanup before any AI call. Keep clinically meaningful text,
  // remove exact duplicate pages, repeated boilerplate, and low-value billing metadata.
  const parts=text.split(/(?=\n--- PAGE \d+ ---\n|\n--- PDF \d+:|\n--- SCREENSHOT \d+:)/g);
  const seenPages=new Set(), seenLongLines=new Set(), kept=[];
  const dropLine=(line)=>{
    const t=line.trim();
    if(!t) return false;
    // Common rehab billing/CPT boilerplate that adds tokens but not functional evidence.
    if(/^(CPT Codes?|Billing Information|Unit Calculation Method|License Number|NPI|Provider Signature|Electronically signed by)\b/i.test(t)) return true;
    if(/^(97110|97112|97116|97530|97535|92507|92526|92610|97162|97166)\b/.test(t) && /THERAPEUTIC|PROCEDURE|ACTIVIT|GAIT TRAINING|EVALUATION|TREATMENT/i.test(t)) return true;
    if(/THERAPEUTIC PROCEDURE,? 1 OR MORE AREAS,? EACH 15 MINUTES/i.test(t)) return true;
    if(/NEUROMUSCULAR REEDUCATION OF MOVEMENT,? BALANCE,? COORDINATION/i.test(t)) return true;
    if(/GAIT TRAINING \(INCLUDES STAIR CLIMBING\)/i.test(t)) return true;
    if(/PHYSICAL THERAPY EVALUATION: .*COMPLEXITY/i.test(t)) return true;
    if(/OCCUPATIONAL THERAPY EVALUATION: .*COMPLEXITY/i.test(t)) return true;
    return false;
  };
  for(const part of parts){
    if(!part.trim()) continue;
    let normalized=part.replace(/[ \t]+/g,' ').replace(/\n{3,}/g,'\n\n').trim();
    const pageKey=fastHash(normalized.replace(/--- PAGE \d+ ---/,'--- PAGE ---'));
    if(seenPages.has(pageKey)) continue;
    seenPages.add(pageKey);
    const lines=[];
    for(const rawLine of normalized.split('\n')){
      const line=rawLine.trim();
      if(dropLine(line)) continue;
      // Repeated long headers/footer text only needs to be sent once.
      if(line.length>=70){
        const lk=fastHash(line.toLowerCase());
        if(seenLongLines.has(lk)) continue;
        seenLongLines.add(lk);
      }
      lines.push(rawLine);
    }
    normalized=lines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
    if(normalized) kept.push(normalized);
  }
  return kept.join('\n\n');
}

function addAdmitRow(name="", date="", insurance=""){
  const row=document.createElement("div");
  row.className="admitRow";
  row.innerHTML=`<div class="admitField nameField"><label class="admitFieldLabel">Resident name</label><input type="text" class="admitName" placeholder="Resident name" value="${name.replace(/"/g,"&quot;")}" required></div>
    <div class="admitField dateField"><label class="admitFieldLabel">Admit date</label><input type="date" class="admitDate" value="${date}" required aria-label="Admit date"></div>
    <div class="admitField insuranceField"><label class="admitFieldLabel">Insurance / payer</label><input type="text" class="admitInsurance" placeholder="Insurance / payer" value="${insurance.replace(/"/g,"&quot;")}" required></div>
    <button type="button" class="secondary removePatient" aria-label="Remove patient">×</button>`;
  row.querySelector(".admitName").addEventListener("input",renderThumbs);
  row.querySelector(".removePatient").onclick=()=>{
    row.remove();
    if(!$("admitRows").children.length) addAdmitRow();
    renderThumbs();
  };
  $("admitRows").appendChild(row);
  renderThumbs();
}
function patientNames(){
  return [...document.querySelectorAll(".admitName")].map(x=>x.value.trim()).filter(Boolean);
}
function setFiles(incoming,{replace=false}={}){
  const base=replace?[]:selectedFiles.slice();
  const seen=new Set(base.map(fileKey));
  const before=base.length;
  for(const f of incoming){
    if(base.length>=MAX_FILES) break;
    const k=fileKey(f);
    if(seen.has(k)) continue;
    base.push(f); seen.add(k);
  }
  selectedFiles=base.slice(0,MAX_FILES);
  renderThumbs();
  if(incoming.length > (selectedFiles.length-before)){
    $("ocrStatus").textContent=`Maximum ${MAX_FILES} files. Extra or duplicate files were not added.`;
  }
}
$("addPatientBtn").onclick=()=>addAdmitRow();
addAdmitRow();

function localTodayISO(){
  const d=new Date();
  const y=d.getFullYear(), m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function inclusiveDayCount(admitISO, reviewISO){
  if(!admitISO || !reviewISO) return "";
  const [ay,am,ad]=admitISO.split("-").map(Number);
  const [ry,rm,rd]=reviewISO.split("-").map(Number);
  const a=Date.UTC(ay,am-1,ad), r=Date.UTC(ry,rm-1,rd);
  const diff=Math.floor((r-a)/86400000)+1;
  return diff>=1 ? diff : "";
}

$("files").addEventListener("change",e=>{
  setFiles(Array.from(e.target.files||[]));
  // Clear the picker so the user can open it again and keep adding files
  // without replacing anything already loaded.
  $("files").value="";
});
$("addFilesBtn").onclick=()=>$("moreFiles").click();
$("moreFiles").addEventListener("change",e=>{
  const incoming=Array.from(e.target.files||[]);
  setFiles(incoming);
  $("moreFiles").value="";
});
function renderThumbs(){
  if(!$("thumbs")) return;
  $("thumbs").innerHTML="";
  const pdfCount=selectedFiles.filter(f=>f.type==="application/pdf"||f.name.toLowerCase().endsWith(".pdf")).length;
  $("fileCount").textContent=selectedFiles.length
    ? `${selectedFiles.length} of ${MAX_FILES} files loaded${pdfCount?` · ${pdfCount} PDF${pdfCount===1?"":"s"}`:""}`
    : "No files loaded.";
  const names=patientNames();
  selectedFiles.forEach(f=>{
    const key=fileKey(f);
    let assigned=filePatientAssignments.get(key)||"";
    if(assigned && !names.includes(assigned)){ filePatientAssignments.delete(key); assigned=""; }
    const d=document.createElement("div"); d.className="thumb"+(assigned?"":" unassigned");
    const rm=document.createElement("button");
    rm.type="button"; rm.className="thumbRemove"; rm.setAttribute("aria-label",`Remove ${f.name}`); rm.title="Remove file"; rm.textContent="×";
    rm.onclick=()=>{ selectedFiles=selectedFiles.filter(x=>fileKey(x)!==key); filePatientAssignments.delete(key); renderThumbs(); };
    d.appendChild(rm);
    if(f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf")){
      const box=document.createElement("div");
      box.style.height="72px"; box.style.display="flex"; box.style.alignItems="center";
      box.style.justifyContent="center"; box.style.fontWeight="800"; box.style.fontSize="20px";
      box.style.background="#f1f1ff"; box.style.color="#5f60dd"; box.style.letterSpacing=".04em";
      box.textContent="PDF"; d.appendChild(box);
    } else {
      const box=document.createElement("div"); box.style.height="72px"; box.style.display="flex"; box.style.alignItems="center"; box.style.justifyContent="center"; box.style.fontWeight="800"; box.style.fontSize="20px"; box.style.background="#eef9fe"; box.style.color="#5b7893"; box.style.letterSpacing=".04em"; box.textContent="IMG"; d.appendChild(box);
    }
    const cap=document.createElement("div"); cap.textContent=f.name; cap.title=f.name; d.appendChild(cap);
    const sel=document.createElement("select");
    sel.innerHTML='<option value="">Assign to patient…</option>'+names.map(n=>`<option value="${esc(n)}">${esc(n)}</option>`).join("");
    sel.value=assigned;
    sel.onchange=()=>{ if(sel.value) filePatientAssignments.set(key,sel.value); else filePatientAssignments.delete(key); d.classList.toggle("unassigned",!sel.value); };
    d.appendChild(sel);
    $("thumbs").appendChild(d);
  });
}
function clearPatientData({message="Patient data cleared from this session.",resetPatients=true}={}){
  selectedFiles=[];
  filePatientAssignments.clear();
  extractionMemoryCache.clear();
  patientReportCache.clear();
  facilityReportCache.clear();
  evidenceSummaryCache.clear();
  latestTextReport="";
  $("files").value="";
  $("moreFiles").value="";
  $("thumbs").innerHTML="";
  $("fileCount").textContent="No files loaded.";
  $("rawText").value="";
  $("names").value="";
  $("ocrStatus").textContent="";
  $("results").innerHTML='<div class="emptyState">Your generated patient breakdown will appear here.</div>';
  if(resetPatients){ $("admitRows").innerHTML=""; addAdmitRow(); }
  $("aiStatus").textContent=message;
  $("privacyStatus").textContent="Privacy session active · patient data currently cleared";
}
$("clearBtn").onclick=()=>clearPatientData();
const PRIVACY_IDLE_MS=20*60*1000;
let privacyIdleTimer=null;
function resetPrivacyIdleTimer(){
  clearTimeout(privacyIdleTimer);
  privacyIdleTimer=setTimeout(()=>clearPatientData({message:"Patient data was automatically cleared after 20 minutes of inactivity."}),PRIVACY_IDLE_MS);
}
["pointerdown","keydown","touchstart","input"].forEach(evt=>document.addEventListener(evt,resetPrivacyIdleTimer,{passive:true}));
resetPrivacyIdleTimer();
window.addEventListener("pagehide",()=>{
  extractionMemoryCache.clear(); patientReportCache.clear(); facilityReportCache.clear(); evidenceSummaryCache.clear(); latestTextReport="";
});


let pdfJsReadyPromise=null;
function waitForPdfJs(){
  if(window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
  if(pdfJsReadyPromise) return pdfJsReadyPromise;
  pdfJsReadyPromise=new Promise((resolve,reject)=>{
    let tries=0;
    const check=()=>{
      if(window.pdfjsLib) return resolve(window.pdfjsLib);
      if(++tries>=100){ pdfJsReadyPromise=null; return reject(new Error("PDF reader did not load.")); }
      setTimeout(check,50);
    };
    check();
  });
  return pdfJsReadyPromise;
}

async function extractPdf(file, fileIndex){
  const key='extract:'+fileKey(file);
  const cached=await cacheGet(key);
  if(cached){
    $("ocrStatus").textContent=`Using in-session extracted text for ${file.name}…`;
    return cached.replace(/^\n*--- PDF \d+:/,`\n\n--- PDF ${fileIndex+1}:`);
  }
  const pdfjsLib=await waitForPdfJs();
  const buf=await file.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  let out=`\n\n--- PDF ${fileIndex+1}: ${file.name} ---`;
  try{
    for(let p=1;p<=pdf.numPages;p++){
      $("ocrStatus").textContent=`Reading file ${fileIndex+1} of ${selectedFiles.length}: ${file.name} · page ${p} of ${pdf.numPages}…`;
      const page=await pdf.getPage(p);
      try{
        const content=await page.getTextContent();
        let pageText=content.items.map(x=>x.str).join(" ").trim();
        if(pageText.length < 40){
          $("ocrStatus").textContent=`OCR file ${fileIndex+1} of ${selectedFiles.length}: ${file.name} · page ${p} of ${pdf.numPages}…`;
          const base=page.getViewport({scale:1});
          const scale=Math.max(1,Math.min(1.4,1800/Math.max(base.width,base.height)));
          const viewport=page.getViewport({scale});
          const canvas=document.createElement("canvas");
          const ctx=canvas.getContext("2d",{alpha:false});
          canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
          await page.render({canvasContext:ctx,viewport}).promise;
          const result=await Tesseract.recognize(canvas,"eng");
          pageText=result.data.text||"";
          canvas.width=1; canvas.height=1;
        }
        out+=`\n\n--- PAGE ${p} ---\n${pageText}`;
      }finally{
        try{page.cleanup();}catch(_){}
      }
      if(p%3===0) await new Promise(r=>setTimeout(r,0));
    }
  }finally{
    try{await pdf.destroy();}catch(_){}
  }
  await cachePut(key,out);
  return out;
}

async function extractAnyFile(f,i){
  const singlePatient=patientNames().length===1?patientNames()[0]:"";
  const assigned=filePatientAssignments.get(fileKey(f))||singlePatient||"UNASSIGNED";
  const isPdf=f.type==="application/pdf" || f.name.toLowerCase().endsWith(".pdf");
  if(isPdf) return `\n\n=== PATIENT DOCUMENT GROUP: ${assigned} ===`+await extractPdf(f,i);
  const key='extract:'+fileKey(f);
  let text=await cacheGet(key);
  if(!text){
    $("ocrStatus").textContent=`OCR reading screenshot ${i+1} of ${selectedFiles.length}…`;
    const r=await Tesseract.recognize(f,"eng");
    text=`\n\n--- SCREENSHOT ${i+1}: ${f.name} ---\n${r.data.text}`;
    await cachePut(key,text);
  }
  return `\n\n=== PATIENT DOCUMENT GROUP: ${assigned} ===`+text;
}

$("extractBtn").onclick=async()=>{
  if(!selectedFiles.length){$("ocrStatus").textContent="Choose at least one PDF or screenshot first.";return}
  const names=patientNames();
  if(names.length===1){
    selectedFiles.forEach(f=>{ if(!filePatientAssignments.get(fileKey(f))) filePatientAssignments.set(fileKey(f),names[0]); });
    renderThumbs();
  }
  const unassigned=selectedFiles.filter(f=>!filePatientAssignments.get(fileKey(f))).length;
  if(names.length>1 && unassigned){
    $("ocrStatus").textContent=`Assign all files to a patient first (${unassigned} unassigned). This prevents resident records from being mixed.`;
    return;
  }
  $("extractBtn").disabled=true;
  try{
    $("ocrStatus").textContent=`Preparing ${selectedFiles.length} files… Large batches are processed in a memory-safe queue.`;
    const pieces=await mapLimit(selectedFiles,EXTRACT_CONCURRENCY,extractAnyFile);
    const combined=pieces.join("");
    $("rawText").value=combined.trim();
    $("ocrStatus").textContent="Extraction complete. Text is kept only for this browser session and is not persistently cached by the app.";
  }catch(e){
    $("ocrStatus").textContent="Could not read one of the files: "+(e.message||"unknown error");
  }finally{$("extractBtn").disabled=false}
};

function maskNames(text){
  const names=$("names").value.split(",").map(x=>x.trim()).filter(Boolean), map={}; let masked=text;
  names.forEach((name,i)=>{
    const label=`Patient ${String.fromCharCode(65+i)}`; map[label]=name;
    const esc=name.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
    masked=masked.replace(new RegExp(esc,"gi"),label);
  });
  return {masked,map};
}
function restoreNames(text,map){let out=text;Object.entries(map).forEach(([label,name])=>out=out.replaceAll(label,name));return out}

function admissionContextFor(patientName){
  const review=localTodayISO();
  const target=(patientName||"").trim().toLowerCase();
  for(const row of document.querySelectorAll(".admitRow")){
    const name=row.querySelector(".admitName")?.value.trim()||"";
    const date=row.querySelector(".admitDate")?.value||"";
    const insurance=row.querySelector(".admitInsurance")?.value.trim()||"";
    if(name && date && insurance && name.toLowerCase()===target){
      const days=inclusiveDayCount(date,review);
      return `REPORT/REVIEW DATE: ${review}\nUSER-ENTERED PATIENT ADMISSION DATA (authoritative):\n- ${name} | Admit Date: ${date} | Days Since Admission: Day ${days} | Insurance/Payer: ${insurance}\nIMPORTANT: Use this admission date, day count, and insurance/payer exactly for this resident. Admission/start date is Day 1.\n\n`;
    }
  }
  return `REPORT/REVIEW DATE: ${review}\n`;
}

function extractedPatientGroups(text){
  const marker=/^=== PATIENT DOCUMENT GROUP:\s*(.+?)\s*===\s*$/gm;
  const matches=[...text.matchAll(marker)];
  const groups=new Map();
  const names=patientNames();
  if(!matches.length){
    groups.set(names[0]||"UNASSIGNED",text);
    return groups;
  }
  for(let i=0;i<matches.length;i++){
    let name=(matches[i][1]||"UNASSIGNED").trim();
    if(name==="UNASSIGNED" && names.length===1) name=names[0];
    const segStart=matches[i].index+matches[i][0].length;
    const segEnd=i+1<matches.length?matches[i+1].index:text.length;
    const seg=text.slice(segStart,segEnd).trim();
    groups.set(name,(groups.get(name)||"")+`\n\n${seg}`);
  }
  return groups;
}

function chunkSourceText(text,maxChars=18000){
  if(text.length<=maxChars) return [text];
  const parts=text.split(/(?=\n--- PAGE \d+ ---\n|\n--- PDF \d+:|\n--- SCREENSHOT \d+:)/g);
  const chunks=[]; let cur="";
  for(const part of parts){
    if(!part) continue;
    if(cur && cur.length+part.length>maxChars){ chunks.push(cur); cur=""; }
    if(part.length>maxChars){
      if(cur){chunks.push(cur);cur="";}
      for(let i=0;i<part.length;i+=maxChars) chunks.push(part.slice(i,i+maxChars));
    }else cur+=part;
  }
  if(cur) chunks.push(cur);
  return chunks.filter(x=>x.trim());
}

const ANALYZE_ENDPOINT=new URL("/api/analyze",window.location.origin).toString();

function friendlyAnalysisError(message){
  const m=String(message||"");
  const clean=m.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
  const diagnosticAt=clean.toUpperCase().indexOf("DIAGNOSTIC:");
  if(diagnosticAt>=0) return clean.slice(diagnosticAt,diagnosticAt+1200);
  const openaiAt=clean.toLowerCase().indexOf("openai diagnostic:");
  if(openaiAt>=0) return clean.slice(openaiAt,openaiAt+1200);
  if(/Request ID:|Inactivity Timeout|504|timed out|timeout/i.test(clean)) return "The analysis service took too long on that request.";
  if(/429|rate limit/i.test(clean)) return "The AI service is temporarily busy.";
  if(/500|502|503|server error|internal/i.test(clean)) return "The analysis service had a temporary server problem.";
  return clean.slice(0,700)||"Analysis could not be completed.";
}
function formatDiagnostic(d){
  if(!d || typeof d!=="object") return "";
  const parts=[];
  if(d.upstream_status) parts.push(`HTTP ${d.upstream_status}${d.upstream_status_text?` ${d.upstream_status_text}`:""}`);
  if(d.event) parts.push(d.event);
  if(d.error_type) parts.push(`type=${d.error_type}`);
  if(d.error_code) parts.push(`code=${d.error_code}`);
  if(d.error_param) parts.push(`param=${d.error_param}`);
  if(d.error_message) parts.push(`message=${String(d.error_message).replace(/\s+/g," ").slice(0,300)}`);
  if(d.openai_request_id) parts.push(`request=${d.openai_request_id}`);
  if(d.model) parts.push(`model=${d.model}`);
  if(d.mode) parts.push(`mode=${d.mode}`);
  return parts.join(" · ");
}

async function callAnalysis(text,mode,statusLabel){
  let lastErr;
  for(let attempt=1;attempt<=1;attempt++){
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),60000);
    try{
      if(statusLabel) $("aiStatus").textContent=statusLabel;
      const r=await fetch(ANALYZE_ENDPOINT,{
        method:"POST",
        headers:{"Content-Type":"application/json","Accept":"text/plain, application/json"},
        body:JSON.stringify({text,mode}),
        signal:controller.signal
      });
      if(!r.ok){
        let message=`Analysis failed (${r.status})`;
        try{
          const ct=r.headers.get("content-type")||"";
          if(ct.includes("application/json")){
            const d=await r.json();
            const diag=formatDiagnostic(d.diagnostic);
            message=diag?`DIAGNOSTIC: ${d.error||"Analysis failed"} · ${diag}`:(d.error||message);
          }
          else { const t=await r.text(); if(t) message=t.slice(0,900); }
        }catch(_){}
        throw new Error(message);
      }
      let streamed="";
      if(r.body){
        const reader=r.body.getReader(),decoder=new TextDecoder();
        while(true){
          const {value,done}=await reader.read();
          if(done) break;
          streamed+=decoder.decode(value,{stream:true});
        }
        streamed+=decoder.decode();
      }else streamed=await r.text();
      if(streamed.includes("\n\nERROR_DIAGNOSTIC:")){
        const rawDiag=streamed.split("\n\nERROR_DIAGNOSTIC:").pop().trim();
        let diagText=rawDiag;
        try{ diagText=formatDiagnostic(JSON.parse(rawDiag)); }catch(_){}
        throw new Error(`DIAGNOSTIC: ${diagText}`);
      }
      if(streamed.includes("\n\nERROR:")) throw new Error(friendlyAnalysisError(streamed.split("\n\nERROR:").pop()));
      if(!streamed.trim()) throw new Error("The analysis service returned an empty report.");
      return streamed.trim();
    }catch(e){
      lastErr=e?.name==="AbortError"?new Error("The analysis service took too long on that request."):e;
      const msg=String(lastErr?.message||lastErr);
      // Account/configuration/validation errors will not improve with an immediate retry.
      if(/credit_balance_exhausted|no credits remaining|invalid_api_key|authentication|unauthorized|forbidden|HTTP 400|HTTP 401|HTTP 403/i.test(msg)) break;
      if(attempt<1) await new Promise(r=>setTimeout(r,250*attempt));
    }finally{
      clearTimeout(timeout);
    }
  }
  throw lastErr||new Error("Analysis could not be completed.");
}

async function condenseEvidencePiece(patientName,baseContext,chunk,label,progressText,depth=0){
  const cacheKey=fastHash(patientName+"\n"+baseContext+"\n"+chunk);
  if(evidenceSummaryCache.has(cacheKey)) return evidenceSummaryCache.get(cacheKey);
  const input=baseContext+`PATIENT: ${patientName}\n${label}\n`+chunk;
  const masked=maskNames(input);
  try{
    const out=restoreNames(await callAnalysis(masked.masked,"extract",progressText),masked.map);
    evidenceSummaryCache.set(cacheKey,out);
    return out;
  }catch(err){
    if(chunk.length<=1800 || depth>=4) throw err;
    const target=Math.max(1400,Math.floor(chunk.length/2));
    const pieces=chunkSourceText(chunk,target);
    if(pieces.length<2) throw err;
    const summaries=[];
    for(let i=0;i<pieces.length;i++){
      summaries.push(await condenseEvidencePiece(
        patientName,baseContext,pieces[i],`${label} PART ${i+1} OF ${pieces.length}`,
        `Processing ${patientName} — smaller document section ${i+1} of ${pieces.length}…`,depth+1
      ));
    }
    const joined=summaries.join("\n\n");
    evidenceSummaryCache.set(cacheKey,joined);
    return joined;
  }
}

async function reduceEvidenceReliable(patientName,baseContext,evidence){
  let joined=evidence.join("\n\n--- NEXT SOURCE CHUNK ---\n\n");
  let pass=1;
  // Speed-first: keep one evidence set whenever it is already compact enough for final synthesis.
  while(joined.length>18000 && pass<=2){
    const groups=chunkSourceText(joined,8000);
    const reduced=await mapLimit(groups,2,async(group,i)=>
      condenseEvidencePiece(
        patientName,baseContext,group,`EVIDENCE REDUCTION ${pass}.${i+1}`,
        `Preparing ${patientName} report — evidence section ${i+1} of ${groups.length}…`
      )
    );
    joined=reduced.join("\n\n--- NEXT EVIDENCE GROUP ---\n\n");
    pass++;
  }
  return joined;
}

async function buildPatientFromEvidence(patientName,baseContext,evidence,index,total){
  let current=evidence;
  for(let attempt=1;attempt<=2;attempt++){
    const synthesis=baseContext+`PATIENT: ${patientName}\nCONDENSED SOURCE EVIDENCE:\n`+current;
    const masked=maskNames(synthesis);
    try{
      return restoreNames(await callAnalysis(masked.masked,"patient",`Building ${patientName} report (${index} of ${total})…`),masked.map);
    }catch(err){
      if(attempt===2) throw new Error(`Final report generation failed after evidence extraction: ${friendlyAnalysisError(err.message)}`);
      const groups=chunkSourceText(current,7000);
      const tighter=await mapLimit(groups,2,async(group,i)=>
        condenseEvidencePiece(
          patientName,baseContext,group,`FINAL SYNTHESIS REDUCTION ${i+1}`,
          `Preparing ${patientName} final report — section ${i+1} of ${groups.length}…`
        )
      );
      current=tighter.join("\n\n");
    }
  }
}

async function generatePatientReliable(patientName,source,index,total){
  const baseContext=admissionContextFor(patientName);
  source=compactSourceText(source);
  const localIcdEvidence=extractLocalIcdEvidence(source);
  const analysisContext=baseContext+(localIcdEvidence?localIcdEvidence+"\n\n":"");
  const cacheKey=fastHash(patientName+"\n"+analysisContext+"\n"+source);
  if(patientReportCache.has(cacheKey)){
    $("aiStatus").textContent=`Using completed session report for ${patientName}…`;
    return patientReportCache.get(cacheKey);
  }

  // Speed-first path: most resident charts can be analyzed in one call.
  // If that call fails, the app automatically falls back to smaller evidence calls.
  const directInput=analysisContext+`PATIENT DOCUMENT GROUP: ${patientName}\n`+source;
  const direct=maskNames(directInput);
  if(direct.masked.length<=100000){
    try{
      const result=await callAnalysis(direct.masked,"patient",`Analyzing ${patientName} (${index} of ${total})…`);
      const restored=restoreNames(result,direct.map);
      patientReportCache.set(cacheKey,restored);
      return restored;
    }catch(err){
      // Do not waste time chunking for a known non-retryable account/configuration error.
      if(/credit_balance_exhausted|no credits remaining|invalid_api_key|authentication|unauthorized|forbidden/i.test(String(err?.message||err))) throw err;
    }
  }

  const chunks=chunkSourceText(source,22000);
  const results=await mapLimit(chunks,3,async(chunk,i)=>{
    try{
      return {ok:true,text:await condenseEvidencePiece(
        patientName,analysisContext,chunk,`SOURCE ${i+1} OF ${chunks.length}`,
        `Processing ${patientName} — document section ${i+1} of ${chunks.length}…`
      )};
    }catch(err){
      return {ok:false,text:`SOURCE ${i+1} OF ${chunks.length}: Evidence extraction unavailable after smaller-section retries. Do not infer facts from this missing section.`,err:friendlyAnalysisError(err?.message||err),index:i+1};
    }
  });
  const evidence=results.map(r=>r.text);
  const missed=results.filter(r=>!r.ok);
  if(missed.length===chunks.length){
    const diag=missed.map(x=>x.err).find(x=>/DIAGNOSTIC:/i.test(x))||missed[0]?.err||"No diagnostic detail returned.";
    throw new Error(`Document evidence processing failed for all ${chunks.length} sections. ${diag}`);
  }
  if(missed.length){
    $("aiStatus").textContent=`Continuing ${patientName} — ${missed.length} source section${missed.length===1?"":"s"} could not be processed; completed evidence is being preserved…`;
  }

  const reducedEvidence=await reduceEvidenceReliable(patientName,analysisContext,evidence);
  const report=await buildPatientFromEvidence(patientName,analysisContext,reducedEvidence,index,total);
  patientReportCache.set(cacheKey,report);
  return report;
}

$("analyzeBtn").onclick=async()=>{
  const raw=$("rawText").value.trim();
  if(!raw){$("aiStatus").textContent="Extract or paste text first.";return}
  const patientRows=[...document.querySelectorAll(".admitRow")];
  const missingRows=patientRows.filter(row=>{
    const name=row.querySelector(".admitName")?.value.trim();
    const date=row.querySelector(".admitDate")?.value;
    const insurance=row.querySelector(".admitInsurance")?.value.trim();
    return !name || !date || !insurance;
  });
  if(missingRows.length){
    missingRows.forEach(row=>{
      [...row.querySelectorAll("input[required]")].forEach(input=>{ if(!input.value.trim()) input.reportValidity(); });
    });
    $("aiStatus").textContent=`Enter resident name, admit date, and insurance for every patient before generating the report.`;
    (missingRows[0].querySelector("input:invalid")||missingRows[0].querySelector("input"))?.focus();
    return;
  }
  $("analyzeBtn").disabled=true;
  try{
    const enteredNames=patientNames();
    let groupedRaw=raw;
    if(enteredNames.length===1){
      groupedRaw=groupedRaw.replace(/===\s*PATIENT DOCUMENT GROUP:\s*UNASSIGNED\s*===/gi,`=== PATIENT DOCUMENT GROUP: ${enteredNames[0]} ===`);
      if(groupedRaw!==raw) $("rawText").value=groupedRaw;
    }
    const groups=extractedPatientGroups(groupedRaw);
    const entries=[...groups.entries()].filter(([name,txt])=>txt.trim() && name!=="UNASSIGNED");
    if(!entries.length){
      const fallbackName=patientNames()[0]||"Patient";
      entries.push([fallbackName,groupedRaw]);
    }
    $("aiStatus").textContent=`Analyzing ${entries.length} patient${entries.length===1?"":"s"}…`;
    const results=await mapLimit(entries,PATIENT_ANALYSIS_CONCURRENCY,async(entry,i)=>{
      const [name,source]=entry;
      try{
        return {name,report:await generatePatientReliable(name,source,i+1,entries.length),error:null};
      }catch(e){
        return {name,report:null,error:friendlyAnalysisError(e.message)};
      }
    });
    const patientReports=results.filter(r=>r.report).map(r=>r.report);
    const failed=results.filter(r=>!r.report);
    if(!patientReports.length){
      const detail=failed.map(r=>`${r.name}: ${r.error}`).join(" | ");
      throw new Error(detail||"No patient report could be generated.");
    }

    // Show completed patient reports immediately; the smaller facility snapshot can finish afterward.
    const patientOnlyReport=patientReports.join("\n\n");
    latestTextReport=patientOnlyReport;
    renderReport(patientOnlyReport);
    setEditMode(false);
    $("aiStatus").textContent=`Patient report${patientReports.length===1?"":"s"} ready. Finishing facility-level snapshot…`;

    let facility="";
    try{
      const facilityInput=patientOnlyReport;
      const facilityKey=fastHash(facilityInput);
      if(facilityReportCache.has(facilityKey)) facility=facilityReportCache.get(facilityKey);
      else {
        const maskedFacility=maskNames(facilityInput);
        facility=restoreNames(await callAnalysis(maskedFacility.masked,"facility","Building facility-level UR snapshot…"),maskedFacility.map);
        facilityReportCache.set(facilityKey,facility);
      }
    }catch(_){
      facility="FACILITY-LEVEL UR SNAPSHOT\nImmediate Review: See patient-specific UR summaries above.\nAuthorization Issues: None\nOxygen Conflicts: See patient-specific oxygen conflict fields above.\nDischarge Planning Focus: See patient-specific discharge plans above.\nStaffing / Operational Issues: None\nRecent Discharges: None";
    }

    const report=patientReports.join("\n\n")+"\n\n"+facility;
    latestTextReport=report;
    renderReport(report);
    setEditMode(false);
    if(failed.length){
      $("aiStatus").textContent=`Generated ${patientReports.length} patient report${patientReports.length===1?"":"s"}. Could not finish: ${failed.map(r=>`${r.name} (${r.error})`).join("; ")}. Click Generate again to retry; completed patients are cached for this session.`;
    }else{
      $("aiStatus").textContent="Patient breakdown generated. You can edit it before copying or downloading it.";
    }
  }catch(e){
    $("aiStatus").textContent=`Could not finish the patient breakdown. ${friendlyAnalysisError(e.message)} Your uploaded files, assignments, and completed evidence are still available for this session. Please click Generate again.`;
  }finally{
    $("analyzeBtn").disabled=false;
  }
};

function esc(s){return s.replace(/[&<>]/g,m=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[m]))}
function parsePatientBlock(block){
  const lines=block.split("\n");
  const obj={name:"",top:{},sections:{}};
  let section="TOP";
  for(const raw of lines){
    const line=raw.trim();
    if(!line) continue;
    if(line.startsWith("PATIENT: ")){ obj.name=line.replace("PATIENT: ","").trim(); continue; }
    if(["CLINICAL / H&P","PREVIOUS FUNCTION & EQUIPMENT","CURRENT STATUS","THERAPY","DISCHARGE PLAN","UTILIZATION REVIEW SUMMARY"].includes(line)){
      section=line; obj.sections[section]=[]; continue;
    }
    const idx=line.indexOf(":");
    if(idx>0){
      const key=line.slice(0,idx).trim(), val=line.slice(idx+1).trim();
      if(section==="TOP") obj.top[key]=val;
      else obj.sections[section].push([key,val]);
    } else if(section!=="TOP"){
      obj.sections[section].push(["",line]);
    }
  }
  return obj;
}


function ensureStairsRow(p){
  const current=p.sections["CURRENT STATUS"]||(p.sections["CURRENT STATUS"]=[]);
  const has=current.some(([k])=>String(k||"").trim().toLowerCase()==="stairs");
  if(has) return;

  const candidates=[];
  for(const [sectionName,rows] of Object.entries(p.sections||{})){
    if(sectionName==="CURRENT STATUS" || !Array.isArray(rows)) continue;
    for(const [k,v] of rows){
      const joined=`${k||""}: ${v||""}`.trim();
      if(/\b(stairs?|steps?|ste|flight|stairway)\b/i.test(joined)) candidates.push(joined);
    }
  }

  if(candidates.length){
    const requirement=candidates[0].replace(/^\s*:?\s*/,"").trim();
    current.push(["Stairs",`Not yet assessed/completed — home/discharge stair requirement noted: ${requirement}`]);
  }else{
    current.push(["Stairs","Not documented — stair/step requirements at home/discharge have not yet been identified."]);
  }
}

function priorityClass(v){
  const x=(v||"").toLowerCase();
  if(x.includes("high")) return "high";
  if(x.includes("watch")) return "watch";
  return "routine";
}

function sectionHtml(title, rows, extraClass=""){
  if(!rows || !rows.length) return "";
  let body="";
  for(const [k,v] of rows){
    if(title!=="PATIENT INFORMATION" && /^(not shown|n\/a|none)$/i.test((v||"").trim())) continue;
    if(title==="UTILIZATION REVIEW SUMMARY" && k==="UR Priority"){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="priority ${priorityClass(v)}">${esc(v)}</span></div></div>`;
    } else if(title==="UTILIZATION REVIEW SUMMARY" && k==="Recommended Follow-Up"){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v follow" data-editable="1">${esc(v)}</div></div>`;
    } else if(title==="CURRENT STATUS" && k==="Stairs" && /not documented|not yet assessed|not yet completed|not assessed|not completed/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="stairAlert">⚠ ${esc(v)}</span></div></div>`;
    } else if(title==="UTILIZATION REVIEW SUMMARY" && k==="Caregiver Support Match" && /concern|needs verification|mismatch|insufficient|unknown|not documented|not established/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="caregiverAlert">⚠ ${esc(v)}</span></div></div>`;
    } else if(title==="CURRENT STATUS" && k==="Home Oxygen Alert" && !/^none|not shown$/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="homeO2Alert">⚠ ${esc(v)}</span></div></div>`;
    } else if(title==="DISCHARGE PLAN" && k==="AI-Recommended DME" && !/^none|not shown$/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="aiDme">${esc(v)}</span></div></div>`;
    } else if(title==="DISCHARGE PLAN" && k==="Swallowing / Diet Readiness Alert" && !/^none|not shown$/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="swallowAlert">⚠ ${esc(v)}</span></div></div>`;
    } else if(title==="DISCHARGE PLAN" && k==="Discharge Destination Alert" && !/^none|not shown$/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="destinationAlert">⚠ ${esc(v)}</span></div></div>`;
    } else if((k==="Oxygen Conflict" || k==="Conflicting Documentation") && !/^none|not shown$/i.test((v||"").trim())){
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1"><span class="conflict">⚠ ${esc(v)}</span></div></div>`;
    } else {
      body += `<div class="field"><div class="k">${esc(k)}</div><div class="v" data-editable="1">${esc(v)}</div></div>`;
    }
  }
  return `<div class="section ${extraClass}"><h4>${esc(title)}</h4><div class="kv">${body}</div></div>`;
}

function renderReport(text){
  $("results").innerHTML="";
  const facilityMarker="\nFACILITY-LEVEL UR SNAPSHOT";
  let patientText=text, facilityText="";
  const fi=text.indexOf(facilityMarker);
  if(fi>=0){ patientText=text.slice(0,fi); facilityText=text.slice(fi+1); }

  const blocks=patientText.split(/\n(?=PATIENT: )/g).filter(x=>x.trim());
  blocks.forEach(block=>{
    if(!block.trim().startsWith("PATIENT: ")) return;
    const p=parsePatientBlock(block);
    ensureStairsRow(p);
    const meta="";

    const card=document.createElement("div");
    card.className="patient";
    card.innerHTML=
      `<div class="patientHead"><h3 data-editable="1">${esc(p.name||"Patient")}</h3>${meta ? `<div class="meta">${esc(meta)}</div>` : ""}</div>` +
      sectionHtml("PATIENT INFORMATION",[
        ["Admit Date",p.top["Start/Adm Date"]||p.top["Admit Date"]||"Not shown"],
        ["Days Since Admission",p.top["Days Since Admission"]||"Not shown"],
        ["Payer",p.top["Payer"]||"Not shown"],
        ["Primary ICD-10",p.top["Primary ICD-10"]||p.top["ICD-10"]||"Not shown"],
        ["Treatment Diagnoses",p.top["Treatment Diagnoses"]||"Not shown"]
      ]) +
      sectionHtml("CLINICAL / H&P",p.sections["CLINICAL / H&P"]) +
      sectionHtml("PREVIOUS FUNCTION & EQUIPMENT",p.sections["PREVIOUS FUNCTION & EQUIPMENT"]) +
      sectionHtml("CURRENT STATUS",p.sections["CURRENT STATUS"]) +
      sectionHtml("THERAPY",p.sections["THERAPY"]) +
      sectionHtml("DISCHARGE PLAN",p.sections["DISCHARGE PLAN"]) +
      sectionHtml("UTILIZATION REVIEW SUMMARY",p.sections["UTILIZATION REVIEW SUMMARY"],"urbox");
    $("results").appendChild(card);
  });

  if(facilityText){
    const f=document.createElement("div");
    f.className="facility";
    f.innerHTML=`<div class="facilityHead">Facility-Level UR Snapshot</div><div class="facilityBody" data-editable="1">${esc(facilityText.replace("FACILITY-LEVEL UR SNAPSHOT","").trim())}</div>`;
    $("results").appendChild(f);
  }
}
let editMode=false;
function setEditMode(on){
  editMode=on;
  document.querySelectorAll('[data-editable="1"]').forEach(el=>{
    el.contentEditable=on?"true":"false";
    el.classList.toggle("editable",on);
  });
  $("editBtn").textContent=on?"Done editing":"Edit breakdown";
  $("aiStatus").textContent=on?"Editing is on. Click any patient name or field value to change it.":"Patient breakdown ready.";
}
$("editBtn").onclick=()=>{
  if(!$("results").querySelector('.patient')) return;
  setEditMode(!editMode);
};
function reportTextFromDom(){
  const r=$("results");
  return r.innerText.trim();
}
$("copyBtn").onclick=async()=>{
  const text=reportTextFromDom(); if(!text)return;
  await navigator.clipboard.writeText(text);
  $("copyBtn").textContent="Copied";
  setTimeout(()=>$("copyBtn").textContent="Copy report",1200)
}

function cleanPdfText(s){
  return (s||"").replace(/\u26A0/g,"").replace(/\s+/g," ").trim();
}
function pdfValueText(s){
  let t=cleanPdfText(s);
  // Keep website-style Current Status comparisons readable in the PDF.
  t=t.replace(/\s+(Best\s*\([^)]*\)\s*:)/gi,"\n\n$1");
  t=t.replace(/\s+(Best\s*[-–—]\s*[^:]+:)/gi,"\n\n$1");
  t=t.replace(/\s+(Baseline\s*:)/gi,"\n\n$1");
  t=t.replace(/\s+(Needs verification\s*:)/gi,"\n\n$1");
  return t;
}
function classifyPdfAlert(label,value){
  const txt=`${label} ${value}`.toLowerCase();
  if(/stairs/.test(txt) && /not documented|not yet assessed|not yet completed|not assessed|not completed|have not yet been identified/.test(txt)){
    return "amber";
  }
  if(/caregiver support match/.test(txt) && /concern|needs verification|mismatch|insufficient|unknown|not documented|not established/.test(txt)){
    return "amber";
  }
  if(/home oxygen alert/.test(txt) && !/home oxygen alert\s+(none|not shown)/.test(txt)){
    return "amber";
  }
  if(/swallowing \/ diet readiness alert/.test(txt) && !/swallowing \/ diet readiness alert\s+(none|not shown)/.test(txt)){
    return "amber";
  }
  if(/discharge destination alert/.test(txt) && !/discharge destination alert\s+(none|not shown)/.test(txt)){
    return "amber";
  }
  if(/needs verification|conflict|inconsistent|discrepan|verify|clarif/.test(txt)){
    return /needs verification|conflict|inconsistent|discrepan/.test(txt)?"red":"amber";
  }
  return "";
}

$("pdfBtn").onclick=()=>{
  if(!$("results").querySelector(".patient")){
    $("aiStatus").textContent="Generate a patient breakdown first.";
    return;
  }
  if(!window.jspdf || !window.jspdf.jsPDF){
    $("aiStatus").textContent="PDF generator did not load. Refresh Safari and try again.";
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc=new jsPDF({orientation:"portrait",unit:"pt",format:"letter"});
  const pageW=612,pageH=792,margin=34,contentW=pageW-(margin*2),bottom=pageH-34;
  let y=34;

  const rgb={
    ink:[23,32,51], muted:[102,112,133], line:[223,227,234],
    head:[248,249,251], section:[83,98,122], blue:[36,67,158],
    blueBg:[238,243,255], urBg:[251,252,255], white:[255,255,255],
    red:[180,35,24], redBg:[255,241,240], redLine:[247,199,195],
    amber:[181,71,8], amberBg:[255,247,237], amberLine:[254,215,170]
  };
  const setText=(c)=>doc.setTextColor(...c);
  const addPage=()=>{doc.addPage();y=34;};
  const need=(n)=>{if(y+n>bottom)addPage();};
  const splitClean=(s,w)=>doc.splitTextToSize(cleanPdfText(s),w);
  const splitValue=(s,w)=>doc.splitTextToSize(pdfValueText(s),w);
  const txtH=(lines,leading)=>Math.max(leading,lines.length*leading);
  const drawLine=(x1,yy,x2)=>{doc.setDrawColor(...rgb.line);doc.setLineWidth(.5);doc.line(x1,yy,x2,yy);};

  function drawAlert(title,body,kind="amber"){
    const bg=kind==="red"?rgb.redBg:rgb.amberBg;
    const stroke=kind==="red"?rgb.redLine:rgb.amberLine;
    const accent=kind==="red"?rgb.red:rgb.amber;
    const titleW=145, innerW=contentW-28, bodyW=innerW-titleW;
    doc.setFont("helvetica","bold");doc.setFontSize(8.5);
    const tl=doc.splitTextToSize(cleanPdfText(title),titleW-8);
    doc.setFont("helvetica","normal");doc.setFontSize(8.5);
    const bl=doc.splitTextToSize(cleanPdfText(body),bodyW);
    const h=Math.max(42,txtH(tl,11.5)+18,txtH(bl,11.5)+18);
    need(h+9); y+=7;
    doc.setFillColor(...bg);doc.setDrawColor(...stroke);doc.setLineWidth(.7);
    doc.roundedRect(margin,y,contentW,h,7,7,"FD");
    doc.setFont("helvetica","bold");doc.setFontSize(8.5);setText(accent);
    doc.text(tl,margin+14,y+16);
    doc.setFont("helvetica","normal");doc.setFontSize(8.5);setText(rgb.ink);
    doc.text(bl,margin+14+titleW,y+16);
    y+=h;
  }

  // Website-like report title.
  doc.setFont("helvetica","bold");doc.setFontSize(18);setText(rgb.ink);
  doc.text("Rehab Utilization Review",margin,y+14);
  doc.setFont("helvetica","normal");doc.setFontSize(9);setText(rgb.muted);
  doc.text(`Generated ${new Date().toLocaleDateString()}`,margin,y+31);
  y+=50;

  const patients=[...$("results").querySelectorAll(".patient")];
  patients.forEach((patient,pi)=>{
    if(pi>0){need(28);y+=18;}
    const name=cleanPdfText(patient.querySelector(".patientHead h3")?.innerText||"Patient");
    const meta=cleanPdfText(patient.querySelector(".patientHead .meta")?.innerText||"");
    const patientAlerts=[];

    // Patient card header mirrors .patientHead.
    need(meta?58:48);
    doc.setFillColor(...rgb.head);
    doc.setDrawColor(...rgb.line);
    doc.roundedRect(margin,y,contentW,meta?55:46,8,8,"FD");
    doc.setFont("helvetica","bold");doc.setFontSize(15);setText(rgb.ink);
    doc.text(name,margin+14,y+21);
    if(meta){
      doc.setFont("helvetica","normal");doc.setFontSize(8.5);setText(rgb.muted);
      doc.text(splitClean(meta,contentW-28),margin+14,y+38);
    }
    y+=meta?55:46;

    [...patient.querySelectorAll(".section")].forEach(section=>{
      const title=cleanPdfText(section.querySelector("h4")?.innerText||"");
      const rows=[...section.querySelectorAll(".field")].map(row=>({
        k:cleanPdfText(row.querySelector(".k")?.innerText||""),
        v:cleanPdfText(row.querySelector(".v")?.innerText||"")
      })).filter(r=>r.k||r.v);
      if(!rows.length)return;

      const isUR=section.classList.contains("urbox");
      need(36);
      if(isUR){
        doc.setFillColor(...rgb.urBg);
        doc.rect(margin,y,contentW,26,"F");
      }
      doc.setFont("helvetica","bold");doc.setFontSize(8);setText(rgb.section);
      doc.text(title.toUpperCase(),margin+14,y+18);
      y+=31;

      rows.forEach((r,idx)=>{
        const labelW=150,valueX=margin+14+labelW,valueW=contentW-28-labelW;
        doc.setFont("helvetica","bold");doc.setFontSize(9.1);
        const kl=splitClean(r.k,labelW-12);
        doc.setFont("helvetica","normal");doc.setFontSize(9.1);
        const vl=splitValue(r.v,valueW);
        const rowH=Math.max(36,txtH(kl,13.5)+18,txtH(vl,13.5)+18);
        need(rowH);

        if(idx>0) drawLine(margin+14,y,margin+contentW-14);
        doc.setFont("helvetica","bold");doc.setFontSize(9.1);setText([52,64,84]);
        doc.text(kl,margin+14,y+18);
        const isAiDme=r.k==="AI-Recommended DME";
        doc.setFont("helvetica",isAiDme?"italic":"normal");doc.setFontSize(9.1);setText(isAiDme?[72,78,92]:[29,41,57]);
        doc.text(vl,valueX,y+18,{lineHeightFactor:1.45});
        y+=rowH;

        const alertKind=classifyPdfAlert(r.k,r.v);
        if(alertKind){
          const key=`${r.k}|${r.v}`;
          if(!patientAlerts.some(a=>a.key===key)) patientAlerts.push({key,kind:alertKind,label:r.k,value:r.v});
        }
      });
      drawLine(margin,y,margin+contentW);
    });

    // Colored, content-driven alerts. Do not invent new clinical facts.
    patientAlerts.slice(0,4).forEach(a=>{
      const title=(/oxygen/i.test(a.label+a.value)?"OXYGEN ALERT":/swallow|diet readiness/i.test(a.label+a.value)?"SWALLOWING / DIET ALERT":/discharge destination/i.test(a.label+a.value)?"DISCHARGE DESTINATION ALERT":/icd|diagnos/i.test(a.label+a.value)?"ICD-10 ALERT":/caregiver/i.test(a.label+a.value)?"CAREGIVER SUPPORT ALERT":"UR ALERT");
      drawAlert(title,a.value,a.kind);
    });

    // Bottom of card.
    doc.setDrawColor(...rgb.line);
    doc.line(margin,y,margin+contentW,y);
    y+=10;
  });

  const facility=$("results").querySelector(".facility");
  if(facility){
    need(64);y+=15;
    const title="Facility-Level UR Snapshot";
    doc.setFillColor(...rgb.blueBg);
    doc.setDrawColor(200,211,239);
    doc.roundedRect(margin,y,contentW,36,8,8,"FD");
    doc.setFont("helvetica","bold");doc.setFontSize(12);setText(rgb.blue);
    doc.text(title,margin+14,y+22);
    y+=36;

    const items=(facility.querySelector(".facilityBody")?.innerText||"")
      .split(/\n+/).map(x=>x.trim()).filter(Boolean);
    items.forEach((item,idx)=>{
      const colon=item.indexOf(":");
      const label=colon>=0?cleanPdfText(item.slice(0,colon+1)):"";
      const value=colon>=0?cleanPdfText(item.slice(colon+1)):cleanPdfText(item);
      const labelW=160,valueX=margin+14+labelW,valueW=contentW-28-labelW;
      doc.setFont("helvetica","bold");doc.setFontSize(9.1);
      const kl=splitClean(label,labelW-12);
      doc.setFont("helvetica","normal");doc.setFontSize(9.1);
      const vl=splitValue(value,valueW);
      const rowH=Math.max(36,txtH(kl,13.5)+18,txtH(vl,13.5)+18);
      need(rowH);
      if(idx>0)drawLine(margin+14,y,margin+contentW-14);
      if(label){
        doc.setFont("helvetica","bold");doc.setFontSize(9.1);setText([52,64,84]);
        doc.text(kl,margin+14,y+18);
      }
      doc.setFont("helvetica","normal");doc.setFontSize(9.1);setText([38,50,71]);
      doc.text(vl,label?valueX:margin+14,y+18,{lineHeightFactor:1.35});
      y+=rowH;
    });
    drawLine(margin,y,margin+contentW);
  }

  // Page numbers.
  const pages=doc.getNumberOfPages();
  for(let i=1;i<=pages;i++){
    doc.setPage(i);
    doc.setFont("helvetica","normal");doc.setFontSize(8);setText(rgb.muted);
    doc.text(`Page ${i} of ${pages}`,pageW-margin,pageH-18,{align:"right"});
  }

  doc.save(`rehab-utilization-review-${localTodayISO()}.pdf`);
  $("pdfBtn").textContent="PDF downloaded";
  setTimeout(()=>{
    $("pdfBtn").textContent="Download PDF";
    clearPatientData({message:"PDF downloaded. Patient data was cleared from the page for privacy."});
  },700);
};
