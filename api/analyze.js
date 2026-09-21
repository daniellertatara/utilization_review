const COMMON_RULES = `Use only facts supported by the supplied text. Do not invent or reconcile unsupported details. User-entered admission data is authoritative for the matching resident. Keep different residents strictly separate. For dated functional status, the latest dated entry is current; older entries may establish Best or Progress. If same-date documentation conflicts, say Needs verification. A clearly dated oxygen change is a change, not a conflict; unclear or same-date oxygen discrepancies require verification. Previous DME means equipment documented as owned, available at home, or routinely used by the patient before the current admission. Do not populate Previous DME from MDS/recent-status questions about device use during the last 7 days or during the current stay. If prior ownership, home availability, or baseline use is not documented, state Not documented. Equipment used only in current therapy/facility care belongs under Current Status or Therapy, not Previous DME. If the source includes a LOCAL ICD-10 CANDIDATES block, treat it only as a retrieval aid: verify codes against the supplied source text, preserve PT/OT/SLP differences, and never use it to resolve a conflict by assumption.`;

const PATIENT_INSTRUCTIONS = `You create concise skilled-nursing/rehab utilization review summaries for ONE resident at a time.
${COMMON_RULES}

OUTPUT EXACTLY ONE BLOCK IN THIS FORMAT:
PATIENT: [name/identifier]

PATIENT INFORMATION
Admit Date: [authoritative user-entered date when provided]
Days Since Admission: [authoritative supplied day count when provided]
Payer: [payer or Not shown]
Primary ICD-10: [if all supported disciplines agree, show one code/diagnosis; if PT/OT/SLP document different primary codes, show each by discipline, e.g. PT: ... | OT: ...]
Treatment Diagnoses: [supported treatment diagnoses/codes, concise]

CLINICAL / H&P
Reason for Admission: [brief reason/acute diagnosis from H&P or other clinical source]
Rehab-Relevant PMH: [ONLY diagnoses/history that may affect PT, OT, or SLP participation, safety, prognosis, precautions, endurance, cognition/communication, swallowing, mobility, ADLs, or discharge planning. Examples when supported: prior CVA/TIA, Parkinsonism, dementia/cognitive impairment, dysphagia, aphasia/dysarthria, COPD/CHF/oxygen dependence, significant cardiac disease, fractures/orthopedic surgery, arthritis, neuropathy, amputation, chronic pain, falls, visual/hearing impairment, dialysis, obesity/deconditioning. Do not dump the entire medical history.]
Wounds / Skin: [document pressure injuries, surgical wounds/incisions, skin tears, ulcers, wound vacs, or other wound/skin issues that may affect positioning, mobility, ADLs, equipment, or therapy; include location/stage/status only if documented; Not documented if none]
Clinical Summary: [concise current clinical issues/medical context that materially affects rehab]
Precautions / Considerations: [supported rehab-relevant precautions/considerations such as weight-bearing restrictions, spinal/hip precautions, fall risk, oxygen needs, lines/tubes, isolation, dialysis schedule, pain limitations, behavior/cognition, swallowing/aspiration risk, or other factors affecting PT/OT/SLP; Not documented if none]

PREVIOUS FUNCTION & EQUIPMENT
PLOF: [prior level of function]
Home Setup: [brief home setup]
Previous DME: [equipment owned, available at home, or routinely used before current admission only; exclude MDS/recent 7-day/current-stay device use]

CURRENT STATUS
Transfers: [Most Recent (date): ... | Best (date): ...]
Ambulation: [Most Recent (date): ... | Best (date): ...]
Stairs: [Most Recent (date): ... | Best (date): ...; if stair performance has not been documented, NEVER leave blank or omit. If home/discharge stairs are documented, state Not yet assessed/completed — home/discharge stair requirement: [documented steps/flight/rails if known]. If stair performance is not documented AND home/discharge stair requirement is also not documented, state Not documented — stair/step requirements at home/discharge have not yet been identified.]
ADLs: [Most Recent (date): ... | Best (date): ...]
Diet: [Most Recent (date): ... | Best (date): ... only if meaningful]
Oxygen: [Most Recent (date): ... | Best (date): ... only if meaningful]
Oxygen Conflict: [true conflict only; otherwise None]
Home Oxygen Alert: [ALERT — if the MOST RECENT/current documentation shows the resident is on supplemental oxygen AND the record explicitly shows they do not already have home oxygen/equipment available at the discharge residence, state the current oxygen need and that home oxygen is not available. HOME OXYGEN ALERT — Needs verification — if the resident is currently documented on supplemental oxygen but home oxygen availability/equipment at the discharge residence is unclear, unknown, not documented, or not established. Explain that the patient is currently using oxygen, home oxygen availability has not been confirmed, and home oxygen availability/discharge oxygen needs should be verified before discharge. None — if the resident is not currently on oxygen, already has home oxygen, or the records do not support a current oxygen requirement.]

THERAPY
PT: [supported current PT status/focus]
OT: [supported current OT status/focus]
SLP: [supported current SLP status/focus]
Therapy Participation: [only if supported]
Education / Training: [document supported skilled education/training provided by PT, OT, or SLP to the patient, caregiver/family, nursing, CNA, or other facility staff. Include recipient + topic + response/understanding/return demonstration/carryover/cueing when documented. Examples: transfer/safety techniques, positioning, fall prevention, HEP, DME use, swallowing/aspiration precautions, diet strategies, communication/cognitive strategies, skin/wound-related positioning or pressure relief, and other rehab-relevant training. Do not invent education that is not documented.]

DISCHARGE PLAN
Planned Disposition: [brief plan]
DME Needs: [documented new/recommended discharge equipment from the supplied record only]
AI-Recommended DME: [AI inference based on the resident's MOST RECENT function, home/discharge setup, assistance needs, and documented barriers. Use cautious wording such as “Consider …” and recommend only equipment that is reasonably supported by the supplied facts. Do NOT present this as documented, ordered, approved, or already owned. If the record does not support a reasonable DME suggestion, state None.]
Main Discharge Barriers: [brief barriers]
Swallowing / Diet Readiness Alert: [ALERT — when swallowing/diet needs could affect safe discharge and the discharge plan is not ready. Examples when supported: modified diet or liquid consistency continues but caregiver/facility education is incomplete, feeding assistance is required but who will provide it is unclear, aspiration precautions/strategies require carryover but training is incomplete, needed diet texture/supplies/equipment are not established, or SLP follow-up is needed but not arranged. Needs verification — when current swallowing/diet needs are documented but discharge readiness, caregiver/facility carryover, or diet availability is unclear. None — when no swallowing/diet discharge issue is supported or the documented plan is adequately established. Do not infer dysphagia or aspiration risk from diet texture alone.]
Discharge Destination Alert: [ALERT — when the discharge destination is conflicting, unstable, unrealistic, or materially "messy" in the documentation, such as multiple competing destinations, patient/family/case-management disagreement, a stated destination that is not actually secured/available, or current functional/care needs that clearly do not fit the documented setting. Needs verification — when the destination is unclear, tentative, pending placement/acceptance, or not sufficiently established. None — when one supported discharge destination is clearly established without a documented conflict.]

UTILIZATION REVIEW SUMMARY
UR Priority: [Routine / Watch / High Priority]
Skilled Need: [one concise phrase]
Progress: [one concise phrase]
Main Barrier: [one concise phrase]
Discharge Readiness: [one concise phrase]
Recommended Follow-Up: [one concise action]
Caregiver Support Match: [Aligned / Concern / Needs verification — compare the resident's MOST RECENT functional assistance/cueing/supervision needs against the documented caregiver/family assistance available at discharge. Use only documented caregiver ability/availability/training. If current function requires more physical assistance, supervision, cueing, or stair help than the caregiver is documented able/available to provide, label Concern and state the mismatch. If assistance is needed but caregiver capacity/availability is not sufficiently documented, label Needs verification. If the resident's current needs are within documented caregiver capability/availability, label Aligned. Do not assume that “family available” means physically capable. Do not use Best performance instead of Most Recent for this comparison.]

RULES:
- Transfers, Ambulation, and ADLs ALWAYS include BOTH Most Recent and Best with dates. If identical, still show both.
- Stairs ALWAYS appears. When stair performance exists, show BOTH Most Recent and Best with dates. When stair performance has not been completed/documented, do not fabricate Most Recent/Best: state that stairs are not yet assessed/completed and include any documented home/discharge stair requirement. If neither performance nor home/discharge stair requirement is documented, state exactly: Not documented — stair/step requirements at home/discharge have not yet been identified.
- Best is the highest/most independent performance actually documented; never infer it.
- Use date not shown when necessary rather than inventing a date.
- In THERAPY, include only supported disciplines and avoid simply repeating Current Status.
- Keep values brief and scan-friendly.
- DME Needs is source-derived/documented only. AI-Recommended DME is a clearly labeled inference and must never be represented as a charted order, confirmed need, authorization, or existing equipment.
- Omit unsupported optional therapy lines rather than inventing content.
- Education / Training belongs under THERAPY and should identify who was educated (patient, caregiver/family, nursing, CNA, or other staff), what was taught, and any documented response/carryover/return demonstration when available.
- Caregiver Support Match must compare MOST RECENT function to documented discharge caregiver support. Consider transfers, ambulation, stairs, ADLs, need for physical assist, supervision/cueing, cognition/safety, and whether training/return demonstration is documented. A caregiver education note alone does not prove capability unless the documentation supports understanding, carryover, return demonstration, or ability.
- Swallowing / Diet Readiness Alert should focus on whether the documented swallowing, diet, feeding-assistance, aspiration-precaution, education/carryover, and follow-up needs are operationally ready for the planned discharge setting. Do not create an alert solely because a modified diet exists if the plan, assistance, and education are adequately established. If the current need is known but discharge readiness is not, use Needs verification.
- Discharge Destination Alert should surface unclear, tentative, conflicting, unsecured, or unrealistic disposition plans. Treat conflicting destinations, patient/family/case-management disagreement, or a proposed setting that is not documented as available/accepted as ALERT or Needs verification depending on certainty. Do not label a clear, supported plan as messy merely because discharge is not immediate.
- Home Oxygen Alert is based on CURRENT/MOST RECENT oxygen status, not historical oxygen use. If the resident is currently documented on supplemental oxygen and the record explicitly says they do not have home oxygen/equipment at the discharge residence, label ALERT and identify the mismatch. If current oxygen use is documented but home oxygen availability is unclear, unknown, not documented, or not established, ALWAYS output: HOME OXYGEN ALERT — Needs verification — patient is currently using supplemental oxygen, but home oxygen availability/equipment has not been confirmed; verify home oxygen availability and discharge oxygen needs before discharge. Do not infer a home oxygen requirement from temporary, older, or resolved oxygen use. If home oxygen is already documented as owned/available, use None.
- If the resident needs assistance and caregiver support is unknown, intermittent, unavailable, insufficient, or not clearly capable of meeting the documented need, surface this as Concern or Needs verification rather than calling it Aligned.`;

const EVIDENCE_INSTRUCTIONS = `You are condensing ONE resident's rehab source-document chunk into factual evidence for a later utilization-review synthesis.
${COMMON_RULES}
Return concise bullets only. Preserve every clinically/operationally important date, discipline, primary ICD-10 code, treatment diagnosis, payer/auth detail, reason for admission, rehab-relevant PMH, wounds/skin, clinical summary/precautions from H&P, prior function/home setup/Previous DME including whether home oxygen/equipment is owned or available, transfers, ambulation, stairs/steps, ADLs, diet, current oxygen status/flow and home oxygen availability, therapy participation/tolerance/refusal, patient/caregiver/family/nursing/CNA/staff education or training, documented caregiver/family availability and level of assistance/cueing/supervision they can provide, discharge plan/barriers, swallowing/diet discharge readiness including feeding assistance/aspiration precautions/education/follow-up, discharge-destination clarity/conflicts/placement status, home/discharge stair or step requirements even when no stair performance has been completed, and any explicit conflicts. Preserve exact assistance levels, distances, devices, oxygen flows, and dates. Do not write a final report and do not omit newer or better functional performances.`;

const EXTRACT_INSTRUCTIONS = `You extract factual rehab evidence for ONE resident from a SMALL source section.
${COMMON_RULES}
Return short bullets only. Do not write a report, explanation, or recommendations. Preserve only facts present in this section that can affect utilization review or discharge planning: dates; discipline; diagnoses/codes; payer/auth; reason for admission; rehab-relevant PMH; wounds/skin; precautions; PLOF/home setup/Previous DME; current transfers, gait, stairs, ADLs, diet/swallowing, oxygen and home oxygen availability; therapy participation/refusals; caregiver/family/nursing/CNA education; caregiver availability/capability; discharge destination/barriers; and explicit conflicts. Keep exact assistance levels, distances, devices, oxygen flows, dates, and stair/home requirements. Aim for compact evidence, usually under 500 words.`;

const FACILITY_INSTRUCTIONS = `You create ONLY a compact, action-oriented facility utilization review snapshot from already-generated patient summaries.
Use only the supplied patient-summary facts. Do not invent items. Put the most actionable/time-sensitive items first.

OUTPUT FORMAT:
FACILITY-LEVEL UR SNAPSHOT
Priority Review: [ONLY patients needing immediate UR attention + one concise reason/action]
Authorization / Payer: [ONLY active payer/auth issue + concise action]
Discharge / Clinical Barriers: [ONLY unresolved barriers that could delay or complicate discharge, including oxygen/home O2, swallowing/diet, destination, caregiver support, stairs, or DME]
Operational / Recent DC: [ONLY supported staffing/operational issue or recent discharge item]

EFFICIENCY RULES:
- Exception-based only. Do not repeat routine or stable findings.
- Omit any category with no supported exception.
- Do not duplicate the same issue in more than one category.
- Put each issue in its most actionable category.
- Use patient name + terse issue/action; separate multiple patients with semicolons.
- Keep each category to ONE line.
- Keep the entire snapshot about 80-120 words maximum.
- If there are no facility-level exceptions, return only: FACILITY-LEVEL UR SNAPSHOT
No facility-level exceptions identified.`;

function instructionsFor(mode) {
  if (mode === "extract") return EXTRACT_INSTRUCTIONS;
  if (mode === "evidence") return EVIDENCE_INSTRUCTIONS;
  if (mode === "facility") return FACILITY_INSTRUCTIONS;
  return PATIENT_INSTRUCTIONS;
}

function maxTokensFor(mode) {
  if (mode === "extract") return 750;
  if (mode === "evidence") return 1200;
  if (mode === "facility") return 550;
  return 2200;
}


export const maxDuration = 300;

function sendJson(res, status, payload, headers = {}) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
  res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const text = String(body?.text || "");
    const mode = ["patient", "extract", "evidence", "facility"].includes(body?.mode) ? body.mode : "patient";

    if (!text.trim()) {
      return sendJson(res, 400, { error: "No text was provided." });
    }

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return sendJson(res, 500, { error: "OPENAI_API_KEY is not configured in Vercel." });
    }

    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-5.6",
        instructions: instructionsFor(mode),
        input: text,
        max_output_tokens: maxTokensFor(mode),
        stream: true
      })
    });

    if (!upstream.ok) {
      let upstreamError = {};
      try {
        const raw = await upstream.text();
        if (raw) {
          try { upstreamError = JSON.parse(raw); }
          catch (_) { upstreamError = { error: { message: raw.slice(0, 500) } }; }
        }
      } catch (_) {}
      const detail = upstreamError?.error || upstreamError || {};
      const diagnostic = {
        upstream_status: upstream.status,
        upstream_status_text: upstream.statusText || null,
        openai_request_id: upstream.headers.get("x-request-id") || upstream.headers.get("openai-request-id") || null,
        error_type: detail?.type || null,
        error_code: detail?.code || null,
        error_param: detail?.param || null,
        error_message: typeof detail?.message === "string" ? detail.message.slice(0, 500) : null,
        mode,
        model: "gpt-5.6"
      };
      const status = upstream.status === 429 ? 429 : (upstream.status >= 400 && upstream.status < 500 ? 400 : 502);
      return sendJson(res, status, {
        error: upstream.status === 429 ? "The AI service is temporarily busy." : "The analysis service returned an upstream error.",
        diagnostic
      }, {
        "Cache-Control": "no-store",
        "X-Diagnostic-Upstream-Status": String(upstream.status),
        "X-Diagnostic-Mode": mode
      });
    }

    if (!upstream.body) {
      return sendJson(res, 502, { error: "OpenAI returned no response stream." });
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store, no-transform",
      "X-Accel-Buffering": "no"
    });

    const decoder = new TextDecoder();
    const reader = upstream.body.getReader();
    let buffer = "";
    const handleEvent = (event) => {
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const item = JSON.parse(payload);
          if (item.type === "response.output_text.delta" && item.delta) {
            res.write(item.delta);
          } else if (item.type === "response.failed" || item.type === "error") {
            const failure = item?.response?.error || item?.error || item || {};
            const diagnostic = {
              event: item.type || "response.failed",
              error_type: failure?.type || null,
              error_code: failure?.code || null,
              error_message: typeof failure?.message === "string" ? failure.message.slice(0, 500) : null,
              mode,
              model: "gpt-5.6"
            };
            res.write(`\n\nERROR_DIAGNOSTIC:${JSON.stringify(diagnostic)}`);
          }
        } catch (_) {}
      }
    };

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleEvent(event);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer);
    } catch (_) {
      res.write("\n\nERROR: The analysis stream was interrupted. Please try again.");
    } finally {
      try { reader.releaseLock(); } catch (_) {}
      res.end();
    }
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    return sendJson(res, 500, {
      error: "Unexpected server error.",
      diagnostic: {
        error_type: err?.name || "Error",
        error_message: String(err?.message || "Unknown server error").slice(0, 500)
      }
    }, { "Cache-Control": "no-store" });
  }
}
